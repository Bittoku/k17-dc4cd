/**
 * Tests for `k17forth inspect` on tree-mode machines (`src/cli/inspect.ts`).
 *
 * A tree machine is built on the in-memory chain through the real commands:
 * deploy with a genesis roster, admit a member, two paid readings, remove the
 * member. `inspect` must print the roster, the readings, the admissions and
 * removals and a verified log hash; a machine whose log hash was changed must
 * print "mismatch" and exit non-zero. No test uses the network.
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv, toByteString } from 'scrypt-ts'
import {
    K17Machine,
    keyHash,
    newAttester,
    payoutOf,
    pubKeyBytes,
    signMemberReading,
} from 'k17-vm'
import { GatewayConfig, loadConfig, saveAttesterKey } from '../src/chain/config'
import { decodeInstance } from '../src/chain/decode'
import { TxSource, parseOutpoint } from '../src/chain/history'
import { Keeper } from '../src/chain/keeper'
import { loadRoster } from '../src/chain/loadRoster'
import { GenesisRoster } from '../src/chain/roster'
import { SponsorDeps, admitCommand, removeCommand } from '../src/cli/admit'
import { deployCommand } from '../src/cli/deploy'
import { inspectCommand } from '../src/cli/inspect'
import {
    readingTag,
    treeConsortiumSource,
} from '../src/programs/treeConsortium'
import {
    MemoryChain,
    PAYOUT_ADDRESS,
    WALLET_KEY,
    keeperOptions,
    sink,
} from './utils/consortiumChain'

const T0 = 1_760_000_000
const START = T0 + 1000
const PERIOD = 1000
const ROUNDS = 3

const sponsorKey = newAttester(Buffer.alloc(32, 80))
const alice = newAttester(Buffer.alloc(32, 81))
const bob = newAttester(Buffer.alloc(32, 82))

const ALICE_INDEX = 3
const ALICE_PAYOUT = 'a1'.repeat(20)
const BOB_PAYOUT = payoutOf(PAYOUT_ADDRESS)
const GENESIS_MEMBERS: GenesisRoster['members'] = [
    {
        index: ALICE_INDEX,
        keyHash: keyHash(alice.pub),
        payout: ALICE_PAYOUT,
        lastRound: 0,
    },
]

describe('inspect on a tree machine', function () {
    this.timeout(900_000)
    const dir = mkdtempSync(join(tmpdir(), 'k17inspect-'))
    let counter = 0
    let clockBase = T0 + 60
    let chain: MemoryChain
    let config: string
    let cfg: GatewayConfig
    let tipOutpoint: string

    /** Write a private file and return its path. */
    function file(text: string): string {
        const path = join(dir, `f-${counter++}`)
        writeFileSync(path, text)
        chmodSync(path, 0o600)
        return path
    }

    /** Sponsor command dependencies: a clock that follows the chain. */
    function parts(): SponsorDeps {
        return {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
            keeper: keeperOptions(chain),
            now: () => clockBase + 60 * chain.cycleBroadcasts,
        }
    }

    /** Output: the outpoint at the tip of the machine, found by following the spends. */
    async function findTip(): Promise<string> {
        let op = parseOutpoint(cfg.machineOutpoint as string)
        for (;;) {
            const next = await chain.spentBy(op)
            if (!next) break
            op = { txid: next, vout: 0 }
        }
        return `${op.txid}:${op.vout}`
    }

    /** A paid reading of a member, relayed through a keeper. */
    async function pay(
        member: typeof alice,
        index: number,
        round: number,
        reading: bigint
    ): Promise<void> {
        const deps = parts()
        const keeper = new Keeper(
            cfg,
            chain,
            deps.signer as TestWallet,
            deps.keeper
        )
        const tip = await keeper.sync()
        const { mirror, machine } = await loadRoster(cfg, {
            provider: chain,
            outpoint: tip,
        })
        const paid = await keeper.tick((deps.now as () => number)(), {
            witness: [0n, reading],
            sig: signMemberReading(
                member,
                machine.instanceId,
                readingTag(round),
                reading
            ),
            attestKey: member.pub,
            tree: mirror.proofFor(index),
        })
        expect(paid.error).to.equal(undefined)
        expect(paid.txid).to.be.a('string')
    }

    /** Run inspect; output: exit code and the printed text. */
    async function inspect(args: string[], source: TxSource = chain) {
        const { lines, io } = sink()
        const code = await inspectCommand(args, io, source)
        return { code, text: lines.join('\n') }
    }

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
        chain = new MemoryChain()
        const source = file(
            treeConsortiumSource({
                start: START,
                period: PERIOD,
                rounds: ROUNDS,
                bountyPerReading: 150,
                range: { min: 4000, max: 6000 },
            })
        )
        config = file(
            `[network]\nname = "testnet"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n`
        )
        const members = file(JSON.stringify({ members: GENESIS_MEMBERS }))
        const { lines, io } = sink()
        const code = await deployCommand(
            [
                source,
                '--config',
                config,
                '--deposit',
                '100000',
                '--reward-min',
                '100',
                '--slope',
                '1',
                '--reward-max',
                '500',
                '--tree',
                members,
                '--sponsor',
                keyHash(sponsorKey.pub),
            ],
            io,
            {
                signer: new TestWallet(WALLET_KEY, chain),
                chainInfo: async () => ({ mediantime: T0 + 1, blocks: 1 }),
                now: () => T0,
            }
        )
        expect(lines.join('\n'), 'deploy output').to.not.contain('ERR')
        expect(code).to.equal(0)
        saveAttesterKey(config, sponsorKey.priv.p, sponsorKey.priv.q)
        cfg = loadConfig(config)

        // admit Bob (before the start: lastRound 0), two readings, remove Bob
        const { lines: adminLines, io: adminIo } = sink()
        expect(
            await admitCommand(
                [
                    config,
                    '--member-key',
                    file(pubKeyBytes(bob.pub) + '\n'),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                ],
                adminIo,
                parts()
            ),
            adminLines.join('\n')
        ).to.equal(0)
        cfg = loadConfig(config)
        clockBase = START
        await pay(alice, ALICE_INDEX, 1, 5000n)
        clockBase = START + PERIOD
        await pay(bob, 0, 2, 4242n)
        const { lines: removeLines, io: removeIo } = sink()
        expect(
            await removeCommand(
                [config, '--member-key', file(pubKeyBytes(bob.pub) + '\n')],
                removeIo,
                parts()
            ),
            removeLines.join('\n')
        ).to.equal(0)
        cfg = loadConfig(config)
        tipOutpoint = await findTip()
    })

    it('--history prints the roster, readings, admin events and a verified log hash', async () => {
        const result = await inspect([
            tipOutpoint,
            '--history',
            '--config',
            config,
        ])
        expect(result.code, result.text).to.equal(0)
        const text = result.text
        // roster after the removal: only Alice, paid in round 1
        expect(text).to.contain('roster (1 member):')
        expect(text).to.contain(
            `[${ALICE_INDEX}] key=${keyHash(alice.pub).slice(
                0,
                12
            )}.. payout=${ALICE_PAYOUT} lastRound 1`
        )
        expect(text).to.contain('round 1 member 3 reading 5000 paid 150 sats')
        expect(text).to.contain('round 2 member 0 reading 4242 paid 150 sats')
        expect(text).to.match(
            new RegExp(
                `seq 1 admit leaf 0 key=${keyHash(bob.pub).slice(
                    0,
                    12
                )}\\.\\. payout=${BOB_PAYOUT}`
            )
        )
        expect(text).to.contain('seq 2 remove leaf 0')
        expect(text).to.contain('logHash: verified')
        expect(text).to.contain('tree: 1 members')
    })

    it('--history without a genesis still checks the log hash and says the roster is not shown', async () => {
        const result = await inspect([tipOutpoint, '--history'])
        expect(result.code, result.text).to.equal(0)
        expect(result.text).to.contain('roster: not shown')
        expect(result.text).to.contain('logHash: verified')
    })

    it('--genesis works in place of --config', async () => {
        const result = await inspect([
            tipOutpoint,
            '--history',
            '--genesis',
            cfg.genesisInscription as string,
        ])
        expect(result.code, result.text).to.equal(0)
        expect(result.text).to.contain('roster (1 member):')
    })

    it('a changed log hash prints mismatch and exits 1', async () => {
        const tipTxid = parseOutpoint(tipOutpoint).txid
        const forged: TxSource = {
            getTransaction: async (txid) => {
                const tx = await chain.getTransaction(txid)
                if (txid !== tipTxid) return tx
                const copy = new bsv.Transaction(tx.toString())
                const machine = decodeInstance(copy.outputs[0].script.toHex())
                    .instance as K17Machine
                machine.logHash = toByteString('11'.repeat(32))
                copy.outputs[0].setScript(machine.lockingScript)
                return copy
            },
        }
        const result = await inspect(
            [tipTxid + ':0', '--history', '--config', config],
            forged
        )
        expect(result.code, result.text).to.equal(1)
        expect(result.text).to.contain('logHash: mismatch')
    })

    it('plain inspect prints root, seq, sponsor and member count', async () => {
        const result = await inspect([tipOutpoint, '--config', config])
        expect(result.code, result.text).to.equal(0)
        const tip = decodeInstance(
            chain.txs
                .get(parseOutpoint(tipOutpoint).txid)!
                .outputs[0].script.toHex()
        ).instance as K17Machine
        expect(result.text).to.contain(
            `tree: roster root ${tip.rosterRoot} seq 2`
        )
        expect(result.text).to.contain(
            `tree: sponsor ${keyHash(sponsorKey.pub).slice(0, 12)}..`
        )
        expect(result.text).to.contain('tree: 1 members')
        expect(result.text).to.not.contain('readings (')
    })

    it('plain inspect without a genesis shows the state and no member count', async () => {
        const result = await inspect([tipOutpoint])
        expect(result.code, result.text).to.equal(0)
        expect(result.text).to.contain('tree: roster root')
        expect(result.text).to.contain('tree: members not shown')
    })

    it('--json carries the tree report', async () => {
        const result = await inspect([
            tipOutpoint,
            '--history',
            '--json',
            '--config',
            config,
        ])
        expect(result.code).to.equal(0)
        const parsed = JSON.parse(result.text)
        expect(parsed.tree.readings).to.have.length(2)
        expect(parsed.tree.logHashCheck.status).to.equal('verified')
    })
})
