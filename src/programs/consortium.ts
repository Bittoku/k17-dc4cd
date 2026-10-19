/**
 * Consortium program: sponsor-paid sensing on a K17+ machine.
 *
 * A sponsor funds one machine UTXO and enrols landowners who own sensors.
 * Each landowner signs one reading per round with a Rabin key; any keeper
 * relays the signed reading, the program checks it and pays the landowner's
 * payout address `bountyPerReading` satoshis with PAYSLOT. The output log
 * keeps every accepted reading in acceptance order.
 *
 * Phases of the generated Forth:
 *   1. Cycle 1 sets `count` to 1. The sponsor is already in roster slot 0:
 *      the deployment's initial memory image puts it there
 *      (`consortiumMemory`); the program never writes roster cells.
 *   2. Enrolment. One cycle per landowner: the sponsor's endorsement for
 *      slot `count` (ENDORSE writes the slot), then `count` grows by one.
 *      Enrolment ends when the roster holds `slots` landowners or at
 *      `enrolDeadline`, whichever comes first, so a missing endorsement
 *      cannot stall the machine past the deadline.
 *   3. Rounds. Round r closes at close(r) = start + (r + 1) * period;
 *      "closes" means the first cycle stamped (nLockTime) at or after
 *      close(r) leaves the round. Round 0 runs from the end of enrolment
 *      (which may be before `start`) to start + period; round r > 0 runs
 *      from close(r - 1) to close(r). Each round opens with a cycle that
 *      zeroes the eight `delivered` cells. Then, until the round closes,
 *      each reading takes two cycles:
 *        attest cycle  IN slot, VERIFY slot != 0, VERIFY slot < count,
 *                      VERIFY not yet delivered this round, IN reading,
 *                      VERIFY the range, OUT, ATTEST under the slot's key;
 *        pay cycle     HALT if VALUE < floor, else PAYSLOT the bounty to
 *                      the slot and mark it delivered.
 *      Slots deliver in any order. Leaving at the close means a missing
 *      signature cannot stall the machine.
 *   4. HALT after the last round: the remainder goes to the beneficiary
 *      (the sponsor's refund address).
 *
 * Rounds are unrolled: each round is its own code block with its close
 * time and tag base as literals, so the program grows by about 200 bytes
 * per round (about 52 KB at rounds = 256).
 *
 * VALUE pushes the UTXO value modulo 2^32, so a machine funded with 2^32
 * satoshis or more would see a wrapped value in the floor check; fund it
 * below 2^32 satoshis (about 42.9 BSV).
 *
 * Every cycle is at most 39 instructions, inside K = 40. The attest cycle
 * keeps the slot on the data stack for the pay cycle, because storing it in
 * a variable would not fit. Comparisons use unsigned division: for D > 0,
 * `X D /` is zero exactly when X < D.
 *
 * Tags: a reading for round r from slot s carries
 * CONSORTIUM_TAG_BASE + epoch * 4096 + r * 16 + s, an endorsement into slot
 * s carries ENDORSE_TAG_BASE + epoch * 16 + s. The ATTEST and ENDORSE
 * messages also bind the machine's instance id.
 */

import {
    CELL,
    MEM_CELLS,
    OUT_MAX,
    ROSTER_SLOTS,
    slotCells,
    withSlot,
} from 'k17-vm'
import { compileToHex } from '../forth/compiler'

/** Deployment parameters of a consortium machine. */
export interface ConsortiumOptions {
    /** Number of landowners, 1..7 (roster slots 1..7; slot 0 is the sponsor). */
    slots: number
    /** Number of rounds, >= 1; slots * rounds must fit the 256-cell output log. */
    rounds: number
    /** Per-deployment constant mixed into every tag, 0..65535. */
    epoch: number
    /** Unix time (s) at which round 0 is due to open. */
    start: number
    /** Length of a round in seconds. */
    period: number
    /** Unix time (s) after which no landowner is enrolled; must be <= start. */
    enrolDeadline: number
    /** Satoshis PAYSLOT pays a landowner per accepted reading, >= 1. */
    bountyPerReading: number
    /** Satoshis; the pay cycle halts instead of paying when VALUE < floor. Must exceed bountyPerReading. */
    floor: number
    /** sha256 of the sponsor's Rabin public key bytes (keyHash), 64 hex chars. */
    sponsorKeyHashHex: string
    /** Accepted readings, inclusive, on the unsigned reading cell. */
    range?: { min: number; max: number }
}

/** Program-type namespace of consortium reading tags (high nibble 3). */
export const CONSORTIUM_TAG_BASE = 0x30000000
/** Namespace of consortium endorsement tags. */
export const ENDORSE_TAG_BASE = 0x38000000

/** Largest cell value. */
const CELL_MAX = 0xffffffff

/** True when `n` is an integer in [lo, hi]. */
function inRange(n: number, lo: number, hi: number): boolean {
    return Number.isInteger(n) && n >= lo && n <= hi
}

/**
 * Check deployment options. Input: options. Output: none; throws an Error
 * that names the first bad option.
 */
function validate(opts: ConsortiumOptions): void {
    if (!inRange(opts.slots, 1, ROSTER_SLOTS - 1))
        throw new Error(`slots must be 1..${ROSTER_SLOTS - 1}`)
    if (!Number.isInteger(opts.rounds) || opts.rounds < 1)
        throw new Error('rounds must be at least 1')
    if (opts.slots * opts.rounds > OUT_MAX)
        throw new Error('slots*rounds exceeds the 256-cell output log')
    if (!inRange(opts.epoch, 0, 65535))
        throw new Error('epoch must be in [0, 65536)')
    if (!inRange(opts.enrolDeadline, 1, CELL_MAX))
        throw new Error('enrolDeadline must be a unix time in [1, 2^32)')
    if (!inRange(opts.start, opts.enrolDeadline, CELL_MAX))
        throw new Error('start must be a unix time >= enrolDeadline')
    if (!inRange(opts.period, 1, CELL_MAX))
        throw new Error('period must be at least 1 second')
    if (opts.start + opts.rounds * opts.period > CELL_MAX)
        throw new Error('the last round must close before 2^32')
    if (!inRange(opts.bountyPerReading, 1, CELL_MAX))
        throw new Error('bountyPerReading must be at least 1 satoshi')
    if (!inRange(opts.floor, opts.bountyPerReading + 1, CELL_MAX))
        throw new Error('floor must exceed bountyPerReading and be below 2^32')
    if (!/^[0-9a-fA-F]{64}$/.test(opts.sponsorKeyHashHex))
        throw new Error('sponsorKeyHashHex must be 64 hex characters')
    if (opts.range) {
        const { min, max } = opts.range
        if (!inRange(min, 0, CELL_MAX) || !inRange(max, min, CELL_MAX))
            throw new Error('range must satisfy 0 <= min <= max < 2^32')
    }
}

/** Reading tag of slot 0 in `round`; slots add their index. */
function readingTagBase(opts: ConsortiumOptions, round: number): bigint {
    return (
        BigInt(CONSORTIUM_TAG_BASE) +
        BigInt(opts.epoch) * 4096n +
        BigInt(round) * 16n
    )
}

/**
 * Tag a landowner signs a reading under (with signReadingFor).
 * Input: options, round (0..rounds-1), slot (1..slots).
 * Output: CONSORTIUM_TAG_BASE + epoch * 4096 + round * 16 + slot.
 */
export function readingTag(
    opts: ConsortiumOptions,
    round: number,
    slot: number
): bigint {
    validate(opts)
    if (!inRange(round, 0, opts.rounds - 1))
        throw new Error(`round must be 0..${opts.rounds - 1}`)
    if (!inRange(slot, 1, opts.slots))
        throw new Error(`slot must be 1..${opts.slots}`)
    return readingTagBase(opts, round) + BigInt(slot)
}

/**
 * Tag the sponsor signs an endorsement under (with signEndorsement).
 * Input: options, target slot (1..slots).
 * Output: ENDORSE_TAG_BASE + epoch * 16 + slot.
 */
export function endorseTag(opts: ConsortiumOptions, slot: number): bigint {
    validate(opts)
    if (!inRange(slot, 1, opts.slots))
        throw new Error(`slot must be 1..${opts.slots}`)
    return BigInt(ENDORSE_TAG_BASE) + BigInt(opts.epoch) * 16n + BigInt(slot)
}

/**
 * Close of a round: the first unix time at which the program no longer
 * accepts readings for it. Input: options, round (0..rounds-1).
 * Output: start + (round + 1) * period.
 */
export function roundClose(opts: ConsortiumOptions, round: number): number {
    validate(opts)
    if (!inRange(round, 0, opts.rounds - 1))
        throw new Error(`round must be 0..${opts.rounds - 1}`)
    return opts.start + (round + 1) * opts.period
}

/**
 * Forth source of the consortium program.
 * Input: deployment options. Output: Forth text for the k17-dc4cd compiler.
 * Throws on invalid options.
 */
export function consortiumSource(opts: ConsortiumOptions): string {
    validate(opts)
    const { floor, bountyPerReading, enrolDeadline } = opts
    const full = opts.slots + 1
    const endorseBase = BigInt(ENDORSE_TAG_BASE) + BigInt(opts.epoch) * 16n
    const deliveredNames = Array.from({ length: ROSTER_SLOTS }, (_, s) =>
        s === 0 ? 'delivered-base' : `delivered-${s}`
    )
    const declarations = deliveredNames.map((n) => `variable ${n}`).join(' ')
    const zeroing = deliveredNames.map((n) => `0 ${n} !`).join(' ')
    let rangeCheck = ''
    if (opts.range) {
        const { min, max } = opts.range
        const width = max - min + 1
        // A range of the whole cell accepts everything: no check.
        if (width <= CELL_MAX)
            rangeCheck = `  dup ${min} - ${width} / 0= verify  \\ ${min} <= reading <= ${max}\n`
    }
    const round = (r: number): string => {
        const close = roundClose(opts, r)
        const tagBase = readingTagBase(opts, r)
        return `
\\ ---- round ${r}: closes at ${close}
yield  \\ round-open cycle: zero the delivered cells
${zeroing}
begin
  yield
  time ${close} / 0=  \\ round still open (time < close)
while
  \\ attest cycle: witness ( slot reading ), signed by the slot's key
  in  ( slot )
  dup verify  \\ not slot 0: the sponsor never delivers
  dup count @ / 0= verify  \\ slot < count: enrolled (slot <= count-1)
  dup delivered-base + @ 0= verify  \\ first reading from this slot this round
  dup ${tagBase} +  ( slot tag )
  in  ( slot tag reading )
${rangeCheck}  dup out
  >r over r> swap attest  ( slot )
  yield
  \\ pay cycle
  value ${floor} / 0= if halt then  \\ VALUE < floor: stop, remainder to the beneficiary
  dup ${bountyPerReading} swap payslot  ( slot )
  1 swap delivered-base + !  \\ mark the slot delivered
repeat
`
    }
    const settings = [
        `slots=${opts.slots}`,
        `rounds=${opts.rounds}`,
        `epoch=${opts.epoch}`,
        `start=${opts.start}`,
        `period=${opts.period}`,
        `enrolDeadline=${enrolDeadline}`,
    ].join(' ')
    const rounds = Array.from({ length: opts.rounds }, (_, r) => round(r))
    return `\\ Consortium program: sponsor-paid sensing
\\ Generated for ${settings}
\\ Roster slot 0 (the sponsor) comes from the initial memory image.
variable count  \\ next free roster slot; slots 1..count-1 are enrolled
${declarations}  \\ delivered flag per slot

1 count !  \\ cycle 1: only the sponsor is enrolled

\\ ---- enrolment: the sponsor endorses one landowner per cycle into slot count
begin
  yield
  time ${enrolDeadline} /  \\ nonzero once time >= enrolDeadline
  count @ ${full} /  \\ nonzero once the roster is full
  or 0=
while
  ${endorseBase} count @ +  0  count @  endorse  ( tag sponsor-slot new-slot -- )
  count @ 1 + count !
repeat
${rounds.join('')}
halt
`
}

/** Compile the consortium program. Input: options. Output: K17 bytecode hex. */
export function consortiumProgram(opts: ConsortiumOptions): string {
    return compileToHex(consortiumSource(opts))
}

/**
 * Initial memory image for a consortium deployment: all cells zero except
 * roster slot 0, which holds the sponsor's key hash and a zero payout.
 * Input: options. Output: memory hex to pass to newMachine / initialState.
 */
export function consortiumMemory(opts: ConsortiumOptions): string {
    validate(opts)
    return withSlot(
        '00'.repeat(MEM_CELLS * CELL),
        0,
        slotCells(opts.sponsorKeyHashHex.toLowerCase(), '00'.repeat(20))
    )
}
