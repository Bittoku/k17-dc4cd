/**
 * Forth-subset compiler for the K17 stack machine.
 *
 * This module turns a small Forth dialect into a token array that the k17-vm
 * `assemble()` function accepts. It supports colon definitions, variables,
 * constants, the K17 primitive words, the immediate-operand words `bounty`
 * and `sigverify`, and the structured control words `if/else/then`,
 * `begin/until`, `begin/again` and `begin/while/repeat`.
 *
 * Output layout: top-level code first, then HALT, then all colon definitions.
 * Execution therefore starts at offset 0 with the top-level program.
 *
 * Control flow uses K17 `IF`, which jumps when the top of stack is ZERO.
 * An unconditional jump is written `LIT 0 IF label`.
 */

import {
    assemble,
    MEM_CELLS,
    OUT_MAX,
    ROSTER_BASE,
    ROSTER_SLOTS,
    SLOT_CELLS,
} from 'k17-vm'

/** Result of a compilation. */
export interface CompileResult {
    /** Tokens ready for k17-vm assemble(). */
    tokens: (string | number)[]
    /** Variable name -> memory cell index. */
    variables: Record<string, number>
    /** User-defined word names in definition order. */
    words: string[]
}

/** Error raised for any source problem. `line` is the 1-based source line. */
export class ForthCompileError extends Error {
    line: number

    /**
     * Input: error text and the 1-based source line. The message is prefixed
     * with the line number. Output: the error object.
     */
    constructor(message: string, line: number) {
        super(`line ${line}: ${message}`)
        this.name = 'ForthCompileError'
        this.line = line
        Object.setPrototypeOf(this, ForthCompileError.prototype)
    }
}

/** Number of memory cells on the K17 machine. */
const MEMORY_CELLS = 64
/** Modulus of a K17 cell (2^32). */
const CELL_MODULUS = 0x100000000n

/** Words that map one-to-one to a mnemonic (the mnemonic is the upper-case word). */
const PRIMITIVES: ReadonlySet<string> = new Set([
    'halt',
    '!',
    '+',
    '-',
    '>r',
    '@',
    'and',
    'drop',
    'dup',
    'or',
    'over',
    'r>',
    'swap',
    'xor',
    'exit',
    '0=',
    'out',
    'time',
    'in',
    'verify',
    '*',
    'hash',
    'who',
    'yield',
    'min',
    'max',
    '/',
    'attest',
    'endorse',
    'payslot',
    'value',
])

/** Built-in constants that compile to `LIT n`. They may not be redefined. */
const BUILTIN_CONSTANTS: Readonly<Record<string, number>> = {
    'roster-base': ROSTER_BASE,
    'slot-cells': SLOT_CELLS,
    'roster-slots': ROSTER_SLOTS,
    'mem-cells': MEM_CELLS,
    'out-max': OUT_MAX,
}

/** Words with a built-in meaning that a program may not redefine. */
const RESERVED: ReadonlySet<string> = new Set([
    ...PRIMITIVES,
    ...Object.keys(BUILTIN_CONSTANTS),
    'bounty',
    'sigverify',
    ':',
    ';',
    'variable',
    'constant',
    'if',
    'else',
    'then',
    'begin',
    'until',
    'again',
    'while',
    'repeat',
])

/** A source word together with its 1-based line number. */
interface SourceWord {
    text: string
    line: number
}

/** An open control-flow structure on the compile-time control stack. */
interface ControlEntry {
    kind: 'if' | 'else' | 'begin' | 'while'
    /** Label to place (if/else/while) or jump back to (begin). */
    label: string
    /** Line of the opening word, for error reports. */
    line: number
}

/**
 * Split source text into lower-cased words, dropping `\` line comments and
 * `( ... )` comments.
 * Input: source text. Output: list of words with line numbers.
 */
function tokenize(source: string): SourceWord[] {
    const words: SourceWord[] = []
    const lines = source.split(/\r?\n/)
    let parenStartLine = 0
    lines.forEach((lineText, index) => {
        const line = index + 1
        for (const raw of lineText.split(/\s+/)) {
            if (raw === '') continue
            if (parenStartLine) {
                if (raw.endsWith(')')) parenStartLine = 0
                continue
            }
            if (raw === '\\') break
            if (raw === '(') {
                parenStartLine = line
                continue
            }
            words.push({ text: raw.toLowerCase(), line })
        }
    })
    if (parenStartLine) {
        throw new ForthCompileError('unterminated ( comment', parenStartLine)
    }
    return words
}

/**
 * Parse a numeric literal (decimal or `$` hex), wrapping modulo 2^32.
 * Input: lower-case word. Output: the cell value, or null if not a number.
 */
function parseNumber(word: string): number | null {
    let value: bigint
    if (/^-?\d+$/.test(word)) value = BigInt(word)
    else if (/^\$[0-9a-f]+$/.test(word)) value = BigInt('0x' + word.slice(1))
    else return null
    return Number(((value % CELL_MODULUS) + CELL_MODULUS) % CELL_MODULUS)
}

/**
 * Remove a trailing `LIT n` from a token list and return n.
 * Input: token list and the line of the consuming word (for the error).
 * Output: the literal value; throws ForthCompileError if there is none.
 */
function popLiteral(
    target: (string | number)[],
    word: string,
    line: number
): number {
    const n = target.length
    if (
        n >= 2 &&
        target[n - 2] === 'LIT' &&
        typeof target[n - 1] === 'number'
    ) {
        const value = target[n - 1] as number
        target.length = n - 2
        return value
    }
    throw new ForthCompileError(
        `'${word}' must be preceded by a literal number`,
        line
    )
}

/**
 * Compile Forth-subset source to K17 assembler tokens.
 * Input: source text. Output: CompileResult (tokens, variables, words).
 * Throws ForthCompileError on any syntax or semantic error.
 */
export function compile(source: string): CompileResult {
    const words = tokenize(source)

    // Pre-scan colon names so a use before definition gets a clear message.
    const declaredLater = new Set<string>()
    words.forEach((w, i) => {
        if (w.text === ':' && i + 1 < words.length)
            declaredLater.add(words[i + 1].text)
    })

    const main: (string | number)[] = []
    const definitions: (string | number)[] = []
    const variables: Record<string, number> = {}
    const constants: Record<string, number> = {}
    const defined: string[] = []
    let nextCell = 0
    let labelCounter = 0
    let control: ControlEntry[] = []
    // Current definition: its token list and start line (null at top level).
    let current: {
        name: string
        tokens: (string | number)[]
        line: number
    } | null = null

    const newLabel = (): string => `L${labelCounter++}`
    const target = (): (string | number)[] => (current ? current.tokens : main)

    /** Read the name argument of a defining word. */
    const nextName = (index: number, owner: SourceWord): SourceWord => {
        if (index >= words.length) {
            throw new ForthCompileError(
                `'${owner.text}' needs a name`,
                owner.line
            )
        }
        const name = words[index]
        if (
            RESERVED.has(name.text) ||
            parseNumber(name.text) !== null ||
            name.text.endsWith(':')
        ) {
            throw new ForthCompileError(
                `invalid name '${name.text}'`,
                name.line
            )
        }
        if (
            defined.includes(name.text) ||
            name.text in variables ||
            name.text in constants
        ) {
            throw new ForthCompileError(
                `'${name.text}' is already defined`,
                name.line
            )
        }
        return name
    }

    /** Pop the top control entry, requiring one of the given kinds. */
    const popControl = (
        word: SourceWord,
        kinds: ControlEntry['kind'][]
    ): ControlEntry => {
        const entry = control[control.length - 1]
        if (!entry || !kinds.includes(entry.kind)) {
            throw new ForthCompileError(
                `'${word.text}' without matching ${kinds.join('/')}`,
                word.line
            )
        }
        control.pop()
        return entry
    }

    for (let i = 0; i < words.length; i++) {
        const word = words[i]
        const text = word.text
        const out = target()

        const numeric = parseNumber(text)
        if (numeric !== null) {
            out.push('LIT', numeric)
        } else if (text in BUILTIN_CONSTANTS) {
            out.push('LIT', BUILTIN_CONSTANTS[text])
        } else if (PRIMITIVES.has(text)) {
            out.push(text.toUpperCase())
        } else if (text === 'bounty' || text === 'sigverify') {
            const operand = popLiteral(out, text, word.line)
            out.push(text.toUpperCase(), operand)
        } else if (text === ':') {
            if (current)
                throw new ForthCompileError('nested definition', word.line)
            const name = nextName(++i, word)
            current = {
                name: name.text,
                tokens: [`${name.text}:`],
                line: word.line,
            }
            defined.push(name.text)
            control = []
        } else if (text === ';') {
            if (!current)
                throw new ForthCompileError(
                    "';' outside a definition",
                    word.line
                )
            if (control.length) {
                const open = control[control.length - 1]
                throw new ForthCompileError(
                    `unterminated '${open.kind}' in '${current.name}'`,
                    open.line
                )
            }
            current.tokens.push('EXIT')
            definitions.push(...current.tokens)
            current = null
        } else if (text === 'variable') {
            const name = nextName(++i, word)
            if (nextCell >= MEMORY_CELLS) {
                throw new ForthCompileError(
                    `out of memory cells (max ${MEMORY_CELLS})`,
                    word.line
                )
            }
            variables[name.text] = nextCell++
        } else if (text === 'constant') {
            const value = popLiteral(out, text, word.line)
            const name = nextName(++i, word)
            constants[name.text] = value
        } else if (text === 'if') {
            const label = newLabel()
            out.push('IF', label)
            control.push({ kind: 'if', label, line: word.line })
        } else if (text === 'else') {
            const entry = popControl(word, ['if'])
            const endLabel = newLabel()
            out.push('LIT', 0, 'IF', endLabel, `${entry.label}:`)
            control.push({ kind: 'else', label: endLabel, line: word.line })
        } else if (text === 'then') {
            const entry = popControl(word, ['if', 'else'])
            out.push(`${entry.label}:`)
        } else if (text === 'begin') {
            const label = newLabel()
            out.push(`${label}:`)
            control.push({ kind: 'begin', label, line: word.line })
        } else if (text === 'until') {
            out.push('IF', popControl(word, ['begin']).label)
        } else if (text === 'again') {
            out.push('LIT', 0, 'IF', popControl(word, ['begin']).label)
        } else if (text === 'while') {
            const label = newLabel()
            if (control[control.length - 1]?.kind !== 'begin') {
                throw new ForthCompileError(
                    "'while' without matching begin",
                    word.line
                )
            }
            out.push('IF', label)
            control.push({ kind: 'while', label, line: word.line })
        } else if (text === 'repeat') {
            const exit = popControl(word, ['while'])
            const begin = popControl(word, ['begin'])
            out.push('LIT', 0, 'IF', begin.label, `${exit.label}:`)
        } else if (text in variables) {
            out.push('LIT', variables[text])
        } else if (text in constants) {
            out.push('LIT', constants[text])
        } else if (defined.includes(text)) {
            out.push('CALL', text)
        } else if (declaredLater.has(text)) {
            throw new ForthCompileError(
                `forward reference to '${text}' (define words before use)`,
                word.line
            )
        } else {
            throw new ForthCompileError(`unknown word '${text}'`, word.line)
        }
    }

    if (current) {
        throw new ForthCompileError(
            `unterminated definition '${current.name}'`,
            current.line
        )
    }
    if (control.length) {
        const open = control[control.length - 1]
        throw new ForthCompileError(`unterminated '${open.kind}'`, open.line)
    }

    return {
        tokens: [...main, 'HALT', ...definitions],
        variables,
        words: defined,
    }
}

/**
 * Compile Forth-subset source and assemble it to program hex.
 * Input: source text. Output: program hex string for the K17 VM.
 */
export function compileToHex(source: string): string {
    return assemble(compile(source).tokens)
}

/**
 * Count the instructions in each cycle of a token list. A cycle ends at each
 * `YIELD` (the `YIELD` counts in the cycle it ends). Labels (`name:`) and the
 * numeric operands that follow `LIT`, `BOUNTY` and similar are not counted.
 * The first cycle starts at the program start; the last ends at the end of
 * the token list. Input: tokens from compile(). Output: one count per cycle.
 */
export function cycleInstructionCounts(tokens: (string | number)[]): number[] {
    const counts: number[] = []
    let current = 0
    for (const token of tokens) {
        if (typeof token !== 'string') continue
        if (token.endsWith(':')) continue
        current++
        if (token === 'YIELD') {
            counts.push(current)
            current = 0
        }
    }
    counts.push(current)
    return counts
}
