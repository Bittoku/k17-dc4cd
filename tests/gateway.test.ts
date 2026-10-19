/**
 * Tests for the gateway: the bridge line reader (`src/gateway/bridge.ts`),
 * the attester with its round, enrolment and range guards
 * (`src/gateway/attester.ts`), the run loop (`src/gateway/gateway.ts`) and
 * the `gateway init` / `gateway run` sub-commands (`src/cli/gateway.ts`).
 *
 * No test uses the network or a serial device: the bridge reads an
 * in-memory stream, and the chain is the in-memory provider of the keeper
 * tests. Rabin keys come from fixed seeds and are made once, because key
 * generation takes seconds.
 */
import { expect } from 'chai'
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Readable } from 'stream'
import { DummyProvider, TestWallet, bsv } from 'scrypt-ts'
import { Rabin } from 'rabinsig'
import {
    K17Machine,
    RABIN_SECURITY_LEVEL,
    addrOf,
    attestMessageFor,
    keyHash,
    newAttester,
    newMachine,
    payoutOf,
    rosterOf,
    signEndorsement,
    signReadingFor,
    withSlot,
    slotCells,
} from 'k17-vm'
import {
    ConsortiumOptions,
    consortiumMemory,
    consortiumProgram,
    endorseTag,
    readingTag,
} from '../src'
import { GatewayConfig, loadConfig } from '../src/chain/config'
import { Keeper } from '../src/chain/keeper'
import { Outpoint } from '../src/chain/history'
import { decodeMachine } from '../src/chain/decode'
import { openBridge } from '../src/gateway/bridge'
import { GatewayAttester } from '../src/gateway/attester'
import { Gateway } from '../src/gateway/gateway'
import { gatewayCommand } from '../src/cli/gateway'
import { CliIo, main } from '../src/cli/k17forth'

const T0 = 1_760_000_000
const FUNDING = 100_000
const WALLET_KEY = bsv.PrivateKey.fromRandom('testnet')
const ECON = {
    beneficiary: addrOf(bsv.PrivateKey.fromRandom('testnet').toAddress()),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}

// Rabin keys from fixed seeds; made once (seconds each).
const sponsor = newAttester(Buffer.alloc(32, 60))
const landowner = newAttester(Buffer.alloc(32, 61))
const stranger = newAttester(Buffer.alloc(32, 62))
const PAYOUT_ADDRESS = bsv.PrivateKey.fromRandom('testnet').toAddress()

const OPTS: ConsortiumOptions = {
    slots: 1,
    rounds: 2,
    epoch: 9,
    start: T0 + 1000,
    period: 1000,
    enrolDeadline: T0 + 1000,
    bountyPerReading: 150,
    floor: 1000,
    sponsorKeyHashHex: keyHash(sponsor.pub),
    range: { min: 4000, max: 6000 },
}

/** The `[consortium]` settings that match OPTS. */
const CONSORTIUM = {
    start: OPTS.start,
    period: OPTS.period,
    epoch: OPTS.epoch,
    slots: OPTS.slots,
    rounds: OPTS.rounds,
    rangeMin: 4000,
    rangeMax: 6000,
}

/** A gateway configuration for slot 1 with the landowner's key. */
function gatewayConfig(extra: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
        network: 'testnet',
        wif: WALLET_KEY.toWIF(),
        rabinP: landowner.priv.p.toString(),
        rabinQ: landowner.priv.q.toString(),
        payoutAddress: PAYOUT_ADDRESS.toString(),
        machineOutpoint: `${'ab'.repeat(32)}:0`,
        instanceId: 'c1'.repeat(32),
        slot: 1,
        signAnyway: false,
        consortium: { ...CONSORTIUM },
        ...extra,
    }
}

/** Memory image with the sponsor in slot 0 and `key` in slot 1. */
function memWithSlot1(key: bigint): { mem: string } {
    return {
        mem: withSlot(
            consortiumMemory(OPTS),
            1,
            slotCells(keyHash(key), payoutOf(PAYOUT_ADDRESS))
        ),
    }
}

/** In-memory chain, as in the keeper tests (see tests/keeper.test.ts). */
class MemoryChain extends DummyProvider {
    txs = new Map<string, bsv.Transaction>()
    spenders = new Map<string, string>()
    cycleBroadcasts = 0

    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.txs.get(txid)
        if (!tx) throw new Error(`unknown tx ${txid}`)
        return tx
    }

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const tx = new bsv.Transaction(rawTxHex)
        if (tx.inputs.some((input) => this.spendsMachine(input)))
            this.cycleBroadcasts++
        for (const input of tx.inputs) {
            const key = `${input.prevTxId.toString('hex')}:${input.outputIndex}`
            const spender = this.spenders.get(key)
            if (spender && spender !== tx.id)
                throw new Error('txn-mempool-conflict')
        }
        this.add(tx)
        return tx.id
    }

    /** True when the input spends a known machine output (a long script). */
    spendsMachine(input: bsv.Transaction.Input): boolean {
        const prev = this.txs.get(input.prevTxId.toString('hex'))
        const output = prev?.outputs[input.outputIndex]
        return !!output && output.script.toBuffer().length > 10_000
    }

    add(tx: bsv.Transaction): void {
        this.txs.set(tx.id, tx)
        for (const input of tx.inputs)
            this.spenders.set(
                `${input.prevTxId.toString('hex')}:${input.outputIndex}`,
                tx.id
            )
    }

    /** The spends lookup: the transaction that spent an outpoint, if any. */
    async spentBy(outpoint: Outpoint): Promise<string | undefined> {
        return this.spenders.get(`${outpoint.txid}:${outpoint.vout}`)
    }

    /**
     * Check every machine spend with the script interpreter. Each stored
     * transaction is parsed from raw hex, so the spent output is attached to
     * input 0 first. Output: the number of machine spends checked.
     */
    verifyMachineSpends(): number {
        let checked = 0
        for (const tx of this.txs.values()) {
            const input = tx.inputs[0]
            if (!input || !this.spendsMachine(input)) continue
            const prev = this.txs.get(input.prevTxId.toString('hex'))!
            const spent = prev.outputs[input.outputIndex]
            const copy = new bsv.Transaction(tx.toString())
            copy.inputs[0].output = new bsv.Transaction.Output({
                script: spent.script,
                satoshis: spent.satoshis,
            })
            const verdict = copy.verifyInputScript(0)
            if (!verdict.success)
                throw new Error(`script failed for ${tx.id}: ${verdict.error}`)
            checked++
        }
        return checked
    }
}

/** Keeper options with a fixed median time past far ahead of the clock. */
function keeperOptions(chain: MemoryChain) {
    return {
        chainInfo: async () => ({ mediantime: T0 + 1_000_000, blocks: 1 }),
        spentBy: (op: Outpoint) => chain.spentBy(op),
    }
}

/**
 * Deploy a consortium machine and, when `enrol` is set, run cycle 1 and the
 * sponsor's endorsement of the landowner into slot 1.
 * Output: the chain, signer and a gateway configuration naming the machine.
 */
async function consortiumOnChain(enrol: boolean): Promise<{
    chain: MemoryChain
    signer: TestWallet
    cfg: GatewayConfig
}> {
    const chain = new MemoryChain()
    const signer = new TestWallet(WALLET_KEY, chain)
    const m = newMachine(
        consortiumProgram(OPTS),
        ECON,
        BigInt(T0),
        rosterOf(),
        consortiumMemory(OPTS)
    )
    await m.connect(signer)
    const tx = await m.deploy(FUNDING)
    const cfg = gatewayConfig({
        machineOutpoint: `${tx.id}:0`,
        instanceId: m.instanceId,
    })
    if (enrol) {
        const keeper = new Keeper(cfg, chain, signer, keeperOptions(chain))
        expect((await keeper.tick(T0 + 1)).txid).to.be.a('string')
        const endorsed = await keeper.tick(T0 + 2, {
            witness: [],
            sig: signEndorsement(
                sponsor,
                m.instanceId,
                endorseTag(OPTS, 1),
                landowner.pub,
                payoutOf(PAYOUT_ADDRESS),
                1n
            ),
            attestKey: sponsor.pub,
            endorseKey: landowner.pub,
            payoutHex: payoutOf(PAYOUT_ADDRESS),
        })
        expect(endorsed.error).to.equal(undefined)
        cfg.machineOutpoint = endorsed.outpoint
    }
    return { chain, signer, cfg }
}

/** Collect every value of an async iterable. */
async function collect(source: AsyncIterable<number>): Promise<number[]> {
    const values: number[] = []
    for await (const value of source) values.push(value)
    return values
}

/** Output sink that keeps all lines. */
function sink(): { lines: string[]; io: CliIo } {
    const lines: string[] = []
    return {
        lines,
        io: {
            out: (l: string) => lines.push(l),
            err: (l: string) => lines.push('ERR ' + l),
        },
    }
}

/** Text that must never be printed: the wallet key and both primes. */
const SECRETS = [
    WALLET_KEY.toWIF(),
    landowner.priv.p.toString(),
    landowner.priv.q.toString(),
]

/** Assert that no line holds a secret. */
function expectNoSecret(lines: string[]): void {
    const text = lines.join('\n')
    for (const secret of SECRETS) expect(text).to.not.contain(secret)
}

describe('gateway: bridge', () => {
    it('reads "R <reading>" lines and ignores other lines', async () => {
        const values = await collect(
            openBridge(
                Readable.from(['R 5231\n', 'ok\n', 'R 12\r\nR x\n', 'R 7\n'])
            )
        )
        expect(values).to.deep.equal([5231, 12, 7])
    })

    it('joins a reading that arrives in pieces', async () => {
        const values = await collect(
            openBridge(Readable.from(['R 52', '31\nR', ' 4100\n', 'R 9']))
        )
        expect(values).to.deep.equal([5231, 4100, 9])
    })
})

describe('gateway: attester', () => {
    const attester = new GatewayAttester(gatewayConfig())

    it('derives the round from the clock and the [consortium] settings', () => {
        const mem = memWithSlot1(landowner.pub)
        expect(attester.currentRound(OPTS.start - 1, mem)).to.equal(null)
        expect(attester.currentRound(OPTS.start, mem)).to.equal(0)
        expect(
            attester.currentRound(OPTS.start + OPTS.period - 1, mem)
        ).to.equal(0)
        expect(attester.currentRound(OPTS.start + OPTS.period, mem)).to.equal(1)
        expect(
            attester.currentRound(OPTS.start + 2 * OPTS.period, mem)
        ).to.equal(null)
    })

    it('signs a reading with readingTag(round, slot) and its own key', () => {
        const input = attester.sign(5231, 1)
        expect(input.witness).to.deep.equal([1n, 5231n])
        expect(input.attestKey).to.equal(landowner.pub)
        const tag = readingTag(OPTS, 1, 1)
        expect(input.sig).to.deep.equal(
            signReadingFor(landowner, 'c1'.repeat(32), tag, 5231n)
        )
        const rabin = new Rabin(RABIN_SECURITY_LEVEL)
        expect(
            rabin.verify(
                attestMessageFor('c1'.repeat(32), tag, 5231n),
                {
                    signature: input.sig!.s,
                    paddingByteCount: input.sig!.padding.length / 2,
                },
                landowner.pub
            )
        ).to.equal(true)
    })

    it('refuses a round that is closed', () => {
        expect(() => attester.sign(5231, null)).to.throw('round closed')
        expect(() => attester.sign(5231, 2)).to.throw('round closed')
    })

    it('refuses a slot that is not enrolled, or holds another key', () => {
        const empty = { mem: consortiumMemory(OPTS) }
        expect(() => attester.currentRound(OPTS.start, empty)).to.throw(
            'slot not enrolled'
        )
        expect(() =>
            attester.currentRound(OPTS.start, memWithSlot1(stranger.pub))
        ).to.throw('slot not enrolled')
        const outside = new GatewayAttester(gatewayConfig({ slot: 2 }))
        expect(() =>
            outside.currentRound(OPTS.start, memWithSlot1(landowner.pub))
        ).to.throw('slot not enrolled')
    })

    it('refuses a reading out of range unless sign_anyway', () => {
        expect(() => attester.sign(6001, 0)).to.throw('reading out of range')
        expect(() => attester.sign(3999, 0)).to.throw('reading out of range')
        const anyway = new GatewayAttester(gatewayConfig({ signAnyway: true }))
        expect(anyway.sign(6001, 0).witness).to.deep.equal([1n, 6001n])
        // A value that is not a 32-bit cell can never be signed.
        expect(() => anyway.sign(2 ** 32, 0)).to.throw('reading out of range')
        expect(() => anyway.sign(-1, 0)).to.throw('reading out of range')
    })

    it('needs the key, the slot, the instance id and [consortium]', () => {
        expect(
            () => new GatewayAttester(gatewayConfig({ rabinP: undefined }))
        ).to.throw(/rabin_p/)
        expect(
            () => new GatewayAttester(gatewayConfig({ slot: undefined }))
        ).to.throw(/slot/)
        expect(
            () => new GatewayAttester(gatewayConfig({ instanceId: undefined }))
        ).to.throw(/instance_id/)
        expect(
            () => new GatewayAttester(gatewayConfig({ consortium: undefined }))
        ).to.throw(/consortium/)
    })

    it('never shows a prime in its errors or its description', () => {
        let message = ''
        try {
            new GatewayAttester(gatewayConfig({ rabinQ: 'not-a-number' }))
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('rabin_q')
        expect(message).to.not.contain(landowner.priv.p.toString())
        expect(attester.keyHashHex).to.equal(keyHash(landowner.pub))
    })
})

describe('gateway: run loop', function () {
    this.timeout(300_000)
    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    it('relays a reading of the open round: signed, attested, paid', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        const bridge = new PassThrough()
        const lines: string[] = []
        let notify = () => undefined as void
        const gateway = new Gateway(cfg, chain, signer, {
            bridge: openBridge(bridge),
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
            intervalMs: 20,
            out: (line) => {
                lines.push(line)
                notify()
            },
        })
        const running = gateway.run()
        bridge.write('R 5231\n')
        await new Promise<void>((resolve) => {
            notify = () => {
                if (lines.some((l) => /delivered 1 earned 150 sats/.test(l)))
                    resolve()
            }
            notify()
        })
        bridge.end()
        await running
        expectNoSecret(lines)
        expect(lines.join('\n')).to.not.contain('error')
        // The machine logged the reading and paid slot 1 once.
        const [txid] = gateway.outpoint!.split(':')
        const machine = decodeMachine(
            chain.txs.get(txid)!.outputs[0].script.toHex()
        ).machine!
        expect(machine.outLog).to.deep.equal([5231n])
        const paid = [...chain.txs.values()].flatMap((tx) =>
            tx.outputs.filter(
                (o) =>
                    o.satoshis === OPTS.bountyPerReading &&
                    o.script.toAddress('testnet').toString() ===
                        PAYOUT_ADDRESS.toString()
            )
        )
        expect(paid).to.have.length(1)
        // Every machine spend passes the script interpreter.
        expect(chain.verifyMachineSpends()).to.be.greaterThan(3)
    })

    it('refuses a reading after the last round closed and broadcasts nothing', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        const before = chain.cycleBroadcasts
        const lines: string[] = []
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain),
            now: () => OPTS.start + OPTS.rounds * OPTS.period,
            out: (line) => lines.push(line),
        })
        const line = await gateway.handleReading(5231)
        expect(line).to.contain('round closed')
        expect(chain.cycleBroadcasts).to.equal(before)
        expectNoSecret([line])
    })

    it('refuses a reading when its slot is not enrolled, and broadcasts nothing', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(false)
        const before = chain.cycleBroadcasts
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
        })
        const line = await gateway.handleReading(5231)
        expect(line).to.contain('slot not enrolled')
        expect(chain.cycleBroadcasts).to.equal(before)
    })

    it('refuses a reading out of range and broadcasts nothing', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        const before = chain.cycleBroadcasts
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
        })
        const line = await gateway.handleReading(9000)
        expect(line).to.contain('reading out of range')
        expect(chain.cycleBroadcasts).to.equal(before)
    })
})

describe('gateway commands', function () {
    this.timeout(60_000)
    const dir = mkdtempSync(join(tmpdir(), 'k17gateway-'))

    /** Write a private config file without an attester key. Output: its path. */
    function configFile(name: string, network = 'testnet'): string {
        const path = join(dir, name)
        writeFileSync(
            path,
            `# gateway config\n[network]\nname = "${network}"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n[gateway]\nslot = 1\n`
        )
        chmodSync(path, 0o600)
        return path
    }

    it('init writes a Rabin key that verifies a signature, and prints no prime', async () => {
        const config = configFile('gw-init.toml')
        const { lines, io } = sink()
        const code = await gatewayCommand(['init', '--config', config], io, {
            generate: () => landowner,
        })
        expect(lines.join('\n')).to.not.contain('ERR')
        expect(code).to.equal(0)
        expect(statSync(config).mode & 0o777).to.equal(0o600)
        expect(existsSync(`${config}.tmp`)).to.equal(false)
        const text = readFileSync(config, 'utf8')
        expect(text).to.contain('# gateway config')
        const cfg = loadConfig(config)
        expect(cfg.slot).to.equal(1)
        // The stored key signs a test reading that verifies under p * q.
        const priv = { p: BigInt(cfg.rabinP!), q: BigInt(cfg.rabinQ!) }
        const pub = priv.p * priv.q
        const sig = signReadingFor(
            { priv, pub },
            'c1'.repeat(32),
            readingTag(OPTS, 0, 1),
            5000n
        )
        const rabin = new Rabin(RABIN_SECURITY_LEVEL)
        expect(
            rabin.verify(
                attestMessageFor(
                    'c1'.repeat(32),
                    readingTag(OPTS, 0, 1),
                    5000n
                ),
                { signature: sig.s, paddingByteCount: sig.padding.length / 2 },
                pub
            )
        ).to.equal(true)
        const printed = lines.join('\n')
        expect(printed).to.contain(keyHash(pub))
        // No payout_address in the file: the wallet address is the payout.
        expect(printed).to.contain(WALLET_KEY.toAddress('testnet').toString())
        expectNoSecret(lines)
    })

    it('init refuses a config that already has a key', async () => {
        const config = configFile('gw-init-twice.toml')
        await gatewayCommand(['init', '--config', config], sink().io, {
            generate: () => landowner,
        })
        const before = readFileSync(config, 'utf8')
        const { lines, io } = sink()
        const code = await gatewayCommand(['init', '--config', config], io, {
            generate: () => stranger,
        })
        expect(code).to.equal(1)
        expect(lines.join('\n')).to.contain('already')
        expect(readFileSync(config, 'utf8')).to.equal(before)
        expectNoSecret(lines)
    })

    it('run refuses a mainnet config without --i-know-this-spends-real-money', async () => {
        const config = configFile('gw-main.toml', 'mainnet')
        const chain = new MemoryChain()
        const { lines, io } = sink()
        const code = await gatewayCommand(['run', '--config', config], io, {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
            bridge: openBridge(Readable.from([])),
        })
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--i-know-this-spends-real-money')
        expect(chain.txs.size).to.equal(0)
        expectNoSecret(lines)
    })

    it('is reachable from the main dispatcher', async () => {
        const { lines, io } = sink()
        expect(await main(['gateway'], io)).to.equal(2)
        expect(lines.join('\n')).to.contain('usage')
    })
})
