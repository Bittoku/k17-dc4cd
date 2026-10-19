/**
 * The keeper: advances a K17 machine on the chain one cycle per `tick`.
 *
 * A tick loads the current machine UTXO, picks an nLockTime, plans the cycle
 * with `planCycle` (with a pending signed input when the caller has one),
 * and broadcasts it through the signer. Rules that bind this module:
 *
 * - nLockTime must be below the chain's median time past (MTP). A node
 *   treats a transaction as final only when nLockTime < MTP, and testnet MTP
 *   lags the wall clock by 40 to 50 minutes. The keeper uses
 *   min(now, MTP - 1), and skips the tick when that is below the machine's
 *   `lastTime` (the contract refuses a lock time before `lastTime`).
 * - Chains of unconfirmed cycles are accepted, so the keeper does not wait
 *   for a confirmation. It keeps the transaction of the latest cycle it made
 *   and spends that one next.
 * - When a broadcast fails because the input is spent or conflicts, the
 *   keeper follows the machine forward from the known outpoint (spends
 *   lookup), then tries once more. A second failure is returned as
 *   `{ error }`; the keeper never loops.
 *
 * No result or error text contains the wallet key or the Rabin primes.
 */

import { Provider, Signer, bsv, toByteString } from 'scrypt-ts'
import { RabinPubKey, RabinSig } from 'scrypt-ts-lib'
import { K17Machine, NO_SIG, addrOf, bindCycleBuilder, planCycle } from 'k17-vm'
import type { GatewayConfig } from './config'
import { ChainInfo, FetchLike, chainInfo } from './provider'
import { Outpoint, parseOutpoint } from './history'
import { decodeMachine } from './decode'

/** A signed input that the keeper gives to the next cycle that needs one. */
export interface PendingInput {
    /** Witness cells, in the order the program reads them with IN. */
    witness: bigint[]
    /** Rabin signature over the reading (NO_SIG when not given). */
    sig?: RabinSig
    /** Key the signature is made under (ATTEST, ENDORSE sponsor). */
    attestKey?: RabinPubKey
    /** New member's key (ENDORSE). */
    endorseKey?: RabinPubKey
    /** New member's 20-byte payout, 40 hex characters (ENDORSE). */
    payoutHex?: string
}

/**
 * What one tick did. Exactly one of these holds: `txid` is set (a cycle was
 * broadcast), `skipped` is set (nothing to do now), or `error` is set.
 */
export interface TickResult {
    /** The cycle transaction that was broadcast. */
    txid?: string
    /** The new machine outpoint, `txid:0`; not set when the machine halted. */
    outpoint?: string
    /** nLockTime of the cycle. */
    lockTime?: number
    /** Median time past that the lock time was clamped to, when it was read. */
    mtp?: number
    /** Satoshis paid to the keeper. */
    reward?: bigint
    /** True when this cycle halted the machine (the beneficiary is refunded). */
    halted?: boolean
    /** True when the keeper had to find the current machine again first. */
    resynced?: boolean
    /** Why the tick did nothing, for example "needs witness". */
    skipped?: string
    /** Why the tick failed. Contains no secret. */
    error?: string
}

/** Options of a keeper; tests replace the network calls. */
export interface KeeperOptions {
    /** Read the chain tip. Default: WhatsOnChain `/chain/info`. */
    chainInfo?: () => Promise<ChainInfo>
    /**
     * Spends lookup: the txid that spent an outpoint, or undefined when it is
     * unspent. Default: WhatsOnChain `/tx/<txid>/<vout>/spent`.
     */
    spentBy?: (outpoint: Outpoint) => Promise<string | undefined>
    /** Fetch function for the default WhatsOnChain calls. */
    fetch?: FetchLike
}

/** The provider calls the keeper uses. */
type TxProvider = Pick<Provider, 'getTransaction' | 'getNetwork'>

/** The machine output that the keeper spends next. */
interface Current {
    tx: bsv.Transaction
    vout: number
}

/** Most outputs the keeper follows forward in one resync. */
const MAX_RESYNC_HOPS = 10_000

/**
 * Tell if a broadcast error means the machine input is spent or conflicts.
 * Input: the error text. Output: true for "missing inputs",
 * "txn-mempool-conflict" or an HTTP 500 that names the inputs.
 */
export function isConflictError(message: string): boolean {
    if (/missing inputs|txn-mempool-conflict/i.test(message)) return true
    return /\b500\b/.test(message) && /inputs?/i.test(message)
}

/**
 * Spends lookup through WhatsOnChain `/tx/<txid>/<vout>/spent`.
 * Input: network, outpoint, fetch function. Output: the spending txid, or
 * undefined when WhatsOnChain answers 404 (unspent). Throws on other errors.
 */
export async function wocSpentBy(
    network: 'testnet' | 'mainnet',
    outpoint: Outpoint,
    fetchFn: FetchLike = fetch as unknown as FetchLike
): Promise<string | undefined> {
    const base = `https://api.whatsonchain.com/v1/bsv/${
        network === 'testnet' ? 'test' : 'main'
    }`
    const url = `${base}/tx/${outpoint.txid}/${outpoint.vout}/spent`
    const response = await fetchFn(url)
    if (response.status === 404) return undefined
    if (!response.ok)
        throw new Error(`WhatsOnChain ${url} failed: HTTP ${response.status}`)
    const body = (await response.json()) as { txid?: unknown }
    return typeof body?.txid === 'string' ? body.txid : undefined
}

/** Text of an unknown thrown value. */
function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

/** Advances one machine; keeps the latest outpoint it made. */
export class Keeper {
    /** The outpoint in the configuration. */
    private readonly start: Outpoint
    private current?: Current
    private halted = false
    private readonly readChain: () => Promise<ChainInfo>
    private readonly spentBy: (
        outpoint: Outpoint
    ) => Promise<string | undefined>

    /**
     * Make a keeper.
     * Input: the configuration (uses `machineOutpoint` and `network`), a
     * provider to read transactions, the wallet signer (pays fees, gets the
     * reward), and options. Throws when the configuration names no machine.
     */
    constructor(
        cfg: GatewayConfig,
        private readonly provider: TxProvider,
        private readonly signer: Signer,
        options: KeeperOptions = {}
    ) {
        if (!cfg.machineOutpoint)
            throw new Error('config: [machine] outpoint is required')
        this.start = parseOutpoint(cfg.machineOutpoint)
        this.readChain =
            options.chainInfo ?? (() => chainInfo(cfg.network, options.fetch))
        this.spentBy =
            options.spentBy ??
            ((op) => wocSpentBy(cfg.network, op, options.fetch))
    }

    /**
     * The outpoint the next tick spends, `txid:vout`.
     * Output: the latest outpoint this keeper made or found, else the one in
     * the configuration; undefined once the machine halted.
     */
    get outpoint(): string | undefined {
        if (this.halted) return undefined
        if (this.current) return `${this.current.tx.id}:${this.current.vout}`
        return `${this.start.txid}:${this.start.vout}`
    }

    /**
     * Run one cycle when one can run now.
     * Input: the wall clock (unix seconds) and optionally a signed input for
     * a program that waits for a witness.
     * Output: the TickResult. Never throws for chain or broadcast errors.
     */
    async tick(now: number, input?: PendingInput): Promise<TickResult> {
        if (this.halted) return { skipped: 'machine halted' }
        let mtp: number
        try {
            mtp = (await this.readChain()).mediantime
        } catch (e) {
            return { error: `chain info: ${messageOf(e)}` }
        }
        let resynced = false
        for (;;) {
            let current: Current
            try {
                current = await this.load()
            } catch (e) {
                return { mtp, error: `load machine: ${messageOf(e)}` }
            }
            const attempt = await this.advance(current, now, mtp, input)
            if (attempt.result) {
                return resynced
                    ? { ...attempt.result, resynced: true }
                    : attempt.result
            }
            const message = attempt.broadcastError as string
            if (resynced || !isConflictError(message))
                return {
                    mtp,
                    error: message,
                    ...(resynced ? { resynced } : {}),
                }
            try {
                const found = await this.resync(current)
                if (found === 'halted') {
                    this.halted = true
                    return { mtp, skipped: 'machine halted', resynced: true }
                }
            } catch (e) {
                return { mtp, error: `resync: ${messageOf(e)}` }
            }
            resynced = true
        }
    }

    /**
     * The machine output to spend: the cached one, else the configured one.
     * Output: its transaction and output index. Throws when it cannot be read.
     */
    private async load(): Promise<Current> {
        if (!this.current) {
            const tx = await this.provider.getTransaction(this.start.txid)
            this.current = { tx, vout: this.start.vout }
        }
        return this.current
    }

    /**
     * Plan and broadcast one cycle from `current`.
     * Input: the machine output, wall clock, MTP and the pending input.
     * Output: `{ result }` when the tick is done (success, skip, or an error
     * that is not a broadcast error), or `{ broadcastError }` when the
     * broadcast failed and the caller decides on a retry.
     */
    private async advance(
        current: Current,
        now: number,
        mtp: number,
        input?: PendingInput
    ): Promise<{ result?: TickResult; broadcastError?: string }> {
        let m: K17Machine
        try {
            m = K17Machine.fromTx(current.tx, current.vout) as K17Machine
        } catch (e) {
            return { result: { mtp, error: `not a machine: ${messageOf(e)}` } }
        }
        const lockTime = Math.min(now, mtp - 1)
        if (BigInt(lockTime) < m.lastTime)
            return {
                result: {
                    mtp,
                    skipped: `waiting: median time past ${mtp} is not yet past lastTime ${m.lastTime}`,
                },
            }
        const value = BigInt(current.tx.outputs[current.vout].satoshis)
        let keeper: bsv.Address
        try {
            keeper = await this.signer.getDefaultAddress()
        } catch (e) {
            return { result: { mtp, error: `wallet: ${messageOf(e)}` } }
        }
        let plan
        try {
            plan = planCycle(
                m,
                value,
                BigInt(lockTime),
                keeper,
                input?.witness ?? [],
                input?.sig ?? NO_SIG,
                {
                    attestKey: input?.attestKey,
                    endorseKey: input?.endorseKey,
                    payoutHex: input?.payoutHex,
                }
            )
        } catch (e) {
            const message = messageOf(e)
            if (/needs a witness/.test(message))
                return { result: { mtp, skipped: 'needs witness' } }
            return { result: { mtp, error: `plan: ${message}` } }
        }
        try {
            await m.connect(this.signer)
            const options = bindCycleBuilder(m, plan, keeper, BigInt(lockTime))
            const { tx } = await m.methods.step(
                addrOf(keeper),
                toByteString(plan.witnessHex),
                plan.sig.s,
                toByteString(plan.sig.padding),
                toByteString(plan.keyAHex),
                toByteString(plan.keyBHex),
                toByteString(plan.payoutHex),
                options
            )
            if (plan.halted) {
                this.halted = true
                this.current = undefined
            } else this.current = { tx, vout: 0 }
            return {
                result: {
                    txid: tx.id,
                    ...(plan.halted ? {} : { outpoint: `${tx.id}:0` }),
                    lockTime,
                    mtp,
                    reward: plan.reward,
                    halted: plan.halted,
                },
            }
        } catch (e) {
            return { broadcastError: messageOf(e) }
        }
    }

    /**
     * Find the current machine output by following spends forward from
     * `from`. Each cycle spends the machine and makes the next one as
     * output 0.
     * Input: the output that the failed broadcast tried to spend.
     * Output: 'halted' when a spend ended the machine, else 'found' (the
     * cached output is updated). Throws when a transaction cannot be read.
     */
    private async resync(from: Current): Promise<'found' | 'halted'> {
        let op: Outpoint = { txid: from.tx.id, vout: from.vout }
        let tx = from.tx
        for (let hop = 0; hop < MAX_RESYNC_HOPS; hop++) {
            const spender = await this.spentBy(op)
            if (!spender) {
                this.current = { tx, vout: op.vout }
                return 'found'
            }
            tx = await this.provider.getTransaction(spender)
            if (
                !tx.outputs[0] ||
                !decodeMachine(tx.outputs[0].script.toHex()).machine
            )
                return 'halted'
            op = { txid: spender, vout: 0 }
        }
        throw new Error(`more than ${MAX_RESYNC_HOPS} cycles to follow`)
    }
}
