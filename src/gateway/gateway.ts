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
 * Tree mode (`[gateway] mode = "tree"`): the gateway is a member of a roster
 * tree, not the owner of a slot. For each reading it follows the machine to
 * its tip, rebuilds the roster (`loadRoster`, from `tip_outpoint`/`outpoint`),
 * finds its own leaf by key hash, and skips with "waiting for next round"
 * when the leaf's `lastRound` is not below the round of the lock time. The
 * lock time is fixed first: one wall-clock value `now` goes to both
 * `Keeper.chainTime` and `Keeper.tick`, so the lock time is exactly
 * `chain.time` = min(now, MTP - 1), and the reading is signed under
 * `readingTag(roundAt(lockTime))`, the round the program computes from the
 * same TIME. The cycle carries witness `[0, reading]`, the signature, the
 * gateway's key and the leaf's Merkle proof; one cycle verifies and pays.
 * A tree gateway keeps only the raw reading, never a signature: a kept
 * reading (tip outage, MIN_STEP wait, round already paid) is signed again
 * for the round of the cycle that finally carries it, because the tag
 * depends on the round. Before every attempt the roster is reloaded; when
 * another member's payment lands between the load and the broadcast, the
 * proof is stale, and the gateway reloads once and plans again (a second
 * failure reports the reason). A gateway whose key is not in the roster
 * refuses to start (`run` returns NOT_IN_ROSTER); one that is removed later
 * refuses each reading and relays nothing, as a slot gateway does when its
 * slot is emptied. With `once`, a reading that cannot go out now (waiting
 * for MTP, a failed broadcast) is dropped and `run` returns NOT_DELIVERED:
 * run the command again after the next block. The start check is fail-open: when the chain cannot be
 * read (or the sync of the tip fails) `run` only warns and goes on, and
 * membership is checked again before every relay; only a roster loaded after
 * a successful sync may conclude "not in the roster" (after a failed sync the
 * reading is kept). Data freshness: a kept reading is signed and paid in the
 * round of the cycle that carries it, so a value measured in round r may be
 * paid in round r + 1; one value is kept and a newer reading replaces it.
 * After a relay it writes `[machine] tip_outpoint` (needs
 * `GatewayOptions.configPath`).
 *
 * Each tick and each reading gives one status line: the round, the slot,
 * the readings delivered and satoshis earned by this slot so far (from
 * `walkHistory`), and what the tick did. No status line holds a secret.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import { decodeLeafPre } from 'k17-vm'
import { GatewayConfig, hideSecrets, saveTipOutpoint } from '../chain/config'
import { Keeper, KeeperOptions, PendingInput } from '../chain/keeper'
import { TxSource, parseOutpoint, walkHistory } from '../chain/history'
import { DecodedMachine, decodeMachine } from '../chain/decode'
import { loadRoster } from '../chain/loadRoster'
import { tickLine } from '../cli/keeper'
import { GatewayAttester, MemberAttester, checkInstance } from './attester'
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
    /**
     * Path of the config file. Tree mode writes `[machine] tip_outpoint`
     * there after each relay. Default: none (nothing is written).
     */
    configPath?: string
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

    /**
     * Keep a transaction that the caller already holds (the keeper's latest
     * cycle), so that no fetch is needed for it. Input: the transaction.
     */
    remember(tx: bsv.Transaction): void {
        this.cache.set(tx.id, tx)
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

/** Exit code of `run` in tree mode when the gateway's key is not in the roster. */
export const NOT_IN_ROSTER = 1

/** Most attempts of one tree-mode reading: the first, and one after a reload. */
const TREE_ATTEMPTS = 2

/** Exit code of `run` with `once` when no reading was delivered. */
export const NOT_DELIVERED = 3

/** Refusal text of a tree gateway whose leaf pays an address that is not its own. */
const LEAF_PAYOUT_MISMATCH =
    "the roster leaf's payout is not this gateway's payout address; relaying nothing (ask the sponsor to admit the key with this payout)"

/** Relays the readings of one slot into one consortium machine. */
export class Gateway {
    private readonly keeper: Keeper
    /** The slot attester (slot mode); undefined in tree mode. */
    private readonly slotSigner?: GatewayAttester
    /** The member attester (tree mode); undefined in slot mode. */
    private readonly member?: MemberAttester
    private readonly configPath?: string
    /** Payout hash of this member's leaf, once known (tree mode). */
    private leafPayout?: string
    /** Leaf index of this member, once known (tree mode). */
    private leafIndex?: number
    private readonly source: CachedSource
    private readonly bridge: AsyncIterable<number>
    private readonly now: () => number
    private readonly intervalMs: number
    private readonly out: (line: string) => void
    private readonly cfg: GatewayConfig
    private readonly once: boolean
    private pending?: Pending
    /** A reading kept because the chain time could not be read. */
    private unsigned?: number
    private readonly deliveredRounds = new Set<number>()
    /** Tree mode: true once a reading cycle was broadcast (for `once`). */
    private treeDelivered = false
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
        provider: Pick<
            Provider,
            'getTransaction' | 'getNetwork' | 'sendTransaction'
        >,
        signer: Signer,
        options: GatewayOptions = {}
    ) {
        this.cfg = cfg
        if (cfg.mode === 'tree') this.member = new MemberAttester(cfg)
        else this.slotSigner = new GatewayAttester(cfg)
        this.configPath = options.configPath
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

    /**
     * The slot attester. Output: the attester; only called in slot mode.
     * Throws when the gateway is in tree mode.
     */
    private attester(): GatewayAttester {
        if (!this.slotSigner) throw new Error('not a slot gateway')
        return this.slotSigner
    }

    /** The machine outpoint the next tick spends; undefined once halted. */
    get outpoint(): string | undefined {
        return this.halted ? undefined : this.keeper.outpoint
    }

    /**
     * The reading that waits: signed for an attest cycle, or kept unsigned
     * until the chain time can be read. Undefined when none waits.
     */
    get pendingReading(): number | undefined {
        return this.pending?.reading ?? this.unsigned
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
        if (this.member) return this.handleTreeReading(reading)
        this.unsigned = undefined
        let chain: ChainNow
        try {
            chain = await this.keeper.chainTime(this.now())
        } catch (e) {
            // The round depends on the chain time: keep the reading and
            // sign it on the next tick.
            this.unsigned = reading
            return this.status(
                UNKNOWN,
                `reading ${reading} kept, not signed yet (signs it on the next tick): ${messageOf(
                    e
                )}`
            )
        }
        let round: number | null = this.attester().roundAt(chain.time)
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
                checkInstance(this.cfg.instanceId as string, machine.instanceId)
                round = this.attester().currentRound(chain.time, machine)
                if (round !== null && this.deliveredRounds.has(round))
                    return this.status(
                        round,
                        `reading ${reading} refused: slot already delivered in round ${round}${syncNote}`
                    )
                const input = this.attester().sign(reading, round)
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
     * Run one tick with the pending input, if any. A reading that was kept
     * unsigned (the chain tip could not be read) is taken again first.
     * Output: the status line.
     */
    async tickIdle(): Promise<string> {
        if (this.halted) return this.status(null, 'machine halted')
        if (this.unsigned !== undefined)
            return this.handleReading(this.unsigned)
        // A tree member has no cycle to run without a reading: the reading
        // cycle itself pays.
        if (this.member) return this.status(UNKNOWN, 'idle: no reading waits')
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
     * In tree mode it first checks the roster (`preflight`) and returns
     * NOT_IN_ROSTER when this gateway's key is not a member.
     * Output: 0 when the bridge ended or the machine halted; with `once`,
     * NOT_DELIVERED when the reading was refused or dropped, or the bridge
     * ended before a reading, or the machine halted first; BRIDGE_FAILED
     * when the bridge failed (the error goes to `out`, with the secrets
     * hidden). Never throws for chain errors (they are status lines).
     */
    async run(): Promise<number> {
        if (this.member) {
            const refusal = await this.preflight()
            if (refusal) {
                this.out(refusal)
                return NOT_IN_ROSTER
            }
        }
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
        let deliveredOnce = false
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
                    while (
                        (this.pending || this.unsigned !== undefined) &&
                        !this.halted
                    ) {
                        await new Promise((r) => setTimeout(r, this.intervalMs))
                        await this.queue
                    }
                    // The cycle after the attest cycle pays the slot.
                    deliveredOnce = this.member
                        ? this.treeDelivered
                        : this.deliveredRounds.size > deliveredBefore
                    if (deliveredOnce && !this.halted && !this.member)
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
        const unadded = this.keeper.unaddedTopUp
        if (unadded > 0n) this.out(`top-up of ${unadded} sats was not added`)
        if (code === 0 && this.once && !deliveredOnce) return NOT_DELIVERED
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
        const round = this.attester().roundAt(chain.time)
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
     * Follow the machine to its tip and rebuild the roster from the chain.
     * Output: the mirror and the machine at the tip, and a note when the
     * sync failed (the last known tip was used). Throws when the machine is
     * halted or the roster cannot be loaded; the message has no secret.
     */
    private async freshRoster(): Promise<{
        mirror: Awaited<ReturnType<typeof loadRoster>>['mirror']
        machine: Awaited<ReturnType<typeof loadRoster>>['machine']
        note: string
    }> {
        let note = ''
        try {
            await this.keeper.sync()
        } catch (e) {
            note = ` (sync failed, used the last known machine: ${messageOf(
                e
            )})`
        }
        const tip = this.keeper.outpoint
        if (!tip) throw new Error('machine halted')
        this.rememberTip()
        const loaded = await loadRoster(this.cfg, {
            provider: this.source,
            outpoint: tip,
        })
        if (this.cfg.instanceId)
            checkInstance(this.cfg.instanceId, loaded.machine.instanceId)
        return { ...loaded, note }
    }

    /** Give the keeper's newest cycle transaction to the cache (no fetch needed for it). */
    private rememberTip(): void {
        const tx = this.keeper.machineTx
        if (tx) this.source.remember(tx)
    }

    /**
     * Tree mode, before the loop: check that the key is in the roster.
     * Output: a refusal line when the key hash is not a leaf of the roster
     * ("this gateway is not in the roster"), else undefined. A failure to
     * read the chain is only noted on `out`: membership is checked again
     * before each relay.
     */
    private async preflight(): Promise<string | undefined> {
        const member = this.member as MemberAttester
        try {
            const { mirror, note } = await this.freshRoster()
            const index = mirror.indexOf(member.keyHashHex)
            // A failed sync means the roster may be older than the admission.
            if (index === undefined && note)
                throw new Error(`the machine tip is not known${note}`)
            if (index === undefined)
                return hideSecrets(
                    `gateway: this gateway is not in the roster (key hash ${member.keyHashHex}); ask the sponsor to admit it`,
                    this.cfg
                )
            this.leafIndex = index
            this.leafPayout = decodeLeafPre(
                mirror.proofFor(index).leafPre
            ).payoutHex
            if (this.leafPayout.toLowerCase() !== member.payoutHex)
                return `gateway: ${LEAF_PAYOUT_MISMATCH}`
        } catch (e) {
            this.out(
                hideSecrets(
                    `gateway: could not check the roster yet: ${messageOf(e)}`,
                    this.cfg
                )
            )
        }
        return undefined
    }

    /**
     * Tree mode: relay one reading as a roster member.
     * Each attempt reads the chain time once, follows the machine, reloads
     * the roster, finds the leaf, checks `lastRound`, signs under the round
     * of the lock time and ticks. At most TREE_ATTEMPTS attempts: a stale
     * proof (another member was paid in between, so the broadcast failed
     * and the keeper resynced, or the plan says "witness rejected") makes a
     * second attempt with a fresh roster.
     * A reading that could not be tried now (tip unreadable, roster
     * unreadable, waiting for MTP or the next round, a failed broadcast) is
     * kept raw in `unsigned`; it is signed again on the attempt that
     * carries it. A reading the machine refuses, or one that is out of
     * range, is dropped.
     * Input: the reading. Output: the status line.
     */
    private async handleTreeReading(reading: number): Promise<string> {
        const member = this.member as MemberAttester
        this.unsigned = undefined
        let stale = ''
        for (let attempt = 0; attempt < TREE_ATTEMPTS; attempt++) {
            // One wall-clock value for the chain time and the tick, so the
            // lock time of the cycle is exactly chain.time.
            const now = this.now()
            let chain: ChainNow
            try {
                chain = await this.keeper.chainTime(now)
            } catch (e) {
                this.unsigned = reading
                return this.status(
                    UNKNOWN,
                    `reading ${reading} kept, not signed yet (signs it on the next tick): ${messageOf(
                        e
                    )}`
                )
            }
            const round = member.roundAt(chain.time)
            let fresh
            try {
                fresh = await this.freshRoster()
            } catch (e) {
                if (/machine halted/.test(messageOf(e))) {
                    this.halted = true
                    return this.status(null, 'machine halted')
                }
                this.unsigned = reading
                return this.status(
                    round,
                    `reading ${reading} kept (signs it on the next tick); error: load roster: ${messageOf(
                        e
                    )}`
                )
            }
            const { mirror, machine, note: syncNote } = fresh
            const index = mirror.indexOf(member.keyHashHex)
            if (syncNote) {
                // The roster is from the last known tip, which may be older
                // than the chain: only a successful sync can conclude that
                // the key is not a member, and a proof against an old root
                // must never be relayed.
                this.unsigned = reading
                return this.status(
                    round,
                    `reading ${reading} kept (signs it on the next tick); error: could not check the roster${syncNote}`
                )
            }
            if (index === undefined)
                return this.status(
                    round,
                    `reading ${reading} refused: this gateway is not in the roster any more (removed?); relaying nothing${syncNote}`
                )
            this.leafIndex = index
            const proof = mirror.proofFor(index)
            const leaf = decodeLeafPre(proof.leafPre)
            this.leafPayout = leaf.payoutHex
            if (leaf.payoutHex.toLowerCase() !== member.payoutHex)
                return this.status(
                    round,
                    `reading ${reading} refused: ${LEAF_PAYOUT_MISMATCH}`
                )
            if (round < 1)
                return this.status(
                    round,
                    `reading ${reading} refused: no round is open yet${syncNote}`
                )
            if (round > member.rounds)
                return this.status(
                    round,
                    `reading ${reading} refused: the machine has ended${syncNote}`
                )
            if (BigInt(round) <= leaf.lastRound) {
                const why = `waiting for next round (paid in round ${leaf.lastRound})${syncNote}`
                if (this.once)
                    return this.status(
                        round,
                        `reading ${reading} dropped: ${why}`
                    )
                this.unsigned = reading
                return this.status(round, `reading ${reading} kept: ${why}`)
            }
            let signed
            try {
                signed = member.sign(reading, chain.time, machine.instanceId)
            } catch (e) {
                return this.status(
                    round,
                    `reading ${reading} refused: ${messageOf(e)}${syncNote}`
                )
            }
            const input: PendingInput = { ...signed.input, tree: proof }
            const result = await this.keeper.tick(now, input, chain.mtp)
            this.rememberTip()
            if (result.halted) this.halted = true
            if (result.txid) {
                this.latest = this.keeper.outpoint ?? `${result.txid}:0`
                // A halting cycle (dead-man, or a bounty the machine cannot
                // pay) refunds the beneficiary: the member was not paid.
                this.treeDelivered = !result.halted
                let saved = ''
                if (this.configPath && result.outpoint)
                    try {
                        saveTipOutpoint(this.configPath, result.outpoint)
                    } catch (e) {
                        saved = ` (could not save tip_outpoint: ${messageOf(
                            e
                        )})`
                    }
                return this.status(
                    signed.round,
                    tickLine(result) +
                        (result.halted
                            ? ` (machine halted, reading ${reading} not paid)`
                            : '') +
                        stale +
                        syncNote +
                        saved
                )
            }
            // A refused top-up is already dropped: plan again at once.
            if (result.topUpRefused && attempt + 1 < TREE_ATTEMPTS) continue
            const rejected = /witness rejected/.test(result.error ?? '')
            const isStale = rejected || (result.resynced && !!result.error)
            if (isStale && attempt + 1 < TREE_ATTEMPTS) {
                stale =
                    ' (the roster changed while the cycle went out; loaded it again)'
                continue
            }
            if (rejected) {
                // No retry can change the machine's answer.
                return this.status(
                    signed.round,
                    `reading ${reading} dropped: the machine rejects it (${result.error})${stale}${syncNote}`
                )
            }
            // MIN_STEP wait, an early tip, or a failed broadcast: keep the
            // raw reading; the next attempt signs it again for its own round.
            // With `once` there is no later tick to wait for: drop the reading
            // (exit NOT_DELIVERED); the operator runs the command again
            // after the next block.
            if (this.once)
                return this.status(
                    signed.round,
                    tickLine(result) +
                        ' (reading dropped: run again after the next block)' +
                        stale +
                        syncNote
                )
            this.unsigned = reading
            return this.status(
                signed.round,
                tickLine(result) + ' (reading kept)' + stale + syncNote
            )
        }
        // Not reached: the last attempt always returns.
        return this.status(UNKNOWN, 'error: no attempt ran')
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
            `round ${round ?? 'closed'} ${
                this.member
                    ? `member ${this.leafIndex ?? '?'}`
                    : `slot ${this.attester().slot}`
            } ${this.tally}: ${detail}`,
            this.cfg
        )
    }

    /**
     * Walk the machine's history and update the delivered count and the
     * satoshis earned by this slot at this gateway's payout address. A walk that fails leaves the old text.
     * Output: none.
     */
    private async refreshTally(): Promise<void> {
        try {
            const cycles = await walkHistory(this.source, this.latest)
            const paid = cycles.filter((c) =>
                this.member
                    ? c.payout?.addressHex.toLowerCase() ===
                      (this.leafPayout ?? this.member.payoutHex)
                    : c.payout?.slot === this.attester().slot &&
                      c.payout.addressHex.toLowerCase() ===
                          this.attester().payoutHex
            )
            const earned = paid.reduce((sum, c) => sum + c.payout!.satoshis, 0)
            this.tally = `delivered ${paid.length} earned ${earned} sats`
        } catch {
            // keep the last known tally
        }
    }
}
