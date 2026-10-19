/**
 * Tests for the keeper (`src/chain/keeper.ts`) and the `deploy` and
 * `keeper` sub-commands. No test uses the network: the chain is an
 * in-memory provider (a DummyProvider subclass) that keeps every broadcast
 * transaction, refuses a spend of an output that is already spent, and can
 * be told to fail the next broadcasts.
 */
import { expect } from 'chai'
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DummyProvider, TestWallet, bsv } from 'scrypt-ts'
import {
    K17Machine,
    addrOf,
    assemble,
    heartbeatProgram,
    newMachine,
    factoringBountyProgram,
    readSlot,
} from 'k17-vm'
import { Keeper, isConflictError, wocSpentBy } from '../src/chain/keeper'
import {
    GatewayConfig,
    hideSecrets,
    loadConfig,
    withMachine,
} from '../src/chain/config'
import { Outpoint } from '../src/chain/history'
import { deployCommand } from '../src/cli/deploy'
import { keeperCommand } from '../src/cli/keeper'
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

/**
 * In-memory chain. Every broadcast transaction is kept; a transaction that
 * spends an output already spent by another one fails with
 * "txn-mempool-conflict", as a node does. The wallet also broadcasts its own
 * fee-splitting transactions, so `cycleBroadcasts` counts only the
 * broadcasts that spend a machine, and `failNext` (forced errors) applies
 * only to those.
 */
class MemoryChain extends DummyProvider {
    txs = new Map<string, bsv.Transaction>()
    spenders = new Map<string, string>()
    failNext: string[] = []
    cycleBroadcasts = 0

    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.txs.get(txid)
        if (!tx) throw new Error(`unknown tx ${txid}`)
        return tx
    }

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const tx = new bsv.Transaction(rawTxHex)
        if (tx.inputs.some((input) => this.spendsMachine(input))) {
            this.cycleBroadcasts++
            const forced = this.failNext.shift()
            if (forced) throw new Error(forced)
        }
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
}

/** A fresh chain and a wallet signer on it. */
function setup(): { chain: MemoryChain; signer: TestWallet } {
    const chain = new MemoryChain()
    return { chain, signer: new TestWallet(WALLET_KEY, chain) }
}

/** Deploy `prog` on the chain. Output: the configuration that names it. */
async function deployed(
    chain: MemoryChain,
    signer: TestWallet,
    prog: string
): Promise<GatewayConfig> {
    const m = newMachine(prog, ECON, BigInt(T0))
    await m.connect(signer)
    const tx = await m.deploy(FUNDING)
    expect(chain.txs.has(tx.id)).to.equal(true)
    return {
        network: 'testnet',
        wif: WALLET_KEY.toWIF(),
        machineOutpoint: `${tx.id}:0`,
        signAnyway: false,
    }
}

/** A keeper on the in-memory chain with a fixed median time past. */
function keeperOn(
    cfg: GatewayConfig,
    chain: MemoryChain,
    signer: TestWallet,
    mediantime = T0 + 1000
): Keeper {
    return new Keeper(cfg, chain, signer, {
        chainInfo: async () => ({ mediantime, blocks: 100 }),
        spentBy: (op) => chain.spentBy(op),
    })
}

/** Machine output 0 of a transaction. */
function machineOf(tx: bsv.Transaction): K17Machine {
    return K17Machine.fromTx(tx, 0) as K17Machine
}

describe('keeper', function () {
    this.timeout(60000)
    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    it('tick advances a heartbeat machine, twice in a chain', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const keeper = keeperOn(cfg, chain, signer)
        const first = await keeper.tick(T0 + 100)
        expect(first.error).to.equal(undefined)
        expect(first.skipped).to.equal(undefined)
        expect(first.txid).to.be.a('string')
        expect(first.outpoint).to.equal(`${first.txid}:0`)
        expect(first.lockTime).to.equal(T0 + 100)
        expect(first.reward).to.equal(200n) // 100 + 1 sat/s * 100 s
        const tx1 = chain.txs.get(first.txid!)!
        expect(tx1.inputs[0].prevTxId.toString('hex')).to.equal(
            cfg.machineOutpoint!.slice(0, 64)
        )
        expect(machineOf(tx1).lastTime).to.equal(BigInt(T0 + 100))
        // The second tick spends the cycle that the first one made, unconfirmed.
        const second = await keeper.tick(T0 + 200)
        expect(second.error).to.equal(undefined)
        const tx2 = chain.txs.get(second.txid!)!
        expect(tx2.inputs[0].prevTxId.toString('hex')).to.equal(first.txid)
        expect(keeper.outpoint).to.equal(second.outpoint)
    })

    it('tick with no witness on a blocked program returns { skipped: "needs witness" }', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(
            chain,
            signer,
            assemble(['IN', 'OUT', 'HALT'])
        )
        const before = chain.cycleBroadcasts
        const result = await keeperOn(cfg, chain, signer).tick(T0 + 100)
        expect(result.skipped).to.equal('needs witness')
        expect(result.txid).to.equal(undefined)
        expect(chain.cycleBroadcasts).to.equal(before)
    })

    it('tick uses the pending input when the program needs a witness', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(
            chain,
            signer,
            factoringBountyProgram(15, 50)
        )
        const keeper = keeperOn(cfg, chain, signer)
        expect((await keeper.tick(T0 + 10)).txid).to.be.a('string') // YIELD
        expect((await keeper.tick(T0 + 20)).skipped).to.equal('needs witness')
        const solved = await keeper.tick(T0 + 30, {
            witness: [3n, 5n],
        })
        expect(solved.error).to.equal(undefined)
        expect(solved.halted).to.equal(true)
        expect((await keeper.tick(T0 + 40)).skipped).to.equal('machine halted')
    })

    it('keeper resyncs after a conflicting spend', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        // Another keeper spends the deployment output first.
        const rival = await keeperOn(cfg, chain, signer).tick(T0 + 50)
        expect(rival.txid).to.be.a('string')
        // This keeper still knows only the deployment outpoint.
        const keeper = keeperOn(cfg, chain, signer)
        const before = chain.cycleBroadcasts
        const result = await keeper.tick(T0 + 100)
        expect(result.error).to.equal(undefined)
        expect(result.resynced).to.equal(true)
        expect(chain.cycleBroadcasts - before).to.equal(2)
        const tx = chain.txs.get(result.txid!)!
        expect(tx.inputs[0].prevTxId.toString('hex')).to.equal(rival.txid)
        expect(machineOf(tx).lastTime).to.equal(BigInt(T0 + 100))
    })

    it('retries a conflict only once, then returns { error }', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        chain.failNext = ['Missing inputs', 'Missing inputs', 'Missing inputs']
        const before = chain.cycleBroadcasts
        const result = await keeperOn(cfg, chain, signer).tick(T0 + 100)
        expect(result.error).to.contain('Missing inputs')
        expect(chain.cycleBroadcasts - before).to.equal(2)
    })

    it('does not retry an error that is not a conflict', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        chain.failNext = ['non-final']
        const before = chain.cycleBroadcasts
        const result = await keeperOn(cfg, chain, signer).tick(T0 + 100)
        expect(result.error).to.contain('non-final')
        expect(chain.cycleBroadcasts - before).to.equal(1)
    })

    it('clamps the lock time below the median time past', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const mtp = T0 + 500
        const keeper = keeperOn(cfg, chain, signer, mtp)
        const result = await keeper.tick(T0 + 5000) // wall clock far ahead
        expect(result.mtp).to.equal(mtp)
        expect(result.lockTime).to.equal(mtp - 1)
        expect(chain.txs.get(result.txid!)!.nLockTime).to.equal(mtp - 1)
    })

    it('uses the wall clock when it is behind the median time past', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const keeper = keeperOn(cfg, chain, signer, T0 + 500)
        const result = await keeper.tick(T0 + 450)
        expect(result.lockTime).to.equal(T0 + 450)
        expect(result.mtp).to.equal(T0 + 500)
    })

    it('skips while the median time past is behind lastTime', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const before = chain.cycleBroadcasts
        const result = await keeperOn(cfg, chain, signer, T0 - 60).tick(
            T0 + 100
        )
        expect(result.skipped).to.contain('median time past')
        expect(result.mtp).to.equal(T0 - 60)
        expect(chain.cycleBroadcasts).to.equal(before)
    })

    it('resync walks forward over several rival cycles', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const rival = keeperOn(cfg, chain, signer)
        let last = ''
        for (const t of [10, 20, 30]) last = (await rival.tick(T0 + t)).txid!
        const keeper = keeperOn(cfg, chain, signer)
        const result = await keeper.tick(T0 + 100)
        expect(result.error).to.equal(undefined)
        expect(result.resynced).to.equal(true)
        const tx = chain.txs.get(result.txid!)!
        expect(tx.inputs[0].prevTxId.toString('hex')).to.equal(last)
    })

    it('resync that ends in a halt stops the keeper', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(
            chain,
            signer,
            factoringBountyProgram(15, 50)
        )
        const rival = keeperOn(cfg, chain, signer)
        await rival.tick(T0 + 10) // YIELD
        expect(
            (await rival.tick(T0 + 20, { witness: [3n, 5n] })).halted
        ).to.equal(true)
        const keeper = keeperOn(cfg, chain, signer)
        const result = await keeper.tick(T0 + 100)
        expect(result).to.deep.include({
            skipped: 'machine halted',
            halted: true,
            resynced: true,
        })
        expect(keeper.outpoint).to.equal(undefined)
        const before = chain.cycleBroadcasts
        expect((await keeper.tick(T0 + 200)).halted).to.equal(true)
        expect(chain.cycleBroadcasts).to.equal(before)
    })

    it('resync to a rival cycle with a later lastTime skips the tick', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        await keeperOn(cfg, chain, signer).tick(T0 + 500)
        const keeper = keeperOn(cfg, chain, signer)
        const before = chain.cycleBroadcasts
        const result = await keeper.tick(T0 + 100)
        expect(result.resynced).to.equal(true)
        expect(result.skipped).to.contain('not yet past lastTime')
        expect(chain.cycleBroadcasts - before).to.equal(1)
    })

    it('reports a resync error when the spends lookup answers nonsense', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        await keeperOn(cfg, chain, signer).tick(T0 + 50)
        const keeper = new Keeper(cfg, chain, signer, {
            chainInfo: async () => ({ mediantime: T0 + 1000, blocks: 1 }),
            fetch: async () => ({
                ok: true,
                status: 200,
                json: async () => ({}),
            }),
        })
        const result = await keeper.tick(T0 + 100)
        expect(result.error).to.equal(
            'resync: could not find the spending transaction'
        )
    })

    it('treats a configured outpoint that is not a machine as halted', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const deployTx = chain.txs.get(cfg.machineOutpoint!.slice(0, 64))!
        const change = deployTx.outputs.findIndex(
            (o) => o.script.toBuffer().length < 100
        )
        expect(change).to.be.greaterThan(0)
        const keeper = keeperOn(
            { ...cfg, machineOutpoint: `${deployTx.id}:${change}` },
            chain,
            signer
        )
        const result = await keeper.tick(T0 + 100)
        expect(result).to.deep.include({
            skipped: 'machine halted',
            halted: true,
        })
    })

    it('hides config secrets in the error of a tick', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        chain.failNext = [`bad thing near ${WALLET_KEY.toWIF()}`]
        const result = await keeperOn(cfg, chain, signer).tick(T0 + 100)
        expect(result.error).to.contain('[hidden]')
        expect(result.error).to.not.contain(WALLET_KEY.toWIF())
    })
})

describe('keeper helpers', () => {
    it('knows which broadcast errors mean a spent or conflicting input', () => {
        expect(isConflictError('258: txn-mempool-conflict')).to.equal(true)
        expect(isConflictError('Missing inputs')).to.equal(true)
        expect(isConflictError('missing inputs')).to.equal(true)
        expect(isConflictError('HTTP 500: bad-txns-inputs-spent')).to.equal(
            true
        )
        expect(isConflictError('16: bad-txns-inputs-missingorspent')).to.equal(
            true
        )
        expect(isConflictError('64: too-long-non-final-chain')).to.equal(true)
        expect(isConflictError('64: non-final')).to.equal(false)
        expect(isConflictError('HTTP 500: timeout')).to.equal(false)
        expect(isConflictError('HTTP 500: input too large')).to.equal(false)
    })

    it('reads the spends lookup from WhatsOnChain', async () => {
        const op = { txid: 'ab'.repeat(32), vout: 1 }
        const urls: string[] = []
        const answer =
            (status: number, body?: unknown) => async (url: string) => {
                urls.push(url)
                return { ok: status === 200, status, json: async () => body }
            }
        expect(
            await wocSpentBy(
                'testnet',
                op,
                answer(200, { txid: 'cd'.repeat(32), vin: 0 })
            )
        ).to.equal('cd'.repeat(32))
        expect(urls[0]).to.equal(
            `https://api.whatsonchain.com/v1/bsv/test/tx/${op.txid}/1/spent`
        )
        expect(await wocSpentBy('testnet', op, answer(404))).to.equal(undefined)
        let unexpected = ''
        try {
            await wocSpentBy('testnet', op, answer(200, {}))
        } catch (e) {
            unexpected = (e as Error).message
        }
        expect(unexpected).to.equal('spends lookup: unexpected response')
        let message = ''
        try {
            await wocSpentBy('mainnet', op, answer(503))
        } catch (e) {
            message = (e as Error).message
        }
        expect(message).to.contain('503')
    })

    it('asks the mempool lookup when the confirmed lookup finds nothing', async () => {
        const op = { txid: 'ab'.repeat(32), vout: 0 }
        const base = `https://api.whatsonchain.com/v1/bsv/test/tx/${op.txid}/0`
        const routes =
            (answers: Record<string, [number, unknown?]>) =>
            async (url: string) => {
                const [status, body] = answers[url] ?? [500]
                return { ok: status === 200, status, json: async () => body }
            }
        expect(
            await wocSpentBy(
                'testnet',
                op,
                routes({
                    [`${base}/spent`]: [404],
                    [`${base}/unconfirmed/spent`]: [
                        200,
                        {
                            txid: 'ef'.repeat(32),
                            vin: 0,
                            status: 'unconfirmed',
                        },
                    ],
                })
            )
        ).to.equal('ef'.repeat(32))
        for (const status of [400, 404])
            expect(
                await wocSpentBy(
                    'testnet',
                    op,
                    routes({
                        [`${base}/spent`]: [404],
                        [`${base}/unconfirmed/spent`]: [status],
                    })
                )
            ).to.equal(undefined)
    })

    it('adds a [machine] table when the config has none', () => {
        const text = withMachine('[network]\nname = "testnet"', 'aa:0', 'bb')
        expect(text).to.equal(
            '[network]\nname = "testnet"\n\n[machine]\noutpoint = "aa:0"\ninstance_id = "bb"\n'
        )
    })

    it('hides every secret of the config in a text', () => {
        const cfg: GatewayConfig = {
            network: 'testnet',
            wif: 'cWIF',
            rabinP: '1234567',
            rabinQ: '7654321',
            signAnyway: false,
        }
        expect(hideSecrets('a cWIF b 1234567 c 7654321', cfg)).to.equal(
            'a [hidden] b [hidden] c [hidden]'
        )
    })
})

describe('deploy and keeper commands', function () {
    this.timeout(60000)
    const dir = mkdtempSync(join(tmpdir(), 'k17deploy-'))
    const source = join(dir, 'beat.fs')
    writeFileSync(source, ': beat begin time out again ; beat\n')

    /** Write a private config file. Output: its path. */
    function configFile(name: string, network = 'testnet'): string {
        const path = join(dir, name)
        writeFileSync(
            path,
            `# gateway config\n[network]\nname = "${network}"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n[machine]\noutpoint = "${'aa'.repeat(
                32
            )}:0" # old\n[gateway]\nslot = 1\n`
        )
        chmodSync(path, 0o600)
        return path
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

    const ARGS = (config: string) => [
        source,
        '--config',
        config,
        '--deposit',
        String(FUNDING),
        '--reward-min',
        '100',
        '--slope',
        '1',
        '--reward-max',
        '500',
    ]

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    it('deploy writes the outpoint and instance id, and keeps mode 600', async () => {
        const { chain, signer } = setup()
        const config = configFile('gw.toml')
        const { lines, io } = sink()
        const code = await deployCommand(ARGS(config), io, {
            signer,
            chainInfo: async () => ({ mediantime: T0, blocks: 1 }),
            now: () => T0 + 3000,
        })
        expect(lines.join('\n')).to.not.contain('ERR')
        expect(code).to.equal(0)
        expect(statSync(config).mode & 0o777).to.equal(0o600)
        const cfg = loadConfig(config)
        const [txid] = cfg.machineOutpoint!.split(':')
        expect(cfg.machineOutpoint).to.equal(`${txid}:0`)
        const tx = chain.txs.get(txid)!
        const m = machineOf(tx)
        expect(cfg.instanceId).to.equal(m.instanceId)
        expect(m.lastTime).to.equal(BigInt(T0 - 1)) // below the median time past
        expect(m.beneficiary).to.equal(addrOf(WALLET_KEY.toAddress()))
        expect(cfg.slot).to.equal(1)
        const text = readFileSync(config, 'utf8')
        expect(text).to.contain('# gateway config')
        expect(text).to.not.contain('aa'.repeat(32))
        const printed = lines.join('\n')
        expect(printed).to.contain(`${txid}:0`)
        expect(printed).to.contain(m.instanceId)
        expect(printed).to.not.contain(WALLET_KEY.toWIF())
    })

    it('deploy builds sponsor memory and a fixed roster from flags', async () => {
        const { chain, signer } = setup()
        const config = configFile('gw-sponsor.toml')
        const sponsor = '5a'.repeat(32)
        const beneficiary = bsv.PrivateKey.fromRandom('testnet').toAddress()
        const { io, lines } = sink()
        const code = await deployCommand(
            [
                ...ARGS(config),
                '--sponsor',
                sponsor,
                '--roster',
                '12345,0x99',
                '--beneficiary',
                beneficiary.toString(),
            ],
            io,
            {
                signer,
                chainInfo: async () => ({ mediantime: T0, blocks: 1 }),
                now: () => T0,
            }
        )
        expect(lines.join('\n')).to.not.contain('ERR')
        expect(code).to.equal(0)
        const [txid] = loadConfig(config).machineOutpoint!.split(':')
        const m = machineOf(chain.txs.get(txid)!)
        expect(readSlot(m.mem, 0).hashHex).to.equal(sponsor)
        expect((m.roster as unknown as bigint[]).slice(0, 2)).to.deep.equal([
            12345n,
            0x99n,
        ])
        expect(m.beneficiary).to.equal(addrOf(beneficiary))
    })

    it('deploy refuses mainnet without --i-know-this-spends-real-money', async () => {
        const { chain, signer } = setup()
        const config = configFile('gw-main.toml', 'mainnet')
        const before = readFileSync(config, 'utf8')
        const { lines, io } = sink()
        const code = await deployCommand(ARGS(config), io, {
            signer,
            chainInfo: async () => ({ mediantime: T0, blocks: 1 }),
        })
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--i-know-this-spends-real-money')
        expect(chain.txs.size).to.equal(0)
        expect(readFileSync(config, 'utf8')).to.equal(before)
        expect(lines.join('\n')).to.not.contain(WALLET_KEY.toWIF())
    })

    it('keeper refuses a mainnet config without --i-know-this-spends-real-money', async () => {
        const { chain, signer } = setup()
        const config = configFile('gw-main-keeper.toml', 'mainnet')
        const { lines, io } = sink()
        const code = await keeperCommand(['--config', config], io, {
            provider: chain,
            signer,
            ticks: 1,
            sleep: async () => undefined,
        })
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--i-know-this-spends-real-money')
        expect(chain.txs.size).to.equal(0)
        expect(lines.join('\n')).to.not.contain(WALLET_KEY.toWIF())
    })

    it('keeper refuses an interval below 1 second', async () => {
        const { lines, io } = sink()
        const code = await keeperCommand(
            ['--config', configFile('gw-interval.toml'), '--interval', '0'],
            io
        )
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--interval')
    })

    it('keeper command runs ticks and prints each result', async () => {
        const { chain, signer } = setup()
        const cfg = await deployed(chain, signer, heartbeatProgram())
        const config = join(dir, 'gw-keeper.toml')
        writeFileSync(
            config,
            `[network]\nname = "testnet"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n[machine]\noutpoint = "${
                cfg.machineOutpoint
            }"\n`
        )
        chmodSync(config, 0o600)
        const { lines, io } = sink()
        const code = await keeperCommand(['--config', config], io, {
            provider: chain,
            signer,
            keeper: {
                chainInfo: async () => ({ mediantime: T0 + 1000, blocks: 1 }),
                spentBy: (op) => chain.spentBy(op),
            },
            ticks: 2,
            now: () => T0 + 100,
            sleep: async () => undefined,
        })
        expect(code).to.equal(0)
        const text = lines.join('\n')
        expect(text).to.not.contain('ERR')
        expect(text.match(/cycle [0-9a-f]{64}/g)).to.have.length(2)
        expect(text).to.not.contain(WALLET_KEY.toWIF())
    })

    it('both commands are reachable from the main dispatcher', async () => {
        for (const command of ['deploy', 'keeper']) {
            const { lines, io } = sink()
            expect(await main([command], io)).to.equal(2)
            expect(lines.join('\n')).to.contain('usage')
        }
    })
})
