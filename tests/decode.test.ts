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
    payoutOf,
    Op,
    SparseMerkleTree,
    encodeLeafPre,
} from 'k17-vm'
import { compileToHex, relayProgram } from '../src'
import { FUNDING, T0, cycle, keeper } from './utils/chain'
import { getDefaultSigner } from './utils/txHelper'
import { decodeMachine } from '../src/chain/decode'
import { walkHistory, decodeUnlocking, TxSource } from '../src/chain/history'
import { loadConfig, describeConfig } from '../src/chain/config'
import { addressBalance, chainInfo } from '../src/chain/provider'
import { deadManText, inspectCommand } from '../src/cli/inspect'
import { main } from '../src/cli/k17forth'
import { loadK17Artifact } from '../src/chain/artifact'

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
    /** Answer unknown ids with a stub funding transaction. */
    stubUnknown = false
    async getTransaction(txid: string): Promise<bsv.Transaction> {
        const tx = this.txs.get(txid)
        if (tx) return tx
        if (!this.stubUnknown) throw new Error(`unknown tx ${txid}`)
        // stands in for the wallet funding transaction of a real deployment
        return new bsv.Transaction()
            .addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 1,
                })
            )
            .addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 1,
                })
            )
            .addOutput(
                new bsv.Transaction.Output({
                    script: P2PKH(KEEPER_HEX),
                    satoshis: 1,
                })
            )
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

const keeperAddress = keeper

/** A real two-cycle chain, built once: see realChain. */
let realChainPromise: Promise<RealChain> | undefined

interface RealChain {
    chain: MemoryChain
    deployTx: bsv.Transaction
    cycle1: Awaited<ReturnType<typeof cycle>>
    cycle2: Awaited<ReturnType<typeof cycle>>
}

/**
 * Build (once) a deployed machine and two real cycles, checked by the script
 * interpreter. The roster slot 0 payout is the keeper's own address.
 * Cycle 1 only pays the keeper; cycle 2 also pays 300 sats to slot 0.
 */
function realChain(): Promise<RealChain> {
    if (!realChainPromise)
        realChainPromise = (async () => {
            const mem = withSlot(
                '0'.repeat(2048),
                0,
                slotCells('11'.repeat(32), payoutOf(keeperAddress))
            )
            const prog = compileToHex('yield 300 0 payslot yield yield')
            const m = newMachine(prog, ECON, T0, undefined, mem)
            await m.connect(getDefaultSigner())
            const deployTx = await m.deploy(FUNDING)
            const cycle1 = await cycle(m, BigInt(FUNDING), T0 + 100n)
            const cycle2 = await cycle(
                cycle1.next,
                cycle1.plan.remaining,
                T0 + 200n
            )
            const chain = new MemoryChain()
            chain.stubUnknown = true
            for (const tx of [deployTx, cycle1.tx, cycle2.tx]) chain.add(tx)
            return { chain, deployTx, cycle1, cycle2 }
        })()
    return realChainPromise
}

describe('chain layer', function () {
    this.timeout(60000)
    before(async () => {
        loadK17Artifact()
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

        it('returns a template reason, not an exception, when the state tail is malformed', () => {
            const hex = newMachine(RELAY, ECON, 1n).lockingScript.toHex()
            // Cut the serialised state short: rebuilding it must not throw.
            const truncated = hex.slice(0, hex.length - 6)
            const result = decodeMachine(truncated)
            expect(result.machine).to.equal(null)
            expect(result.reason).to.contain('template')
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
            // A byte a quarter of the way in: inside the contract code, far from the
            // state tail, whatever the script size.
            const at = Math.floor(hex.length / 8) * 2
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
        it('tells reward from payout by replay when keeper and payout address are the same', async () => {
            const { chain, deployTx, cycle1, cycle2 } = await realChain()
            expect(chain.txs.has(deployTx.id)).to.equal(true)
            const cycles = await walkHistory(chain, `${cycle2.tx.id}:0`)
            expect(cycles).to.have.length(2)
            // cycle 1 pays only the keeper, whose address is also the slot payout
            expect(cycles[0].txid).to.equal(cycle1.tx.id)
            expect(cycles[0].ambiguous).to.equal(false)
            expect(cycles[0].reward).to.equal(Number(cycle1.plan.reward))
            expect(cycles[0].reward).to.be.greaterThan(0)
            expect(cycles[0].payout).to.equal(undefined)
            expect(cycles[0].lockTime).to.equal(Number(T0) + 100)
            // cycle 2 pays the keeper and the slot, to the same address
            expect(cycles[1].ambiguous).to.equal(false)
            expect(cycles[1].reward).to.equal(Number(cycle2.plan.reward))
            expect(cycles[1].payout).to.deep.include({
                vout: 2,
                satoshis: 300,
                addressHex: payoutOf(keeperAddress),
                slot: 0,
            })
            expect(cycles[1].state?.lastTime).to.equal(T0 + 200n)
        })

        it('marks a cycle ambiguous when it has no readable unlocking script', async () => {
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
            const c1 = spend(
                deploy,
                0,
                [
                    [machineAt(3n, 2n).lockingScript, 9880],
                    [P2PKH(KEEPER_HEX), 120],
                ],
                2
            )
            chain.add(c1)
            const cycles = await walkHistory(chain, c1.id)
            expect(cycles).to.have.length(1)
            expect(cycles[0].ambiguous).to.equal(true)
            expect(cycles[0].reward).to.equal(null)
            expect(cycles[0].payout).to.equal(undefined)
            expect(cycles[0].state?.pc).to.equal(3)
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
            expect(cycles[0].ambiguous).to.equal(true)
        })
    })

    describe('v3 tree cycle', () => {
        /**
         * Deploy a v3 machine whose roster tree holds one member, run a
         * `MEMBER DROP YIELD HALT` cycle with that member's proof, and check
         * that the history decoder reads the three tree chunks and replays the
         * cycle (not `ambiguous`).
         */
        it('decodes the tree chunks of a MEMBER cycle and replays it', async () => {
            const memberKeyHash = '5a'.repeat(32)
            const memberLeaf = encodeLeafPre(
                memberKeyHash,
                payoutOf(keeperAddress),
                0n
            )
            const tree = new SparseMerkleTree()
            tree.set(5, memberLeaf)
            const proofForMember = tree.proof(5)
            const prog = [Op.MEMBER, Op.DROP, Op.YIELD, Op.HALT]
                .map((op) => op.toString(16).padStart(2, '0'))
                .join('')
            const m = newMachine(
                prog,
                ECON,
                T0,
                undefined,
                undefined,
                undefined,
                {
                    rosterRoot: tree.root(),
                    sponsorKeyHash: '77'.repeat(32),
                }
            )
            await m.connect(getDefaultSigner())
            const deployTx = await m.deploy(FUNDING)
            const run = await cycle(
                m,
                BigInt(FUNDING),
                T0 + 100n,
                [],
                undefined,
                {},
                proofForMember
            )
            expect(run.plan.treeOp).to.equal('member')
            const args = decodeUnlocking(run.tx.inputs[0].script.chunks)
            expect(args?.tree).to.deep.equal({
                leafPre: memberLeaf,
                proof: proofForMember.proof,
                leafIndex: 5n,
            })
            const chain = new MemoryChain()
            chain.stubUnknown = true
            chain.add(deployTx)
            chain.add(run.tx)
            const cycles = await walkHistory(chain, `${run.tx.id}:0`)
            expect(cycles).to.have.length(1)
            expect(cycles[0].ambiguous).to.equal(false)
            expect(cycles[0].reward).to.equal(Number(run.plan.reward))
        })

        it('reads a 7-chunk (v2) unlocking script as having no tree', () => {
            // push of a 20-byte keeper address, then six OP_0 pushes
            const script = bsv.Script.fromHex(
                '14' + 'cd'.repeat(20) + '00'.repeat(6)
            )
            const args = decodeUnlocking(script.chunks)
            expect(args).to.not.equal(null)
            expect(args?.tree).to.equal(undefined)
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

        it('does not echo a malformed secret line from a TOML error', () => {
            const path = join(dir, 'broken.toml')
            writeFileSync(
                path,
                '[network]\nname = "testnet"\n[wallet]\nwif = cLEAKEDSECRET99\n'
            )
            chmodSync(path, 0o600)
            let message = ''
            try {
                loadConfig(path)
            } catch (e) {
                message = (e as Error).message
            }
            expect(message).to.contain('not valid TOML at row 4, col 7')
            expect(message).to.not.contain('LEAKEDSECRET')
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
        it('prints the state of the output', async () => {
            const { chain, cycle2 } = await realChain()
            const out: string[] = []
            const code = await inspectCommand(
                [cycle2.tx.id],
                { out: (l) => out.push(l), err: (l) => out.push('ERR ' + l) },
                chain
            )
            expect(code).to.equal(0)
            const text = out.join('\n')
            expect(text).to.contain('pc ')
            expect(text).to.contain(`lastTime ${T0 + 200n}`)
            expect(text).to.contain(
                `roster 0 key=11111111.. payout=${payoutOf(keeperAddress)}`
            )
            expect(text).to.not.contain('ERR')
        })

        it('prints the dead-man interval: off, or seconds with a unit', async () => {
            const { chain, cycle2 } = await realChain()
            const off: string[] = []
            await inspectCommand(
                [cycle2.tx.id],
                { out: (l) => off.push(l), err: () => undefined },
                chain
            )
            expect(off.join('\n')).to.contain('dead-man: off')

            const m = newMachine(
                compileToHex('yield'),
                { ...ECON, deadMan: 2_592_000n },
                T0
            )
            const tx = new bsv.Transaction().addOutput(
                new bsv.Transaction.Output({
                    script: m.lockingScript,
                    satoshis: 1000,
                })
            )
            chain.add(tx)
            expect(
                decodeMachine(m.lockingScript.toHex()).machine?.deadMan
            ).to.equal(2_592_000n)
            const on: string[] = []
            await inspectCommand(
                [`${tx.id}:0`],
                { out: (l) => on.push(l), err: () => undefined },
                chain
            )
            expect(on.join('\n')).to.contain('dead-man: 2592000 s (30 days)')
            expect(deadManText(21_600n)).to.equal('21600 s (6 hours)')
            expect(deadManText(21_601n)).to.equal('21601 s')
        })

        it('prints history with --history', async () => {
            const { chain, cycle1, cycle2 } = await realChain()
            const out: string[] = []
            await inspectCommand(
                [`${cycle2.tx.id}:0`, '--history'],
                { out: (l) => out.push(l), err: () => undefined },
                chain
            )
            const text = out.join('\n')
            expect(text).to.contain('history (2 cycles')
            expect(text).to.contain(cycle1.tx.id)
            expect(text).to.contain(`reward ${cycle1.plan.reward} ->`)
            expect(text).to.contain(
                `payout 300 to ${payoutOf(keeperAddress)} (slot 0)`
            )
            expect(text).to.not.contain('ambiguous')
        })

        it('says so when a cycle is ambiguous', async () => {
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
            const c1 = spend(
                deploy,
                0,
                [
                    [machineAt(3n, 2n).lockingScript, 9880],
                    [P2PKH(KEEPER_HEX), 120],
                ],
                2
            )
            chain.add(c1)
            const out: string[] = []
            await inspectCommand(
                [c1.id, '--history'],
                { out: (l) => out.push(l), err: () => undefined },
                chain
            )
            expect(out.join('\n')).to.contain('ambiguous')
        })

        it('prints one JSON object with --json', async () => {
            const { chain, cycle2 } = await realChain()
            const out: string[] = []
            await inspectCommand(
                [cycle2.tx.id, '--history', '--json'],
                { out: (l) => out.push(l), err: () => undefined },
                chain
            )
            const parsed = JSON.parse(out.join('\n'))
            expect(parsed.machine.lastTime).to.equal((T0 + 200n).toString())
            expect(parsed.history).to.have.length(2)
            expect(parsed.history[1].payout.slot).to.equal(0)
            expect(parsed.history[1].ambiguous).to.equal(false)
        })

        it('explains when the output is not a machine', async () => {
            const { chain, cycle2 } = await realChain()
            const err: string[] = []
            const code = await inspectCommand(
                [`${cycle2.tx.id}:1`],
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
