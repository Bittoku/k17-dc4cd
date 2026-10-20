/**
 * Tree-mode consortium program: sponsor-paid sensing on a K17+ v3.1 machine
 * whose roster is a sparse Merkle tree (k17-vm `smt.ts`).
 *
 * The roster lives in the machine state as `rosterRoot`. Each member leaf
 * holds a Rabin key hash, a payout address and `lastRound`, the last round
 * the member was paid for. Members sign one reading per round; any keeper
 * relays a signed reading with the member's Merkle proof, and the program
 * pays the member `bountyPerReading` satoshis with PAYLEAF, which also sets
 * the leaf's `lastRound` to the current round. The sponsor (the machine's
 * `sponsorKeyHash`) admits and removes members at any time.
 *
 * Rounds (from TIME, never from the witness):
 *   roundAt(t) = 0                                  when t < start
 *              = floor((t - start) / period) + 1    otherwise.
 * Readings are accepted in rounds 1..rounds, that is for
 * start <= TIME < END, with END = start + rounds * period. A genesis member
 * (lastRound 0) is first payable in round 1. A member admitted during round
 * r gets lastRound r and is first payable in round r + 1; a member admitted
 * before start gets lastRound 0.
 *
 * Every cycle runs the same code:
 *   1. End check, before IN: when TIME >= END the program HALTs, so the
 *      machine refunds its balance to the beneficiary without a witness.
 *   2. IN reads a selector: 0 reading, 1 admit, 2 remove. Any other value
 *      makes VERIFY fail (the transaction is invalid; nothing faults).
 *   3. Reading (witness: 0 reading):
 *        VERIFY TIME >= start, compute the round,
 *        MEMBER DROP                  bind the member (the index is unused),
 *        VERIFY lastRound < round     one payment per member per round,
 *        IN the reading, VERIFY the range (when one is set),
 *        ATTESTM readingTag(round) reading   signed by the member's key,
 *        OUTH the reading             fold it into the log hash,
 *        PAYLEAF bountyPerReading round.
 *      Admit (witness: 1): ADMIT_TAG roundAt(TIME) ADMIT.
 *      Remove (witness: 2): REMOVE_TAG REMOVE.
 *   4. YIELD, then loop.
 * An unaffordable PAYLEAF (bounty above the balance less one satoshi) is
 * a fault at payout accounting, so the machine halts and refunds by itself;
 * the program has no floor check.
 *
 * Instruction budget: every branch, from the first instruction of a cycle
 * to its YIELD or HALT, is at most 40 instructions (K17Machine.K). The
 * reading branch is the longest: 40 with a range check, 34 without (see
 * tests/treeConsortium.test.ts). Three choices keep it inside K:
 *   - The selector stays on the data stack. On every branch it is 0 at the
 *     YIELD (the reading branch has selector 0; the admin branches reduce
 *     it to 0), and `until` consumes it as the loop's jump-back flag.
 *   - Comparisons that must hold are written `X D / if 0 verify then`: for
 *     D > 0 the quotient is zero exactly when X < D, and IF jumps over the
 *     refusal on zero, so the accepted path costs no `0=` and no VERIFY.
 *   - The round is computed as (TIME - (start - period)) / period, which is
 *     floor((TIME - start) / period) + 1 without the `1 +`. It runs only
 *     after TIME >= start is verified, so the subtraction cannot wrap.
 *
 * Tags: a reading for round r is signed under READING_TAG_BASE + r; ADMIT
 * and REMOVE signatures carry ADMIT_TAG and REMOVE_TAG. The ATTESTM, ADMIT
 * and REMOVE messages also bind the machine's instance id, and the ADMIT
 * and REMOVE messages bind the roster sequence number, so the fixed admin
 * tags cannot be replayed.
 *
 * VALUE is not used, so the machine may hold any balance the contract
 * accepts.
 */

import { compileToHex } from '../forth/compiler'

/** Deployment parameters of a tree-mode consortium machine. */
export interface TreeConsortiumOptions {
    /** Unix time (s) at which round 1 opens; > 0. */
    start: number
    /** Length of a round in seconds; >= 60 (one MIN_STEP). */
    period: number
    /** Number of rounds, >= 1; END = start + rounds * period must fit a cell. */
    rounds: number
    /** Satoshis PAYLEAF pays a member per accepted reading, >= 1. */
    bountyPerReading: number
    /** Accepted readings, inclusive, on the unsigned reading cell. */
    range?: { min: number; max: number }
}

/** Reading tag of round 0; round r readings are signed under READING_TAG_BASE + r. */
export const READING_TAG_BASE = 0x40000000
/** Tag the sponsor signs every admission under (with signAdmission). */
export const ADMIT_TAG = 0x48000000
/** Tag the sponsor signs every removal under (with signRemoval). */
export const REMOVE_TAG = 0x4c000000

/** Largest cell value. */
const CELL_MAX = 0xffffffff
/** Cell modulus (2^32). */
const CELL_MOD = 0x100000000
/** Rounds are below 2^28, so reading tags stay below ADMIT_TAG. */
const ROUND_LIMIT = 0x10000000
/** Shortest round: one MIN_STEP, the least spacing of two live cycles. */
const MIN_PERIOD = 60

/** True when `n` is an integer in [lo, hi]. */
function inRange(n: number, lo: number, hi: number): boolean {
    return Number.isInteger(n) && n >= lo && n <= hi
}

/**
 * Check deployment options. Input: options. Output: none; throws an Error
 * that names the first bad option.
 */
function validate(opts: TreeConsortiumOptions): void {
    if (!inRange(opts.start, 1, CELL_MAX))
        throw new Error('start must be a unix time in [1, 2^32)')
    if (!inRange(opts.period, MIN_PERIOD, CELL_MAX))
        throw new Error(`period must be at least ${MIN_PERIOD} seconds`)
    if (!inRange(opts.rounds, 1, ROUND_LIMIT - 1))
        throw new Error('rounds must be at least 1 and below 2^28')
    if (opts.start + opts.rounds * opts.period > CELL_MAX)
        throw new Error('END = start + rounds * period must fit a cell')
    // The round is (TIME - (start - period)) / period. Its numerator is at
    // most rounds * period + period - 1; it is exact when that fits a cell.
    // This only binds when start < period.
    if ((opts.rounds + 1) * opts.period - 1 > CELL_MAX)
        throw new Error('(rounds + 1) * period must fit a cell')
    if (!inRange(opts.bountyPerReading, 1, CELL_MAX))
        throw new Error('bountyPerReading must be in [1, 2^32)')
    if (opts.range) {
        const { min, max } = opts.range
        if (!inRange(min, 0, CELL_MAX) || !inRange(max, min, CELL_MAX))
            throw new Error('range must satisfy 0 <= min <= max < 2^32')
    }
}

/**
 * Tag a member signs its reading for `round` under (with signMemberReading).
 * Input: round, an integer in [0, 2^28). Output: READING_TAG_BASE + round.
 * Throws on a round out of range.
 */
export function readingTag(round: number): bigint {
    if (!inRange(round, 0, ROUND_LIMIT - 1))
        throw new Error('round must be an integer in [0, 2^28)')
    return BigInt(READING_TAG_BASE) + BigInt(round)
}

/**
 * The round the program computes at unix time `t` (ruling 2).
 * Input: options, unix time t (s). Output: 0 when t < start, else
 * floor((t - start) / period) + 1. Values above `rounds` mean the machine
 * has ended (t >= END). Throws on invalid options or a negative or
 * non-integer t.
 */
export function roundAt(opts: TreeConsortiumOptions, t: number): number {
    validate(opts)
    if (!Number.isInteger(t) || t < 0)
        throw new Error('t must be a non-negative integer')
    if (t < opts.start) return 0
    return Math.floor((t - opts.start) / opts.period) + 1
}

/**
 * Forth source of the tree-mode consortium program.
 * Input: deployment options. Output: Forth text for the k17-dc4cd compiler,
 * with `\` comments. Throws on invalid options.
 */
export function treeConsortiumSource(opts: TreeConsortiumOptions): string {
    validate(opts)
    const { start, period, rounds, bountyPerReading } = opts
    const end = start + rounds * period
    // start - period as a cell; (TIME - roundBase) / period is the round.
    const roundBase = (((start - period) % CELL_MOD) + CELL_MOD) % CELL_MOD
    let rangeCheck = ''
    if (opts.range) {
        const { min, max } = opts.range
        const width = max - min + 1
        // A range of the whole cell accepts everything: no check.
        if (width <= CELL_MAX)
            rangeCheck = `    dup ${min} - ${width} / if 0 verify then  \\ ${min} <= reading <= ${max}\n`
    }
    const settings = [
        `start=${start}`,
        `period=${period}`,
        `rounds=${rounds}`,
        `bountyPerReading=${bountyPerReading}`,
        opts.range
            ? `range=${opts.range.min}..${opts.range.max}`
            : 'range=none',
    ].join(' ')
    return `\\ Tree consortium program: sponsor-paid sensing over a Merkle roster
\\ Generated for ${settings}
\\ Round r (1..${rounds}) runs from ${start} + (r-1)*${period}; the machine ends at ${end}.
\\ Witness per cycle: 0 reading | 1 | 2. Stack comments show the data stack.
begin
  \\ cycle start (the first cycle, or the 'until' jump after a YIELD)
  time ${end} / if halt then  \\ TIME >= END: halt and refund, before any IN
  in  ( sel )
  dup if
    \\ ---- admin: sel 1 admits, sel 2 removes, any other value is refused
    1 - dup if  ( sel-1 )
      1 - dup if 0 verify then  ( 0 )  \\ sel must be 2
      ${REMOVE_TAG} remove  ( 0 )  \\ sponsor-signed removal under REMOVE_TAG
    else  ( 0 )
      ${ADMIT_TAG}  ( 0 tag )
      time ${start} / dup if  \\ TIME >= start: round from TIME, else round 0
        drop time ${roundBase} - ${period} /
      then  ( 0 tag round )
      admit  ( 0 )  \\ sponsor-signed admission with lastRound := round
    then
  else
    \\ ---- reading ( 0 )
    time ${start} / verify  \\ TIME >= start (rounds start at 1)
    ${bountyPerReading} time ${roundBase} - ${period} /  ( 0 bounty round )
    member drop  \\ verify the proof, bind the member; the leaf index is unused
    lastround over / if 0 verify then  \\ lastRound < round: not yet paid this round
    dup ${READING_TAG_BASE} + in  ( 0 bounty round tag reading )
${rangeCheck}    swap over attestm  ( 0 bounty round reading )  \\ signed by the member under readingTag(round)
    outh  ( 0 bounty round )  \\ fold the reading into the log hash
    payleaf  ( 0 )  \\ pay the bounty, lastRound := round
  then
  yield
until  \\ the selector, now 0 on every branch: jump back to begin
`
}

/** Compile the tree consortium program. Input: options. Output: K17 bytecode hex. */
export function treeConsortiumProgram(opts: TreeConsortiumOptions): string {
    return compileToHex(treeConsortiumSource(opts))
}
