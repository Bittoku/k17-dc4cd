/**
 * Small argument parser shared by the chain sub-commands (`deploy`,
 * `keeper`): `--name value` flags, `--name` switches and positional
 * arguments.
 */

/** Parsed arguments. */
export interface ParsedArgs {
    /** Arguments that are not flags, in order. */
    positional: string[]
    /** Value of each `--name value` flag, by name without the dashes. */
    values: Map<string, string>
    /** Names of the switches that are present. */
    switches: Set<string>
}

/**
 * Parse arguments.
 * Input: the arguments, the names of flags that take a value, and the names
 * of switches. Output: the parsed arguments, or a text that says what is
 * wrong (an unknown flag, or a flag with no value).
 */
export function parseFlags(
    args: string[],
    valueFlags: string[],
    switchFlags: string[] = []
): ParsedArgs | string {
    const parsed: ParsedArgs = {
        positional: [],
        values: new Map(),
        switches: new Set(),
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (!arg.startsWith('--')) {
            parsed.positional.push(arg)
            continue
        }
        const name = arg.slice(2)
        if (switchFlags.includes(name)) parsed.switches.add(name)
        else if (valueFlags.includes(name)) {
            const value = args[++i]
            if (value === undefined) return `${arg} needs a value`
            parsed.values.set(name, value)
        } else return `unknown flag ${arg}`
    }
    return parsed
}

/** Largest top-up the tools accept: 21 million coins, in satoshis. */
export const MAX_TOP_UP_SATS = 2_100_000_000_000_000n

/**
 * Read the value of a `--top-up` flag.
 * Input: the flag text, or undefined when the flag is absent.
 * Output: the top-up in satoshis (0n when the flag is absent), or a text
 * that says what is wrong: the value must be a non-negative whole number
 * of satoshis (digits only, no sign, no decimals, no unit) and at most
 * `MAX_TOP_UP_SATS`.
 */
export function parseTopUp(text: string | undefined): bigint | string {
    if (text === undefined) return 0n
    if (!/^\d+$/.test(text))
        return `--top-up must be a whole number of satoshis (0 or more), not "${text}"`
    const sats = BigInt(text)
    if (sats > MAX_TOP_UP_SATS)
        return `--top-up is too large (most ${MAX_TOP_UP_SATS} satoshis)`
    return sats
}

/** Help line for the `--top-up` flag, shared by the commands that send a cycle. */
export const TOP_UP_HELP =
    '--top-up <sats>: add sats to the machine escrow with the first cycle that goes out, paid from the wallet of this command; later cycles add nothing; refused when that cycle halts the machine'
