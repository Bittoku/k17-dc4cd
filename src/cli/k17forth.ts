#!/usr/bin/env node
/**
 * Entry point of the k17forth tool: dispatches to the `compile`, `run`,
 * `repl`, `inspect`, `deploy`, `endorse`, `keeper` and `gateway` sub-commands. `main` takes the arguments and an output sink so
 * tests can call it without a process.
 */

import { compileCommand } from './compile'
import { runCommand } from './run'
import { startRepl } from './repl'
import { inspectCommand } from './inspect'
import { deployCommand } from './deploy'
import { endorseCommand } from './endorse'
import { keeperCommand } from './keeper'
import { gatewayCommand } from './gateway'

/** Where a command writes its text. */
export interface CliIo {
    /** Normal output, one line per call. */
    out: (line: string) => void
    /** Error output, one line per call. */
    err: (line: string) => void
}

/** Output sink that writes to the process streams. */
export const PROCESS_IO: CliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
}

/** Help text of the whole tool. */
export const USAGE = `usage: k17forth <command> [arguments]

commands:
  compile <file.fs> [--json]              print hex, disassembly and cycle counts
  run <file.fs> --scenario <file.json>    run on the reference VM, one cycle per scenario entry
  repl [file.fs]                          type Forth and see the machine after each line
  inspect <txid[:vout]> [--history] [--json] [--network testnet|mainnet]
                                          show a machine on the chain and its cycles
  deploy <file.fs> --config <gw.toml> --deposit <sats> --reward-min <sats>
         --slope <sats/s> --reward-max <sats> [--beneficiary <addr>]
         [--roster <keys>] [--initial-mem <hexfile> | --sponsor <key>]
                                          deploy a machine, save its outpoint in the config
  endorse --config <sponsor.toml> --member <public key hex> --payout <addr> --slot <n>
                                          sponsor: enrol a landowner's key into a roster slot
  keeper --config <gw.toml> [--interval <seconds>]
                                          advance the machine in the config, one cycle per tick
  gateway init --config <gw.toml>         make the attester key, print what the sponsor needs
  gateway run --config <gw.toml> [--interval <seconds>] [--once]
                                          sign bridge readings and relay them to the machine`

/**
 * Run the tool.
 * Input: arguments (without node and script name) and an output sink.
 * Output: exit code, or a promise of it for `inspect`, `deploy`,
 * `endorse`, `keeper` and `gateway`, which use the chain.
 * The repl is asynchronous, so for `repl` this returns 0 when the session has
 * started and the process stays open until it ends.
 */
export function main(
    argv: string[],
    io: CliIo = PROCESS_IO
): number | Promise<number> {
    const [command, ...rest] = argv
    switch (command) {
        case 'compile':
            return compileCommand(rest, io)
        case 'run':
            return runCommand(rest, io)
        case 'repl':
            return startRepl(rest, io)
        case 'inspect':
            return inspectCommand(rest, io)
        case 'deploy':
            return deployCommand(rest, io)
        case 'endorse':
            return endorseCommand(rest, io)
        case 'keeper':
            return keeperCommand(rest, io)
        case 'gateway':
            return gatewayCommand(rest, io)
        default:
            io.err(USAGE)
            return 2
    }
}

if (require.main === module) {
    Promise.resolve(main(process.argv.slice(2))).then((code) => {
        process.exitCode = code
    })
}
