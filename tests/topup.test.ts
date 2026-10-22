/**
 * Tests for the escrow top-up in the chain tools (`--top-up`).
 *
 * Covers: the `--top-up` parser and the five commands that read it
 * (`keeper`, `gateway run`, `admit`, `remove`, `endorse`); the keeper path
 * (the next machine output holds remaining + topUp, lastTime is the same as
 * without a top-up, the top-up rides on the first cycle only); the refusal
 * of a top-up on a halting cycle (nothing is broadcast); the history decoder
 * (chunk 10 of the unlocking script is `topUp`); and the `inspect --history`
 * line. The chain is in memory; no test uses the network.
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DummyProvider, TestWallet, bsv } from 'scrypt-ts'
import {
    DEAD_MAN_FLOOR,
    K17Machine,
    addrOf,
    assemble,
    heartbeatProgram,
    newMachine,
} from 'k17-vm'
import { GatewayConfig } from '../src/chain/config'
import { Outpoint, decodeUnlocking, walkHistory } from '../src/chain/history'
import { Keeper } from '../src/chain/keeper'
import { admitCommand, removeCommand } from '../src/cli/admit'
import { endorseCommand } from '../src/cli/endorse'
import { MAX_TOP_UP_SATS, parseTopUp } from '../src/cli/flags'
import { gatewayCommand } from '../src/cli/gateway'
import { inspectCommand } from '../src/cli/inspect'
import { keeperCommand, tickLine } from '../src/cli/keeper'
import type { CliIo } from '../src/cli/k17forth'

const T0 = 1_760_000_000
const FUNDING = 100_000
const TOP_UP = 5000n
const WALLET_KEY = bsv.PrivateKey.fromRandom('testnet')
const ECON = {
    beneficiary: addrOf(bsv.PrivateKey.fromRandom('testnet').toAddress()),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}

/** In-memory chain that keeps every broadcast transaction and its spender. */
class MemoryChain extends DummyProvider {
    txs = new Map<string, bsv.Transaction>()
    spenders = new Map<string, string>()
    /** Number of broadcasts that spend a long (machine) output. */
    cycleBroadcasts = 0

    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.txs.get(txid)
        if (!tx) throw new Error(`unknown tx ${txid}`)
        return tx
    }

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const tx = new bsv.Transaction(rawTxHex)
        for (const input of tx.inputs) {
            const prev = this.txs.get(input.prevTxId.toString('hex'))
            const output = prev?.outputs[input.outputIndex]
            if (output && output.script.toBuffer().length > 10_000)
                this.cycleBroadcasts++
            this.spenders.set(
                `${input.prevTxId.toString('hex')}:${input.outputIndex}`,
                tx.id
            )
        }
        this.txs.set(tx.id, tx)
        return tx.id
    }

    async spentBy(outpoint: Outpoint): Promise<string | undefined> {
        return this.spenders.get(`${outpoint.txid}:${outpoint.vout}`)
    }
}

/** A chain with its wallet signer. */
function setup(): { chain: MemoryChain; signer: TestWallet } {
    const chain = new MemoryChain()
    return { chain, signer: new TestWallet(WALLET_KEY, chain) }
}

/**
 * Deploy a program on the chain.
 * Input: chain, signer, program hex, dead-man seconds (default off).
 * Output: the config that names the machine, and the deploy transaction.
 */
async function deployed(
    chain: MemoryChain,
    signer: TestWallet,
    prog: string,
    deadMan = 0n
): Promise<{ cfg: GatewayConfig; deployTx: bsv.Transaction }> {
    const m = newMachine(prog, { ...ECON, deadMan }, BigInt(T0))
    await m.connect(signer)
    const deployTx = await m.deploy(FUNDING)
    return {
        deployTx,
        cfg: {
            network: 'testnet',
            wif: WALLET_KEY.toWIF(),
            machineOutpoint: `${deployTx.id}:0`,
            signAnyway: false,
        },
    }
}

/** A keeper with a fixed median time past, optionally with a top-up. */
function keeperOn(
    cfg: GatewayConfig,
    chain: MemoryChain,
    signer: TestWallet,
    topUp?: bigint,
    mediantime = T0 + 1000
): Keeper {
    return new Keeper(cfg, chain, signer, {
        chainInfo: async () => ({ mediantime, blocks: 100 }),
        spentBy: (op) => chain.spentBy(op),
        topUp,
    })
}

/** Output sink that keeps all lines (errors start with "ERR "). */
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

describe('top-up', function () {
    this.timeout(120000)
    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    describe('--top-up parsing', () => {
        it('reads a whole number of satoshis, and 0 when the flag is absent', () => {
            expect(parseTopUp(undefined)).to.equal(0n)
            expect(parseTopUp('0')).to.equal(0n)
            expect(parseTopUp('5000')).to.equal(5000n)
            expect(parseTopUp(String(MAX_TOP_UP_SATS))).to.equal(
                MAX_TOP_UP_SATS
            )
        })

        it('rejects garbage with a clear message', () => {
            for (const text of ['', '-5', '1.5', '5k', 'abc', '0x10', ' 7']) {
                const result = parseTopUp(text)
                expect(result, text).to.be.a('string')
                expect(result as string).to.contain('--top-up')
            }
            expect(parseTopUp(String(MAX_TOP_UP_SATS + 1n))).to.contain(
                'too large'
            )
        })

        it('every command that sends a cycle refuses a bad value with exit code 2', async () => {
            const cases: {
                name: string
                run: (io: CliIo) => Promise<number>
            }[] = [
                {
                    name: 'keeper',
                    run: (io) =>
                        keeperCommand(
                            ['--config', 'x.toml', '--top-up', 'abc'],
                            io
                        ),
                },
                {
                    name: 'gateway run',
                    run: (io) =>
                        gatewayCommand(
                            ['run', '--config', 'x.toml', '--top-up', '1.5'],
                            io
                        ),
                },
                {
                    name: 'admit',
                    run: (io) =>
                        admitCommand(
                            [
                                'x.toml',
                                '--member-key',
                                'k',
                                '--payout',
                                'p',
                                '--top-up',
                                '-5',
                            ],
                            io
                        ),
                },
                {
                    name: 'remove',
                    run: (io) =>
                        removeCommand(
                            ['x.toml', '--index', '1', '--top-up', 'lots'],
                            io
                        ),
                },
                {
                    name: 'endorse',
                    run: (io) =>
                        endorseCommand(
                            [
                                '--config',
                                'x.toml',
                                '--member',
                                'aa',
                                '--payout',
                                'p',
                                '--slot',
                                '1',
                                '--top-up',
                                '12abc',
                            ],
                            io
                        ),
                },
            ]
            for (const { name, run } of cases) {
                const { lines, io } = sink()
                expect(await run(io), name).to.equal(2)
                expect(lines.join('\n'), name).to.contain('--top-up must be')
            }
        })

        it('the usage text of each command names --top-up', async () => {
            const { lines, io } = sink()
            await keeperCommand([], io)
            await gatewayCommand([], io)
            await admitCommand([], io)
            await removeCommand([], io)
            await endorseCommand([], io)
            expect(lines.filter((l) => l.includes('--top-up'))).to.have.length(
                5
            )
        })
    })

    describe('keeper path', () => {
        it('the next machine output holds remaining + topUp and lastTime does not change', async () => {
            const plain = setup()
            const withTopUp = setup()
            const a = await deployed(
                plain.chain,
                plain.signer,
                heartbeatProgram()
            )
            const b = await deployed(
                withTopUp.chain,
                withTopUp.signer,
                heartbeatProgram()
            )
            const base = await keeperOn(a.cfg, plain.chain, plain.signer).tick(
                T0 + 100
            )
            const topped = await keeperOn(
                b.cfg,
                withTopUp.chain,
                withTopUp.signer,
                TOP_UP
            ).tick(T0 + 100)
            expect(base.error).to.equal(undefined)
            expect(topped.error).to.equal(undefined)
            expect(topped.topUp).to.equal(TOP_UP)
            expect(base.topUp).to.equal(undefined)
            // A top-up never changes the keeper reward or the lock time.
            expect(topped.reward).to.equal(base.reward)
            expect(topped.lockTime).to.equal(base.lockTime)
            const baseTx = plain.chain.txs.get(base.txid!)!
            const toppedTx = withTopUp.chain.txs.get(topped.txid!)!
            expect(BigInt(toppedTx.outputs[0].satoshis)).to.equal(
                BigInt(baseTx.outputs[0].satoshis) + TOP_UP
            )
            const baseMachine = K17Machine.fromTx(baseTx, 0) as K17Machine
            const toppedMachine = K17Machine.fromTx(toppedTx, 0) as K17Machine
            expect(toppedMachine.lastTime).to.equal(baseMachine.lastTime)
            expect(toppedMachine.lastTime).to.equal(BigInt(T0 + 100))
        })

        it('the top-up rides on the first cycle only', async () => {
            const { chain, signer } = setup()
            const { cfg } = await deployed(chain, signer, heartbeatProgram())
            const keeper = keeperOn(cfg, chain, signer, TOP_UP)
            const first = await keeper.tick(T0 + 100)
            const second = await keeper.tick(T0 + 200)
            expect(first.topUp).to.equal(TOP_UP)
            expect(second.error).to.equal(undefined)
            expect(second.topUp).to.equal(undefined)
            // The second cycle's value is the first one's minus the reward.
            const firstValue = BigInt(
                chain.txs.get(first.txid!)!.outputs[0].satoshis
            )
            const secondValue = BigInt(
                chain.txs.get(second.txid!)!.outputs[0].satoshis
            )
            expect(secondValue).to.equal(firstValue - second.reward!)
        })

        it('prints the top-up in the tick line', () => {
            const line = tickLine({
                txid: 'ab'.repeat(32),
                outpoint: `${'ab'.repeat(32)}:0`,
                lockTime: T0,
                mtp: T0 + 1,
                reward: 200n,
                topUp: TOP_UP,
            })
            expect(line).to.contain('top-up: 5000 sats')
            expect(
                tickLine({ txid: 'cd'.repeat(32), reward: 1n })
            ).to.not.contain('top-up')
        })

        it('refuses a top-up on a halting cycle before any broadcast, then goes on', async () => {
            const { chain, signer } = setup()
            const deadMan = DEAD_MAN_FLOOR
            const { cfg } = await deployed(
                chain,
                signer,
                assemble(['IN', 'OUT', 'HALT']),
                deadMan
            )
            const due = T0 + Number(deadMan)
            const keeper = keeperOn(cfg, chain, signer, TOP_UP, due + 1)
            const before = chain.cycleBroadcasts
            const refused = await keeper.tick(due + 5)
            expect(refused.txid).to.equal(undefined)
            expect(refused.topUpRefused).to.equal(true)
            expect(refused.error).to.contain('top-up of 5000 sats refused')
            expect(refused.error).to.contain('halts the machine')
            expect(refused.error).to.not.contain('    at ')
            expect(chain.cycleBroadcasts).to.equal(before)
            // The keeper dropped the top-up, so the next tick halts the machine.
            const halted = await keeper.tick(due + 5)
            expect(halted.error).to.equal(undefined)
            expect(halted.halted).to.equal(true)
            expect(halted.deadManHalt).to.equal(true)
            expect(halted.topUp).to.equal(undefined)
        })

        it('the keeper command takes --top-up once and reports it', async () => {
            const { chain, signer } = setup()
            const { cfg } = await deployed(chain, signer, heartbeatProgram())
            const dir = mkdtempSync(join(tmpdir(), 'k17topup-'))
            const config = join(dir, 'gw.toml')
            writeFileSync(
                config,
                `[network]\nname = "testnet"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n[machine]\noutpoint = "${
                    cfg.machineOutpoint
                }"\n`
            )
            chmodSync(config, 0o600)
            const { lines, io } = sink()
            let clockCalls = 0
            const code = await keeperCommand(
                ['--config', config, '--top-up', '5000'],
                io,
                {
                    provider: chain,
                    signer,
                    keeper: {
                        chainInfo: async () => ({
                            mediantime: T0 + 1000,
                            blocks: 1,
                        }),
                        spentBy: (op) => chain.spentBy(op),
                    },
                    ticks: 2,
                    now: () => T0 + 100 * ++clockCalls,
                    sleep: async () => undefined,
                }
            )
            expect(code).to.equal(0)
            const text = lines.join('\n')
            expect(text).to.not.contain('ERR')
            expect(text).to.contain('top-up=5000 sats (first cycle only)')
            expect(text.match(/top-up: 5000 sats/g)).to.have.length(1)
            expect(text.match(/cycle [0-9a-f]{64}/g)).to.have.length(2)
        })
    })

    describe('history', () => {
        /** A chain with one plain cycle and one cycle that carries a top-up. */
        async function twoCycles() {
            const { chain, signer } = setup()
            const { cfg, deployTx } = await deployed(
                chain,
                signer,
                heartbeatProgram()
            )
            // The first tick has no top-up; a second keeper adds it.
            const plain = await keeperOn(cfg, chain, signer).tick(T0 + 100)
            const next = {
                ...cfg,
                machineOutpoint: plain.outpoint as string,
            }
            const topped = await keeperOn(next, chain, signer, TOP_UP).tick(
                T0 + 200
            )
            expect(topped.error).to.equal(undefined)
            return { chain, deployTx, plain, topped }
        }

        it('decodeUnlocking reads chunk 10 as topUp, and 0 for a 10-chunk script', async () => {
            const { chain, plain, topped } = await twoCycles()
            const toppedArgs = decodeUnlocking(
                chain.txs.get(topped.txid!)!.inputs[0].script.chunks
            )
            expect(toppedArgs?.topUp).to.equal(TOP_UP)
            const plainArgs = decodeUnlocking(
                chain.txs.get(plain.txid!)!.inputs[0].script.chunks
            )
            expect(plainArgs?.topUp).to.equal(0n)
            // push of a 20-byte keeper address, then nine OP_0 pushes: no topUp chunk
            const ten = bsv.Script.fromHex(
                '14' + 'cd'.repeat(20) + '00'.repeat(9)
            )
            expect(ten.chunks).to.have.length(10)
            expect(decodeUnlocking(ten.chunks)?.topUp).to.equal(0n)
        })

        it('walkHistory reports the top-up of each cycle and replays it', async () => {
            const { chain, topped } = await twoCycles()
            const cycles = await walkHistory(chain, topped.outpoint!)
            expect(cycles).to.have.length(2)
            expect(cycles.map((c) => c.topUp)).to.deep.equal([0n, TOP_UP])
            expect(cycles.every((c) => !c.ambiguous)).to.equal(true)
        })

        it('inspect --history shows the top-up of a cycle and nothing for the others', async () => {
            const { chain, topped } = await twoCycles()
            const { lines, io } = sink()
            const code = await inspectCommand(
                [topped.outpoint!, '--history'],
                io,
                chain
            )
            expect(code, lines.join('\n')).to.equal(0)
            const rows = lines.filter((l) => l.includes('lockTime'))
            expect(rows).to.have.length(2)
            expect(rows[0]).to.not.contain('top-up')
            expect(rows[1]).to.contain('top-up 5000')
        })
    })
})
