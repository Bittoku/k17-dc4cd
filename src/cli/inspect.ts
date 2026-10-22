/**
 * The `k17forth inspect` sub-command.
 *
 * Reads one UTXO from the chain, decodes it as a K17 machine and prints its
 * state: program counter, stacks, output log, memory, roster and
 * disassembly. With `--history` it also walks back to the deployment and
 * prints every cycle. `--json` prints one JSON object instead (big numbers
 * as strings).
 *
 * Tree-mode machines (a Merkle roster and a sponsor) also get the tree
 * state: roster root, seq, sponsor, log hash and, when the genesis
 * inscription is given (`--genesis` or `--config`), the member count. With
 * `--history` they get the roster table, every paid reading, every admission
 * and removal.
 * With `--history` every machine gets an exact log-hash check.
 */

import { createHash } from 'crypto'
import type { Provider } from 'scrypt-ts'
import { decodeLeafPre, encodeCell } from 'k17-vm'
import { memoryCells } from './scenario'
import type { CliIo } from './k17forth'
import { DecodedMachine, decodeMachine } from '../chain/decode'
import {
    DecodedCycle,
    TxSource,
    parseOutpoint,
    walkHistory,
} from '../chain/history'
import { makeProvider } from '../chain/provider'
import { NetworkName, loadConfig } from '../chain/config'
import { loadRoster } from '../chain/loadRoster'
import type { RosterMirror } from '../chain/roster'
import { isTreeProgram } from '../forth/compiler'

/** Help text of the inspect sub-command. */
export const INSPECT_USAGE =
    'usage: k17forth inspect <txid[:vout]> [--history] [--json] [--genesis <txid[:vout]> | --config <toml>] [--network testnet|mainnet]'

/** 32 zero bytes as hex: the log hash of a new machine, and "no sponsor". */
const ZERO_HASH = '00'.repeat(32)

/** One paid reading of a tree machine. */
export interface TreeReading {
    txid: string
    /** Round of the reading (the member's new `lastRound`). */
    round: number
    /** Leaf index of the member that was paid. */
    member: number
    /** The cells that the cycle folded into the log hash (OUTH), in order. */
    logged: bigint[]
    /** Satoshis paid to the member. */
    satoshis: number
}

/** One admission or removal of a tree machine. */
export interface TreeAdmin {
    txid: string
    op: 'admit' | 'remove'
    /** `rosterSeq` after the cycle. */
    seq: bigint
    /** Leaf index that was written or cleared. */
    leaf: number
    /** Key hash (64 hex) and payout (40 hex) of an admitted member. */
    keyHash?: string
    payout?: string
}

/** Result of the log-hash check. */
export interface LogHashCheck {
    status: 'verified' | 'mismatch' | 'not checked'
    /** Why the check did not run, or what differed. */
    detail?: string
}

/**
 * Check the log hash of a machine against its history.
 * Every cycle reports the cells that OUTH folded (`DecodedCycle.logged`, from
 * the replay), so folding them from 32 zero bytes with
 * `logHash := sha256(logHash || cell(value))` must give the machine's
 * `logHash`. This is exact for any program. A cycle that could not be
 * replayed hides its cells, so the check does not run then.
 * Input: the machine and the cycles (oldest first). Output: the check result.
 */
export function checkLogHash(
    machine: DecodedMachine,
    cycles: DecodedCycle[]
): LogHashCheck {
    const hidden = cycles.find((c) => c.ambiguous)
    if (hidden)
        return {
            status: 'not checked',
            detail: `cycle ${hidden.txid} could not be replayed`,
        }
    let folded = ZERO_HASH
    for (const cycle of cycles)
        for (const value of cycle.logged)
            folded = createHash('sha256')
                .update(Buffer.from(folded + encodeCell(value), 'hex'))
                .digest('hex')
    return folded === machine.logHash
        ? { status: 'verified' }
        : {
              status: 'mismatch',
              detail: `history gives ${folded}, the machine has ${machine.logHash}`,
          }
}

/**
 * Paid readings, admissions and removals found in the cycles.
 * A paid reading is a MEMBER cycle that wrote a leaf; its round is the new
 * leaf's `lastRound` and its logged cells are what the cycle folded.
 * Input: the cycles, oldest first. Output: both lists, in cycle order.
 */
export function treeEvents(cycles: DecodedCycle[]): {
    readings: TreeReading[]
    admin: TreeAdmin[]
} {
    const readings: TreeReading[] = []
    const admin: TreeAdmin[] = []
    for (const c of cycles) {
        if (c.ambiguous || !c.tree) continue
        const leaf = Number(c.tree.leafIndex)
        if (c.treeOp === 'member' && c.leafAfter && c.payout)
            readings.push({
                txid: c.txid,
                round: Number(decodeLeafPre(c.leafAfter).lastRound),
                member: leaf,
                logged: c.logged,
                satoshis: c.payout.satoshis,
            })
        else if (c.treeOp === 'admit' && c.leafAfter) {
            const fields = decodeLeafPre(c.leafAfter)
            admin.push({
                txid: c.txid,
                op: 'admit',
                seq: c.rosterSeq,
                leaf,
                keyHash: fields.keyHashHex,
                payout: fields.payoutHex,
            })
        } else if (c.treeOp === 'remove')
            admin.push({ txid: c.txid, op: 'remove', seq: c.rosterSeq, leaf })
    }
    return { readings, admin }
}

/** Tree machines have a sponsor or use the tree instructions. */
function isTreeMachine(machine: DecodedMachine): boolean {
    return isTreeProgram(machine.prog) || machine.sponsorKeyHash !== ZERO_HASH
}

/** Text lines for the roster mirror: a header and one line per member. */
function rosterLines(mirror: RosterMirror): string[] {
    const members = mirror.members()
    return [
        `roster (${members.length} member${members.length === 1 ? '' : 's'}):`,
        ...members.map(
            (m) =>
                `  [${m.index}] key=${m.keyHash.slice(0, 12)}.. payout=${
                    m.payout
                } lastRound ${m.lastRound}`
        ),
    ]
}

/** Text lines for the tree state of a machine (no history needed). */
function treeStateLines(
    machine: DecodedMachine,
    mirror?: RosterMirror
): string[] {
    return [
        `tree: roster root ${machine.rosterRoot} seq ${machine.rosterSeq}`,
        `tree: sponsor ${machine.sponsorKeyHash.slice(0, 12)}..`,
        `tree: logHash ${machine.logHash}`,
        mirror
            ? `tree: ${mirror.members().length} members`
            : 'tree: members not shown (give --genesis <txid[:vout]> or --config <toml>)',
    ]
}

/**
 * Text lines that describe a machine.
 * Input: the decoded machine. Output: lines, same layout as `run`.
 */
function machineLines(machine: DecodedMachine): string[] {
    const lines = [
        `pc ${machine.pc}  lastTime ${machine.lastTime}`,
        `ds [${machine.ds.join(' ')}]`,
        `rs [${machine.rs.join(' ')}]`,
        `out [${machine.outLog.join(' ')}]`,
    ]
    const cells = memoryCells(machine.mem)
    if (cells.length)
        lines.push('mem ' + cells.map(([i, v]) => `[${i}]=${v}`).join(' '))
    for (const r of machine.roster)
        lines.push(
            `roster ${r.slot} key=${r.keyHashShort}.. payout=${r.payoutHex}`
        )
    lines.push(
        `instance ${machine.instanceId}`,
        `beneficiary ${machine.beneficiary}  reward min ${machine.rewardMin} slope ${machine.slope} max ${machine.rewardMax}`,
        `dead-man: ${deadManText(machine.deadMan)}`,
        'program:',
        ...machine.disassembly.map((l) => '  ' + l)
    )
    return lines
}

/**
 * Text for the dead-man interval of a machine.
 * Input: the interval in seconds (0n = off). Output: "off", or the seconds
 * with the largest whole unit (days, hours, minutes) when it divides evenly,
 * for example "2592000 s (30 days)".
 */
export function deadManText(seconds: bigint): string {
    if (seconds === 0n) return 'off'
    const units: [string, bigint][] = [
        ['day', 86400n],
        ['hour', 3600n],
        ['minute', 60n],
    ]
    for (const [name, size] of units) {
        if (seconds % size === 0n) {
            const count = seconds / size
            return `${seconds} s (${count} ${name}${count === 1n ? '' : 's'})`
        }
    }
    return `${seconds} s`
}

/**
 * Text that shows the escrow top-up of a cycle in the history.
 * Input: the cycle. Output: ` top-up <sats>` when the cycle added value to
 * the machine, else an empty string (a cycle with no top-up shows nothing).
 */
export function topUpNote(cycle: DecodedCycle): string {
    return cycle.topUp > 0n ? ` top-up ${cycle.topUp}` : ''
}

/**
 * One text line that describes a cycle.
 * Input: the cycle. Output: the line.
 */
function cycleLine(cycle: DecodedCycle): string {
    if (cycle.ambiguous)
        return `${cycle.txid} lockTime ${
            cycle.lockTime
        } ambiguous: the cycle could not be replayed, so reward and payout are not known${topUpNote(
            cycle
        )} -> ${cycle.state ? `pc ${cycle.state.pc}` : 'halted'}`
    const payout = cycle.payout
        ? ` payout ${cycle.payout.satoshis} to ${cycle.payout.addressHex}` +
          (cycle.payout.slot === undefined
              ? ''
              : cycle.payout.slot === -1
              ? ' (tree member)'
              : ` (slot ${cycle.payout.slot})`)
        : ''
    const after = cycle.state ? `pc ${cycle.state.pc}` : 'halted'
    const topUp = topUpNote(cycle)
    return `${cycle.txid} lockTime ${cycle.lockTime} reward ${cycle.reward}${payout}${topUp} -> ${after}`
}

/**
 * JSON text of a value; bigint values become decimal strings.
 * Input: any value. Output: indented JSON.
 */
function toJson(value: unknown): string {
    return JSON.stringify(
        value,
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2
    )
}

/**
 * Outpoint of the deployment output of a machine, for `loadRoster`.
 * Input: the chain, the cycles from `walkHistory` (oldest first) and the
 * outpoint given to inspect. Output: the output that the oldest cycle spent,
 * or the given outpoint when there is no cycle (it is the deployment).
 */
async function deploymentOf(
    chain: TxSource,
    cycles: DecodedCycle[],
    given: string
): Promise<string> {
    if (cycles.length === 0) return given
    const first = await chain.getTransaction(cycles[0].txid)
    return `${first.inputs[0].prevTxId.toString('hex')}:${
        first.inputs[0].outputIndex
    }`
}

/**
 * Run the inspect sub-command.
 * Input: arguments after `inspect`, an output sink, and optionally a
 * transaction source (default: the chain provider of `--network`, testnet if
 * not given). Output: exit code: 0 on success, 1 when the output is not a
 * machine, the chain cannot be read, the roster does not load, or the log
 * hash does not match the history; 2 on wrong arguments.
 */
export async function inspectCommand(
    args: string[],
    io: CliIo,
    source?: TxSource
): Promise<number> {
    const json = args.includes('--json')
    const history = args.includes('--history')
    let network: NetworkName | undefined
    let genesisArg: string | undefined
    let configPath: string | undefined
    const positional: string[] = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--json' || arg === '--history') continue
        if (arg === '--genesis' || arg === '--config') {
            const value = args[++i]
            if (!value) {
                io.err(INSPECT_USAGE)
                return 2
            }
            if (arg === '--genesis') genesisArg = value
            else configPath = value
            continue
        }
        if (arg === '--network') {
            const value = args[++i]
            if (value !== 'testnet' && value !== 'mainnet') {
                io.err(INSPECT_USAGE)
                return 2
            }
            network = value
        } else positional.push(arg)
    }
    if (positional.length !== 1) {
        io.err(INSPECT_USAGE)
        return 2
    }
    let outpoint
    try {
        outpoint = parseOutpoint(positional[0])
    } catch (e) {
        io.err((e as Error).message)
        return 2
    }
    try {
        // The config gives the network unless --network was given.
        const saved = configPath ? loadConfig(configPath) : undefined
        const chain: TxSource =
            source ??
            (makeProvider(network ?? saved?.network ?? 'testnet', {
                readAttempts: 2,
            }) as Provider)
        const tx = await chain.getTransaction(outpoint.txid)
        const output = tx.outputs[outpoint.vout]
        if (!output) {
            io.err(`${outpoint.txid} has no output ${outpoint.vout}`)
            return 1
        }
        const decoded = decodeMachine(output.script.toHex())
        if (!decoded.machine) {
            io.err(`${outpoint.txid}:${outpoint.vout}: ${decoded.reason}`)
            return 1
        }
        const machine = decoded.machine
        const isTree = isTreeMachine(machine)
        // A tree machine needs its history for the roster and the checks.
        const cycles =
            history || (isTree && (genesisArg || configPath))
                ? await walkHistory(chain, positional[0])
                : undefined
        let mirror: RosterMirror | undefined
        if (isTree && (genesisArg || configPath)) {
            // An explicit --genesis wins over both genesis fields of the config.
            const genesisInscription = genesisArg ?? saved?.genesisInscription
            const genesisOutpoint =
                (genesisArg ? undefined : saved?.genesisOutpoint) ??
                (await deploymentOf(chain, cycles ?? [], positional[0]))
            mirror = (
                await loadRoster(
                    {
                        machineOutpoint: positional[0],
                        genesisInscription,
                        genesisOutpoint,
                    },
                    { provider: chain }
                )
            ).mirror
        }
        const events = isTree && history ? treeEvents(cycles ?? []) : undefined
        const logCheck =
            history && cycles ? checkLogHash(machine, cycles) : undefined
        const exitCode = logCheck?.status === 'mismatch' ? 1 : 0
        if (json) {
            io.out(
                toJson({
                    outpoint,
                    satoshis: output.satoshis,
                    machine,
                    ...(cycles && history ? { history: cycles } : {}),
                    ...(logCheck ? { logHashCheck: logCheck } : {}),
                    ...(isTree
                        ? { tree: { members: mirror?.members(), ...events } }
                        : {}),
                })
            )
            return exitCode
        }
        io.out(
            `output ${outpoint.txid}:${outpoint.vout}  ${output.satoshis} sats`
        )
        for (const line of machineLines(machine)) io.out(line)
        if (isTree)
            for (const line of treeStateLines(machine, mirror)) io.out(line)
        if (cycles && history) {
            io.out(`history (${cycles.length} cycles, oldest first):`)
            for (const cycle of cycles) io.out('  ' + cycleLine(cycle))
        }
        if (events) {
            if (mirror) for (const line of rosterLines(mirror)) io.out(line)
            else
                io.out(
                    'roster: not shown (give --genesis <txid[:vout]> or --config <toml>)'
                )
            io.out(`readings (${events.readings.length}):`)
            for (const r of events.readings)
                io.out(
                    `  round ${r.round} member ${
                        r.member
                    } logged [${r.logged.join(' ')}] paid ${r.satoshis} sats (${
                        r.txid
                    })`
                )
            io.out(`admissions and removals (${events.admin.length}):`)
            for (const a of events.admin)
                io.out(
                    a.op === 'admit'
                        ? `  seq ${a.seq} admit leaf ${
                              a.leaf
                          } key=${a.keyHash?.slice(0, 12)}.. payout=${
                              a.payout
                          } (${a.txid})`
                        : `  seq ${a.seq} remove leaf ${a.leaf} (${a.txid})`
                )
        }
        if (logCheck)
            io.out(
                `logHash: ${logCheck.status}` +
                    (logCheck.detail ? ` (${logCheck.detail})` : '')
            )
        return exitCode
    } catch (e) {
        io.err(`inspect: ${(e as Error).message}`)
        return 1
    }
}
