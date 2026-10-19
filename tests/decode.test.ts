/**
 * Tests for the chain layer: machine decoding, history walking, the config
 * loader, the WhatsOnChain helpers and the `inspect` sub-command. No test
 * uses the network: transactions come from an in-memory map and HTTP calls
 * use a fake fetch.
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bsv } from 'scrypt-ts'
import {
    K17Machine,
    addrOf,
    newMachine,
    slotCells,
    withSlot,
    heartbeatProgram,
} from 'k17-vm'
import { relayProgram } from '../src'
import { decodeMachine } from '../src/chain/decode'
import { walkHistory, TxSource } from '../src/chain/history'
import { loadConfig, describeConfig } from '../src/chain/config'
import { addressBalance, chainInfo } from '../src/chain/provider'
import { inspectCommand } from '../src/cli/inspect'
import { main } from '../src/cli/k17forth'

const ECON = {
    beneficiary: addrOf(bsv.PrivateKey.fromRandom('testnet').toAddress()),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}
const PAYOUT_HEX = 'ab'.repeat(20)
const KEEPER_HEX = 'cd'.repeat(20)
const P2PKH = (hash: string) => bsv.Script.fromHex('76a914' + hash + '88ac')
const RELAY = relayProgram({
    hops: 2,
    epoch: 1000,
    deadline: 1_760_000_000 + 86400,
    bountyPerHop: 50,
})

/** Machine with a payout in memory roster slot 0, moved to `pc`. */
function machineAt(pc: bigint, lastTime: bigint): K17Machine {
    const mem = withSlot(
        '0'.repeat(2048),
        0,
        slotCells('11'.repeat(32), PAYOUT_HEX)
    )
    const m = newMachine(
        heartbeatProgram(),
        ECON,
        1_760_000_000n,
        undefined,
        mem
    )
    const moved = K17Machine.fromLockingScript(
        m.lockingScript.toHex()
    ) as K17Machine
    moved.pc = pc
    moved.lastTime = lastTime
    return moved
}

/** In-memory chain: txid to transaction. */
class MemoryChain implements TxSource {
    txs = new Map<string, bsv.Transaction>()
    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.txs.get(txid)
        if (!tx) throw new Error(`unknown tx ${txid}`)
        return tx
    }
    add(tx: bsv.Transaction): string {
        this.txs.set(tx.id, tx)
        return tx.id
    }
}

/** Transaction spending `prev` output `vout` as input 0, with these outputs. */
function spend(
    prev: bsv.Transaction,
    vout: number,
    outputs: [bsv.Script, number][],
    lockTime = 0
): bsv.Transaction {
    const tx = new bsv.Transaction().from({
        txId: prev.id,
        outputIndex: vout,
        script: prev.outputs[vout].script.toHex(),
        satoshis: prev.outputs[vout].satoshis,
    })
    for (const [script, satoshis] of outputs)
        tx.addOutput(new bsv.Transaction.Output({ script, satoshis }))
    tx.nLockTime = lockTime
    return tx
}

describe('chain layer', function () {
    this.timeout(60000)
    before(async () => {
        await K17Machine.loadArtifact(
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    describe('decodeMachine', () => {
        it('decodes a relay machine into roster view and disassembly', () => {
            const m = newMachine(RELAY, ECON, 1_760_000_000n)
            const result = decodeMachine(m.lockingScript.toHex())
            expect(result.reason).to.equal(null)
            expect(result.machine.prog).to.equal(RELAY)
            expect(result.machine.pc).to.equal(0)
            expect(result.machine.lastTime).to.equal(1_760_000_000n)
            expect(result.machine.roster).to.deep.equal([])
            expect(result.machine.disassembly.length).to.be.greaterThan(2)
        })

        it('shows filled roster slots', () => {
            const result = decodeMachine(
                machineAt(0n, 5n).lockingScript.toHex()
            )
            expect(result.machine.roster).to.deep.equal([
                { slot: 0, keyHashShort: '11111111', payoutHex: PAYOUT_HEX },
            ])
        })

        it('returns null with "not a K17 machine" for a P2PKH script', () => {
            const result = decodeMachine(P2PKH(KEEPER_HEX).toHex())
            expect(result).to.deep.equal({
                machine: null,
                reason: 'not a K17 machine',
            })
        })

        it('returns a template reason when one code byte differs', () => {
            const hex = newMachine(RELAY, ECON, 1n).lockingScript.toHex()
            const at = 400_000 // inside the contract code, far from the state tail
            const flipped =
                hex.slice(0, at) +
                (hex.slice(at, at + 2) === 'ff' ? '00' : 'ff') +
                hex.slice(at + 2)
            const result = decodeMachine(flipped)
            expect(result.machine).to.equal(null)
            expect(result.reason).to.contain('template')
        })
    })

    describe('walkHistory', () => {
        it('follows input 0 back to the deployment', async () => {
            const chain = new MemoryChain()
            const funding = new bsv.Transaction().addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 50000,
                })
            )
            chain.add(funding)
            const m0 = machineAt(0n, 1_760_000_000n)
            const deploy = spend(funding, 0, [[m0.lockingScript, 10000]])
            chain.add(deploy)
            // cycle 1: reward 120 to the keeper, payout 300 to the roster slot
            const c1 = spend(
                deploy,
                0,
                [
                    [machineAt(3n, 1_760_000_100n).lockingScript, 9580],
                    [P2PKH(KEEPER_HEX), 120],
                    [P2PKH(PAYOUT_HEX), 300],
                ],
                1_760_000_100
            )
            chain.add(c1)
            // cycle 2: reward 0, so the payout is output 1
            const c2 = spend(
                c1,
                0,
                [
                    [machineAt(6n, 1_760_000_200n).lockingScript, 9380],
                    [P2PKH(PAYOUT_HEX), 200],
                ],
                1_760_000_200
            )
            chain.add(c2)

            const cycles = await walkHistory(chain, `${c2.id}:0`)
            expect(cycles).to.have.length(2)
            expect(cycles[0].txid).to.equal(c1.id)
            expect(cycles[0].lockTime).to.equal(1_760_000_100)
            expect(cycles[0].reward).to.equal(120)
            expect(cycles[0].payout).to.deep.include({
                vout: 2,
                satoshis: 300,
                addressHex: PAYOUT_HEX,
                slot: 0,
            })
            expect(cycles[0].state?.pc).to.equal(3)
            expect(cycles[1].txid).to.equal(c2.id)
            expect(cycles[1].reward).to.equal(0)
            expect(cycles[1].payout).to.deep.include({
                vout: 1,
                satoshis: 200,
                slot: 0,
            })
            expect(cycles[1].state?.pc).to.equal(6)
        })

        it('returns no cycles for the deployment output itself', async () => {
            const chain = new MemoryChain()
            const funding = new bsv.Transaction().addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 50000,
                })
            )
            chain.add(funding)
            const deploy = spend(funding, 0, [
                [machineAt(0n, 1n).lockingScript, 10000],
            ])
            chain.add(deploy)
            expect(await walkHistory(chain, deploy.id)).to.deep.equal([])
        })

        it('marks a halted cycle (beneficiary refund) with null state', async () => {
            const chain = new MemoryChain()
            const funding = new bsv.Transaction().addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 50000,
                })
            )
            chain.add(funding)
            const deploy = spend(funding, 0, [
                [machineAt(0n, 1n).lockingScript, 10000],
            ])
            chain.add(deploy)
            const end = spend(
                deploy,
                0,
                [
                    [P2PKH('ee'.repeat(20)), 9900],
                    [P2PKH(KEEPER_HEX), 100],
                ],
                77
            )
            chain.add(end)
            const cycles = await walkHistory(chain, end.id)
            expect(cycles).to.have.length(1)
            expect(cycles[0].halted).to.equal(true)
            expect(cycles[0].state).to.equal(null)
            expect(cycles[0].reward).to.equal(100)
        })
    })

    describe('config', () => {
        const dir = mkdtempSync(join(tmpdir(), 'k17cfg-'))
        const body = `
[network]
name = "testnet"
[wallet]
wif = "cSECRETWIFVALUE"
[attester]
rabin_p = "123456789"
rabin_q = "987654321"
payout_address = "mtestaddress"
[bridge]
serial = "/dev/ttyUSB0"
[machine]
outpoint = "${'aa'.repeat(32)}:0"
[gateway]
slot = 2
sign_anyway = true
`
        it('loads a private file', () => {
            const path = join(dir, 'ok.toml')
            writeFileSync(path, body, { mode: 0o600 })
            chmodSync(path, 0o600)
            const cfg = loadConfig(path)
            expect(cfg.network).to.equal('testnet')
            expect(cfg.wif).to.equal('cSECRETWIFVALUE')
            expect(cfg.rabinP).to.equal('123456789')
            expect(cfg.slot).to.equal(2)
            expect(cfg.signAnyway).to.equal(true)
            expect(cfg.serial).to.equal('/dev/ttyUSB0')
        })

        it('defaults sign_anyway to false', () => {
            const path = join(dir, 'min.toml')
            writeFileSync(
                path,
                '[network]\nname = "mainnet"\n[wallet]\nwif = "x"\n'
            )
            chmodSync(path, 0o600)
            expect(loadConfig(path).signAnyway).to.equal(false)
        })

        it('rejects a group or world readable file without printing secrets', () => {
            const path = join(dir, 'open.toml')
            writeFileSync(path, body)
            chmodSync(path, 0o644)
            let message = ''
            try {
                loadConfig(path)
            } catch (e) {
                message = (e as Error).message
            }
            expect(message).to.contain('chmod 600')
            expect(message).to.not.contain('SECRET')
        })

        it('rejects an unknown network and a missing wif', () => {
            const a = join(dir, 'badnet.toml')
            writeFileSync(
                a,
                '[network]\nname = "regtest"\n[wallet]\nwif = "x"\n'
            )
            chmodSync(a, 0o600)
            expect(() => loadConfig(a)).to.throw('network')
            const b = join(dir, 'nowif.toml')
            writeFileSync(b, '[network]\nname = "testnet"\n')
            chmodSync(b, 0o600)
            expect(() => loadConfig(b)).to.throw('wif')
        })

        it('never shows secrets in its description', () => {
            const path = join(dir, 'desc.toml')
            writeFileSync(path, body)
            chmodSync(path, 0o600)
            const text = describeConfig(loadConfig(path))
            expect(text).to.not.contain('SECRET')
            expect(text).to.not.contain('123456789')
            expect(text).to.not.contain('987654321')
            expect(text).to.contain('testnet')
        })
    })

    describe('WhatsOnChain helpers', () => {
        const fake =
            (answers: Record<string, unknown>) => async (url: string) => {
                const hit = answers[url]
                return {
                    ok: hit !== undefined,
                    status: hit !== undefined ? 200 : 404,
                    json: async () => hit,
                }
            }
        it('reads mediantime and blocks from chain/info', async () => {
            const f = fake({
                'https://api.whatsonchain.com/v1/bsv/test/chain/info': {
                    mediantime: 1760000000,
                    blocks: 1700,
                    chain: 'test',
                },
            })
            expect(await chainInfo('testnet', f)).to.deep.equal({
                mediantime: 1760000000,
                blocks: 1700,
            })
        })

        it('reads the balance from /address/<addr>/balance', async () => {
            const f = fake({
                'https://api.whatsonchain.com/v1/bsv/main/address/1abc/balance':
                    { confirmed: 5000, unconfirmed: -200 },
            })
            expect(await addressBalance('mainnet', '1abc', f)).to.equal(4800)
        })

        it('throws a clear error on an HTTP failure', async () => {
            let message = ''
            try {
                await chainInfo('testnet', fake({}))
            } catch (e) {
                message = (e as Error).message
            }
            expect(message).to.contain('404')
        })
    })

    describe('inspect', () => {
        /** Chain with a deployment and one cycle; returns the tip txid. */
        function build(): { chain: MemoryChain; tip: string } {
            const chain = new MemoryChain()
            const funding = new bsv.Transaction().addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 50000,
                })
            )
            chain.add(funding)
            const deploy = spend(funding, 0, [
                [machineAt(0n, 1_760_000_000n).lockingScript, 10000],
            ])
            chain.add(deploy)
            const c1 = spend(
                deploy,
                0,
                [
                    [machineAt(3n, 1_760_000_100n).lockingScript, 9880],
                    [P2PKH(KEEPER_HEX), 120],
                ],
                1_760_000_100
            )
            chain.add(c1)
            return { chain, tip: c1.id }
        }

        it('prints the state of the output', async () => {
            const { chain, tip } = build()
            const out: string[] = []
            const code = await inspectCommand(
                [tip],
                { out: (l) => out.push(l), err: (l) => out.push('ERR ' + l) },
                chain
            )
            expect(code).to.equal(0)
            const text = out.join('\n')
            expect(text).to.contain('pc 3')
            expect(text).to.contain(
                `roster 0 key=11111111.. payout=${PAYOUT_HEX}`
            )
            expect(text).to.not.contain('ERR')
        })

        it('prints history with --history', async () => {
            const { chain, tip } = build()
            const out: string[] = []
            await inspectCommand(
                [`${tip}:0`, '--history'],
                { out: (l) => out.push(l), err: () => undefined },
                chain
            )
            const text = out.join('\n')
            expect(text).to.contain(tip)
            expect(text).to.contain('reward 120')
            expect(text).to.contain('lockTime 1760000100')
        })

        it('prints one JSON object with --json', async () => {
            const { chain, tip } = build()
            const out: string[] = []
            await inspectCommand(
                [tip, '--history', '--json'],
                { out: (l) => out.push(l), err: () => undefined },
                chain
            )
            const parsed = JSON.parse(out.join('\n'))
            expect(parsed.machine.pc).to.equal(3)
            expect(parsed.history).to.have.length(1)
            expect(parsed.history[0].reward).to.equal(120)
            expect(parsed.machine.lastTime).to.equal('1760000100')
        })

        it('explains when the output is not a machine', async () => {
            const { chain, tip } = build()
            const err: string[] = []
            const code = await inspectCommand(
                [`${tip}:1`],
                { out: () => undefined, err: (l) => err.push(l) },
                chain
            )
            expect(code).to.equal(1)
            expect(err.join('\n')).to.contain('not a K17 machine')
        })

        it('rejects a bad outpoint', async () => {
            const err: string[] = []
            const code = await inspectCommand(
                ['nothex'],
                { out: () => undefined, err: (l) => err.push(l) },
                new MemoryChain()
            )
            expect(code).to.equal(2)
        })

        it('is reachable from the main dispatcher', () => {
            const err: string[] = []
            const result = main(['inspect'], {
                out: () => undefined,
                err: (l) => err.push(l),
            })
            return Promise.resolve(result).then((code) =>
                expect(code).to.equal(2)
            )
        })
    })
})
