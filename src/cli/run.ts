/**
 * The `k17forth run` sub-command.
 *
 * Compiles a Forth source file and runs it on the reference VM, one cycle
 * per entry of a scenario JSON file (see scenario.ts). Prints status,
 * stacks, memory, roster slots and the output log after each cycle.
 */

import { readFileSync } from 'fs'
import { assemble } from 'k17-vm'
import { compile, ForthCompileError } from '../forth/compiler'
import { Scenario, formatReport, runScenario } from './scenario'
import type { CliIo } from './k17forth'

/** Help text of the run sub-command. */
export const RUN_USAGE = 'usage: k17forth run <file.fs> --scenario <file.json>'

/**
 * Run the run sub-command.
 * Input: arguments after `run` and an output sink. Output: exit code: 0 when
 * every cycle ran, 1 when a cycle ended in verify_failed or need_witness or
 * the source has an error, 2 on wrong arguments or an unreadable scenario.
 */
export function runCommand(args: string[], io: CliIo): number {
    const flag = args.indexOf('--scenario')
    const scenarioPath = flag >= 0 ? args[flag + 1] : undefined
    const files = args.filter((a, i) => a !== '--scenario' && i !== flag + 1)
    if (files.length !== 1 || !scenarioPath) {
        io.err(RUN_USAGE)
        return 2
    }
    let scenario: Scenario
    try {
        scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
        if (!Array.isArray(scenario.cycles))
            throw new Error('"cycles" must be a list')
    } catch (e) {
        io.err(`${scenarioPath}: ${(e as Error).message}`)
        return 2
    }
    let progHex: string
    try {
        progHex = assemble(compile(readFileSync(files[0], 'utf8')).tokens)
    } catch (e) {
        if (e instanceof ForthCompileError) {
            io.err(`${files[0]}: ${e.message}`)
            return 1
        }
        throw e
    }
    let blocked = false
    try {
        for (const report of runScenario(progHex, scenario)) {
            io.out(
                `cycle ${report.index}: ${report.status} (lockTime ${report.lockTime}, witness used ${report.witnessUsed})`
            )
            for (const line of formatReport(report)) io.out('  ' + line)
            if (
                report.status === 'verify_failed' ||
                report.status === 'need_witness'
            )
                blocked = true
        }
    } catch (e) {
        io.err(`${scenarioPath}: ${(e as Error).message}`)
        return 2
    }
    return blocked ? 1 : 0
}
