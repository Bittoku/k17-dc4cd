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
import { TestWallet } from 'scrypt-ts'
import { Rabin } from 'rabinsig'
import {
    K17Machine,
    RABIN_SECURITY_LEVEL,
    attestMessageFor,
    keyHash,
    signReadingFor,
} from 'k17-vm'
import { ConsortiumOptions, consortiumMemory, readingTag } from '../src'
import { loadConfig } from '../src/chain/config'
import { decodeMachine } from '../src/chain/decode'
import { openBridge } from '../src/gateway/bridge'
import { GatewayAttester } from '../src/gateway/attester'
import { Gateway } from '../src/gateway/gateway'
import { gatewayCommand } from '../src/cli/gateway'
import { main } from '../src/cli/k17forth'
import {
    ChainTip,
    MemoryChain,
    OPTS,
    PAYOUT_ADDRESS,
    T0,
    WALLET_KEY,
    collect,
    consortiumOnChain,
    expectNoSecret,
    gatewayConfig,
    keeperOptions,
    landowner,
    memWithSlot1,
    outLogOf,
    sink,
    stranger,
    tickUntil,
} from './utils/consortiumChain'

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

describe('gateway: bridge limits', () => {
    it('discards a line longer than the limit and goes on', async () => {
        const discarded: number[] = []
        const values = await collect(
            openBridge(
                Readable.from([
                    'x'.repeat(300) + '\nR 5\n',
                    'y'.repeat(200),
                    'y'.repeat(200),
                    '\nR 6\n',
                ]),
                { onDiscarded: (chars) => discarded.push(chars) }
            )
        )
        expect(values).to.deep.equal([5, 6])
        expect(discarded).to.deep.equal([300, 400])
    })
})

describe('gateway: attester', () => {
    const attester = new GatewayAttester(gatewayConfig())

    it('derives the round from the chain time and the [consortium] settings', () => {
        const mem = memWithSlot1(landowner.pub)
        // Round 0 opens when enrolment ends, which can be before start.
        expect(attester.currentRound(OPTS.start - 1, mem)).to.equal(0)
        expect(attester.currentRound(T0, mem)).to.equal(0)
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

    it('with once, relays one reading through its pay cycle and stops when the bridge has ended', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        const lines: string[] = []
        const gateway = new Gateway(cfg, chain, signer, {
            // The bridge ends at once, as standard input does after one line.
            bridge: openBridge(Readable.from(['R 5231\n'])),
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
            intervalMs: 20,
            once: true,
            out: (line) => lines.push(line),
        })
        expect(await gateway.run()).to.equal(0)
        expect(gateway.pendingReading).to.equal(undefined)
        expect(outLogOf(chain, gateway)).to.deep.equal([5231n])
        expect(lines.join('\n')).to.contain('delivered 1 earned 150 sats')
        expectNoSecret(lines)
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

describe('gateway: chain time and pending readings', function () {
    this.timeout(300_000)
    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    it('takes the round from the chain time when MTP lags the clock by 2400 s', async () => {
        const LONG: ConsortiumOptions = { ...OPTS, period: 3600 }
        const { chain, signer, cfg } = await consortiumOnChain(true, LONG)
        // The wall clock is 100 s past the close of round 0 ...
        const wall = LONG.start + LONG.period + 100
        // ... but the chain time, min(now, MTP - 1), is still in round 0.
        const tip: ChainTip = { mtp: wall - 2400 }
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain, tip),
            now: () => wall,
        })
        const first = await gateway.handleReading(5231)
        expect(first).to.match(/^round 0 slot 1 /)
        expect(first).to.not.contain('refused')
        await tickUntil(gateway, /delivered 1 earned 150 sats/)
        expect(outLogOf(chain, gateway)).to.deep.equal([5231n])
        // Every cycle so far is stamped in round 0 of the machine.
        for (const tx of chain.txs.values())
            expect(tx.nLockTime).to.be.below(LONG.start + LONG.period)
        // MTP passes the close: the next reading is for round 1.
        tip.mtp = wall + 10
        const second = await gateway.handleReading(5300)
        expect(second).to.match(/^round 1 slot 1 /)
        await tickUntil(gateway, /delivered 2 earned 300 sats/)
        expect(outLogOf(chain, gateway)).to.deep.equal([5231n, 5300n])
        expect(chain.verifyMachineSpends()).to.be.greaterThan(6)
    })

    it('keeps a pending reading through a skipped and a failed tick, then refuses a second reading in the round', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        // Chain time T0 + 1 is before the machine's lastTime (T0 + 2): skip.
        const tip: ChainTip = { mtp: T0 + 2 }
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain, tip),
            now: () => OPTS.start + 100,
        })
        const skipped = await gateway.handleReading(5231)
        expect(skipped).to.contain('skipped: waiting')
        expect(gateway.pendingReading).to.equal(5231)
        tip.fail = 'tip unreachable'
        const failed = await gateway.tickIdle()
        expect(failed).to.contain('tip unreachable')
        expect(gateway.pendingReading).to.equal(5231)
        tip.fail = undefined
        tip.mtp = T0 + 1_000_000
        await tickUntil(gateway, /delivered 1 earned 150 sats/)
        expect(gateway.pendingReading).to.equal(undefined)
        expect(outLogOf(chain, gateway)).to.deep.equal([5231n])
        const before = chain.cycleBroadcasts
        const duplicate = await gateway.handleReading(5300)
        expect(duplicate).to.contain('slot already delivered in round 0')
        expect(chain.cycleBroadcasts).to.equal(before)
        expect(gateway.pendingReading).to.equal(undefined)
    })

    it('drops a pending reading that the machine rejects instead of retrying it', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(true)
        cfg.signAnyway = true
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
        })
        await gateway.handleReading(9000) // signed, outside the program's range
        await tickUntil(gateway, /dropped reading 9000: the machine rejects it/)
        expect(gateway.pendingReading).to.equal(undefined)
        const next = await gateway.tickIdle()
        expect(next).to.contain('needs witness')
        expect(next).to.not.contain('witness rejected')
    })

    it('ends run() with exit code 1 and a hidden message when the bridge fails', async () => {
        const chain = new MemoryChain()
        const lines: string[] = []
        const failing: AsyncIterable<number> = {
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    throw new Error(`port gone near ${WALLET_KEY.toWIF()}`)
                },
            }),
        }
        const gateway = new Gateway(
            gatewayConfig(),
            chain,
            new TestWallet(WALLET_KEY, chain),
            { bridge: failing, out: (line) => lines.push(line) }
        )
        expect(await gateway.run()).to.equal(1)
        expect(lines.join('\n')).to.contain('bridge failed: port gone')
        expectNoSecret(lines)
        expect(chain.txs.size).to.equal(0)
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

    it('refuses a [consortium] start below 1', () => {
        const path = configFile('gw-start.toml')
        writeFileSync(
            path,
            readFileSync(path, 'utf8') +
                '[consortium]\nstart = 0\nperiod = 60\nepoch = 1\nslots = 1\nrounds = 1\n'
        )
        expect(() => loadConfig(path)).to.throw(
            'config: [consortium] start must be a whole number, 1 or more'
        )
    })

    it('is reachable from the main dispatcher', async () => {
        const { lines, io } = sink()
        expect(await main(['gateway'], io)).to.equal(2)
        expect(lines.join('\n')).to.contain('usage')
    })
})
