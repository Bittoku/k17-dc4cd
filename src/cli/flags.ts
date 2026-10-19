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
