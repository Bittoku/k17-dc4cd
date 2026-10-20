/**
 * Tests for `k17forth admit` and `k17forth remove` (`src/cli/admit.ts`) and
 * the shared roster loader (`src/chain/loadRoster.ts`): the sponsor of a
 * tree-mode machine admits and removes members on the in-memory chain. Every
 * accepted cycle is checked against the roster mirror's prediction, and the
 * chain's script interpreter verifies the machine spends. The refusals check
 * that nothing is signed or broadcast. No test uses the network.
 */
import { expect } from 'chai'
import {
    chmodSync,
    copyFileSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv } from 'scrypt-ts'
import {
    K17Machine,
    keyHash,
    newAttester,
    payoutOf,
    pubKeyBytes,
    signMemberReading,
    signRemoval,
} from 'k17-vm'
import { GatewayConfig, loadConfig, saveAttesterKey } from '../src/chain/config'
import { decodeInstance } from '../src/chain/decode'
import { parseOutpoint } from '../src/chain/history'
import { inscriptionScript, parseInscription } from '../src/chain/inscription'
import { Keeper } from '../src/chain/keeper'
import { loadRoster } from '../src/chain/loadRoster'
import { GenesisRoster, RosterMirror } from '../src/chain/roster'
import { SponsorDeps, admitCommand, removeCommand } from '../src/cli/admit'
import { deployCommand } from '../src/cli/deploy'
import {
    REMOVE_TAG,
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
const END = START + ROUNDS * PERIOD

// Rabin keys from fixed seeds; made once (seconds each).
const sponsorKey = newAttester(Buffer.alloc(32, 70))
const alice = newAttester(Buffer.alloc(32, 71))
const bob = newAttester(Buffer.alloc(32, 72))
const carol = newAttester(Buffer.alloc(32, 73))
const stranger = newAttester(Buffer.alloc(32, 74))

const ALICE_INDEX = 3
const ALICE_PAYOUT = 'a1'.repeat(20)
const BOB_PAYOUT = payoutOf(PAYOUT_ADDRESS)

/** Genesis members: Alice at leaf 3, not yet paid. */
const GENESIS_MEMBERS: GenesisRoster['members'] = [
    {
        index: ALICE_INDEX,
        keyHash: keyHash(alice.pub),
        payout: ALICE_PAYOUT,
        lastRound: 0,
    },
]

/** A chain that runs one hook before the next broadcast that spends the machine. */
class HookChain extends MemoryChain {
    before?: () => Promise<void>

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        if (this.before) {
            const tx = new bsv.Transaction(rawTxHex)
            if (tx.inputs.some((input) => this.spendsMachine(input))) {
                const hook = this.before
                this.before = undefined
                await hook()
            }
        }
        return super.sendRawTransaction(rawTxHex)
    }
}

describe('sponsor admit and remove', function () {
    this.timeout(900_000)
    const dir = mkdtempSync(join(tmpdir(), 'k17admit-'))
    const source = join(dir, 'tree.fs')
    let counter = 0
    /** Clock base: the wall clock is this plus 60 s per machine spend. */
    let clockBase = T0 + 60

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
        writeFileSync(
            source,
            treeConsortiumSource({
                start: START,
                period: PERIOD,
                rounds: ROUNDS,
                bountyPerReading: 150,
                range: { min: 4000, max: 6000 },
            })
        )
    })

    beforeEach(() => {
        clockBase = T0 + 60
    })

    /** Write a file and return its path. */
    function file(text: string, mode = 0o600): string {
        const path = join(dir, `f-${counter++}`)
        writeFileSync(path, text)
        chmodSync(path, mode)
        return path
    }

    /**
     * Deploy a tree machine on a fresh chain and give its config the
     * sponsor key. Output: the chain, the sponsor config path and the config.
     */
    async function deployTree(existing?: HookChain): Promise<{
        chain: HookChain
        config: string
        cfg: GatewayConfig
    }> {
        const chain = existing ?? new HookChain()
        const config = file(
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
        return { chain, config, cfg: loadConfig(config) }
    }

    /** Test parts: wallet, tip far ahead of the clock, a clock that follows the chain. */
    function parts(chain: MemoryChain): SponsorDeps {
        return {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
            keeper: keeperOptions(chain),
            now: () => clockBase + 60 * chain.cycleBroadcasts,
        }
    }

    /** The outpoint at the tip of the machine, found by following the spends. */
    async function tipOutpoint(
        chain: MemoryChain,
        cfg: GatewayConfig
    ): Promise<string> {
        let op = parseOutpoint(cfg.machineOutpoint as string)
        for (;;) {
            const next = await chain.spentBy(op)
            if (!next) break
            op = { txid: next, vout: 0 }
        }
        return `${op.txid}:${op.vout}`
    }

    /** The machine at the tip of the chain. */
    async function tipOf(chain: MemoryChain, cfg: GatewayConfig) {
        const { txid } = parseOutpoint(await tipOutpoint(chain, cfg))
        return decodeInstance(chain.txs.get(txid)!.outputs[0].script.toHex())
            .instance as K17Machine
    }

    /** Root of a roster built from a member list. */
    const rootOf = (members: GenesisRoster['members']) =>
        RosterMirror.fromMembers(members).root()

    /** Public key file in the hex form of `gateway init`. */
    const hexKeyFile = (pub: bigint) => file(pubKeyBytes(pub) + '\n')

    /** Public key file in decimal. */
    const decimalKeyFile = (pub: bigint) => file(pub.toString() + '\n')

    /** Member entry for the mirror's prediction. */
    const memberOf = (
        pub: bigint,
        index: number,
        payout: string,
        lastRound = 0
    ) => ({ index, keyHash: keyHash(pub), payout, lastRound })

    /** Run a command; output: exit code and lines. */
    async function run(
        command: typeof admitCommand,
        args: string[],
        chain: MemoryChain
    ) {
        const { lines, io } = sink()
        const code = await command(args, io, parts(chain))
        return { code, text: lines.join('\n') }
    }

    /** A paid reading by Alice, relayed through a keeper (the rival of a stale-mirror test). */
    async function payAlice(
        chain: MemoryChain,
        cfg: GatewayConfig,
        round: number,
        reading: bigint
    ) {
        const deps = parts(chain)
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
                alice,
                machine.instanceId,
                readingTag(round),
                reading
            ),
            attestKey: alice.pub,
            tree: mirror.proofFor(ALICE_INDEX),
        })
        expect(paid.error).to.equal(undefined)
        expect(paid.txid).to.be.a('string')
    }

    it('admits then removes, and the machine root and seq are what the mirror predicts', async () => {
        const { chain, config, cfg } = await deployTree()
        const genesisRoot = rootOf(GENESIS_MEMBERS)
        expect((await tipOf(chain, cfg)).rosterRoot).to.equal(genesisRoot)

        const admitted = await run(
            admitCommand,
            [
                config,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(admitted.code, admitted.text).to.equal(0)
        // the lowest free leaf is 0 (Alice holds 3)
        const withBob = [...GENESIS_MEMBERS, memberOf(bob.pub, 0, BOB_PAYOUT)]
        let tip = await tipOf(chain, cfg)
        expect(tip.rosterRoot).to.equal(rootOf(withBob))
        expect(tip.rosterSeq).to.equal(1n)
        expect(admitted.text).to.contain('admitted leaf 0')

        // a second admission with a decimal key file at a chosen leaf
        const second = await run(
            admitCommand,
            [
                config,
                '--member-key',
                decimalKeyFile(carol.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
                '--index',
                '9',
            ],
            chain
        )
        expect(second.code, second.text).to.equal(0)
        const withCarol = [...withBob, memberOf(carol.pub, 9, BOB_PAYOUT)]
        tip = await tipOf(chain, cfg)
        expect(tip.rosterRoot).to.equal(rootOf(withCarol))
        expect(tip.rosterSeq).to.equal(2n)

        // remove Bob by key, then Carol by leaf index
        const removedBob = await run(
            removeCommand,
            [config, '--member-key', hexKeyFile(bob.pub)],
            chain
        )
        expect(removedBob.code, removedBob.text).to.equal(0)
        tip = await tipOf(chain, cfg)
        expect(tip.rosterRoot).to.equal(
            rootOf([...GENESIS_MEMBERS, memberOf(carol.pub, 9, BOB_PAYOUT)])
        )
        expect(tip.rosterSeq).to.equal(3n)
        const removedCarol = await run(
            removeCommand,
            [config, '--index', '9'],
            chain
        )
        expect(removedCarol.code, removedCarol.text).to.equal(0)
        tip = await tipOf(chain, cfg)
        expect(tip.rosterRoot).to.equal(genesisRoot)
        expect(tip.rosterSeq).to.equal(4n)

        // the loader rebuilds the same mirror from the whole history
        const { mirror } = await loadRoster(cfg, {
            provider: chain,
            outpoint: await tipOutpoint(chain, cfg),
        })
        expect(mirror.root()).to.equal(genesisRoot)
        expect(mirror.seq()).to.equal(4n)
        // the interpreter accepted all four machine spends
        expect(chain.verifyMachineSpends()).to.equal(4)
        const text = [admitted.text, second.text, removedBob.text].join('\n')
        for (const secret of [
            WALLET_KEY.toWIF(),
            sponsorKey.priv.p.toString(),
            sponsorKey.priv.q.toString(),
        ])
            expect(text).to.not.contain(secret)
    })

    it('refuses a duplicate key, an occupied leaf and an unknown member with no broadcast', async () => {
        const { chain, config, cfg } = await deployTree()
        const before = chain.txs.size
        const attempts: [typeof admitCommand, string[], number, RegExp][] = [
            [
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(alice.pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                ],
                1,
                /in the roster already \(leaf 3\)/,
            ],
            [
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(bob.pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                    '--index',
                    String(ALICE_INDEX),
                ],
                1,
                /leaf 3 is occupied/,
            ],
            [
                removeCommand,
                [config, '--member-key', hexKeyFile(bob.pub)],
                1,
                /not in the roster/,
            ],
            [
                removeCommand,
                [config, '--index', '5'],
                1,
                /leaf 5 holds no member/,
            ],
            // usage errors: exit 2
            [
                removeCommand,
                [config, '--index', '5', '--member-key', hexKeyFile(bob.pub)],
                2,
                /usage/,
            ],
            [
                admitCommand,
                [config, '--member-key', hexKeyFile(bob.pub)],
                2,
                /usage/,
            ],
            [
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(bob.pub),
                    '--payout',
                    bsv.PrivateKey.fromRandom('livenet').toAddress().toString(),
                ],
                2,
                /not a testnet address/,
            ],
            [
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(bob.pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                    '--index',
                    '70000',
                ],
                2,
                /--index/,
            ],
        ]
        for (const [command, args, want, pattern] of attempts) {
            const result = await run(command, args, chain)
            expect(result.code, result.text).to.equal(want)
            expect(result.text).to.match(pattern)
        }
        expect(chain.cycleBroadcasts).to.equal(0)
        expect(chain.txs.size).to.equal(before)
        expect((await tipOf(chain, cfg)).rosterSeq).to.equal(0n)
    })

    it('refuses to start with a key that is not the sponsor', async () => {
        const { chain, config, cfg } = await deployTree()
        const wrong = join(dir, `wrong-${counter++}.toml`)
        copyFileSync(config, wrong)
        chmodSync(wrong, 0o600)
        saveAttesterKey(wrong, stranger.priv.p, stranger.priv.q)
        const result = await run(
            admitCommand,
            [
                wrong,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(result.code).to.equal(1)
        expect(result.text).to.contain('not the sponsor')
        expect(result.text).to.not.contain(stranger.priv.p.toString())
        expect(chain.cycleBroadcasts).to.equal(0)
        expect((await tipOf(chain, cfg)).rosterSeq).to.equal(0n)
    })

    it('says to wait for the next block when MIN_STEP is not met', async () => {
        const { chain, config } = await deployTree()
        clockBase = T0 + 30 // less than lastTime + 60
        const result = await run(
            admitCommand,
            [
                config,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(result.code).to.equal(1)
        expect(result.text).to.contain('after the next block')
        expect(chain.cycleBroadcasts).to.equal(0)
    })

    it('refuses after the program end, with no broadcast', async () => {
        const { chain, config } = await deployTree()
        clockBase = END + 60
        const result = await run(
            admitCommand,
            [
                config,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(result.code).to.equal(1)
        expect(result.text).to.contain('has ended')
        expect(chain.cycleBroadcasts).to.equal(0)
    })

    it('reloads and re-signs at the new seq when an admission lands first', async () => {
        const { chain, config, cfg } = await deployTree()
        // after the first plan and before the broadcast, Carol is admitted
        chain.before = async () => {
            const rival = await run(
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(carol.pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                    '--index',
                    '9',
                ],
                chain
            )
            expect(rival.code, rival.text).to.equal(0)
        }
        const result = await run(
            admitCommand,
            [
                config,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(result.code, result.text).to.equal(0)
        expect(result.text).to.contain('loading it again')
        const tip = await tipOf(chain, cfg)
        expect(tip.rosterSeq).to.equal(2n)
        expect(tip.rosterRoot).to.equal(
            rootOf([
                ...GENESIS_MEMBERS,
                memberOf(carol.pub, 9, BOB_PAYOUT),
                memberOf(bob.pub, 0, BOB_PAYOUT),
            ])
        )
    })

    it('a second stale failure ends the command with the reason', async () => {
        const { chain, config, cfg } = await deployTree()
        // two rival admissions: one before each of the two tries
        const rival = (pub: bigint, index: string) => async () => {
            const done = await run(
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                    '--index',
                    index,
                ],
                chain
            )
            expect(done.code, done.text).to.equal(0)
        }
        chain.before = async () => {
            // the next broadcast (our retry) is also overtaken
            await rival(carol.pub, '9')()
            chain.before = rival(stranger.pub, '11')
        }
        const result = await run(
            admitCommand,
            [
                config,
                '--member-key',
                hexKeyFile(bob.pub),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(result.code).to.equal(1)
        expect(result.text).to.match(/ERR admit: /)
        expect((await tipOf(chain, cfg)).rosterSeq).to.equal(2n)
        // only the two rival cycles reached the chain; none of ours did
        const machineSpends = [...chain.txs.values()].filter(
            (tx) => tx.inputs[0] && chain.spendsMachine(tx.inputs[0])
        )
        expect(machineSpends.length).to.equal(2)
    })

    it('a payment landing first changes the proof: the removal is signed again and goes through', async () => {
        const { chain, config, cfg } = await deployTree()
        clockBase = START // round 1
        chain.before = () => payAlice(chain, cfg, 1, 5000n)
        const result = await run(
            removeCommand,
            [config, '--member-key', hexKeyFile(alice.pub)],
            chain
        )
        expect(result.code, result.text).to.equal(0)
        const tip = await tipOf(chain, cfg)
        expect(tip.rosterSeq).to.equal(1n)
        expect(tip.rosterRoot).to.equal(rootOf([]))
        expect(chain.verifyMachineSpends()).to.equal(2)
    })

    it('a removal signed before the member is paid still verifies after the payment (v3.1 binding)', async () => {
        const { chain, cfg } = await deployTree()
        clockBase = START
        const deps = parts(chain)
        const keeper = new Keeper(
            cfg,
            chain,
            deps.signer as TestWallet,
            deps.keeper
        )
        const first = await loadRoster(cfg, { provider: chain })
        // signed now, over the member's key hash and payout, at seq 0
        const signature = signRemoval(
            sponsorKey,
            first.machine.instanceId,
            BigInt(REMOVE_TAG),
            first.mirror.seq(),
            BigInt(ALICE_INDEX),
            keyHash(alice.pub),
            ALICE_PAYOUT
        )
        // Alice is paid: her leaf (lastRound) changes, the seq does not
        await payAlice(chain, cfg, 1, 5000n)
        const after = await loadRoster(cfg, {
            provider: chain,
            outpoint: await keeper.sync(),
        })
        expect(after.mirror.seq()).to.equal(0n)
        expect(after.mirror.proofFor(ALICE_INDEX).leafPre).to.not.equal(
            first.mirror.proofFor(ALICE_INDEX).leafPre
        )
        const removed = await keeper.tick((deps.now as () => number)(), {
            witness: [2n],
            sig: signature,
            attestKey: sponsorKey.pub,
            tree: after.mirror.proofFor(ALICE_INDEX),
        })
        expect(removed.error).to.equal(undefined)
        expect(removed.txid).to.be.a('string')
        expect(chain.verifyMachineSpends()).to.equal(2)
        const tip = await tipOf(chain, cfg)
        expect(tip.rosterRoot).to.equal(rootOf([]))
        expect(tip.rosterSeq).to.equal(1n)
    })

    it('loadRoster refuses a config without the genesis inscription and a foreign genesis', async () => {
        const { chain, cfg } = await deployTree()
        await loadRoster(cfg, { provider: chain })
        let message = ''
        try {
            await loadRoster(
                { ...cfg, genesisInscription: undefined },
                { provider: chain }
            )
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('genesis_inscription')
        // an output that is not an inscription
        message = ''
        try {
            await loadRoster(
                { ...cfg, genesisInscription: cfg.genesisOutpoint },
                { provider: chain }
            )
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('no inscription')
    })

    it('loadRoster refuses an inscription of another machine and one with another root', async () => {
        const first = await deployTree()
        const second = await deployTree(first.chain)
        let message = ''
        try {
            await loadRoster(
                {
                    ...first.cfg,
                    genesisInscription: second.cfg.genesisInscription,
                },
                { provider: first.chain }
            )
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('another machine')
        // same instance id, a root the machine was not deployed with
        const { txid, vout } = parseOutpoint(
            first.cfg.genesisInscription as string
        )
        const genesis = JSON.parse(
            parseInscription(
                first.chain.txs.get(txid)!.outputs[vout].script
            )!.body.toString('utf8')
        ) as GenesisRoster
        genesis.rosterRoot = rootOf([])
        const forged = new bsv.Transaction().addOutput(
            new bsv.Transaction.Output({
                satoshis: 1,
                script: inscriptionScript(
                    WALLET_KEY.toAddress(),
                    'application/json',
                    Buffer.from(JSON.stringify(genesis))
                ),
            })
        )
        first.chain.add(forged)
        message = ''
        try {
            await loadRoster(
                { ...first.cfg, genesisInscription: `${forged.id}:0` },
                { provider: first.chain }
            )
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('root differs')
    })

    it('needs the mainnet switch and a plausible decimal key', async () => {
        const { chain, config } = await deployTree()
        const mainnet = join(dir, `main-${counter++}.toml`)
        copyFileSync(config, mainnet)
        chmodSync(mainnet, 0o600)
        writeFileSync(
            mainnet,
            readFileSync(mainnet, 'utf8').replace('"testnet"', '"mainnet"')
        )
        const args = (extra: string[]) => [
            mainnet,
            '--member-key',
            hexKeyFile(bob.pub),
            '--payout',
            bsv.PrivateKey.fromRandom('livenet').toAddress().toString(),
            ...extra,
        ]
        const refused = await run(admitCommand, args([]), chain)
        expect(refused.code).to.equal(2)
        expect(refused.text).to.contain('--i-know-this-spends-real-money')
        // with the switch the command goes on (and fails later: no such machine on mainnet is tested here)
        const short = await run(
            admitCommand,
            [
                config,
                '--member-key',
                file('12345'),
                '--payout',
                PAYOUT_ADDRESS.toString(),
            ],
            chain
        )
        expect(short.code).to.equal(2)
        expect(short.text).to.contain('at least 2048 bits')
        expect(chain.cycleBroadcasts).to.equal(0)
    })

    it('saves tip_outpoint and the next run starts from it', async () => {
        const { chain, config, cfg } = await deployTree()
        const payout = PAYOUT_ADDRESS.toString()
        for (const [pub, index] of [
            [bob.pub, '0'],
            [carol.pub, '9'],
        ] as [bigint, string][]) {
            const done = await run(
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(pub),
                    '--payout',
                    payout,
                    '--index',
                    index,
                ],
                chain
            )
            expect(done.code, done.text).to.equal(0)
        }
        const saved = loadConfig(config)
        expect(saved.tipOutpoint).to.equal(await tipOutpoint(chain, cfg))
        expect(saved.machineOutpoint).to.equal(cfg.machineOutpoint)
        expect(statSync(config).mode & 0o777).to.equal(0o600)
        let hops = 0
        const deps = parts(chain)
        deps.keeper = {
            ...deps.keeper,
            spentBy: async (op) => {
                hops++
                return chain.spentBy(op)
            },
        }
        const { lines, io } = sink()
        const code = await removeCommand(
            [config, '--member-key', hexKeyFile(bob.pub)],
            io,
            deps
        )
        expect(code, lines.join('\n')).to.equal(0)
        // from the saved tip: one look at the unspent tip; from the
        // deployment it would be one more per earlier cycle (2)
        expect(hops).to.equal(1)
        expect(loadConfig(config).tipOutpoint).to.equal(
            await tipOutpoint(chain, cfg)
        )
    })

    it('a removal by leaf index is refused when the leaf holds another member on the retry', async () => {
        const { chain, config } = await deployTree()
        const payout = PAYOUT_ADDRESS.toString()
        const admit = (pub: bigint) =>
            run(
                admitCommand,
                [
                    config,
                    '--member-key',
                    hexKeyFile(pub),
                    '--payout',
                    payout,
                    '--index',
                    '9',
                ],
                chain
            )
        expect((await admit(carol.pub)).code).to.equal(0)
        chain.before = async () => {
            const gone = await run(
                removeCommand,
                [config, '--member-key', hexKeyFile(carol.pub)],
                chain
            )
            expect(gone.code, gone.text).to.equal(0)
            expect((await admit(bob.pub)).code).to.equal(0)
        }
        const result = await run(removeCommand, [config, '--index', '9'], chain)
        expect(result.code).to.equal(1)
        expect(result.text).to.contain('another member')
    })
})
