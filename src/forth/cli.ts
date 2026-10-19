/**
 * Command-line driver for the Forth-subset compiler.
 *
 * Usage: npx ts-node src/forth/cli.ts file.fs
 * Kept for `npm run forth`. It runs the `compile` sub-command of the
 * k17forth tool (src/cli/k17forth.ts), which prints hex, disassembly and
 * per-cycle instruction counts.
 */

import { compileCommand } from '../cli/compile'
import { PROCESS_IO } from '../cli/k17forth'

process.exitCode = compileCommand(process.argv.slice(2), PROCESS_IO)
