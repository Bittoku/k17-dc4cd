/**
 * The `k17forth repl` sub-command: a line-at-a-time Forth on the reference VM.
 *
 * Each line is compiled as top-level code appended to the program so far and
 * run from where the last line stopped, until it finishes or blocks. Stacks,
 * memory, variables and words stay between lines. A line that blocks
 * (need_witness, verify_failed) or does not compile changes nothing.
 * Dot commands set up the signatures, witness cells and roster for the next
 * line. The `Repl` class holds all logic; `startRepl` adds the readline loop.
 */

import { readFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import {
    HAS_OPERAND,
    K17State,
    MNEMONIC,
    PaySlot,
    ROSTER_SLOTS,
    SLOT_CELLS,
    Status,
    assemble,
    initialState,
    keyHash,
    slotCells,
    step,
    withSlot,
} from 'k17-vm'
import { compile, ForthCompileError } from '../forth/compiler'
import {
    AttesterBook,
    CycleSpec,
    DEFAULT_INSTANCE_ID,
    DEFAULT_PAYOUT,
    cycleEnvironment,
    decodeCells,
    formatReport,
    memoryWithRoster,
    reportOf,
    toBig,
} from './scenario'
import type { CliIo } from './k17forth'

/** Most instructions one line may run before the repl gives up on it. */
export const STEP_LIMIT = 100_000

/** Help text of the repl commands. */
export const REPL_HELP = `Type Forth. Each line runs at once. Commands:
  .mem A B                          show memory cells A to B
  .roster                           show roster slots and the fixed roster
  .attester NAME SEEDHEX            define a signer from a 32-byte seed
  .enrol SLOT NAME [PAYOUTHEX]      put NAME in memory roster SLOT
  .fixed NAME...                    set the SIGVERIFY roster (by name)
  .witness N...                     witness cells for the next line
  .attest NAME TAG VALUE            sign for ATTEST in the next line
  .sigverify NAME TAG VALUE         sign for SIGVERIFY in the next line
  .endorse NAME TAG PAYOUTHEX NEWMEMBER NEWSLOT   sign for ENDORSE in the next line
  .value N                          VALUE of the spent output
  .time N                           TIME (nLockTime)
  .reset                            empty machine, same signers
  .save FILE                        write the accepted source to FILE
  .help                             show this text`

/**
 * Number of program bytes that a token list assembles to.
 * Input: assembler tokens (labels allowed, label operands allowed).
 * Output: byte length.
 */
export function byteLength(tokens: (string | number)[]): number {
    let bytes = 0
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (typeof token !== 'string' || token.endsWith(':')) continue
        bytes += 1
        if (HAS_OPERAND.has(MNEMONIC[token])) {
            bytes += 4
            i++
        }
    }
    return bytes
}

/** The line-at-a-time Forth machine. */
export class Repl {
    private book = new AttesterBook()
    private fixedRoster: string[] = []
    private slotNames: Record<string, string> = {}
    private payouts: Record<string, string> = {}
    private source = ''
    private state: K17State
    /** Byte offset where the next line's code starts. */
    private mainEnd = 0
    private lockTime = 0n
    private value = 0n
    private pending: CycleSpec = { lockTime: 0 }
    private lineCount = 0

    /** Output: an empty machine. */
    constructor() {
        this.state = this.freshState()
    }

    /** Output: an empty machine whose memory holds the enrolled roster slots. */
    private freshState(): K17State {
        const names = Object.keys(this.slotNames)
        return initialState(
            '',
            names.length ? this.memoryWithPayouts() : undefined
        )
    }

    /** Output: the memory image with every enrolled slot written. */
    private memoryWithPayouts(): string {
        let mem = memoryWithRoster(this.book, {})
        for (const [slot, name] of Object.entries(this.slotNames))
            mem = withSlot(
                mem,
                Number(slot),
                slotCells(
                    keyHash(this.book.get(name).pub),
                    this.payouts[slot] ?? DEFAULT_PAYOUT
                )
            )
        return mem
    }

    /**
     * Run every line of `input` in turn.
     * Input: text with one or more lines (Forth or dot commands).
     * Output: the text lines to print, in order.
     */
    execute(input: string): string[] {
        const lines: string[] = []
        for (const line of input.split('\n'))
            lines.push(...this.executeLine(line))
        return lines
    }

    /**
     * Load a source file as one chunk, so colon definitions may span lines.
     * Input: Forth text. Output: the text lines to print.
     */
    load(source: string): string[] {
        return this.runChunk(source)
    }

    /** Input: one line. Output: the text lines to print. */
    private executeLine(line: string): string[] {
        const trimmed = line.trim()
        if (trimmed.startsWith('.')) {
            try {
                return this.command(trimmed.split(/\s+/))
            } catch (e) {
                return [`error: ${(e as Error).message}`]
            }
        }
        return this.runChunk(line)
    }

    /**
     * Compile `text` after the accepted source and run it.
     * Input: Forth text. Output: status line then the machine view.
     */
    private runChunk(text: string): string[] {
        const candidate = this.source ? `${this.source}\n${text}` : text
        let tokens: (string | number)[]
        let mainLength: number
        let progHex: string
        try {
            const result = compile(candidate)
            tokens = result.tokens
            mainLength = result.mainLength
            progHex = assemble(tokens)
        } catch (e) {
            if (e instanceof ForthCompileError) return [`error: ${e.message}`]
            throw e
        }
        if (this.state.halted)
            return ['error: the machine has halted; use .reset']
        const lineEnd = byteLength(tokens.slice(0, mainLength))
        let env
        try {
            env = cycleEnvironment(
                this.book,
                {
                    ...this.pending,
                    lockTime: this.lockTime,
                    value: this.value,
                },
                this.fixedRoster,
                DEFAULT_INSTANCE_ID
            )
        } catch (e) {
            return [`error: ${(e as Error).message}`]
        }

        let state: K17State = {
            ...this.state,
            prog: progHex,
            pc: BigInt(this.mainEnd),
        }
        let status: Status = 'ok'
        let witnessIndex = 0
        let bountyDue = 0n
        let sigUsed = false
        let payslot: PaySlot | undefined
        let steps = 0
        while (state.pc !== BigInt(lineEnd)) {
            if (++steps > STEP_LIMIT)
                return [
                    `error: more than ${STEP_LIMIT} instructions; line not run`,
                    ...this.view('ok'),
                ]
            const r = step(
                state,
                env,
                witnessIndex,
                bountyDue,
                sigUsed,
                payslot
            )
            status = r.status
            if (status === 'need_witness' || status === 'verify_failed')
                return [`${status}: line not run`, ...this.view('ok')]
            state = r.state
            witnessIndex = r.witnessIndex
            bountyDue = r.bountyDue
            sigUsed = r.sigUsed
            payslot = r.payslot
            if (status === 'halted' || status === 'fault') break
            if (status === 'yield') {
                witnessIndex = 0
                bountyDue = 0n
                sigUsed = false
                payslot = undefined
            }
        }
        this.state = state
        this.source = candidate
        this.mainEnd = lineEnd
        this.pending = { lockTime: 0 }
        return this.view(status, witnessIndex, bountyDue, payslot)
    }

    /**
     * The status line and machine view of the current state.
     * Input: status and the counters of the cycle. Output: text lines.
     */
    private view(
        status: Status,
        witnessUsed = 0,
        bountyDue = 0n,
        payslot?: PaySlot
    ): string[] {
        const report = reportOf(
            this.lineCount++,
            status,
            this.lockTime,
            this.state,
            witnessUsed,
            bountyDue,
            payslot
        )
        return [status, ...formatReport(report)]
    }

    /** Input: words of a dot command. Output: text lines. Throws on bad arguments. */
    private command(words: string[]): string[] {
        const [name, ...args] = words
        const need = (count: number) => {
            if (args.length < count)
                throw new Error(`${name} needs ${count} arguments; see .help`)
        }
        switch (name) {
            case '.help':
                return REPL_HELP.split('\n')
            case '.mem': {
                need(2)
                const first = Number(args[0])
                const last = Number(args[1])
                const cells = decodeCells(this.state.mem)
                if (!(first >= 0 && last >= first && last < cells.length))
                    throw new Error(
                        `cells must satisfy 0 <= A <= B < ${cells.length}`
                    )
                return cells
                    .slice(first, last + 1)
                    .map((v, i) => `[${first + i}]=${v}`)
            }
            case '.roster': {
                const lines = this.view('ok').filter((l) =>
                    l.startsWith('roster')
                )
                lines.push(`fixed [${this.fixedRoster.join(', ')}]`)
                return lines
            }
            case '.attester':
                need(2)
                this.book.define(args[0], args[1])
                return ['ok']
            case '.enrol': {
                need(2)
                const slot = Number(args[0])
                if (
                    !(
                        Number.isInteger(slot) &&
                        slot >= 0 &&
                        slot < ROSTER_SLOTS
                    )
                )
                    throw new Error(`slot must be 0..${ROSTER_SLOTS - 1}`)
                const payout = args[2] ?? DEFAULT_PAYOUT
                const cells = slotCells(
                    keyHash(this.book.get(args[1]).pub),
                    payout
                )
                if (cells.length !== SLOT_CELLS)
                    throw new Error('payout must be 40 hex characters')
                this.state = {
                    ...this.state,
                    mem: withSlot(this.state.mem, slot, cells),
                }
                this.slotNames[String(slot)] = args[1]
                this.payouts[String(slot)] = payout
                return ['ok']
            }
            case '.fixed':
                args.forEach((n) => this.book.get(n))
                this.fixedRoster = args
                return ['ok']
            case '.witness':
                this.pending.witness = args.map(toBig)
                return ['ok']
            case '.attest':
                need(3)
                this.book.get(args[0])
                this.pending.attest = {
                    attester: args[0],
                    tag: args[1],
                    value: args[2],
                }
                return ['ok']
            case '.sigverify':
                need(3)
                this.book.get(args[0])
                this.pending.sigverify = {
                    attester: args[0],
                    tag: args[1],
                    value: args[2],
                }
                return ['ok']
            case '.endorse':
                need(5)
                this.book.get(args[0])
                this.book.get(args[3])
                this.pending.endorse = {
                    endorser: args[0],
                    tag: args[1],
                    payoutHex: args[2],
                    newMember: args[3],
                    newSlot: Number(args[4]),
                }
                return ['ok']
            case '.value':
                need(1)
                this.value = toBig(args[0])
                return ['ok']
            case '.time':
                need(1)
                this.lockTime = toBig(args[0])
                return ['ok']
            case '.reset':
                this.source = ''
                this.mainEnd = 0
                this.pending = { lockTime: 0 }
                this.state = this.freshState()
                return this.view('ok')
            case '.save':
                need(1)
                writeFileSync(args[0], this.source + '\n')
                return [`saved ${args[0]}`]
            default:
                throw new Error(`unknown command ${name}; see .help`)
        }
    }
}

/**
 * Start an interactive repl on the terminal.
 * Input: arguments after `repl` (optional source file to load first) and an
 * output sink. Output: 0 once the session has started, 1 if the file cannot
 * be read or compiled. The process stays open until input ends.
 */
export function startRepl(args: string[], io: CliIo): number {
    const repl = new Repl()
    if (args.length > 1) {
        io.err('usage: k17forth repl [file.fs]')
        return 2
    }
    if (args.length === 1) {
        let loaded: string[]
        try {
            loaded = repl.load(readFileSync(args[0], 'utf8'))
        } catch (e) {
            io.err(`${args[0]}: ${(e as Error).message}`)
            return 1
        }
        if (loaded[0].startsWith('error')) {
            io.err(`${args[0]}: ${loaded[0]}`)
            return 1
        }
        loaded.forEach((l) => io.out(l))
    }
    io.out('k17forth repl. Type .help for commands, Ctrl-D to leave.')
    const lines = createInterface({ input: process.stdin, prompt: 'k17> ' })
    lines.prompt()
    lines.on('line', (line) => {
        repl.execute(line).forEach((l) => io.out(l))
        lines.prompt()
    })
    return 0
}
