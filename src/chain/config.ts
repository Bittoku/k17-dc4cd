/**
 * Gateway configuration loader.
 *
 * Reads the TOML file that the gateway and keeper tools share: network,
 * wallet key, attester (Rabin) key, payout address, serial bridge, target
 * machine and gateway options. The file holds secrets (`wif`, `rabin_p`,
 * `rabin_q`), so the loader refuses a file that other users can read, and
 * `describeConfig` shows a configuration with the secrets hidden. No error
 * message or description ever contains a secret value. `saveMachine`
 * writes a new `[machine]` outpoint and instance id into the file in place,
 * atomically, and keeps the file mode.
 */

import {
    chmodSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs'
import { randomBytes } from 'crypto'
import * as TOML from '@iarna/toml'

/** Networks the tools can talk to. */
export type NetworkName = 'testnet' | 'mainnet'

/** The validated configuration. Optional parts are undefined when not set. */
export interface GatewayConfig {
    network: NetworkName
    /** Wallet private key in WIF form. SECRET. */
    wif: string
    /** First Rabin prime of the attester key, as a decimal or 0x string. SECRET. */
    rabinP?: string
    /** Second Rabin prime of the attester key. SECRET. */
    rabinQ?: string
    /** Address that the attester's payouts go to. */
    payoutAddress?: string
    /** Serial device of the sensor bridge, for example /dev/ttyUSB0. */
    serial?: string
    /** The machine to serve, as `txid:vout`. */
    machineOutpoint?: string
    /** Instance id of that machine, 64 hex characters (`[machine] instance_id`). */
    instanceId?: string
    /** Roster slot of this gateway. */
    slot?: number
    /** Sign a reading even when the gateway thinks it is out of range. */
    signAnyway: boolean
}

/**
 * Read a table from parsed TOML.
 * Input: the parsed document and a table name. Output: the table, or an
 * empty object when it is not there.
 */
function table(doc: TOML.JsonMap, name: string): TOML.JsonMap {
    const value = doc[name]
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as TOML.JsonMap)
        : {}
}

/**
 * Read an optional string value.
 * Input: a table and a key. Output: the string, or undefined.
 * Throws (naming the key, not the value) when the value is not a string.
 */
function optionalString(
    section: string,
    t: TOML.JsonMap,
    key: string
): string | undefined {
    const value = t[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string')
        throw new Error(`config: [${section}] ${key} must be a string`)
    return value
}

/**
 * Load and check a configuration file.
 * Input: path to the TOML file.
 * Output: the configuration. Throws an Error with a plain message when the
 * file can be read by group or other users, when it is not valid TOML, or
 * when `network.name` or `wallet.wif` is missing or wrong.
 */
export function loadConfig(path: string): GatewayConfig {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077)
        throw new Error(
            `config: ${path} holds secrets but other users can read it ` +
                `(mode ${mode.toString(8)}). Run: chmod 600 ${path}`
        )
    let doc: TOML.JsonMap
    try {
        doc = TOML.parse(readFileSync(path, 'utf8'))
    } catch (e) {
        // The parser message quotes the source line, which can hold a secret.
        // Report only the row and column.
        const { line, col } = e as { line?: number; col?: number }
        const where =
            typeof line === 'number' && typeof col === 'number'
                ? ` at row ${line + 1}, col ${col + 1}`
                : ''
        throw new Error(`config: ${path} is not valid TOML${where}`)
    }
    const network = optionalString('network', table(doc, 'network'), 'name')
    if (network !== 'testnet' && network !== 'mainnet')
        throw new Error('config: [network] name must be "testnet" or "mainnet"')
    const wif = optionalString('wallet', table(doc, 'wallet'), 'wif')
    if (!wif) throw new Error('config: [wallet] wif is required')
    const attester = table(doc, 'attester')
    const machine = table(doc, 'machine')
    const gateway = table(doc, 'gateway')
    const slot = gateway.slot
    if (
        slot !== undefined &&
        (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0)
    )
        throw new Error(
            'config: [gateway] slot must be a whole number, 0 or more'
        )
    const signAnyway = gateway.sign_anyway
    if (signAnyway !== undefined && typeof signAnyway !== 'boolean')
        throw new Error('config: [gateway] sign_anyway must be true or false')
    return {
        network,
        wif,
        rabinP: optionalString('attester', attester, 'rabin_p'),
        rabinQ: optionalString('attester', attester, 'rabin_q'),
        payoutAddress: optionalString('attester', attester, 'payout_address'),
        serial: optionalString('bridge', table(doc, 'bridge'), 'serial'),
        machineOutpoint: optionalString('machine', machine, 'outpoint'),
        instanceId: optionalString('machine', machine, 'instance_id'),
        slot: slot as number | undefined,
        signAnyway: signAnyway === true,
    }
}

/**
 * Describe a configuration for a log line.
 * Input: a configuration. Output: one line of text. The three secrets
 * (wif, rabin_p, rabin_q) show only as "set" or "not set".
 */
export function describeConfig(cfg: GatewayConfig): string {
    const secret = (v?: string) => (v ? 'set' : 'not set')
    return [
        `network=${cfg.network}`,
        `wif=${secret(cfg.wif)}`,
        `rabin_p=${secret(cfg.rabinP)}`,
        `rabin_q=${secret(cfg.rabinQ)}`,
        `payout_address=${cfg.payoutAddress ?? 'not set'}`,
        `serial=${cfg.serial ?? 'not set'}`,
        `machine=${cfg.machineOutpoint ?? 'not set'}`,
        `slot=${cfg.slot ?? 'not set'}`,
        `sign_anyway=${cfg.signAnyway}`,
    ].join(' ')
}

/** TOML line that starts a table, for example `[machine]`. */
const TABLE_HEADER = /^\s*\[/

/**
 * Set `[machine] outpoint` and `instance_id` in the text of a config file.
 * Input: the file text, the outpoint (`txid:vout`) and the instance id.
 * Output: the new text. Other lines, comments included, do not change; old
 * `outpoint` and `instance_id` lines of the `[machine]` table are replaced;
 * the table is added at the end when it is not there.
 */
export function withMachine(
    text: string,
    outpoint: string,
    instanceId: string
): string {
    const entries = [
        `outpoint = ${JSON.stringify(outpoint)}`,
        `instance_id = ${JSON.stringify(instanceId)}`,
    ]
    const lines = text.split('\n')
    const header = lines.findIndex((l) => /^\s*\[machine\]\s*(#.*)?$/.test(l))
    if (header < 0) {
        const body =
            text.length === 0 || text.endsWith('\n') ? text : text + '\n'
        return `${body}\n[machine]\n${entries.join('\n')}\n`
    }
    let end = lines.findIndex((l, i) => i > header && TABLE_HEADER.test(l))
    if (end < 0) end = lines.length
    const kept = lines
        .slice(header + 1, end)
        .filter((l) => !/^\s*(outpoint|instance_id)\s*=/.test(l))
    return [
        ...lines.slice(0, header + 1),
        ...entries,
        ...kept,
        ...lines.slice(end),
    ].join('\n')
}

/**
 * Write the machine outpoint and instance id into a config file.
 * Input: the file path, the outpoint and the instance id.
 * Output: none. The new text goes to a temporary file in the same folder
 * with the old file mode (600 for a valid config), which then replaces the
 * file by rename, so a crash never leaves half a file. Throws (with no
 * secret in the message) when the new text is not valid TOML.
 */
export function saveMachine(
    path: string,
    outpoint: string,
    instanceId: string
): void {
    const mode = statSync(path).mode & 0o777
    const text = withMachine(readFileSync(path, 'utf8'), outpoint, instanceId)
    try {
        TOML.parse(text)
    } catch {
        throw new Error(
            `config: cannot update ${path}: the result is not valid TOML`
        )
    }
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
        writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
        chmodSync(temp, mode)
        renameSync(temp, path)
    } catch (e) {
        try {
            unlinkSync(temp)
        } catch {
            // the temporary file was not made or is already renamed
        }
        throw e
    }
}

/**
 * Hide the secrets of a configuration in a text.
 * Input: any text (for example an error message from a library) and the
 * configuration. Output: the text with every wif, rabin_p and rabin_q value
 * replaced by "[hidden]".
 */
export function hideSecrets(text: string, cfg: GatewayConfig): string {
    let result = text
    for (const secret of [cfg.wif, cfg.rabinP, cfg.rabinQ])
        if (secret) result = result.split(secret).join('[hidden]')
    return result
}
