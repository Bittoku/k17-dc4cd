/**
 * Tests for the third-party top-up flow (`k17forth topup offer|sign|complete`
 * and `--top-up-offer`).
 *
 * Covers: the happy path offer -> request -> sign -> complete on a plain
 * machine (Keeper.buildTopUpRequest) and on a tree machine through
 * `admit --top-up-offer`; the funder's refusals, each on its own (a tampered
 * topUp argument or amount, a machine prevout that is not the tip, an extra
 * output, the coin missing, at another index, twice, signed or spent, a
 * wrong instance id, a machine with a copied instance id, a second coin of
 * the funder key, input 0 not a machine, a coin value that is not the
 * amount, and a machine unlocking script that is not push-only, has an extra
 * push or a non-minimal push); `complete` run again or after a send that
 * failed once the node took the cycle;
 * the planner's refusal of a halting cycle before any request; `complete` on
 * a stale request; and the flag rules (`--top-up` with `--top-up-offer`, the
 * loops). The chain is in memory; no test uses the network.
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv } from 'scrypt-ts'
import {
    DEAD_MAN_FLOOR,
    FunderInput,
    K17Machine,
    NO_SIG,
    buildFundedCycleTx,
    planCycle,
    rosterOf,
    addrOf,
    assemble,
    heartbeatProgram,
    keyHash,
    newAttester,
    newMachine,
    pubKeyBytes,
    readSlot,
} from 'k17-vm'
import { GatewayConfig, loadConfig, saveAttesterKey } from '../src/chain/config'
import { decodeInstance, decodeMachine } from '../src/chain/decode'
import { decodeUnlocking, parseOutpoint } from '../src/chain/history'
import { Keeper } from '../src/chain/keeper'
import {
    TopUpOffer,
    TopUpRequest,
    makeExactCoin,
    readOffer,
    readRequest,
    readSignature,
    requestIdOf,
} from '../src/chain/topup'
import { admitCommand, removeCommand } from '../src/cli/admit'
import { deployCommand } from '../src/cli/deploy'
import { endorseCommand } from '../src/cli/endorse'
import { gatewayCommand } from '../src/cli/gateway'
import { keeperCommand } from '../src/cli/keeper'
import { main } from '../src/cli/k17forth'
import { topupCommand } from '../src/cli/topup'
import { treeConsortiumSource } from '../src/programs/treeConsortium'
import {
    MemoryChain,
    OPTS,
    PAYOUT_ADDRESS,
    WALLET_KEY,
    chainClock,
    consortiumOnChain,
    keeperOptions,
    landowner,
    sink,
    sponsor,
} from './utils/consortiumChain'

const T0 = 1_760_000_000
const FUNDING = 100_000
const AMOUNT = 5000n
const FUNDER_KEY = bsv.PrivateKey.fromRandom('testnet')
const ECON = {
    beneficiary: addrOf(bsv.PrivateKey.fromRandom('testnet').toAddress()),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}
/** Median time past far ahead of every clock in these tests. */
const MTP = T0 + 1_000_000

/** A memory chain whose next send takes the transaction and then fails. */
class AcceptThenFailChain extends MemoryChain {
    /** When true, the next send stores the transaction and throws. */
    failAfterNextSend = false

    /**
     * Store the transaction; throw a timeout after that when asked to.
     * Input: raw transaction hex. Output: the txid.
     */
    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const txid = await super.sendRawTransaction(rawTxHex)
        if (this.failAfterNextSend) {
            this.failAfterNextSend = false
            throw new Error('timeout after the node took the transaction')
        }
        return txid
    }
}

/** A memory chain that lists the real unspent P2PKH coins of an address. */
class ListingChain extends MemoryChain {
    /**
     * Put a coin of `sats` on an address (a transaction with a made-up input).
     * Input: the address and the value. Output: none.
     */
    seed(address: bsv.Address, sats: number): void {
        const tx = new bsv.Transaction()
        tx.addInput(
            new bsv.Transaction.Input({
                prevTxId: Buffer.alloc(32, this.txs.size + 1),
                outputIndex: 0,
                script: new bsv.Script(''),
            }),
            bsv.Script.buildPublicKeyHashOut(address),
            sats + 1000
        )
        tx.addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.buildPublicKeyHashOut(address),
                satoshis: sats,
            })
        )
        this.add(tx)
    }

    /**
     * The unspent P2PKH outputs of an address on this chain.
     * Input: the address. Output: the coins.
     */
    async listUnspent(address: bsv.Address | string) {
        const script = bsv.Script.buildPublicKeyHashOut(
            bsv.Address.fromString(address.toString())
        ).toHex()
        const coins = []
        for (const tx of this.txs.values())
            for (let i = 0; i < tx.outputs.length; i++)
                if (
                    tx.outputs[i].script.toHex() === script &&
                    !this.spenders.has(`${tx.id}:${i}`)
                )
                    coins.push({
                        txId: tx.id,
                        outputIndex: i,
                        satoshis: tx.outputs[i].satoshis,
                        script,
                    })
        return coins
    }
}

describe('third-party top-up (topup offer, sign, complete)', function () {
    this.timeout(600_000)
    const dir = mkdtempSync(join(tmpdir(), 'k17offer-'))
    let counter = 0

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    /** A new path in the test directory. */
    const path = (name: string) => join(dir, `${counter++}-${name}`)

    /** Write a config file (mode 600) and return its path. */
    function config(key: bsv.PrivateKey, machine?: string): string {
        const p = path('cfg.toml')
        writeFileSync(
            p,
            `[network]\nname = "testnet"\n[wallet]\nwif = "${key.toWIF()}"\n${
                machine ? `[machine]\noutpoint = "${machine}"\n` : ''
            }`
        )
        chmodSync(p, 0o600)
        return p
    }

    /** Spends lookup of a chain, for the topup commands. */
    const deps = (chain: MemoryChain, signer?: TestWallet) => ({
        provider: chain,
        signer,
        spentBy: (op: { txid: string; vout: number }) => chain.spentBy(op),
    })

    /** A keeper on `cfg` with the far-ahead MTP. */
    const keeperOn = (cfg: GatewayConfig, chain: MemoryChain) =>
        new Keeper(cfg, chain, new TestWallet(WALLET_KEY, chain), {
            chainInfo: async () => ({ mediantime: MTP, blocks: 1 }),
            spentBy: (op) => chain.spentBy(op),
        })

    /**
     * Deploy a program with the keeper wallet.
     * Output: the keeper config (object) that names the machine.
     */
    async function deployed(
        chain: MemoryChain,
        prog = heartbeatProgram(),
        deadMan = 0n
    ): Promise<GatewayConfig> {
        const m = newMachine(prog, { ...ECON, deadMan }, BigInt(T0))
        await m.connect(new TestWallet(WALLET_KEY, chain))
        const deployTx = await m.deploy(FUNDING)
        return {
            network: 'testnet',
            wif: WALLET_KEY.toWIF(),
            machineOutpoint: `${deployTx.id}:0`,
            signAnyway: false,
        }
    }

    /**
     * Run `topup offer` for a machine.
     * Output: the offer path and the offer.
     */
    async function makeOffer(
        chain: MemoryChain,
        machine: string,
        amount = AMOUNT,
        signer = new TestWallet(FUNDER_KEY, chain)
    ): Promise<{ offerPath: string; offer: TopUpOffer; funderCfg: string }> {
        const funderCfg = config(FUNDER_KEY)
        const offerPath = path('offer.json')
        const { lines, io } = sink()
        const code = await topupCommand(
            [
                'offer',
                funderCfg,
                '--machine',
                machine,
                '--amount',
                amount.toString(),
                '--out',
                offerPath,
            ],
            io,
            deps(chain, signer)
        )
        expect(code, lines.join('\n')).to.equal(0)
        return {
            offerPath,
            offer: readOffer(readFileSync(offerPath, 'utf8')),
            funderCfg,
        }
    }

    /** Write a request file and return its path. */
    function requestFile(request: TopUpRequest): string {
        const p = path('request.json')
        writeFileSync(p, JSON.stringify(request))
        return p
    }

    /** Run `topup sign`. Output: exit code, text, and the signature path. */
    async function sign(
        chain: MemoryChain,
        funderCfg: string,
        requestPath: string,
        offerPath: string
    ) {
        const sigPath = path('sig.json')
        const { lines, io } = sink()
        const code = await topupCommand(
            [
                'sign',
                funderCfg,
                requestPath,
                '--offer',
                offerPath,
                '--out',
                sigPath,
            ],
            io,
            deps(chain)
        )
        return { code, text: lines.join('\n'), sigPath }
    }

    /** Run `topup complete`. Output: exit code and text. */
    async function complete(
        chain: MemoryChain,
        requestPath: string,
        sigPath: string
    ) {
        const { lines, io } = sink()
        const code = await topupCommand(
            ['complete', requestPath, sigPath],
            io,
            deps(chain)
        )
        return { code, text: lines.join('\n') }
    }

    /**
     * A plain machine, an offer for it and a request built by the keeper at
     * clock `now`. Output: everything the tests need.
     */
    async function offered(now = T0 + 100, chain = new MemoryChain()) {
        const cfg = await deployed(chain)
        const { offer, offerPath, funderCfg } = await makeOffer(
            chain,
            cfg.machineOutpoint as string
        )
        const built = await keeperOn(cfg, chain).buildTopUpRequest(now, offer)
        expect(built.error, built.error).to.equal(undefined)
        expect(built.request).to.not.equal(undefined)
        const request = built.request as TopUpRequest
        return {
            chain,
            cfg,
            offer,
            offerPath,
            funderCfg,
            built,
            request,
            requestPath: requestFile(request),
        }
    }

    /** P2PKH script hex of the funder key. */
    const funderScript = bsv.Script.buildPublicKeyHashOut(
        FUNDER_KEY.toAddress()
    ).toHex()

    describe('happy path', () => {
        it('offer -> request -> sign -> complete adds the amount once; lastTime is as without a top-up', async () => {
            const f = await offered()
            // The offer coin holds exactly the amount on the funder key.
            const { txid, vout } = parseOutpoint(f.offer.coin)
            const coinOut = f.chain.txs.get(txid)!.outputs[vout]
            expect(BigInt(coinOut.satoshis)).to.equal(AMOUNT)
            expect(coinOut.script.toHex()).to.equal(funderScript)
            expect(f.offer.instanceId).to.equal(
                (
                    K17Machine.fromTx(
                        f.chain.txs.get(
                            parseOutpoint(f.cfg.machineOutpoint as string).txid
                        )!,
                        0
                    ) as K17Machine
                ).instanceId.toLowerCase()
            )
            // The request holds no key and sends nothing.
            const requestText = readFileSync(f.requestPath, 'utf8')
            expect(requestText).to.not.contain(WALLET_KEY.toWIF())
            expect(requestText).to.not.contain(FUNDER_KEY.toWIF())
            const before = f.chain.cycleBroadcasts
            expect(f.request.machinePrevout).to.equal(f.cfg.machineOutpoint)
            expect(f.request.machineInputIndex).to.equal(0)
            expect(f.request.funderInputIndex).to.equal(1)

            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(0)
            const sig = readSignature(readFileSync(signed.sigPath, 'utf8'))
            expect(sig.requestId).to.equal(requestIdOf(f.request.txHex))
            expect(readFileSync(signed.sigPath, 'utf8')).to.not.contain(
                FUNDER_KEY.toWIF()
            )
            expect(f.chain.cycleBroadcasts).to.equal(before)

            const done = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(done.code, done.text).to.equal(0)
            expect(f.chain.cycleBroadcasts).to.equal(before + 1)
            const cycleId = /txid ([0-9a-f]{64})/.exec(done.text)![1]
            const cycle = f.chain.txs.get(cycleId)!
            const value = BigInt(FUNDING) - (f.built.reward as bigint)
            expect(BigInt(cycle.outputs[0].satoshis)).to.equal(value + AMOUNT)
            expect(done.text).to.contain(`new machine value ${value + AMOUNT}`)
            // The funder coin is spent by this cycle only, and no output
            // pays the funder's script.
            expect(await f.chain.spentBy(parseOutpoint(f.offer.coin))).to.equal(
                cycleId
            )
            expect(
                cycle.outputs.some((o) => o.script.toHex() === funderScript)
            ).to.equal(false)
            expect(
                decodeUnlocking(cycle.inputs[0].script.chunks)?.topUp
            ).to.equal(AMOUNT)
            expect(f.chain.verifyMachineSpends()).to.equal(1)

            // The same cycle with no top-up on a twin chain: same lastTime
            // and reward; the machine value differs by the amount only.
            const twin = new MemoryChain()
            const twinCfg = await deployed(twin)
            const plain = await keeperOn(twinCfg, twin).tick(T0 + 100)
            expect(plain.error).to.equal(undefined)
            const plainTx = twin.txs.get(plain.txid!)!
            const toppedMachine = K17Machine.fromTx(cycle, 0) as K17Machine
            const plainMachine = K17Machine.fromTx(plainTx, 0) as K17Machine
            expect(toppedMachine.lastTime).to.equal(plainMachine.lastTime)
            expect(toppedMachine.lastTime).to.equal(BigInt(T0 + 100))
            expect(plain.reward).to.equal(f.built.reward)
            expect(BigInt(cycle.outputs[0].satoshis)).to.equal(
                BigInt(plainTx.outputs[0].satoshis) + AMOUNT
            )
        })

        it('offer uses a coin of exactly the amount that the wallet holds already', async () => {
            const chain = new ListingChain()
            chain.seed(FUNDER_KEY.toAddress(), 50_000)
            chain.seed(WALLET_KEY.toAddress(), 500_000)
            const cfg = await deployed(chain)
            const wallet = () => {
                const w = new TestWallet(FUNDER_KEY, chain)
                w.enableSplitFeeTx(false)
                return w
            }
            const first = await makeOffer(
                chain,
                cfg.machineOutpoint as string,
                AMOUNT,
                wallet()
            )
            const { lines, io } = sink()
            const out = path('offer2.json')
            const code = await topupCommand(
                [
                    'offer',
                    first.funderCfg,
                    '--machine',
                    cfg.machineOutpoint as string,
                    '--amount',
                    AMOUNT.toString(),
                    '--out',
                    out,
                ],
                io,
                deps(chain, wallet())
            )
            expect(code, lines.join('\n')).to.equal(0)
            expect(lines.join('\n')).to.contain('already in the wallet')
            expect(readOffer(readFileSync(out, 'utf8')).coin).to.equal(
                first.offer.coin
            )
        })
    })

    describe('funder refusals', () => {
        /** Sign a (tampered) request and expect a refusal with `text`. */
        async function refused(
            f: Awaited<ReturnType<typeof offered>>,
            request: TopUpRequest,
            text: string | RegExp
        ) {
            const before = f.chain.txs.size
            const signed = await sign(
                f.chain,
                f.funderCfg,
                requestFile(request),
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(1)
            if (typeof text === 'string') expect(signed.text).to.contain(text)
            else expect(signed.text).to.match(text)
            expect(f.chain.txs.size).to.equal(before)
            return signed
        }

        /** Minimal script-number bytes of a positive value. */
        function scriptNum(value: bigint): Buffer {
            const bytes: number[] = []
            for (let v = value; v > 0n; v >>= 8n) bytes.push(Number(v & 0xffn))
            if (bytes[bytes.length - 1] & 0x80) bytes.push(0)
            return Buffer.from(bytes)
        }

        /** The request transaction with a new topUp argument on input 0. */
        function withTopUpArg(txHex: string, topUp: bigint): string {
            const tx = new bsv.Transaction(txHex)
            const old = tx.inputs[0].script
            const script = new bsv.Script('')
            old.chunks.forEach((chunk, i) => {
                if (i === 10) script.add(scriptNum(topUp))
                else if (chunk.buf) script.add(chunk.buf)
                else script.add(chunk.opcodenum)
            })
            tx.inputs[0].setScript(script)
            return tx.uncheckedSerialize()
        }

        /** A funder input for a coin of the funder key, with a claimed value. */
        const coinInput = (outpoint: string, sats: bigint): FunderInput => {
            const { txid, vout } = parseOutpoint(outpoint)
            return {
                txId: txid,
                outputIndex: vout,
                satoshis: sats,
                script: funderScript,
            }
        }

        /**
         * A request that a dishonest keeper builds by hand with k17-vm: the
         * cycle at T0 + 100 from the deployed machine, with `coins` as the
         * funder inputs and `topUp` on the machine input.
         */
        async function craft(
            f: Awaited<ReturnType<typeof offered>>,
            coins: FunderInput[],
            topUp: bigint,
            coin = f.offer.coin
        ): Promise<TopUpRequest> {
            const prevTx = f.chain.txs.get(
                parseOutpoint(f.cfg.machineOutpoint as string).txid
            )!
            const m = K17Machine.fromTx(prevTx, 0) as K17Machine
            const wallet = new TestWallet(WALLET_KEY, f.chain)
            const keeperAddress = await wallet.getDefaultAddress()
            const lock = BigInt(T0 + 100)
            const plan = planCycle(
                m,
                BigInt(FUNDING),
                lock,
                keeperAddress,
                [],
                NO_SIG,
                {},
                undefined,
                { topUp }
            )
            await m.connect(wallet)
            const built = await buildFundedCycleTx(
                m,
                plan,
                keeperAddress,
                lock,
                coins
            )
            return { ...f.request, coin, txHex: built.tx.uncheckedSerialize() }
        }

        /** The request transaction with input 0's unlocking script replaced. */
        function withUnlocking(
            txHex: string,
            change: (script: bsv.Script) => string
        ): string {
            const tx = new bsv.Transaction(txHex)
            tx.inputs[0].setScript(
                bsv.Script.fromHex(change(tx.inputs[0].script))
            )
            return tx.uncheckedSerialize()
        }

        /** Hex of a script made of some chunks of another script. */
        const chunksHex = (script: bsv.Script, from: number, to?: number) => {
            const part = new bsv.Script('')
            for (const chunk of script.chunks.slice(from, to))
                if (chunk.buf) part.add(chunk.buf)
                else part.add(chunk.opcodenum)
            return part.toHex()
        }

        it('refuses a machine with a copied instance id (another lineage)', async () => {
            const f = await offered()
            // A real K17 machine of the attacker with the same instance id.
            const clone = newMachine(
                heartbeatProgram(),
                ECON,
                BigInt(T0),
                rosterOf(),
                undefined,
                f.offer.instanceId
            )
            await clone.connect(new TestWallet(WALLET_KEY, f.chain))
            const cloneTx = await clone.deploy(FUNDING)
            const cloneCfg = { ...f.cfg, machineOutpoint: `${cloneTx.id}:0` }
            const built = await keeperOn(cloneCfg, f.chain).buildTopUpRequest(
                T0 + 100,
                { ...f.offer, machine: cloneCfg.machineOutpoint }
            )
            expect(built.error).to.equal(undefined)
            await refused(
                f,
                built.request as TopUpRequest,
                `but the unspent tip of the machine named in the offer (${f.offer.machine}) is ${f.offer.machine}`
            )
        })

        it('refuses a request with a second coin of the funder key (two offers in one transaction)', async () => {
            const f = await offered()
            const second = await makeExactCoin(
                new TestWallet(FUNDER_KEY, f.chain),
                AMOUNT,
                new Set([f.offer.coin])
            )
            expect(second.outpoint).to.not.equal(f.offer.coin)
            const request = await craft(
                f,
                [
                    coinInput(f.offer.coin, AMOUNT),
                    coinInput(second.outpoint, AMOUNT),
                ],
                2n * AMOUNT
            )
            await refused(
                f,
                request,
                "input 2 spends another coin of this funder's key"
            )
        })

        it('refuses a request whose input 0 is not a K17 machine', async () => {
            const f = await offered()
            const tx = new bsv.Transaction(f.request.txHex)
            const { txid, vout } = parseOutpoint(f.offer.coin)
            tx.inputs[0] = new bsv.Transaction.Input({
                prevTxId: Buffer.from(txid, 'hex'),
                outputIndex: vout,
                script: tx.inputs[0].script,
                sequenceNumber: tx.inputs[0].sequenceNumber,
            })
            await refused(
                f,
                {
                    ...f.request,
                    machinePrevout: f.offer.coin,
                    txHex: tx.uncheckedSerialize(),
                },
                'which is not a K17 machine'
            )
        })

        it('refuses a coin whose value on the chain is not the amount', async () => {
            const f = await offered()
            const bigger = await makeExactCoin(
                new TestWallet(FUNDER_KEY, f.chain),
                AMOUNT + 1n
            )
            // The funder's own offer names this coin with the amount
            // (a wrong offer file); the keeper claims the amount as its value.
            const offerPath = path('offer-bigger.json')
            writeFileSync(
                offerPath,
                JSON.stringify({ ...f.offer, coin: bigger.outpoint })
            )
            const request = await craft(
                f,
                [coinInput(bigger.outpoint, AMOUNT)],
                AMOUNT,
                bigger.outpoint
            )
            const signed = await sign(
                f.chain,
                f.funderCfg,
                requestFile(request),
                offerPath
            )
            expect(signed.code, signed.text).to.equal(1)
            expect(signed.text).to.contain(
                `the coin holds ${AMOUNT + 1n} sats, not the amount ${AMOUNT}`
            )
        })

        it('refuses a request that uses the coin twice', async () => {
            const f = await offered()
            const tx = new bsv.Transaction(f.request.txHex)
            tx.inputs.push(
                new bsv.Transaction.Input({
                    prevTxId: tx.inputs[1].prevTxId,
                    outputIndex: tx.inputs[1].outputIndex,
                    script: new bsv.Script(''),
                })
            )
            await refused(
                f,
                { ...f.request, txHex: tx.uncheckedSerialize() },
                'the coin is an input more than once'
            )
        })

        it('refuses a request whose funder input has a script already', async () => {
            const f = await offered()
            const tx = new bsv.Transaction(f.request.txHex)
            tx.inputs[1].setScript(
                new bsv.Script('').add(Buffer.from('01', 'hex'))
            )
            await refused(
                f,
                { ...f.request, txHex: tx.uncheckedSerialize() },
                'the funder input already has a script'
            )
        })

        it('refuses a machine unlocking script that is not push-only (a decoder sees other arguments than the interpreter)', async () => {
            const f = await offered()
            // "<5000> OP_DROP" in front: a naive decoder reads chunk 10 one
            // place further on, the interpreter drops the extra push.
            const txHex = withUnlocking(f.request.txHex, (script) => {
                const front = new bsv.Script('')
                    .add(Buffer.from('8813', 'hex'))
                    .add(bsv.Opcode.OP_DROP)
                return front.toHex() + script.toHex()
            })
            await refused(
                f,
                { ...f.request, txHex },
                'the machine input unlocking script is not push-only'
            )
        })

        it('refuses a machine unlocking script with an extra push', async () => {
            const f = await offered()
            const txHex = withUnlocking(
                f.request.txHex,
                (script) =>
                    script.toHex() +
                    new bsv.Script('').add(Buffer.from('01', 'hex')).toHex()
            )
            await refused(
                f,
                { ...f.request, txHex },
                /unlocking script has 16 pushes, the step ABI has 15/
            )
        })

        it('refuses a machine unlocking script with a push that is not minimal', async () => {
            const f = await offered()
            const txHex = withUnlocking(f.request.txHex, (script) => {
                const buf = script.chunks[10].buf as Buffer
                const pushdata1 =
                    '4c' +
                    buf.length.toString(16).padStart(2, '0') +
                    buf.toString('hex')
                return (
                    chunksHex(script, 0, 10) + pushdata1 + chunksHex(script, 11)
                )
            })
            await refused(f, { ...f.request, txHex }, 'push 10 is not minimal')
        })

        it('refuses a request whose machine input tops up another amount', async () => {
            const f = await offered()
            await refused(
                f,
                {
                    ...f.request,
                    txHex: withTopUpArg(f.request.txHex, AMOUNT - 1n),
                },
                `tops up ${AMOUNT - 1n} sats, not the offer amount ${AMOUNT}`
            )
        })

        it('refuses a request whose amount field is not the offer amount', async () => {
            const f = await offered()
            await refused(
                f,
                { ...f.request, amount: (AMOUNT + 1n).toString() },
                'is not the offer amount'
            )
        })

        it('refuses a request whose machine prevout is not the tip', async () => {
            const f = await offered()
            // Another cycle lands first.
            const rival = await keeperOn(f.cfg, f.chain).tick(T0 + 200)
            expect(rival.txid).to.be.a('string')
            await refused(
                f,
                f.request,
                'but the unspent tip of the machine named in the offer'
            )
        })

        it('refuses a request with an extra output that takes value (the interpreter fails)', async () => {
            const f = await offered()
            const tx = new bsv.Transaction(f.request.txHex)
            tx.addOutput(
                new bsv.Transaction.Output({
                    script: bsv.Script.buildPublicKeyHashOut(
                        bsv.PrivateKey.fromRandom('testnet').toAddress()
                    ),
                    satoshis: Number(AMOUNT),
                })
            )
            await refused(
                f,
                { ...f.request, txHex: tx.uncheckedSerialize() },
                'the machine input (input 0) fails the script interpreter'
            )
        })

        it('refuses a request without the coin', async () => {
            const f = await offered()
            const tx = new bsv.Transaction(f.request.txHex)
            tx.inputs.splice(f.request.funderInputIndex, 1)
            await refused(
                f,
                { ...f.request, txHex: tx.uncheckedSerialize() },
                'the coin is not an input of the request'
            )
        })

        it('refuses a request that states another funder input index', async () => {
            const f = await offered()
            await refused(
                f,
                { ...f.request, funderInputIndex: 2 },
                'the coin is input 1, not the stated funder input 2'
            )
        })

        it('refuses when the coin is spent elsewhere', async () => {
            const f = await offered()
            const { txid, vout } = parseOutpoint(f.offer.coin)
            const elsewhere = new bsv.Transaction()
                .from({
                    txId: txid,
                    outputIndex: vout,
                    script: funderScript,
                    satoshis: Number(AMOUNT),
                })
                .addOutput(
                    new bsv.Transaction.Output({
                        script: bsv.Script.fromHex(funderScript),
                        satoshis: Number(AMOUNT) - 100,
                    })
                )
                .sign(
                    FUNDER_KEY,
                    bsv.crypto.Signature.SIGHASH_ALL |
                        bsv.crypto.Signature.SIGHASH_FORKID
                )
            f.chain.add(elsewhere)
            await refused(f, f.request, 'is spent already')
        })

        it('refuses a request for a machine with another instance id', async () => {
            const f = await offered()
            // A second machine; the keeper builds a request for it with the
            // same coin and then claims the first machine's instance id.
            const otherCfg = await deployed(f.chain)
            const other = K17Machine.fromTx(
                f.chain.txs.get(
                    parseOutpoint(otherCfg.machineOutpoint as string).txid
                )!,
                0
            ) as K17Machine
            const built = await keeperOn(otherCfg, f.chain).buildTopUpRequest(
                T0 + 100,
                { ...f.offer, instanceId: other.instanceId.toLowerCase() }
            )
            expect(built.error).to.equal(undefined)
            await refused(
                f,
                {
                    ...(built.request as TopUpRequest),
                    instanceId: f.offer.instanceId,
                },
                "not the offer's machine"
            )
        })

        it('refuses an offer of another funder key', async () => {
            const f = await offered()
            const otherCfg = config(bsv.PrivateKey.fromRandom('testnet'))
            const signed = await sign(
                f.chain,
                otherCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code).to.equal(1)
            expect(signed.text).to.contain('not for the key of this funder')
        })
    })

    describe('keeper side', () => {
        it('a halting cycle takes no offer: no request is built and nothing is sent', async () => {
            const chain = new MemoryChain()
            const cfg = await deployed(
                chain,
                assemble(['IN', 'OUT', 'HALT']),
                DEAD_MAN_FLOOR
            )
            const { offer } = await makeOffer(
                chain,
                cfg.machineOutpoint as string
            )
            const due = T0 + Number(DEAD_MAN_FLOOR)
            const before = chain.cycleBroadcasts
            const built = await keeperOn(cfg, chain).buildTopUpRequest(
                due + 5,
                offer
            )
            expect(built.request).to.equal(undefined)
            expect(built.topUpRefused).to.equal(true)
            expect(built.error).to.contain('halts the machine')
            expect(chain.cycleBroadcasts).to.equal(before)
        })

        it('refuses an offer for another machine before it builds anything', async () => {
            const f = await offered()
            const built = await keeperOn(f.cfg, f.chain).buildTopUpRequest(
                T0 + 100,
                { ...f.offer, instanceId: 'ab'.repeat(32) }
            )
            expect(built.request).to.equal(undefined)
            expect(built.error).to.contain('the offer is for machine')
        })

        it('complete refuses a stale request after the machine moved', async () => {
            const f = await offered()
            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(0)
            const rival = await keeperOn(f.cfg, f.chain).tick(T0 + 200)
            expect(rival.txid).to.be.a('string')
            const before = f.chain.txs.size
            const done = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(done.code).to.equal(1)
            expect(done.text).to.contain(
                'offer expired: the machine moved; build a new request'
            )
            expect(f.chain.txs.size).to.equal(before)
        })

        it('complete run again after a success reports the cycle as sent, not expired', async () => {
            const f = await offered()
            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(0)
            const first = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(first.code, first.text).to.equal(0)
            const sends = f.chain.cycleBroadcasts
            const again = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(again.code, again.text).to.equal(0)
            expect(again.text).to.contain('is on the chain already')
            expect(again.text).to.not.contain('expired')
            expect(f.chain.cycleBroadcasts).to.equal(sends)
        })

        it('complete reports success when the send fails after the node took the cycle', async () => {
            const chain = new AcceptThenFailChain()
            const f = await offered(T0 + 100, chain)
            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(0)
            chain.failAfterNextSend = true
            const done = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(done.code, done.text).to.equal(0)
            expect(done.text).to.contain('is on the chain already')
            expect(done.text).to.not.contain('expired')
            expect(chain.cycleBroadcasts).to.equal(1)
        })

        it('complete reports a malleated variant of the cycle as sent, not expired', async () => {
            const f = await offered()
            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            expect(signed.code, signed.text).to.equal(0)
            const sig = JSON.parse(readFileSync(signed.sigPath, 'utf8'))
            // The same cycle with a changed funder scriptSig (OP_0 OP_DROP
            // appended): another txid, the same machine and coin spends.
            const variant = new bsv.Transaction(f.request.txHex)
            variant.inputs[f.request.funderInputIndex].setScript(
                bsv.Script.fromHex(sig.unlockingScript + '0075')
            )
            expect(variant.id).to.not.equal(
                new bsv.Transaction(f.request.txHex).id
            )
            f.chain.add(variant)
            const sends = f.chain.cycleBroadcasts
            const done = await complete(f.chain, f.requestPath, signed.sigPath)
            expect(done.code, done.text).to.equal(0)
            expect(done.text).to.contain('is on the chain already')
            expect(done.text).to.not.contain('expired')
            expect(f.chain.cycleBroadcasts).to.equal(sends)
        })

        it('complete refuses a signature of another request', async () => {
            const f = await offered()
            const signed = await sign(
                f.chain,
                f.funderCfg,
                f.requestPath,
                f.offerPath
            )
            const sig = JSON.parse(readFileSync(signed.sigPath, 'utf8'))
            const other = path('sig.json')
            writeFileSync(
                other,
                JSON.stringify({ ...sig, requestId: 'cd'.repeat(32) })
            )
            const done = await complete(f.chain, f.requestPath, other)
            expect(done.code).to.equal(1)
            expect(done.text).to.contain('for another request')
        })
    })

    describe('flags', () => {
        it('--top-up with --top-up-offer is a usage error on admit, remove and endorse', async () => {
            const runs = [
                (io: ReturnType<typeof sink>['io']) =>
                    admitCommand(
                        [
                            'x.toml',
                            '--member-key',
                            'k',
                            '--payout',
                            'p',
                            '--top-up',
                            '5',
                            '--top-up-offer',
                            'offer.json',
                        ],
                        io
                    ),
                (io: ReturnType<typeof sink>['io']) =>
                    removeCommand(
                        [
                            'x.toml',
                            '--index',
                            '1',
                            '--top-up',
                            '5',
                            '--top-up-offer',
                            'offer.json',
                        ],
                        io
                    ),
                (io: ReturnType<typeof sink>['io']) =>
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
                            '5',
                            '--top-up-offer',
                            'offer.json',
                        ],
                        io
                    ),
            ]
            for (const run of runs) {
                const { lines, io } = sink()
                expect(await run(io)).to.equal(2)
                expect(lines.join('\n')).to.contain(
                    'use --top-up or --top-up-offer, not both'
                )
            }
        })

        it('the loops refuse --top-up-offer (keeper, gateway run, also with --once)', async () => {
            const cases: [
                string,
                (io: ReturnType<typeof sink>['io']) => Promise<number>
            ][] = [
                [
                    'keeper',
                    (io) =>
                        keeperCommand(
                            ['--config', 'x.toml', '--top-up-offer', 'o.json'],
                            io
                        ),
                ],
                [
                    'gateway run',
                    (io) =>
                        gatewayCommand(
                            [
                                'run',
                                '--config',
                                'x.toml',
                                '--top-up-offer',
                                'o.json',
                            ],
                            io
                        ),
                ],
                [
                    'gateway run',
                    (io) =>
                        gatewayCommand(
                            [
                                'run',
                                '--config',
                                'x.toml',
                                '--once',
                                '--top-up-offer',
                                'o.json',
                            ],
                            io
                        ),
                ],
            ]
            for (const [name, run] of cases) {
                const { lines, io } = sink()
                expect(await run(io), name).to.equal(2)
                expect(lines.join('\n'), name).to.contain(
                    `${name} runs a loop of cycles and does not take --top-up-offer`
                )
            }
            const both = sink()
            expect(
                await keeperCommand(
                    [
                        '--config',
                        'x.toml',
                        '--top-up',
                        '5',
                        '--top-up-offer',
                        'o.json',
                    ],
                    both.io
                )
            ).to.equal(2)
            expect(both.lines.join('\n')).to.contain('not both')
        })

        it('topup without a sub-command, or with a bad amount, is a usage error', async () => {
            const { lines, io } = sink()
            expect(await main(['topup'], io)).to.equal(2)
            expect(
                await topupCommand(
                    ['offer', 'f.toml', '--machine', 'ab', '--amount', '1.5'],
                    io
                )
            ).to.equal(2)
            expect(
                await topupCommand(
                    ['offer', 'f.toml', '--machine', 'ab', '--amount', '0'],
                    io
                )
            ).to.equal(2)
            const text = lines.join('\n')
            expect(text).to.contain('usage: k17forth topup offer')
            expect(text).to.contain('--amount must be a whole number')
            expect(text).to.contain('--amount must be at least 1 sat')
        })

        it('the usage text of admit, remove and endorse names --top-up-offer', async () => {
            const { lines, io } = sink()
            await admitCommand([], io)
            await removeCommand([], io)
            await endorseCommand([], io)
            expect(
                lines.filter((l) => l.includes('--top-up-offer'))
            ).to.have.length(3)
        })
    })

    describe('admit --top-up-offer (tree machine)', () => {
        const START = T0 + 1000
        const sponsorKey = newAttester(Buffer.alloc(32, 80))
        const bob = newAttester(Buffer.alloc(32, 81))

        it('writes a request; sign and complete admit the member with the top-up', async () => {
            const chain = new MemoryChain()
            const source = path('tree.fs')
            writeFileSync(
                source,
                treeConsortiumSource({
                    start: START,
                    period: 1000,
                    rounds: 3,
                    bountyPerReading: 150,
                    range: { min: 4000, max: 6000 },
                })
            )
            const sponsorCfg = config(WALLET_KEY)
            const members = path('members.json')
            writeFileSync(members, JSON.stringify({ members: [] }))
            const deployed = sink()
            const deployCode = await deployCommand(
                [
                    source,
                    '--config',
                    sponsorCfg,
                    '--deposit',
                    String(FUNDING),
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
                deployed.io,
                {
                    signer: new TestWallet(WALLET_KEY, chain),
                    chainInfo: async () => ({ mediantime: T0 + 1, blocks: 1 }),
                    now: () => T0,
                }
            )
            expect(deployCode, deployed.lines.join('\n')).to.equal(0)
            saveAttesterKey(sponsorCfg, sponsorKey.priv.p, sponsorKey.priv.q)
            const cfg = loadConfig(sponsorCfg)
            const { offerPath, funderCfg } = await makeOffer(
                chain,
                cfg.machineOutpoint as string
            )
            const bobKey = path('bob.key')
            writeFileSync(bobKey, pubKeyBytes(bob.pub) + '\n')
            const requestPath = path('request.json')
            const before = chain.cycleBroadcasts
            const admitted = sink()
            const code = await admitCommand(
                [
                    sponsorCfg,
                    '--member-key',
                    bobKey,
                    '--payout',
                    bsv.PrivateKey.fromRandom('testnet').toAddress().toString(),
                    '--top-up-offer',
                    offerPath,
                    '--request-out',
                    requestPath,
                ],
                admitted.io,
                {
                    provider: chain,
                    signer: new TestWallet(WALLET_KEY, chain),
                    keeper: {
                        chainInfo: async () => ({ mediantime: MTP, blocks: 1 }),
                        spentBy: (op) => chain.spentBy(op),
                    },
                    now: () => T0 + 60,
                }
            )
            const text = admitted.lines.join('\n')
            expect(code, text).to.equal(0)
            expect(text).to.contain(`top-up request written to ${requestPath}`)
            expect(text).to.contain('k17forth topup sign')
            expect(text).to.contain('k17forth topup complete')
            expect(chain.cycleBroadcasts).to.equal(before)
            // No tip_outpoint is saved: nothing landed yet.
            expect(loadConfig(sponsorCfg).tipOutpoint).to.equal(undefined)
            const request = readRequest(readFileSync(requestPath, 'utf8'))

            const signed = await sign(chain, funderCfg, requestPath, offerPath)
            expect(signed.code, signed.text).to.equal(0)
            const done = await complete(chain, requestPath, signed.sigPath)
            expect(done.code, done.text).to.equal(0)
            expect(chain.cycleBroadcasts).to.equal(before + 1)
            const cycleId = /txid ([0-9a-f]{64})/.exec(done.text)![1]
            const cycle = chain.txs.get(cycleId)!
            const next = decodeInstance(cycle.outputs[0].script.toHex())
                .instance as K17Machine
            expect(next.rosterSeq).to.equal(1n)
            const prev = chain.txs.get(
                parseOutpoint(request.machinePrevout).txid
            )!.outputs[0]
            const reward = BigInt(cycle.outputs[1].satoshis)
            expect(BigInt(cycle.outputs[0].satoshis)).to.equal(
                BigInt(prev.satoshis) - reward + AMOUNT
            )
            expect(chain.verifyMachineSpends()).to.equal(1)
        })
    })
    describe('endorse --top-up-offer (slot machine)', () => {
        it('sends the lead cycle as usual, then writes a request for the endorsement cycle', async () => {
            const { chain, signer, cfg } = await consortiumOnChain(false)
            const c = cfg.consortium!
            const sponsorCfg = path('sponsor.toml')
            writeFileSync(
                sponsorCfg,
                [
                    '[network]',
                    'name = "testnet"',
                    '[wallet]',
                    `wif = "${WALLET_KEY.toWIF()}"`,
                    '[attester]',
                    `rabin_p = "${sponsor.priv.p}"`,
                    `rabin_q = "${sponsor.priv.q}"`,
                    '[machine]',
                    `outpoint = "${cfg.machineOutpoint}"`,
                    `instance_id = "${cfg.instanceId}"`,
                    '[consortium]',
                    `start = ${c.start}`,
                    `period = ${c.period}`,
                    `epoch = ${c.epoch}`,
                    `slots = ${c.slots}`,
                    `rounds = ${c.rounds}`,
                    '',
                ].join('\n')
            )
            chmodSync(sponsorCfg, 0o600)
            const { offerPath, funderCfg } = await makeOffer(
                chain,
                cfg.machineOutpoint as string
            )
            const requestPath = path('request.json')
            const { lines, io } = sink()
            const code = await endorseCommand(
                [
                    '--config',
                    sponsorCfg,
                    '--member',
                    pubKeyBytes(landowner.pub),
                    '--payout',
                    PAYOUT_ADDRESS.toString(),
                    '--slot',
                    '1',
                    '--top-up-offer',
                    offerPath,
                    '--request-out',
                    requestPath,
                ],
                io,
                {
                    provider: chain,
                    signer,
                    keeper: keeperOptions(chain),
                    now: chainClock(chain, OPTS.start - 100),
                }
            )
            const text = lines.join('\n')
            expect(code, text).to.equal(0)
            expect(text).to.contain('cycle before the endorsement')
            expect(text).to.contain('The endorsement of slot 1 lands only')
            // The lead cycle went out with no top-up; the endorsement waits.
            expect(chain.cycleBroadcasts).to.equal(1)
            const signed = await sign(chain, funderCfg, requestPath, offerPath)
            expect(signed.code, signed.text).to.equal(0)
            const done = await complete(chain, requestPath, signed.sigPath)
            expect(done.code, done.text).to.equal(0)
            expect(chain.cycleBroadcasts).to.equal(2)
            const cycleId = /txid ([0-9a-f]{64})/.exec(done.text)![1]
            const mem = decodeMachine(
                chain.txs.get(cycleId)!.outputs[0].script.toHex()
            ).machine!.mem
            expect(readSlot(mem, 1).hashHex).to.equal(keyHash(landowner.pub))
            expect(
                decodeUnlocking(chain.txs.get(cycleId)!.inputs[0].script.chunks)
                    ?.topUp
            ).to.equal(AMOUNT)
            expect(chain.verifyMachineSpends()).to.equal(2)
        })
    })
})
