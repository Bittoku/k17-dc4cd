/**
 * Roster-attested aggregation relay: DC4CD §5.1 ("in-network distributed
 * data aggregation") ported to a K17+ machine on a UTXO chain.
 *
 * In DC4CD the program for "average temperature" travels along a linear
 * chain of motes: each hop measures, adds its reading to the running sum,
 * increments the node count and forwards sum, count and the same program to
 * its successor; the last node sends the result back. Here the UTXO is the
 * message: it carries program and state from hop to hop. What the chain
 * adds, and DC4CD lists as future work, is authentication (each hop's
 * reading must be Rabin-signed by the roster member for that hop), ordering
 * and replay protection (one UTXO, one successor), an incentive (the
 * liveness auction and a per-hop bounty pay whoever relays), and an audit
 * trail. What it costs is latency (block time) and fees.
 *
 * Hop k of the roster signs attestMessage(epoch + k, reading). The epoch is
 * a deployment constant so a signature cannot be replayed into another
 * instance with the same roster. Any keeper may relay a signed reading; the
 * attester is trusted only for the value. If a roster member never answers,
 * the deadline lets any keeper HALT the machine and refund the beneficiary.
 *
 * Memory: sum, lo (running minimum), hi (running maximum). The hop count is
 * static, so it is a literal at retrieval time. The output log at HALT is
 * the "retrieval message": [hops, sum, average, min, max].
 *
 * Each hop is 36 K17 instructions, inside one 40-instruction cycle, so the
 * attestation check, the bounty and the YIELD land in one transaction.
 */

import { compile, compileToHex } from '../forth/compiler'

/** Deployment parameters of a relay instance. */
export interface RelayOptions {
    /** Number of roster members that take part, 1..4 (K17 roster slots). */
    hops: number
    /** Per-deployment constant mixed into every attestation tag. */
    epoch: number
    /** Unix time after which any keeper may HALT and refund. */
    deadline: number
    /** Extra satoshis paid to the relaying keeper per accepted hop. */
    bountyPerHop: number
}

/** Program-type namespace of relay tags (high nibble 1). */
export const RELAY_TAG_BASE = 0x10000000

/**
 * Attestation tag that roster member `k` must sign for this instance:
 * RELAY_TAG_BASE + epoch * 16 + k. The namespace keeps relay and fuzzy
 * tags disjoint even when their epochs coincide; the epoch must be below
 * 2^24 and the slot below 16.
 */
export function relayTag(opts: RelayOptions, k: number): bigint {
    if (opts.epoch < 0 || opts.epoch >= 1 << 24)
        throw new Error('epoch must be in [0, 2^24)')
    return BigInt(RELAY_TAG_BASE) + BigInt(opts.epoch) * 16n + BigInt(k)
}

/**
 * Forth source of the relay program.
 * Input: deployment options. Output: Forth text for the k17-dc4cd compiler.
 */
export function relaySource(opts: RelayOptions): string {
    if (opts.hops < 1 || opts.hops > 4) throw new Error('hops must be 1..4')
    const hop = (k: number) => `
\\ ---- hop ${k}: roster slot ${k} attests (tag ${relayTag(opts, k)}, reading)
time ${
        opts.deadline
    } - $80000000 and 0= if halt then   \\ past the deadline: refund
${relayTag(opts, k)} in over over ${k} sigverify swap drop  \\ ( reading )
${opts.bountyPerHop} bounty
accumulate
yield`
    return `\\ Roster-attested aggregation relay (DC4CD section 5.1 on a UTXO chain)
\\ Generated for hops=${opts.hops} epoch=${opts.epoch} deadline=${opts.deadline}
variable sum
variable lo
variable hi

: accumulate ( reading -- )
  dup sum @ + sum !
  dup lo @ min lo !
  hi @ max hi ! ;

$ffffffff lo !          \\ running minimum starts at the top of the range
yield                   \\ deployment cycle ends here; hop 0 is the next transaction
${Array.from({ length: opts.hops }, (_, k) => hop(k)).join('\n')}

\\ ---- retrieval: the output log is the message to the ancestor
${opts.hops} out
sum @ out
sum @ ${opts.hops} / out
lo @ out
hi @ out
halt
`
}

/** Compile the relay program. Input: options. Output: K17 bytecode hex. */
export function relayProgram(opts: RelayOptions): string {
    return compileToHex(relaySource(opts))
}

/** Compile and return the token form, for inspection and tests. */
export function relayTokens(opts: RelayOptions): (string | number)[] {
    return compile(relaySource(opts)).tokens
}
