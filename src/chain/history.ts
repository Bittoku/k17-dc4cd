/**
 * History of a K17 machine on the chain.
 *
 * Each cycle spends the machine as input 0 and makes the next machine as
 * output 0. `walkHistory` starts at the current UTXO and follows input 0
 * back until it reaches the deployment transaction (the one whose input 0
 * does not spend a K17 machine). For every cycle it reports the
 * transaction id, nLockTime, the keeper reward, the slot payout and the
 * machine state after the cycle.
 */

import type { bsv } from 'scrypt-ts'
import { DecodedMachine, decodeMachine } from './decode'

/** The one provider method that the walk needs; tests give an in-memory map. */
export interface TxSource {
    /** Get a transaction by its id (64 hex characters). */
    getTransaction(txid: string): Promise<bsv.Transaction>
}

/** The output that paid a roster slot. */
export interface PayoutOutput {
    vout: number
    satoshis: number
    /** The 20-byte public key hash that was paid, hex. */
    addressHex: string
    /** Roster slot that has this payout address, when one matches. */
    slot?: number
}

/** One cycle of a machine. */
export interface DecodedCycle {
    txid: string
    lockTime: number
    /** Satoshis paid to the keeper (0 when the reward output is absent). */
    reward: number
    /** The payout output, when the cycle paid a roster slot. */
    payout?: PayoutOutput
    /** True when output 0 is not a machine: the machine halted and refunded. */
    halted: boolean
    /** Machine state after the cycle, or null when halted. */
    state: DecodedMachine | null
}

/** A transaction output reference. */
export interface Outpoint {
    txid: string
    vout: number
}

/**
 * Read an outpoint.
 * Input: `txid` or `txid:vout` (txid is 64 hex characters; vout defaults to 0).
 * Output: the outpoint. Throws an Error with a plain message when malformed.
 */
export function parseOutpoint(text: string): Outpoint {
    const match = /^([0-9a-fA-F]{64})(?::(\d+))?$/.exec(text)
    if (!match) throw new Error(`"${text}" is not a txid or txid:vout`)
    return {
        txid: match[1].toLowerCase(),
        vout: match[2] ? Number(match[2]) : 0,
    }
}

/**
 * Public key hash of a P2PKH script.
 * Input: script hex. Output: 40 hex characters, or undefined for other scripts.
 */
function p2pkhHash(scriptHex: string): string | undefined {
    return /^76a914([0-9a-f]{40})88ac$/.exec(scriptHex)?.[1]
}

/**
 * Work out the keeper reward and the payout of one cycle.
 * Layout of the outputs: 0 state (or refund), then the keeper reward when it
 * is above 0, then the payout when the cycle ran PAYSLOT, then change. The
 * satoshis that left the machine (previous value less output 0) equal the
 * reward plus the payout. When only one output follows, it is the payout if
 * its address is a roster payout address, and the reward if not.
 * Input: the cycle transaction, the value of the spent machine output, and
 * the roster payout addresses of the previous state as slot-to-hex.
 * Output: reward and optional payout.
 */
function splitOutputs(
    tx: bsv.Transaction,
    previousValue: number,
    rosterPayouts: Map<string, number>
): { reward: number; payout?: PayoutOutput } {
    const left = previousValue - tx.outputs[0].satoshis
    const rest = tx.outputs.slice(1)
    const payoutAt = (index: number): PayoutOutput | undefined => {
        const out = rest[index]
        const hash = out && p2pkhHash(out.script.toHex())
        if (!out || !hash) return undefined
        return {
            vout: index + 1,
            satoshis: out.satoshis,
            addressHex: hash,
            slot: rosterPayouts.get(hash),
        }
    }
    if (left <= 0 || rest.length === 0) return { reward: 0 }
    if (rest[0].satoshis === left) {
        const single = payoutAt(0)
        return single && single.slot !== undefined
            ? { reward: 0, payout: single }
            : { reward: left }
    }
    if (rest.length > 1 && rest[0].satoshis + rest[1].satoshis === left)
        return { reward: rest[0].satoshis, payout: payoutAt(1) }
    return { reward: rest[0].satoshis }
}

/**
 * Walk the history of a machine.
 * Input: a transaction source and the machine's outpoint (`txid` or
 * `txid:vout`). Output: the cycles from the oldest to the newest; empty when
 * the outpoint is the deployment output. Each transaction is fetched once.
 * Throws when a transaction cannot be fetched.
 */
export async function walkHistory(
    source: TxSource,
    outpoint: string
): Promise<DecodedCycle[]> {
    const cache = new Map<string, bsv.Transaction>()
    const fetchTx = async (txid: string): Promise<bsv.Transaction> => {
        let tx = cache.get(txid)
        if (!tx) {
            tx = await source.getTransaction(txid)
            cache.set(txid, tx)
        }
        return tx
    }
    const cycles: DecodedCycle[] = []
    let txid = parseOutpoint(outpoint).txid
    for (;;) {
        const tx = await fetchTx(txid)
        if (tx.inputs.length === 0) break
        const previousTxid = tx.inputs[0].prevTxId.toString('hex')
        const previousOut = (await fetchTx(previousTxid)).outputs[
            tx.inputs[0].outputIndex
        ]
        const previous =
            previousOut && decodeMachine(previousOut.script.toHex())
        if (!previous || !previous.machine) break // this transaction is the deployment
        const after = decodeMachine(tx.outputs[0].script.toHex())
        const rosterPayouts = new Map(
            previous.machine.roster.map((r) => [r.payoutHex, r.slot] as const)
        )
        const { reward, payout } = splitOutputs(
            tx,
            previousOut.satoshis,
            rosterPayouts
        )
        cycles.push({
            txid: tx.id,
            lockTime: tx.nLockTime,
            reward,
            payout,
            halted: !after.machine,
            state: after.machine,
        })
        txid = previousTxid
    }
    return cycles.reverse()
}
