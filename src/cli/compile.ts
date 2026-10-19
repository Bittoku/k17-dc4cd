/**
 * The `k17forth compile` sub-command.
 *
 * Compiles a Forth source file and prints the program as hex, its
 * disassembly and the instruction count of each cycle. `--json` prints the
 * same data as one JSON object.
 */

import { readFileSync } from 'fs'
import { disassemble, assemble } from 'k17-vm'
import {
    compile,
    cycleInstructionCounts,
    ForthCompileError,
} from '../forth/compiler'
import type { CliIo } from './k17forth'

/** Help text of the compile sub-command. */
export const COMPILE_USAGE = 'usage: k17forth compile <file.fs> [--json]'

/**
 * Run the compile sub-command.
 * Input: arguments after `compile` (file path, optional --json) and an
 * output sink. Output: exit code: 0 on success, 1 on a source error, 2 on
 * wrong arguments.
 */
export function compileCommand(args: string[], io: CliIo): number {
    const json = args.includes('--json')
    const files = args.filter((a) => a !== '--json')
    if (files.length !== 1) {
        io.err(COMPILE_USAGE)
        return 2
    }
    const path = files[0]
    try {
        const result = compile(readFileSync(path, 'utf8'))
        const hex = assemble(result.tokens)
        const cycles = cycleInstructionCounts(result.tokens)
        if (json) {
            io.out(
                JSON.stringify(
                    {
                        hex,
                        disassembly: disassemble(hex).split('\n'),
                        cycles,
                        variables: result.variables,
                        words: result.words,
                    },
                    null,
                    2
                )
            )
        } else {
            io.out(hex)
            io.out(disassemble(hex))
            io.out(`cycles: ${cycles.join(', ')}`)
        }
        return 0
    } catch (e) {
        if (e instanceof ForthCompileError) {
            io.err(`${path}: ${e.message}`)
            return 1
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${path}: file not found`)
            return 1
        }
        throw e
    }
}
