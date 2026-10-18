/**
 * Command-line driver for the Forth-subset compiler.
 *
 * Usage: npx ts-node src/forth/cli.ts file.fs
 * Prints the program as hex, then its disassembly.
 */

import { readFileSync } from 'fs'
import { disassemble } from 'k17-vm'
import { compileToHex, ForthCompileError } from './compiler'

/**
 * Compile the file named in argv[2] and print hex and disassembly.
 * Input: process arguments. Output: text on stdout; exit code 1 on error.
 */
function main(): void {
    const path = process.argv[2]
    if (!path) {
        console.error('usage: cli.ts file.fs')
        process.exit(2)
    }
    try {
        const hex = compileToHex(readFileSync(path, 'utf8'))
        console.log(hex)
        console.log(disassemble(hex))
    } catch (e) {
        if (e instanceof ForthCompileError) {
            console.error(`${path}: ${e.message}`)
            process.exit(1)
        }
        throw e
    }
}

main()
