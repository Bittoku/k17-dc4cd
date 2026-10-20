/**
 * Tests for the gateway in tree mode (`[gateway] mode = "tree"`): the member
 * attester (`MemberAttester`), the config checks, and the `Gateway` run on
 * the in-memory chain with a deployed tree machine. The chain's script
 * interpreter verifies every machine spend, so a signature under the wrong
 * round fails the test. No test uses the network.
 *
 * Rabin keys come from fixed seeds and are made once (seconds each).
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv } from 'scrypt-ts'
import {
    K17Machine,
    decodeLeafPre,
    keyHash,
    newAttester,
    payoutOf,
    pubKeyBytes,
    signMemberReading,
} from 'k17-vm'
import { GatewayConfig, loadConfig, saveAttesterKey } from '../src/chain/config'
import { loadRoster } from '../src/chain/loadRoster'
import { GenesisRoster } from '../src/chain/roster'
import { admitCommand, removeCommand } from '../src/cli/admit'
import { deployCommand } from '../src/cli/deploy'
import { gatewayCommand } from '../src/cli/gateway'
import { MemberAttester } from '../src/gateway/attester'
import { Gateway, NOT_DELIVERED, NOT_IN_ROSTER } from '../src/gateway/gateway'
import {
    readingTag,
    roundAt,
    treeConsortiumSource,
} from '../src/programs/treeConsortium'
import {
    ChainTip,
    MemoryChain,
    PAYOUT_ADDRESS,
    T0,
    WALLET_KEY,
    expectNoSecret,
    keeperOptions,
    sink,
} from './utils/consortiumChain'

const START = T0 + 1000
const PERIOD = 1000
const ROUNDS = 3
const OPTS = {
    start: START,
    period: PERIOD,
    rounds: ROUNDS,
    bountyPerReading: 150,
    range: { min: 4000, max: 6000 },
}

// Rabin keys from fixed seeds; made once (seconds each).
const sponsorKey = newAttester(Buffer.alloc(32, 80))
const alice = newAttester(Buffer.alloc(32, 81))
const bob = newAttester(Buffer.alloc(32, 82))
const outsider = newAttester(Buffer.alloc(32, 83))

const ALICE_INDEX = 3
const BOB_INDEX = 5
const ALICE_PAYOUT = 'a1'.repeat(20)
const BOB_PAYOUT = payoutOf(PAYOUT_ADDRESS)

/** Genesis members: Alice at leaf 3 and Bob at leaf 5, neither paid yet. */
const GENESIS_MEMBERS: GenesisRoster['members'] = [
    {
        index: ALICE_INDEX,
        keyHash: keyHash(alice.pub),
        payout: ALICE_PAYOUT,
        lastRound: 0,
    },
    {
        index: BOB_INDEX,
        keyHash: keyHash(bob.pub),
        payout: BOB_PAYOUT,
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

/** A bridge that ends at once; the tests call `handleReading` themselves. */
async function* emptyBridge(): AsyncGenerator<number> {
    // no readings
}

/** A bridge with one reading. */
async function* oneReading(reading: number): AsyncGenerator<number> {
    yield reading
}

describe('gateway: tree mode', function () {
    this.timeout(900_000)
    const dir = mkdtempSync(join(tmpdir(), 'k17gwtree-'))
    const source = join(dir, 'tree.fs')
    let counter = 0
    /** Base of the wall clock; it adds 60 s per machine spend. */
    let clockBase = START + 100

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
        writeFileSync(source, treeConsortiumSource(OPTS))
    })

    beforeEach(() => {
        clockBase = START + 100
    })

    /** Write a file and return its path. */
    function file(text: string, mode = 0o600): string {
        const path = join(dir, `f-${counter++}`)
        writeFileSync(path, text)
        chmodSync(path, mode)
        return path
    }

    /** Deploy a tree machine; output: the chain and the deployer's config path. */
    async function deployTree(): Promise<{ chain: HookChain; config: string }> {
        const chain = new HookChain()
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
        return { chain, config }
    }

    /**
     * A config file for one gateway: the deployment's machine, the key, and
     * a tree-mode `[gateway]` and `[consortium]`.
     */
    function memberConfig(
        deployed: string,
        key: { priv: { p: bigint; q: bigint } },
        gatewayExtra = ''
    ): string {
        const path = file(readFileSync(deployed, 'utf8'))
        saveAttesterKey(path, key.priv.p, key.priv.q)
        writeFileSync(
            path,
            readFileSync(path, 'utf8') +
                `[gateway]\nmode = "tree"\n${gatewayExtra}` +
                `[consortium]\nstart = ${START}\nperiod = ${PERIOD}\nrounds = ${ROUNDS}\n` +
                'range_min = 4000\nrange_max = 6000\n'
        )
        chmodSync(path, 0o600)
        return path
    }

    /** A wall clock that adds 60 s for every machine spend on the chain. */
    const clockOf = (chain: MemoryChain) => () =>
        clockBase + 60 * chain.cycleBroadcasts

    /** A tree gateway on the test chain. */
    function gatewayOf(
        chain: MemoryChain,
        path: string,
        tip?: ChainTip,
        once?: { reading: number }
    ): { gateway: Gateway; lines: string[] } {
        const lines: string[] = []
        const gateway = new Gateway(
            loadConfig(path),
            chain,
            new TestWallet(WALLET_KEY, chain),
            {
                bridge: once ? oneReading(once.reading) : emptyBridge(),
                keeper: keeperOptions(chain, tip),
                now: clockOf(chain),
                intervalMs: 20,
                once: once !== undefined,
                out: (line) => lines.push(line),
                configPath: path,
            }
        )
        return { gateway, lines }
    }

    /** The tip outpoint of the machine, found by following the spends. */
    async function tipOf(chain: MemoryChain, config: string): Promise<string> {
        const cfg = loadConfig(config)
        let txid = (cfg.machineOutpoint as string).split(':')[0]
        for (;;) {
            const next = await chain.spentBy({ txid, vout: 0 })
            if (!next) return `${txid}:0`
            txid = next
        }
    }

    /** The `lastRound` of a leaf at the tip of the chain. */
    async function lastRoundOf(
        chain: MemoryChain,
        config: string,
        index: number
    ): Promise<bigint> {
        const { mirror } = await loadRoster(loadConfig(config), {
            provider: chain,
            outpoint: await tipOf(chain, config),
        })
        return decodeLeafPre(mirror.proofFor(index).leafPre).lastRound
    }

    it('loads a tree config without slots or epoch, and checks the mode and the settings', () => {
        const path = memberConfig(
            file(
                `[network]\nname = "testnet"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n`
            ),
            alice
        )
        const cfg = loadConfig(path)
        expect(cfg.mode).to.equal('tree')
        expect(cfg.tree).to.deep.equal({
            start: START,
            period: PERIOD,
            rounds: ROUNDS,
            rangeMin: 4000,
            rangeMax: 6000,
        })
        expect(cfg.consortium).to.equal(undefined)
        const text = readFileSync(path, 'utf8')
        const bad = (from: string, to: string) => {
            const copy = file(text.replace(from, to))
            return () => loadConfig(copy)
        }
        expect(bad('mode = "tree"', 'mode = "forest"')).to.throw(
            'config: [gateway] mode must be "slots" or "tree"'
        )
        expect(bad(`period = ${PERIOD}`, 'period = 30')).to.throw(
            'config: [consortium] period must be a whole number, 60 or more'
        )
        expect(bad('range_max = 6000\n', '')).to.throw(
            'config: [consortium] range_min and range_max go together'
        )
        // A slot-mode file still needs epoch and slots.
        expect(bad('mode = "tree"', 'mode = "slots"')).to.throw(
            'config: [consortium] epoch is required'
        )
    })

    it('signs under readingTag(roundAt(lockTime)) at a round boundary', () => {
        const cfg: GatewayConfig = {
            network: 'testnet',
            wif: WALLET_KEY.toWIF(),
            rabinP: alice.priv.p.toString(),
            rabinQ: alice.priv.q.toString(),
            signAnyway: false,
            mode: 'tree',
            tree: { start: START, period: PERIOD, rounds: ROUNDS },
        }
        const attester = new MemberAttester(cfg)
        const id = 'c1'.repeat(32)
        // The last second of round 1 and the first second of round 2.
        const last = attester.sign(5000, START + PERIOD - 1, id)
        const first = attester.sign(5000, START + PERIOD, id)
        expect(last.round).to.equal(1)
        expect(first.round).to.equal(2)
        expect(last.round).to.equal(roundAt(OPTS, START + PERIOD - 1))
        expect(first.round).to.equal(roundAt(OPTS, START + PERIOD))
        expect(last.input.sig).to.deep.equal(
            signMemberReading(alice, id, readingTag(1), 5000n)
        )
        expect(first.input.sig).to.deep.equal(
            signMemberReading(alice, id, readingTag(2), 5000n)
        )
        expect(last.input.sig).to.not.deep.equal(first.input.sig)
        expect(last.input.witness).to.deep.equal([0n, 5000n])
        expect(last.input.attestKey).to.equal(alice.pub)
        expect(() => attester.sign(5000, START - 1, id)).to.throw(
            'no round is open'
        )
        expect(() => attester.sign(5000, START + ROUNDS * PERIOD, id)).to.throw(
            'round closed'
        )
    })

    it('two gateways in one round are paid in sequence; the second works on a fresh roster', async () => {
        const { chain, config } = await deployTree()
        const aliceCfg = memberConfig(config, alice)
        const bobCfg = memberConfig(config, bob)
        const a = gatewayOf(chain, aliceCfg)
        const b = gatewayOf(chain, bobCfg)

        const first = await a.gateway.handleReading(5000)
        expect(first).to.contain('delivered 1 earned 150 sats')
        // Bob's keeper still sits at the deployment; handleReading follows
        // the machine, reloads the roster (Alice is paid now) and relays.
        const second = await b.gateway.handleReading(5100)
        expect(second).to.contain('delivered 1 earned 150 sats')
        expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(1n)
        expect(await lastRoundOf(chain, config, BOB_INDEX)).to.equal(1n)
        expect(chain.verifyMachineSpends()).to.be.at.least(2)
        expectNoSecret([...a.lines, first, second])
    })

    it('reloads once when another member is paid while the cycle goes out', async () => {
        const { chain, config } = await deployTree()
        const a = gatewayOf(chain, memberConfig(config, alice))
        const b = gatewayOf(chain, memberConfig(config, bob))
        // Bob loads the roster and plans; Alice's payment lands before Bob's broadcast.
        chain.before = async () => {
            expect(await a.gateway.handleReading(5000)).to.contain(
                'delivered 1'
            )
        }
        const line = await b.gateway.handleReading(5100)
        expect(line).to.contain('loaded it again')
        expect(line).to.contain('delivered 1 earned 150 sats')
        expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(1n)
        expect(await lastRoundOf(chain, config, BOB_INDEX)).to.equal(1n)
        expect(chain.verifyMachineSpends()).to.be.at.least(2)
    })

    it('refuses to start when the key is not in the roster, and sends nothing', async () => {
        const { chain, config } = await deployTree()
        const path = memberConfig(config, outsider)
        const before = chain.cycleBroadcasts
        const { lines, io } = sink()
        const code = await gatewayCommand(['run', '--config', path], io, {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
            keeper: keeperOptions(chain),
            now: clockOf(chain),
            bridge: emptyBridge(),
        })
        expect(code).to.equal(NOT_IN_ROSTER)
        expect(lines.join('\n')).to.contain('this gateway is not in the roster')
        expect(chain.cycleBroadcasts).to.equal(before)
        expectNoSecret(lines)
        // A member starts, and the bridge ends at once.
        const member = sink()
        expect(
            await gatewayCommand(
                ['run', '--config', memberConfig(config, alice)],
                member.io,
                {
                    provider: chain,
                    signer: new TestWallet(WALLET_KEY, chain),
                    keeper: keeperOptions(chain),
                    now: clockOf(chain),
                    bridge: emptyBridge(),
                }
            )
        ).to.equal(0)
    })

    it('a gateway paid in this round waits for the next round, then relays', async () => {
        const { chain, config } = await deployTree()
        const path = memberConfig(config, alice)
        const { gateway } = gatewayOf(chain, path)
        expect(await gateway.handleReading(5000)).to.contain('delivered 1')
        const sent = chain.cycleBroadcasts
        const waiting = await gateway.handleReading(5200)
        expect(waiting).to.contain('waiting for next round')
        expect(chain.cycleBroadcasts).to.equal(sent)
        expect(gateway.pendingReading).to.equal(5200)
        // Still the same round on an idle tick.
        expect(await gateway.tickIdle()).to.contain('waiting for next round')
        expect(chain.cycleBroadcasts).to.equal(sent)
        // Round 2 opens; the kept reading is signed again for round 2.
        clockBase = START + PERIOD + 100
        const next = await gateway.tickIdle()
        expect(next).to.contain('delivered 2 earned 300 sats')
        expect(gateway.pendingReading).to.equal(undefined)
        expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(2n)
        expect(chain.verifyMachineSpends()).to.be.at.least(2)
    })

    it('a removed gateway relays nothing', async () => {
        const { chain, config } = await deployTree()
        const { gateway, lines } = gatewayOf(chain, memberConfig(config, alice))
        // The sponsor removes Alice.
        const sponsorCfg = file(readFileSync(config, 'utf8'))
        saveAttesterKey(sponsorCfg, sponsorKey.priv.p, sponsorKey.priv.q)
        const sponsor = sink()
        expect(
            await removeCommand(
                [sponsorCfg, '--index', String(ALICE_INDEX)],
                sponsor.io,
                {
                    provider: chain,
                    signer: new TestWallet(WALLET_KEY, chain),
                    keeper: keeperOptions(chain),
                    now: clockOf(chain),
                }
            )
        ).to.equal(0)
        const sent = chain.cycleBroadcasts
        const line = await gateway.handleReading(5000)
        expect(line).to.contain('not in the roster any more')
        expect(chain.cycleBroadcasts).to.equal(sent)
        expect(gateway.pendingReading).to.equal(undefined)
        expect(lines.join('\n')).to.not.contain('delivered 1')
        // Bob is still paid after the removal.
        const b = gatewayOf(chain, memberConfig(config, bob))
        expect(await b.gateway.handleReading(5100)).to.contain('delivered 1')
    })

    it('uses the round of the exact lock time at a round boundary', async () => {
        for (const [lockTime, round] of [
            [START + PERIOD - 1, 1],
            [START + PERIOD, 2],
        ] as const) {
            const { chain, config } = await deployTree()
            const path = memberConfig(config, alice)
            // MTP - 1 is the lock time; the wall clock is far past it.
            const tip: ChainTip = { mtp: lockTime + 1 }
            const { gateway } = gatewayOf(chain, path, tip)
            clockBase = lockTime + 5000
            const line = await gateway.handleReading(5000)
            expect(line, `lockTime ${lockTime}`).to.contain('delivered 1')
            const tx = chain.txs.get(gateway.outpoint!.split(':')[0])!
            expect(tx.nLockTime).to.equal(lockTime)
            expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(
                BigInt(round)
            )
            // The interpreter accepts the signature only under the program's round.
            expect(chain.verifyMachineSpends()).to.be.greaterThan(0)
        }
    })

    it('keeps a reading when the tip cannot be read and signs it again for the later round', async () => {
        const { chain, config } = await deployTree()
        const tip: ChainTip = { mtp: T0 + 1_000_000, fail: 'tip down' }
        const { gateway } = gatewayOf(chain, memberConfig(config, alice), tip)
        expect(await gateway.handleReading(5000)).to.contain('kept')
        expect(gateway.pendingReading).to.equal(5000)
        expect(chain.cycleBroadcasts).to.equal(0)
        // The tip comes back after round 1 closed: the cycle is in round 2.
        tip.fail = undefined
        clockBase = START + PERIOD + 100
        expect(await gateway.tickIdle()).to.contain('delivered 1')
        expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(2n)
        expect(chain.verifyMachineSpends()).to.be.greaterThan(0)
    })

    it('writes tip_outpoint after a relay', async () => {
        const { chain, config } = await deployTree()
        const path = memberConfig(config, alice)
        expect(loadConfig(path).tipOutpoint).to.equal(undefined)
        const { gateway } = gatewayOf(chain, path)
        expect(await gateway.handleReading(5000)).to.contain('delivered 1')
        expect(loadConfig(path).tipOutpoint).to.equal(gateway.outpoint)
        expect(loadConfig(path).tipOutpoint).to.equal(
            await tipOf(chain, config)
        )
        // The public key of the gateway is what the sponsor admits.
        expect(pubKeyBytes(alice.pub)).to.have.length.greaterThan(100)
    })

    it('does not call a member removed when the tip cannot be followed, and relays once it can', async () => {
        const { chain, config } = await deployTree()
        // The sponsor admits a new member before round 1; the new member's
        // config still names the deployment as its last known tip.
        clockBase = START - 600
        const sponsorCfg = file(readFileSync(config, 'utf8'))
        saveAttesterKey(sponsorCfg, sponsorKey.priv.p, sponsorKey.priv.q)
        const admitted = sink()
        expect(
            await admitCommand(
                [
                    sponsorCfg,
                    '--member-key',
                    file(pubKeyBytes(outsider.pub)),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                ],
                admitted.io,
                {
                    provider: chain,
                    signer: new TestWallet(WALLET_KEY, chain),
                    keeper: keeperOptions(chain),
                    now: clockOf(chain),
                }
            )
        ).to.equal(0)
        clockBase = START + 100
        const path = memberConfig(config, outsider)
        let lookupDown = true
        const lines: string[] = []
        const options = keeperOptions(chain)
        const gateway = new Gateway(
            loadConfig(path),
            chain,
            new TestWallet(WALLET_KEY, chain),
            {
                bridge: emptyBridge(),
                keeper: {
                    ...options,
                    spentBy: async (op) => {
                        if (lookupDown) throw new Error('lookup down')
                        return options.spentBy(op)
                    },
                },
                now: clockOf(chain),
                intervalMs: 20,
                out: (line) => lines.push(line),
                configPath: path,
            }
        )
        // Start: only a warning, no refusal.
        expect(await gateway.run()).to.equal(0)
        expect(lines.join('\n')).to.contain('could not check the roster')
        const sent = chain.cycleBroadcasts
        const kept = await gateway.handleReading(5000)
        expect(kept).to.contain('kept')
        expect(kept).to.not.contain('not in the roster')
        expect(gateway.pendingReading).to.equal(5000)
        expect(chain.cycleBroadcasts).to.equal(sent)
        lookupDown = false
        expect(await gateway.tickIdle()).to.contain('delivered 1')
        expect(gateway.pendingReading).to.equal(undefined)
        expect(chain.verifyMachineSpends()).to.be.at.least(2)
    })

    it('run --once: a relayed and paid reading exits 0', async () => {
        const { chain, config } = await deployTree()
        const { gateway, lines } = gatewayOf(
            chain,
            memberConfig(config, alice),
            undefined,
            { reading: 5000 }
        )
        expect(await gateway.run()).to.equal(0)
        expect(lines.join('\n')).to.contain('delivered 1 earned 150 sats')
        expect(await lastRoundOf(chain, config, ALICE_INDEX)).to.equal(1n)
        expect(chain.verifyMachineSpends()).to.be.at.least(1)
    })

    it('run --once: a gateway already paid in this round exits NOT_DELIVERED and drops the reading', async () => {
        const { chain, config } = await deployTree()
        const path = memberConfig(config, alice)
        expect(
            await gatewayOf(chain, path).gateway.handleReading(5000)
        ).to.contain('delivered 1')
        const sent = chain.cycleBroadcasts
        const { gateway, lines } = gatewayOf(chain, path, undefined, {
            reading: 5200,
        })
        expect(await gateway.run()).to.equal(NOT_DELIVERED)
        expect(lines.join('\n')).to.contain('waiting for next round')
        expect(gateway.pendingReading).to.equal(undefined)
        expect(chain.cycleBroadcasts).to.equal(sent)
    })

    it('run --once: waiting for MTP exits NOT_DELIVERED with nothing broadcast', async () => {
        const { chain, config } = await deployTree()
        // The chain time stays at one value, so a second cycle breaks MIN_STEP.
        const tip: ChainTip = { mtp: START + 200 }
        clockBase = START + 300
        expect(
            await gatewayOf(
                chain,
                memberConfig(config, alice),
                tip
            ).gateway.handleReading(5000)
        ).to.contain('delivered 1')
        const sent = chain.cycleBroadcasts
        const { gateway, lines } = gatewayOf(
            chain,
            memberConfig(config, bob),
            tip,
            { reading: 5100 }
        )
        const code = await gateway.run()
        expect(code, lines.join('\n')).to.equal(NOT_DELIVERED)
        expect(lines.join('\n')).to.contain('waiting for MTP')
        expect(gateway.pendingReading).to.equal(undefined)
        expect(chain.cycleBroadcasts).to.equal(sent)
    })

    it('refuses a reading out of range and sends nothing', async () => {
        const { chain, config } = await deployTree()
        const { gateway } = gatewayOf(chain, memberConfig(config, alice))
        const line = await gateway.handleReading(7000)
        expect(line).to.contain('reading out of range')
        expect(chain.cycleBroadcasts).to.equal(0)
    })
})
