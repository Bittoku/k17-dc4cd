/**
 * Tests for the roster mirror (`src/chain/roster.ts`) and the tree fields of
 * the history replay. A real v3.1 tree-mode machine runs three cycles
 * (ADMIT, then MEMBER + PAYLEAF, then REMOVE) through the k17-vm keeper
 * helpers and the script interpreter. `walkHistory` decodes them from an
 * in-memory chain and the mirror follows them. No network is used.
 */
import { expect } from 'chai'
import { bsv } from 'scrypt-ts'
import {
    SparseMerkleTree,
    assemble,
    decodeLeafPre,
    encodeLeafPre,
    keyHash,
    newAttester,
    newMachine,
    signAdmission,
    signRemoval,
    K17Machine,
} from 'k17-vm'
import { ECON, FUNDING, T0, cycle, loadMachineArtifact } from './utils/chain'
import { getDefaultSigner } from './utils/txHelper'
import { DecodedCycle, TxSource, walkHistory } from '../src/chain/history'
import { GenesisRoster, RosterMirror, replayRoster } from '../src/chain/roster'

/** Rabin key generation is slow: make the two attesters once. */
const sponsor = newAttester(Buffer.from('roster-test-sponsor'))
const newcomer = newAttester(Buffer.from('roster-test-newcomer'))

const KEY_HASHES = ['11', '22', '33'].map((byte) => byte.repeat(32))
const PAYOUTS = ['aa', 'bb', 'cc'].map((byte) => byte.repeat(20))
const NEWCOMER_PAYOUT = 'dd'.repeat(20)
const TAG_ADMIT = 1000
const TAG_REMOVE = 1001
const BOUNTY = 1000
/** The genesis member that the payment cycle pays. */
const PAID_INDEX = 1

/** Genesis roster of three members at the given leaf indexes. */
function genesisAt(indexes: number[], instanceId = '00'.repeat(32)) {
    const members = indexes.map((index, i) => ({
        index,
        keyHash: KEY_HASHES[i],
        payout: PAYOUTS[i],
        lastRound: 5,
    }))
    const tree = new SparseMerkleTree()
    for (const m of members) {
        tree.set(
            m.index,
            encodeLeafPre(m.keyHash, m.payout, BigInt(m.lastRound), 0n)
        )
    }
    const genesis: GenesisRoster = {
        k17: 'roster',
        instanceId,
        rosterRoot: tree.root(),
        members,
    }
    return genesis
}

/** In-memory chain; unknown ids answer with a stub funding transaction. */
class MemoryChain implements TxSource {
    txs = new Map<string, bsv.Transaction>()
    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const known = this.txs.get(txid)
        if (known) return known
        const stub = new bsv.Transaction()
        for (let i = 0; i < 3; i++) {
            stub.addOutput(
                new bsv.Transaction.Output({
                    script: bsv.Script.fromHex(
                        '76a914' + 'ab'.repeat(20) + '88ac'
                    ),
                    satoshis: 1,
                })
            )
        }
        return stub
    }
}

/** The real chain that the tests below read, built once. */
interface TreeChain {
    genesis: GenesisRoster
    chain: MemoryChain
    lastTxid: string
    final: K17Machine
    admitIndex: number
    cycleTimes: bigint[]
}
let treeChainPromise: Promise<TreeChain> | undefined

/**
 * Deploy a tree machine over the genesis roster at indexes 0, 1 and 2 and
 * run its three cycles. Cycle 1: the sponsor admits the newcomer at the
 * mirror's next free leaf. Cycle 2: the machine binds genesis member 1 and
 * pays it. Cycle 3: the sponsor removes the newcomer.
 */
function treeChain(): Promise<TreeChain> {
    if (!treeChainPromise)
        treeChainPromise = (async () => {
            const prog = assemble([
                ...['LIT', TAG_ADMIT, 'TIME', 'ADMIT', 'YIELD'],
                ...[
                    'MEMBER',
                    'DROP',
                    'LIT',
                    BOUNTY,
                    'TIME',
                    'PAYLEAF',
                    'YIELD',
                ],
                ...['LIT', TAG_REMOVE, 'REMOVE', 'YIELD', 'HALT'],
            ])
            const probe = genesisAt([0, 1, 2])
            const m0 = newMachine(
                prog,
                ECON,
                T0,
                undefined,
                undefined,
                undefined,
                {
                    rosterRoot: probe.rosterRoot,
                    sponsorKeyHash: keyHash(sponsor.pub),
                }
            )
            await m0.connect(getDefaultSigner())
            const deployTx = await m0.deploy(FUNDING)
            const genesis = genesisAt([0, 1, 2], m0.instanceId)
            const mirror = RosterMirror.fromGenesis(genesis)
            const chain = new MemoryChain()
            chain.txs.set(deployTx.id, deployTx)
            const times = [T0 + 60n, T0 + 120n, T0 + 180n]

            // cycle 1: ADMIT at the next free leaf
            const admitIndex = mirror.nextFreeIndex()
            const r1 = await cycle(
                m0,
                BigInt(FUNDING),
                times[0],
                [],
                signAdmission(
                    sponsor,
                    m0.instanceId,
                    BigInt(TAG_ADMIT),
                    0n,
                    BigInt(admitIndex),
                    newcomer.pub,
                    NEWCOMER_PAYOUT
                ),
                {
                    attestKey: sponsor.pub,
                    endorseKey: newcomer.pub,
                    payoutHex: NEWCOMER_PAYOUT,
                },
                mirror.proofFor(admitIndex)
            )
            chain.txs.set(r1.tx.id, r1.tx)

            // cycle 2: pay genesis member 1 (its proof comes from the genesis mirror
            // plus the admission, which does not touch leaf 1)
            const afterAdmit = new SparseMerkleTree()
            for (const g of genesis.members) {
                afterAdmit.set(
                    g.index,
                    encodeLeafPre(g.keyHash, g.payout, BigInt(g.lastRound), 0n)
                )
            }
            afterAdmit.set(
                admitIndex,
                encodeLeafPre(
                    keyHash(newcomer.pub),
                    NEWCOMER_PAYOUT,
                    times[0],
                    0n
                )
            )
            const r2 = await cycle(
                r1.next as K17Machine,
                r1.plan.remaining,
                times[1],
                [],
                undefined,
                {},
                afterAdmit.proof(PAID_INDEX)
            )
            chain.txs.set(r2.tx.id, r2.tx)

            // cycle 3: REMOVE the newcomer
            const afterPay = new SparseMerkleTree(
                new Map(
                    [...Array(3).keys()].map((i) => [
                        i,
                        afterAdmit.get(i) as string,
                    ])
                )
            )
            afterPay.set(admitIndex, afterAdmit.get(admitIndex) as string)
            afterPay.set(
                PAID_INDEX,
                encodeLeafPre(
                    KEY_HASHES[PAID_INDEX],
                    PAYOUTS[PAID_INDEX],
                    times[1],
                    0n
                )
            )
            const r3 = await cycle(
                r2.next as K17Machine,
                r2.plan.remaining,
                times[2],
                [],
                signRemoval(
                    sponsor,
                    m0.instanceId,
                    BigInt(TAG_REMOVE),
                    1n,
                    BigInt(admitIndex),
                    keyHash(newcomer.pub),
                    NEWCOMER_PAYOUT
                ),
                { attestKey: sponsor.pub },
                afterPay.proof(admitIndex)
            )
            chain.txs.set(r3.tx.id, r3.tx)
            return {
                genesis,
                chain,
                lastTxid: r3.tx.id,
                final: r3.next as K17Machine,
                admitIndex,
                cycleTimes: times,
            }
        })()
    return treeChainPromise
}

describe('RosterMirror', function () {
    this.timeout(600_000)

    describe('fromGenesis', () => {
        it('rebuilds the deployed root from three members', () => {
            const genesis = genesisAt([0, 1, 2])
            const mirror = RosterMirror.fromGenesis(genesis)
            expect(mirror.root()).to.equal(genesis.rosterRoot)
            expect(mirror.seq()).to.equal(0n)
            expect(mirror.indexOf(KEY_HASHES[1])).to.equal(1)
            expect(mirror.indexOf(KEY_HASHES[1].toUpperCase())).to.equal(1)
            expect(mirror.hasKey(KEY_HASHES[2])).to.equal(true)
            expect(mirror.hasKey('99'.repeat(32))).to.equal(false)
        })

        it('throws when the members do not give the deployed root', () => {
            const genesis = genesisAt([0, 1, 2])
            genesis.members[2].lastRound = 6
            expect(() => RosterMirror.fromGenesis(genesis)).to.throw(
                /not the deployed/
            )
        })

        it('refuses duplicate indexes and duplicate key hashes', () => {
            const sameIndex = genesisAt([0, 1, 2])
            sameIndex.members[2].index = 0
            expect(() => RosterMirror.fromGenesis(sameIndex)).to.throw(
                /duplicate member index 0/
            )
            const sameKey = genesisAt([0, 1, 2])
            sameKey.members[2].keyHash = KEY_HASHES[0]
            expect(() => RosterMirror.fromGenesis(sameKey)).to.throw(
                /duplicate key hash/
            )
        })

        it('refuses malformed member fields', () => {
            const bad = (change: (g: GenesisRoster) => void): (() => void) => {
                const genesis = genesisAt([0, 1, 2])
                change(genesis)
                return () => RosterMirror.fromGenesis(genesis)
            }
            expect(bad((g) => (g.members[0].index = 65536))).to.throw(/index/)
            expect(bad((g) => (g.members[0].index = -1))).to.throw(/index/)
            expect(bad((g) => (g.members[0].keyHash = 'zz'))).to.throw(
                /keyHash/
            )
            expect(bad((g) => (g.members[0].payout = 'ab'))).to.throw(/payout/)
            expect(bad((g) => (g.members[0].lastRound = -1))).to.throw(
                /lastRound/
            )
            expect(bad((g) => (g.members[0].lastRound = 1.5))).to.throw(
                /lastRound/
            )
        })
    })

    describe('nextFreeIndex', () => {
        it('skips occupied leaves', () => {
            expect(
                RosterMirror.fromGenesis(genesisAt([0, 1, 2])).nextFreeIndex()
            ).to.equal(3)
            expect(
                RosterMirror.fromGenesis(genesisAt([0, 1, 3])).nextFreeIndex()
            ).to.equal(2)
            expect(
                RosterMirror.fromGenesis(genesisAt([1, 2, 3])).nextFreeIndex()
            ).to.equal(0)
        })
    })

    describe('history replay of a real tree machine', () => {
        let cycles: DecodedCycle[]
        let built: TreeChain
        before(async () => {
            await loadMachineArtifact()
            built = await treeChain()
            cycles = await walkHistory(built.chain, built.lastTxid)
        })

        it('decodes the tree fields of each cycle', () => {
            expect(cycles.map((c) => c.ambiguous)).to.deep.equal([
                false,
                false,
                false,
            ])
            expect(cycles.map((c) => c.treeOp)).to.deep.equal([
                'admit',
                'member',
                'remove',
            ])
            expect(cycles.map((c) => c.rosterSeq)).to.deep.equal([1n, 1n, 2n])
            expect(cycles[0].tree?.leafPre).to.equal('')
            expect(cycles[0].tree?.leafIndex).to.equal(BigInt(built.admitIndex))
            expect(cycles[1].tree?.leafIndex).to.equal(BigInt(PAID_INDEX))
            expect(cycles[2].rosterRoot).to.equal(built.final.rosterRoot)
            // the leaf each cycle wrote, with the round the program used
            expect(
                decodeLeafPre(cycles[0].leafAfter as string)
            ).to.deep.include({
                keyHashHex: keyHash(newcomer.pub),
                payoutHex: NEWCOMER_PAYOUT,
                lastRound: built.cycleTimes[0],
            })
            expect(
                decodeLeafPre(cycles[1].leafAfter as string)
            ).to.deep.include({
                keyHashHex: KEY_HASHES[PAID_INDEX],
                lastRound: built.cycleTimes[1],
            })
            expect(cycles[2].leafAfter).to.equal('')
        })

        it('replays admit, payment and remove to the final root and seq', () => {
            const mirror = replayRoster(built.genesis, cycles)
            expect(mirror.root()).to.equal(built.final.rosterRoot)
            expect(mirror.seq()).to.equal(built.final.rosterSeq)
            expect(mirror.seq()).to.equal(2n)
            expect(mirror.hasKey(keyHash(newcomer.pub))).to.equal(false)
            expect(mirror.nextFreeIndex()).to.equal(built.admitIndex)
        })

        it('gives proofs that verify against the final root', () => {
            const mirror = replayRoster(built.genesis, cycles)
            for (const index of [0, PAID_INDEX, 2, built.admitIndex, 40000]) {
                const proof = mirror.proofFor(index)
                expect(
                    SparseMerkleTree.verify(
                        built.final.rosterRoot,
                        proof.leafPre,
                        proof.proof,
                        proof.leafIndex
                    )
                ).to.equal(true)
            }
            // the paid member carries its new lastRound
            expect(
                decodeLeafPre(mirror.proofFor(PAID_INDEX).leafPre).lastRound
            ).to.equal(built.cycleTimes[1])
        })

        it('tracks an admission and a payment step by step', () => {
            const mirror = RosterMirror.fromGenesis(built.genesis)
            mirror.apply(cycles[0])
            expect(mirror.seq()).to.equal(1n)
            expect(mirror.indexOf(keyHash(newcomer.pub))).to.equal(
                built.admitIndex
            )
            expect(mirror.root()).to.equal(cycles[0].rosterRoot)
            mirror.apply(cycles[1])
            expect(mirror.seq()).to.equal(1n)
            expect(mirror.root()).to.equal(cycles[1].rosterRoot)
        })

        it('throws on a root mismatch and leaves the mirror unchanged', () => {
            const mirror = RosterMirror.fromGenesis(built.genesis)
            const before = mirror.root()
            const tampered = { ...cycles[0], rosterRoot: 'ee'.repeat(32) }
            expect(() => mirror.apply(tampered)).to.throw(/roster mirror gives/)
            expect(mirror.root()).to.equal(before)
            expect(mirror.seq()).to.equal(0n)
            expect(mirror.hasKey(keyHash(newcomer.pub))).to.equal(false)
            mirror.apply(cycles[0]) // the honest cycle still applies
            expect(mirror.root()).to.equal(cycles[0].rosterRoot)
        })

        it('throws when a cycle is skipped or ambiguous', () => {
            const skipped = RosterMirror.fromGenesis(built.genesis)
            expect(() => skipped.apply(cycles[2])).to.throw(/empty leaf/)
            const mirror = RosterMirror.fromGenesis(built.genesis)
            expect(() =>
                mirror.apply({ ...cycles[0], ambiguous: true })
            ).to.throw(/ambiguous/)
        })

        it('throws when the genesis does not match the chain', () => {
            const wrong = genesisAt([0, 1, 3], built.genesis.instanceId)
            expect(() => replayRoster(wrong, cycles)).to.throw()
        })
    })
})
