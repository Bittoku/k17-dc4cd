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
import {
    K17Machine,
    NO_SIG,
    addrOf,
    bindCycleBuilder,
    outputLog,
    planCycle,
    stateOf,
} from 'k17-vm'
import { GatewayConfig, hideSecrets } from './config'
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
    /**
     * Cells that this cycle added to the output log (OUT), in order; empty
     * when it added none. Set only when a cycle was broadcast.
     */
    logged?: bigint[]
    /**
     * True when the machine is halted: this cycle halted it (the beneficiary
     * is refunded), or the keeper found it halted. No later tick does work.
     */
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

/** Result of a tick on a machine that is halted. */
const HALTED: TickResult = { skipped: 'machine halted', halted: true }

/** Most outputs the keeper follows forward in one resync. */
const MAX_RESYNC_HOPS = 10_000

/** Node reject texts that mean the machine input is spent or conflicts. */
const CONFLICT_TEXTS = [
    /txn-mempool-conflict/,
    /missing inputs/i,
    /inputs-spent/,
    /missingorspent/,
    /too-long-non-final-chain/,
]

/**
 * Tell if a broadcast error means the machine input is spent or conflicts.
 * Input: the error text. Output: true when it holds one of the known node
 * reject texts: "txn-mempool-conflict", "missing inputs" (any case),
 * "inputs-spent", "missingorspent" or "too-long-non-final-chain".
 */
export function isConflictError(message: string): boolean {
    return CONFLICT_TEXTS.some((text) => text.test(message))
}

/**
 * Read one WhatsOnChain spends answer.
 * Input: the URL, a fetch function and the HTTP codes that mean "no spend".
 * Output: the spending txid, or undefined for a "no spend" code. Throws on
 * any other HTTP error, and throws "spends lookup: unexpected response" for
 * a 200 whose body has no 64-hex `txid`.
 */
async function wocSpend(
    url: string,
    fetchFn: FetchLike,
    noSpend: number[]
): Promise<string | undefined> {
    const response = await fetchFn(url)
    if (noSpend.includes(response.status)) return undefined
    if (!response.ok)
        throw new Error(`WhatsOnChain ${url} failed: HTTP ${response.status}`)
    const body = (await response.json()) as { txid?: unknown } | null
    const txid = body?.txid
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/.test(txid))
        throw new Error('spends lookup: unexpected response')
    return txid
}

/**
 * Spends lookup through WhatsOnChain.
 *
 * First `GET /tx/<txid>/<vout>/spent`. Checked on testnet on 2026-10-19:
 * a spent output gives HTTP 200 with
 * `{"txid":"<spender txid>","vin":<input index>,"status":"confirmed"}`;
 * an unspent output gives HTTP 404 "Not Found". When that finds nothing,
 * the mempool variant `GET /tx/<txid>/<vout>/unconfirmed/spent` (same body,
 * `"status":"unconfirmed"`) finds a rival spend that is not yet mined. That
 * variant answered HTTP 400 for an output whose spend is already confirmed,
 * so 400 and 404 both mean "no mempool spend" there.
 * Input: network, outpoint, fetch function. Output: the spending txid, or
 * undefined when neither lookup finds a spend. Throws on other HTTP errors
 * and on a 200 with no 64-hex `txid`.
 */
export async function wocSpentBy(
    network: 'testnet' | 'mainnet',
    outpoint: Outpoint,
    fetchFn: FetchLike = fetch as unknown as FetchLike
): Promise<string | undefined> {
    const base = `https://api.whatsonchain.com/v1/bsv/${
        network === 'testnet' ? 'test' : 'main'
    }/tx/${outpoint.txid}/${outpoint.vout}`
    return (
        (await wocSpend(`${base}/spent`, fetchFn, [404])) ??
        (await wocSpend(`${base}/unconfirmed/spent`, fetchFn, [400, 404]))
    )
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
    private readonly cfg: GatewayConfig
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
        this.cfg = cfg
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
     * The time the next cycle would be stamped with.
     * Input: the wall clock (unix seconds). Output: `time` = min(now,
     * MTP - 1), the nLockTime a tick uses, and the `mtp` it read. Pass that
     * `mtp` to `tick` so that one operation reads the chain tip once.
     * Throws "chain info: ..." when the tip cannot be read.
     */
    async chainTime(now: number): Promise<{ time: number; mtp: number }> {
        let mtp: number
        try {
            mtp = (await this.readChain()).mediantime
        } catch (e) {
            throw new Error(
                hideSecrets(`chain info: ${messageOf(e)}`, this.cfg)
            )
        }
        return { time: Math.min(now, mtp - 1), mtp }
    }

    /**
     * Run one cycle when one can run now.
     * Input: the wall clock (unix seconds), optionally a signed input for
     * a program that waits for a witness, and optionally the median time
     * past that `chainTime` read (then the tip is not read again).
     * Output: the TickResult, with the config secrets hidden in `error`.
     * Never throws for chain or broadcast errors.
     */
    async tick(
        now: number,
        input?: PendingInput,
        knownMtp?: number
    ): Promise<TickResult> {
        const result = await this.tickOnce(now, input, knownMtp)
        return result.error
            ? { ...result, error: hideSecrets(result.error, this.cfg) }
            : result
    }

    /**
     * The work of `tick`, before the secrets are hidden.
     * Input and output: as `tick`.
     */
    private async tickOnce(
        now: number,
        input?: PendingInput,
        knownMtp?: number
    ): Promise<TickResult> {
        if (this.halted) return { ...HALTED }
        let mtp: number
        if (knownMtp !== undefined) mtp = knownMtp
        else
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
                    return { mtp, ...HALTED, resynced: true }
                }
            } catch (e) {
                return { mtp, error: `resync: ${messageOf(e)}` }
            }
            resynced = true
        }
    }

    /**
     * Follow the machine forward to its unspent output, so that the next
     * tick (and a reader of `outpoint`) sees the newest machine. Other
     * processes (a sponsor's endorsement, other gateways) move the machine
     * on, so the configured outpoint can be old.
     * Output: the outpoint the next tick spends, or undefined when the
     * machine halted. Throws when the spends lookup or a transaction read
     * fails; the keeper state is then unchanged.
     */
    async sync(): Promise<string | undefined> {
        if (this.halted) return undefined
        const found = await this.resync(await this.load())
        if (found === 'halted') {
            this.halted = true
            this.current = undefined
        }
        return this.outpoint
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
        const output = current.tx.outputs[current.vout]
        if (!output || !decodeMachine(output.script.toHex()).machine) {
            // A spend that ended the machine leaves no machine at output 0.
            this.halted = true
            return { result: { mtp, ...HALTED } }
        }
        const m = K17Machine.fromTx(current.tx, current.vout) as K17Machine
        const lockTime = Math.min(now, mtp - 1)
        if (BigInt(lockTime) < m.lastTime)
            return {
                result: {
                    mtp,
                    skipped: `waiting: median time past ${mtp} is not yet past lastTime ${m.lastTime}`,
                },
            }
        const value = BigInt(output.satoshis)
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
            const logged = outputLog(plan.nextState).slice(
                outputLog(stateOf(m)).length
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
                    logged,
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
     * cached output is updated). Throws "could not find the spending
     * transaction" when the spends lookup fails, and throws when a
     * transaction cannot be read.
     */
    private async resync(from: Current): Promise<'found' | 'halted'> {
        let op: Outpoint = { txid: from.tx.id, vout: from.vout }
        let tx = from.tx
        for (let hop = 0; hop < MAX_RESYNC_HOPS; hop++) {
            let spender: string | undefined
            try {
                spender = await this.spentBy(op)
            } catch {
                throw new Error('could not find the spending transaction')
            }
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
