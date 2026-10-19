/**
 * The `k17forth inspect` sub-command.
 *
 * Reads one UTXO from the chain, decodes it as a K17 machine and prints its
 * state: program counter, stacks, output log, memory, roster and
 * disassembly. With `--history` it also walks back to the deployment and
 * prints every cycle. `--json` prints one JSON object instead (big numbers
 * as strings).
 */

import type { Provider } from 'scrypt-ts'
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
import type { NetworkName } from '../chain/config'

/** Help text of the inspect sub-command. */
export const INSPECT_USAGE =
    'usage: k17forth inspect <txid[:vout]> [--history] [--json] [--network testnet|mainnet]'

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
 * One text line that describes a cycle.
 * Input: the cycle. Output: the line.
 */
function cycleLine(cycle: DecodedCycle): string {
    if (cycle.ambiguous)
        return `${cycle.txid} lockTime ${
            cycle.lockTime
        } ambiguous: the cycle could not be replayed, so reward and payout are not known -> ${
            cycle.state ? `pc ${cycle.state.pc}` : 'halted'
        }`
    const payout = cycle.payout
        ? ` payout ${cycle.payout.satoshis} to ${cycle.payout.addressHex}` +
          (cycle.payout.slot === undefined
              ? ''
              : cycle.payout.slot === -1
              ? ' (tree member)'
              : ` (slot ${cycle.payout.slot})`)
        : ''
    const after = cycle.state ? `pc ${cycle.state.pc}` : 'halted'
    return `${cycle.txid} lockTime ${cycle.lockTime} reward ${cycle.reward}${payout} -> ${after}`
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
 * Run the inspect sub-command.
 * Input: arguments after `inspect`, an output sink, and optionally a
 * transaction source (default: the chain provider of `--network`, testnet if
 * not given). Output: exit code: 0 on success, 1 when the output is not a
 * machine or the chain cannot be read, 2 on wrong arguments.
 */
export async function inspectCommand(
    args: string[],
    io: CliIo,
    source?: TxSource
): Promise<number> {
    const json = args.includes('--json')
    const history = args.includes('--history')
    let network: NetworkName = 'testnet'
    const positional: string[] = []
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--json' || arg === '--history') continue
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
        const chain: TxSource =
            source ?? (makeProvider(network, { readAttempts: 2 }) as Provider)
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
        const cycles = history
            ? await walkHistory(chain, positional[0])
            : undefined
        if (json) {
            io.out(
                toJson({
                    outpoint,
                    satoshis: output.satoshis,
                    machine: decoded.machine,
                    ...(cycles ? { history: cycles } : {}),
                })
            )
            return 0
        }
        io.out(
            `output ${outpoint.txid}:${outpoint.vout}  ${output.satoshis} sats`
        )
        for (const line of machineLines(decoded.machine)) io.out(line)
        if (cycles) {
            io.out(`history (${cycles.length} cycles, oldest first):`)
            for (const cycle of cycles) io.out('  ' + cycleLine(cycle))
        }
        return 0
    } catch (e) {
        io.err(`inspect: ${(e as Error).message}`)
        return 1
    }
}
