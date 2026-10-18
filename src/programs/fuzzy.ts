/**
 * Distributed fuzzy fire detection: DC4CD §5.2 ported to K17+, as a demo.
 *
 * DC4CD runs a D-FLER style fuzzy inference on each mote: local temperature
 * and smoke memberships are combined with the neighbourhood's opinions and
 * a rule such as
 *
 *     temp.high @ smoke.high @ &  temp-neighbor.high @ smoke-neighbor.high @ & &  => fire.high
 *
 * decides. The fuzzy AND is min, OR is max. Here each opinion is one
 * attested cell: truth values in 0..1000 for temp.high and smoke.high packed
 * as temp*65536 + smoke, signed by the roster member that holds the sensor.
 * Slot 0 is the local node, slots 1..n are neighbours. The program fuzzy-ANDs
 * each opinion (min of its two memberships), averages the neighbourhood,
 * ANDs that with the local opinion and compares against a threshold. The
 * output log is [fire.high, alarm]; an alarm releases a bounty.
 *
 * This is a demonstration that symbolic (fuzzy) reasoning, not only
 * arithmetic, runs under consensus with attested inputs. It is not a fire
 * detector: block latency rules that out. Its realistic use is as the
 * acceptance test of a job bounty.
 */

import { compile, compileToHex } from '../forth/compiler'

/** Deployment parameters of a fuzzy instance. */
export interface FuzzyOptions {
    /** Number of neighbour opinions, 1..3 (slots 1..neighbours). */
    neighbours: number
    /** Per-deployment constant mixed into every attestation tag. */
    epoch: number
    /** Alarm when fire.high >= threshold (0..1000). */
    threshold: number
    /** Satoshis released to the keeper that lands the alarm cycle. */
    alarmBounty: number
}

/** Pack two truth values (0..1000) into one opinion cell. */
export function packOpinion(tempHigh: number, smokeHigh: number): bigint {
    return BigInt(tempHigh) * 65536n + BigInt(smokeHigh)
}

/** Attestation tag roster member `k` must sign for this instance. */
export function fuzzyTag(opts: FuzzyOptions, k: number): bigint {
    return BigInt(opts.epoch + k)
}

/**
 * Forth source of the fuzzy program.
 * Input: deployment options. Output: Forth text for the k17-dc4cd compiler.
 */
export function fuzzySource(opts: FuzzyOptions): string {
    if (opts.neighbours < 1 || opts.neighbours > 3)
        throw new Error('neighbours must be 1..3')
    const neighbour = (k: number) => `
\\ ---- neighbour ${k} dispenses its opinion
${opts.epoch + k} in over over ${k} sigverify swap drop opinion
nsum @ + nsum !
yield`
    return `\\ Distributed fuzzy fire detection (DC4CD section 5.2 on a UTXO chain)
\\ Truth values are 0..1000. An opinion cell packs temp.high*65536 + smoke.high.
variable local
variable nsum

: unpack ( packed -- temp smoke ) dup 65536 / swap over 65536 * - ;
: opinion ( packed -- truth ) unpack min ;        \\ fuzzy AND of the two memberships
: >= ( a b -- flag ) - $80000000 and 0= ;

yield
\\ ---- local node (slot 0) measures
${opts.epoch} in over over 0 sigverify swap drop opinion local !
yield
${Array.from({ length: opts.neighbours }, (_, i) => neighbour(i + 1)).join(
    '\n'
)}

\\ ---- rule: fire.high = local AND average(neighbourhood)
nsum @ ${opts.neighbours} / local @ min
dup out
${opts.threshold} >= if 1 out ${opts.alarmBounty} bounty else 0 out then
halt
`
}

/** Compile the fuzzy program. Input: options. Output: K17 bytecode hex. */
export function fuzzyProgram(opts: FuzzyOptions): string {
    return compileToHex(fuzzySource(opts))
}

/** Compile and return the token form, for inspection and tests. */
export function fuzzyTokens(opts: FuzzyOptions): (string | number)[] {
    return compile(fuzzySource(opts)).tokens
}
