/**
 * The gateway: relays a sensor's signed readings into a consortium machine.
 *
 * A gateway serves one roster slot of one consortium machine. For each
 * reading from the bridge it checks the slot and the round, signs the
 * reading (`GatewayAttester`), keeps it as the pending input and runs a
 * keeper tick with it. Between readings it runs a tick on a timer with the
 * pending input, if any, so the machine moves on through the cycles that
 * need no witness (round open, pay). The keeper picks the lock time
 * (min(now, MTP - 1)) and handles resync.
 *
 * Rounds follow the chain time, not the wall clock: the time a cycle is
 * stamped with, min(now, MTP - 1) (`Keeper.chainTime`), because the
 * program reads its round from the nLockTime. Each operation reads the
 * median time past once and gives it to the keeper's tick.
 *
 * A pending input stays until a cycle that this gateway broadcast logs a
 * reading (the attest cycle runs OUT after it reads the witness; the
 * keeper reports the logged cells), until its round is no longer open at
 * the chain time, or until the planner rejects it ("witness rejected"),
 * which no retry can change. A skipped or failed tick keeps it. After a
 * delivery the gateway signs no other reading for that round, because the
 * program accepts one reading per slot per round.
 *
 * Each tick and each reading gives one status line: the round, the slot,
 * the readings delivered and satoshis earned by this slot so far (from
 * `walkHistory`), and what the tick did. No status line holds a secret.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import { GatewayConfig, hideSecrets } from '../chain/config'
import { Keeper, KeeperOptions, PendingInput } from '../chain/keeper'
import { TxSource, parseOutpoint, walkHistory } from '../chain/history'
import { DecodedMachine, decodeMachine } from '../chain/decode'
import { tickLine } from '../cli/keeper'
import { GatewayAttester } from './attester'
import { Bridge, openBridge } from './bridge'

/** Default time between ticks with no reading, in milliseconds. */
export const DEFAULT_INTERVAL_MS = 60_000

/** Parts of a gateway that tests and the command line replace. */
export interface GatewayOptions {
    /** Readings. Default: `openBridge([bridge] serial, or 'stdin')`. */
    bridge?: AsyncIterable<number>
    /** Options of the keeper (chain info, spends lookup). */
    keeper?: KeeperOptions
    /** Wall clock, unix seconds. Default: the system clock. */
    now?: () => number
    /** Time between ticks with no reading, ms. Default: DEFAULT_INTERVAL_MS. */
    intervalMs?: number
    /** Where status lines go. Default: standard output. */
    out?: (line: string) => void
    /**
     * Relay one reading and stop: after the first reading, tick on the
     * interval until it is delivered, dropped or refused (or the machine
     * halts); after a delivery run one more tick, the pay cycle; then end
     * `run`. Default: false (run until the bridge ends).
     */
    once?: boolean
}

/** A signed reading that waits for an attest cycle. */
interface Pending {
    input: PendingInput
    round: number
    reading: number
}

/** Text of an unknown thrown value. */
function messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

/**
 * A transaction source that keeps every transaction it fetched, so that
 * repeated history walks fetch only new cycles. Transactions never change,
 * so the cache is never stale; failed fetches are not kept.
 */
class CachedSource implements TxSource {
    private readonly cache = new Map<string, bsv.Transaction>()

    /**
     * Make the cache.
     * Input: the source that does the real fetches.
     */
    constructor(private readonly source: TxSource) {}

    /**
     * Get a transaction.
     * Input: txid. Output: the transaction, from the cache when it was
     * fetched before. Throws when the source throws.
     */
    async getTransaction(txid: string): Promise<bsv.Transaction> {
        let tx = this.cache.get(txid)
        if (!tx) {
            tx = await this.source.getTransaction(txid)
            this.cache.set(txid, tx)
        }
        return tx
    }
}

/** Chain time of one operation: the lock time and the MTP it came from. */
interface ChainNow {
    /** min(now, MTP - 1): the nLockTime the next cycle gets. */
    time: number
    /** The median time past that was read. */
    mtp: number
}

/** The round text of a status line when the chain time is not known. */
const UNKNOWN = '?'

/** Exit code of `run` when the bridge failed. */
export const BRIDGE_FAILED = 1

/** Relays the readings of one slot into one consortium machine. */
export class Gateway {
    private readonly keeper: Keeper
    private readonly attester: GatewayAttester
    private readonly source: CachedSource
    private readonly bridge: AsyncIterable<number>
    private readonly now: () => number
    private readonly intervalMs: number
    private readonly out: (line: string) => void
    private readonly cfg: GatewayConfig
    private readonly once: boolean
    private pending?: Pending
    private readonly deliveredRounds = new Set<number>()
    private halted = false
    /** The latest machine outpoint, kept after a halt for the history walk. */
    private latest: string
    /** Work that runs one at a time: readings and timer ticks. */
    private queue: Promise<void> = Promise.resolve()
    private idleQueued = false
    /** Delivered count and earnings text of the last history walk. */
    private tally = 'delivered ? earned ? sats'

    /**
     * Make a gateway.
     * Input: the configuration (machine, attester key, slot, `[consortium]`),
     * a provider to read transactions, the wallet signer (pays fees, gets
     * the keeper reward), and options. Throws a plain message (no secret)
     * when the configuration lacks a part the gateway needs.
     */
    constructor(
        cfg: GatewayConfig,
        provider: Pick<Provider, 'getTransaction' | 'getNetwork'>,
        signer: Signer,
        options: GatewayOptions = {}
    ) {
        this.cfg = cfg
        this.attester = new GatewayAttester(cfg)
        this.keeper = new Keeper(cfg, provider, signer, options.keeper)
        this.latest = this.keeper.outpoint as string
        this.source = new CachedSource(provider)
        this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
        this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
        this.once = options.once ?? false
        this.out = options.out ?? ((line) => console.log(line))
        this.bridge =
            options.bridge ??
            openBridge(cfg.serial ?? 'stdin', {
                onDiscarded: (chars) =>
                    this.out(
                        `bridge: discarded a line of ${chars} characters (longer than the limit)`
                    ),
            })
    }

    /** The machine outpoint the next tick spends; undefined once halted. */
    get outpoint(): string | undefined {
        return this.halted ? undefined : this.keeper.outpoint
    }

    /** The reading that waits for an attest cycle, if any. */
    get pendingReading(): number | undefined {
        return this.pending?.reading
    }

    /**
     * Take one reading: follow the machine to its newest output
     * (`Keeper.sync`), check, sign, and tick with it.
     * Input: the reading. Output: the status line. When the slot is not
     * enrolled, no round is open at the chain time, the reading is out of
     * range, or the slot already delivered in this round, the line says why
     * and nothing is broadcast.
     */
    async handleReading(reading: number): Promise<string> {
        if (this.halted) return this.status(null, 'machine halted')
        let chain: ChainNow
        try {
            chain = await this.keeper.chainTime(this.now())
        } catch (e) {
            return this.status(UNKNOWN, `reading ${reading}: ${messageOf(e)}`)
        }
        let round: number | null = this.attester.roundAt(chain.time)
        // Other processes move the machine on (the sponsor's endorsements,
        // other gateways): check the enrolment on the newest machine.
        let syncNote = ''
        try {
            await this.keeper.sync()
        } catch (e) {
            syncNote = ` (sync failed, used the last known machine: ${messageOf(
                e
            )})`
        }
        if (!this.keeper.outpoint) {
            this.halted = true
            return this.status(null, 'machine halted')
        }
        let machine: DecodedMachine | null
        try {
            machine = await this.currentMachine()
        } catch (e) {
            return this.status(
                round,
                `error: load machine: ${messageOf(e)}${syncNote}`
            )
        }
        if (machine) {
            try {
                round = this.attester.currentRound(chain.time, machine)
                if (round !== null && this.deliveredRounds.has(round))
                    return this.status(
                        round,
                        `reading ${reading} refused: slot already delivered in round ${round}${syncNote}`
                    )
                const input = this.attester.sign(reading, round)
                this.pending = { input, round: round as number, reading }
            } catch (e) {
                return this.status(
                    round,
                    `reading ${reading} refused: ${messageOf(e)}${syncNote}`
                )
            }
        }
        return (await this.tick(chain)) + syncNote
    }

    /**
     * Run one tick with the pending input, if any.
     * Output: the status line.
     */
    async tickIdle(): Promise<string> {
        if (this.halted) return this.status(null, 'machine halted')
        let chain: ChainNow
        try {
            chain = await this.keeper.chainTime(this.now())
        } catch (e) {
            return this.status(UNKNOWN, `error: ${messageOf(e)}`)
        }
        return this.tick(chain)
    }

    /**
     * Run until the bridge ends or the machine halts: one tick per reading
     * and one tick per interval. With `once`, stop after the first reading
     * is delivered and paid, dropped or refused. Each status line goes to `out`.
     * Output: 0 when the bridge ended or the machine halted; BRIDGE_FAILED
     * when the bridge failed (the error goes to `out`, with the secrets
     * hidden). Never throws for chain errors (they are status lines).
     */
    async run(): Promise<number> {
        let stop: () => void = () => undefined
        const stopped = new Promise<'stop'>((resolve) => {
            stop = () => resolve('stop')
        })
        const timer = setInterval(() => {
            if (this.idleQueued) return
            this.idleQueued = true
            void this.enqueue(async () => {
                this.idleQueued = false
                return this.tickIdle()
            }, stop)
        }, this.intervalMs)
        let next: Promise<IteratorResult<number>> | undefined
        let code = 0
        try {
            const iterator = this.bridge[Symbol.asyncIterator]()
            while (!this.halted) {
                next = iterator.next()
                const step = await Promise.race([next, stopped])
                if (step === 'stop') break
                next = undefined
                if (step.done) break
                const reading = step.value
                await this.enqueue(() => this.handleReading(reading), stop)
                if (this.once) {
                    const deliveredBefore = this.deliveredRounds.size
                    // The interval timer ticks until the reading is settled.
                    while (this.pending && !this.halted) {
                        await new Promise((r) => setTimeout(r, this.intervalMs))
                        await this.queue
                    }
                    // The cycle after the attest cycle pays the slot.
                    if (
                        this.deliveredRounds.size > deliveredBefore &&
                        !this.halted
                    )
                        await this.enqueue(() => this.tickIdle(), stop)
                    break
                }
            }
        } catch (e) {
            next = undefined
            this.out(hideSecrets(`bridge failed: ${messageOf(e)}`, this.cfg))
            code = BRIDGE_FAILED
        } finally {
            clearInterval(timer)
            await this.queue
            if (next) {
                // A read is still waiting: close the bridge under it.
                next.catch(() => undefined)
                ;(this.bridge as Partial<Bridge>).close?.()
            }
        }
        return code
    }

    /**
     * Queue work so that only one tick runs at a time.
     * Input: the work (gives a status line) and the function to call when
     * the machine halted. Output: a promise that settles when the work did.
     */
    private enqueue(
        work: () => Promise<string>,
        onHalt: () => void
    ): Promise<void> {
        this.queue = this.queue.then(async () => {
            let line: string
            try {
                line = await work()
            } catch (e) {
                line = await this.status(UNKNOWN, `error: ${messageOf(e)}`)
            }
            this.out(line)
            if (this.halted) onHalt()
        })
        return this.queue
    }

    /**
     * One keeper tick with the pending input.
     * Input: the chain time of this operation. Output: the status line.
     */
    private async tick(chain: ChainNow): Promise<string> {
        const round = this.attester.roundAt(chain.time)
        let note = ''
        if (this.pending && this.pending.round !== round) {
            note = ` (dropped reading ${this.pending.reading}: round ${this.pending.round} closed)`
            this.pending = undefined
        }
        const result = await this.keeper.tick(
            this.now(),
            this.pending?.input,
            chain.mtp
        )
        if (result.halted) this.halted = true
        if (result.txid)
            this.latest = this.keeper.outpoint ?? `${result.txid}:0`
        if (this.pending && result.txid && result.logged?.length) {
            // The cycle ran OUT: it read this gateway's witness.
            this.deliveredRounds.add(this.pending.round)
            this.pending = undefined
        } else if (
            this.pending &&
            /witness rejected/.test(result.error ?? '')
        ) {
            note += ` (dropped reading ${this.pending.reading}: the machine rejects it)`
            this.pending = undefined
        }
        return this.status(round, tickLine(result) + note)
    }

    /**
     * The machine at the outpoint the next tick spends.
     * Output: the decoded machine, or null when that output is not a
     * machine. Throws when the transaction cannot be read.
     */
    private async currentMachine(): Promise<DecodedMachine | null> {
        const outpoint = this.keeper.outpoint
        if (!outpoint) return null
        const { txid, vout } = parseOutpoint(outpoint)
        const output = (await this.source.getTransaction(txid)).outputs[vout]
        return output ? decodeMachine(output.script.toHex()).machine : null
    }

    /**
     * The status line: round, slot, delivered readings and satoshis earned
     * by this slot (from the machine's history), then the detail.
     * Input: the round at the chain time (null: none open; '?': the chain
     * time is not known) and the detail text.
     * Output: one line with the config secrets hidden. It walks the history
     * first (`refreshTally`).
     */
    private async status(
        round: number | null | typeof UNKNOWN,
        detail: string
    ): Promise<string> {
        await this.refreshTally()
        return hideSecrets(
            `round ${round ?? 'closed'} slot ${this.attester.slot} ${
                this.tally
            }: ${detail}`,
            this.cfg
        )
    }

    /**
     * Walk the machine's history and update the delivered count and the
     * satoshis earned by this slot. A walk that fails leaves the old text.
     * Output: none.
     */
    private async refreshTally(): Promise<void> {
        try {
            const cycles = await walkHistory(this.source, this.latest)
            const paid = cycles.filter(
                (c) => c.payout?.slot === this.attester.slot
            )
            const earned = paid.reduce((sum, c) => sum + c.payout!.satoshis, 0)
            this.tally = `delivered ${paid.length} earned ${earned} sats`
        } catch {
            // keep the last known tally
        }
    }
}
