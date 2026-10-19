/**
 * Shared fixtures of the consortium tests (gateway, endorse): fixed Rabin
 * keys for the sponsor, a landowner and a stranger, the consortium options
 * and `[consortium]` settings, an in-memory chain that records spends and
 * checks every machine spend with the script interpreter, keeper options
 * with a movable chain tip, and helpers that deploy and enrol a consortium
 * machine and that run gateway ticks. No helper uses the network.
 */
import { expect } from 'chai'
import { DummyProvider, TestWallet, bsv } from 'scrypt-ts'
import {
    addrOf,
    keyHash,
    newAttester,
    newMachine,
    payoutOf,
    rosterOf,
    signEndorsement,
    withSlot,
    slotCells,
} from 'k17-vm'
import {
    ConsortiumOptions,
    consortiumMemory,
    consortiumProgram,
    endorseTag,
} from '../../src'
import { GatewayConfig } from '../../src/chain/config'
import { Keeper } from '../../src/chain/keeper'
import { Outpoint } from '../../src/chain/history'
import { decodeMachine } from '../../src/chain/decode'
import { Gateway } from '../../src/gateway/gateway'
import { CliIo } from '../../src/cli/k17forth'

export const T0 = 1_760_000_000
export const FUNDING = 100_000
export const WALLET_KEY = bsv.PrivateKey.fromRandom('testnet')
export const ECON = {
    beneficiary: addrOf(bsv.PrivateKey.fromRandom('testnet').toAddress()),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}

// Rabin keys from fixed seeds; made once (seconds each).
export const sponsor = newAttester(Buffer.alloc(32, 60))
export const landowner = newAttester(Buffer.alloc(32, 61))
export const stranger = newAttester(Buffer.alloc(32, 62))
export const PAYOUT_ADDRESS = bsv.PrivateKey.fromRandom('testnet').toAddress()

export const OPTS: ConsortiumOptions = {
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
export const CONSORTIUM = {
    start: OPTS.start,
    period: OPTS.period,
    epoch: OPTS.epoch,
    slots: OPTS.slots,
    rounds: OPTS.rounds,
    rangeMin: 4000,
    rangeMax: 6000,
}

/** A gateway configuration for slot 1 with the landowner's key. */
export function gatewayConfig(
    extra: Partial<GatewayConfig> = {}
): GatewayConfig {
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
export function memWithSlot1(key: bigint): { mem: string } {
    return {
        mem: withSlot(
            consortiumMemory(OPTS),
            1,
            slotCells(keyHash(key), payoutOf(PAYOUT_ADDRESS))
        ),
    }
}

/** In-memory chain, as in the keeper tests (see tests/keeper.test.ts). */
export class MemoryChain extends DummyProvider {
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
export function keeperOptions(
    chain: MemoryChain,
    tip: ChainTip = { mtp: T0 + 1_000_000 }
) {
    return {
        chainInfo: async () => {
            if (tip.fail) throw new Error(tip.fail)
            return { mediantime: tip.mtp, blocks: 1 }
        },
        spentBy: (op: Outpoint) => chain.spentBy(op),
    }
}

/**
 * A wall clock for gateway and endorse tests that moves 60 s (MIN_STEP) for
 * every machine spend on the chain, so each cycle gets a lock time at least
 * 60 s after the one before it, and idle ticks do not move it.
 * Input: the chain and the clock value before the first spend. Output: the
 * clock function (unix seconds).
 */
export function chainClock(chain: MemoryChain, first: number): () => number {
    return () => first + 60 * chain.cycleBroadcasts
}

/** A chain tip that a test can move: the median time past, or a failure. */
export interface ChainTip {
    mtp: number
    /** When set, reading the tip throws this text. */
    fail?: string
}

/**
 * Deploy a consortium machine and, when `enrol` is set, run cycle 1 and the
 * sponsor's endorsement of the landowner into slot 1.
 * Output: the chain, signer and a gateway configuration naming the machine.
 */
export async function consortiumOnChain(
    enrol: boolean,
    opts: ConsortiumOptions = OPTS
): Promise<{
    chain: MemoryChain
    signer: TestWallet
    cfg: GatewayConfig
}> {
    const chain = new MemoryChain()
    const signer = new TestWallet(WALLET_KEY, chain)
    const m = newMachine(
        consortiumProgram(opts),
        ECON,
        BigInt(T0),
        rosterOf(),
        consortiumMemory(opts)
    )
    await m.connect(signer)
    const tx = await m.deploy(FUNDING)
    const cfg = gatewayConfig({
        machineOutpoint: `${tx.id}:0`,
        instanceId: m.instanceId,
        consortium: {
            ...CONSORTIUM,
            start: opts.start,
            period: opts.period,
            epoch: opts.epoch,
            slots: opts.slots,
            rounds: opts.rounds,
        },
    })
    if (enrol) {
        const keeper = new Keeper(cfg, chain, signer, keeperOptions(chain))
        expect((await keeper.tick(T0 + 60)).txid).to.be.a('string')
        const endorsed = await keeper.tick(T0 + 120, {
            witness: [],
            sig: signEndorsement(
                sponsor,
                m.instanceId,
                endorseTag(opts, 1),
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

/**
 * Run idle ticks until a status line matches.
 * Input: the gateway, the pattern, the most ticks to run and a function
 * that runs before each tick (for example to move the chain tip).
 * Output: the matching line. Throws with all lines when none matches.
 */
export async function tickUntil(
    gateway: Gateway,
    pattern: RegExp,
    most = 8,
    beforeTick: () => void = () => undefined
): Promise<string> {
    const lines: string[] = []
    for (let i = 0; i < most; i++) {
        beforeTick()
        const line = await gateway.tickIdle()
        lines.push(line)
        if (pattern.test(line)) return line
    }
    throw new Error(`no line matches ${pattern}:\n${lines.join('\n')}`)
}

/** The output log of the machine a gateway serves now. */
export function outLogOf(chain: MemoryChain, gateway: Gateway): bigint[] {
    const [txid] = gateway.outpoint!.split(':')
    return decodeMachine(chain.txs.get(txid)!.outputs[0].script.toHex())
        .machine!.outLog
}

/** Collect every value of an async iterable. */
export async function collect(
    source: AsyncIterable<number>
): Promise<number[]> {
    const values: number[] = []
    for await (const value of source) values.push(value)
    return values
}

/** Output sink that keeps all lines. */
export function sink(): { lines: string[]; io: CliIo } {
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
export const SECRETS = [
    WALLET_KEY.toWIF(),
    landowner.priv.p.toString(),
    landowner.priv.q.toString(),
]

/** Assert that no line holds a secret. */
export function expectNoSecret(lines: string[]): void {
    const text = lines.join('\n')
    for (const secret of SECRETS) expect(text).to.not.contain(secret)
}
