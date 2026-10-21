/**
 * Decoding of K17Machine locking scripts.
 *
 * `decodeMachine` accepts a locking script as hex and tells whether it is a
 * K17Machine made from the compiled artifact. A script counts as a machine
 * only when rebuilding it from its decoded fields gives the same bytes, so a
 * script with changed contract code is refused, not misread. The artifact
 * must be loaded first (`K17Machine.loadArtifact`).
 */

import { K17Machine, disassemble } from 'k17-vm'
import { decodeCells, rosterView, RosterView } from '../cli/scenario'

/** A K17 machine as stored in one UTXO. */
export interface DecodedMachine {
    /** Program bytecode, hex. */
    prog: string
    /** Program counter (byte offset). */
    pc: number
    /** Data stack cells, bottom first. */
    ds: bigint[]
    /** Return stack cells, bottom first. */
    rs: bigint[]
    /** Memory image, hex. */
    mem: string
    /** Output log cells. */
    outLog: bigint[]
    /** nLockTime of the transaction that made this state. */
    lastTime: bigint
    /** Filled memory roster slots. */
    roster: RosterView[]
    /** Disassembly of the program, one line per entry. */
    disassembly: string[]
    /** Deployment fields. */
    beneficiary: string
    rewardMin: bigint
    slope: bigint
    rewardMax: bigint
    /** Dead-man interval in seconds (v3.1); 0n means off. */
    deadMan: bigint
    instanceId: string
    /** Roster tree root (64 hex; tree-mode machines, else the empty root). */
    rosterRoot: string
    /** Number of admissions and removals so far. */
    rosterSeq: bigint
    /** Key hash of the sponsor (64 hex; all zero when the machine has no sponsor). */
    sponsorKeyHash: string
    /** Hash chain over the OUTH values, 64 hex (32 zero bytes at deployment). */
    logHash: string
}

/** Result of `decodeMachine`: the machine, or the reason it is not one. */
export interface DecodeResult {
    /** The machine, or null when the script is not one. */
    machine: DecodedMachine | null
    /** Why the script is not a machine; null when it is one. */
    reason: string | null
}

/** Reason text for a script that is not a K17 machine at all. */
export const NOT_A_MACHINE = 'not a K17 machine'

/** Reason text for a long script that is not built from the artifact. */
export const TEMPLATE_MISMATCH =
    'script does not match the K17Machine template of the artifact'

/**
 * Scripts shorter than this many hex characters cannot be a machine. A machine
 * holds the whole compiled contract, so it is at least as long as the
 * artifact's template less its placeholder tags (16 tags of up to 14
 * characters each, so 300 is a safe margin).
 */
const MIN_MACHINE_HEX: number =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('k17-vm/artifacts/k17Machine.json').hex.length - 300

/** A decode result that also keeps the contract instance, for replay. */
export interface DecodedInstance extends DecodeResult {
    /** The contract instance; null when the script is not a machine. */
    instance: K17Machine | null
}

/**
 * Decode a locking script.
 * Input: locking script as hex.
 * Output: `{ machine, reason: null }`, or `{ machine: null, reason }`. The
 * reason is "not a K17 machine" for short scripts such as P2PKH, and a text
 * that contains "template" when a long script does not match the artifact's
 * template (for example a changed contract).
 */
export function decodeMachine(lockingScriptHex: string): DecodeResult {
    const { machine, reason } = decodeInstance(lockingScriptHex)
    return { machine, reason }
}

/**
 * Decode a locking script and keep the contract instance.
 * Input: locking script as hex. Output: as `decodeMachine`, plus `instance`
 * (the K17Machine, for `planCycle` replay); null when not a machine.
 */
export function decodeInstance(lockingScriptHex: string): DecodedInstance {
    if (lockingScriptHex.length < MIN_MACHINE_HEX)
        return { machine: null, reason: NOT_A_MACHINE, instance: null }
    let instance: K17Machine
    try {
        instance = K17Machine.fromLockingScript(lockingScriptHex) as K17Machine
        // Rebuilding the script can also throw on a malformed state tail; any
        // failure here means the script is not this artifact's machine.
        if (instance.lockingScript.toHex() !== lockingScriptHex)
            return { machine: null, reason: TEMPLATE_MISMATCH, instance: null }
    } catch {
        return { machine: null, reason: TEMPLATE_MISMATCH, instance: null }
    }
    return {
        reason: null,
        instance,
        machine: {
            prog: instance.prog,
            pc: Number(instance.pc),
            ds: decodeCells(instance.ds),
            rs: decodeCells(instance.rs),
            mem: instance.mem,
            outLog: decodeCells(instance.outLog),
            lastTime: instance.lastTime,
            roster: rosterView(instance.mem),
            disassembly: disassemble(instance.prog).split('\n'),
            beneficiary: instance.beneficiary,
            rewardMin: instance.rewardMin,
            slope: instance.slope,
            rewardMax: instance.rewardMax,
            deadMan: instance.deadMan,
            instanceId: instance.instanceId,
            rosterRoot: instance.rosterRoot,
            rosterSeq: instance.rosterSeq,
            sponsorKeyHash: instance.sponsorKeyHash,
            logHash: instance.logHash,
        },
    }
}
