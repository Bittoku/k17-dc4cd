/**
 * The `k17forth gateway` sub-commands.
 *
 * `gateway init --config <gw.toml>` makes a new Rabin attester key
 * (`newAttester()`, which takes some seconds), writes `[attester] rabin_p`
 * and `rabin_q` into the config file atomically with mode 600, and prints
 * what the sponsor needs to endorse this gateway: the public key hash, the
 * public key, and the payout address (`[attester] payout_address`, else the
 * wallet address). It never prints a prime, and it refuses a config that
 * already has a key.
 *
 * `gateway run --config <gw.toml> [--interval <seconds>] [--once]` runs a
 * `Gateway` on the bridge (`[bridge] serial`, else standard input) until the
 * bridge ends or the machine halts; with `--once` it stops after the first
 * reading is delivered, dropped or refused, with exit code 0 only when the
 * machine accepted the reading (else 3). A bridge error ends it with
 * exit code 1. A mainnet config needs
 * `--i-know-this-spends-real-money`, because the keeper pays fees.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import { Attester, keyHash, newAttester, payoutOf, pubKeyBytes } from 'k17-vm'
import {
    GatewayConfig,
    describeConfig,
    hideSecrets,
    loadConfig,
    saveAttesterKey,
} from '../chain/config'
import { KeeperOptions } from '../chain/keeper'
import { makeProvider, makeSigner } from '../chain/provider'
import { Gateway } from '../gateway/gateway'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the gateway sub-commands. */
export const GATEWAY_USAGE = `usage: k17forth gateway init --config <gw.toml>
       k17forth gateway run --config <gw.toml> [--interval <seconds>] [--once] [--i-know-this-spends-real-money]`

/** Switch that allows a gateway on a mainnet machine. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of the gateway commands that tests replace. */
export interface GatewayCommandDeps {
    /** Make the Rabin key (init). Default: `newAttester()`. */
    generate?: () => Attester
    /** Provider to read transactions (run). Default: `makeProvider`. */
    provider?: Pick<Provider, 'getTransaction' | 'getNetwork'>
    /** Wallet signer (run). Default: `makeSigner` of the config. */
    signer?: Signer
    /** Readings (run). Default: the bridge of the config. */
    bridge?: AsyncIterable<number>
    /** Options of the keeper (run). */
    keeper?: KeeperOptions
    /** Wall clock, unix seconds (run). Default: the system clock. */
    now?: () => number
}

/**
 * Run a gateway sub-command.
 * Input: arguments after `gateway`, an output sink and optional test parts.
 * Output: exit code: 0 on success, 1 when the config cannot be used or the
 * bridge failed, 2 on wrong arguments (or a mainnet config without the
 * switch), 3 for `run --once` when no reading was delivered.
 */
export async function gatewayCommand(
    args: string[],
    io: CliIo,
    deps: GatewayCommandDeps = {}
): Promise<number> {
    const [sub, ...rest] = args
    if (sub === 'init') return initCommand(rest, io, deps)
    if (sub === 'run') return runGateway(rest, io, deps)
    io.err(GATEWAY_USAGE)
    return 2
}

/**
 * The payout address of a gateway.
 * Input: the configuration. Output: `[attester] payout_address`, else the
 * address of the wallet key on the config's network. Throws "config:
 * [wallet] wif is not a valid key" (never the key) when the key is bad.
 */
function payoutAddress(cfg: GatewayConfig): bsv.Address {
    if (cfg.payoutAddress) return bsv.Address.fromString(cfg.payoutAddress)
    try {
        return bsv.PrivateKey.fromWIF(cfg.wif).toAddress(
            cfg.network === 'mainnet'
                ? bsv.Networks.mainnet
                : bsv.Networks.testnet
        )
    } catch {
        throw new Error('config: [wallet] wif is not a valid key')
    }
}

/**
 * `gateway init`: make and save the attester key, print the public parts.
 * Input and output: as `gatewayCommand`.
 */
async function initCommand(
    args: string[],
    io: CliIo,
    deps: GatewayCommandDeps
): Promise<number> {
    const parsed = parseFlags(args, ['config'])
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(GATEWAY_USAGE)
        return 2
    }
    const config = parsed.values.get('config')
    if (!config || parsed.positional.length) {
        io.err(GATEWAY_USAGE)
        return 2
    }
    let hide: (text: string) => string = (text) => text
    try {
        const cfg = loadConfig(config)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.rabinP || cfg.rabinQ)
            throw new Error(
                `config: ${config} already has an [attester] key; remove rabin_p and rabin_q to make a new one`
            )
        const payout = payoutAddress(cfg)
        io.out('gateway: making a Rabin key (this takes some seconds)')
        const attester = (deps.generate ?? (() => newAttester()))()
        const { p, q } = attester.priv
        hide = (text) =>
            hideSecrets(text, {
                ...cfg,
                rabinP: p.toString(),
                rabinQ: q.toString(),
            })
        saveAttesterKey(config, p, q)
        io.out(`gateway: key saved in ${config} (mode 600)`)
        io.out('give these to the sponsor:')
        io.out(`  public key hash: ${keyHash(attester.pub)}`)
        io.out(`  public key: ${pubKeyBytes(attester.pub)}`)
        io.out(
            `  payout address: ${payout.toString()}${
                cfg.payoutAddress ? '' : ' (the wallet address)'
            }`
        )
        io.out(`  payout hash: ${payoutOf(payout)}`)
        if (cfg.slot !== undefined) io.out(`  slot: ${cfg.slot}`)
        return 0
    } catch (e) {
        io.err(hide((e as Error).message))
        return 1
    }
}

/**
 * `gateway run`: relay readings until the bridge ends or the machine halts.
 * Input and output: as `gatewayCommand`.
 */
async function runGateway(
    args: string[],
    io: CliIo,
    deps: GatewayCommandDeps
): Promise<number> {
    const parsed = parseFlags(
        args,
        ['config', 'interval'],
        [MAINNET_SWITCH, 'once']
    )
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(GATEWAY_USAGE)
        return 2
    }
    const config = parsed.values.get('config')
    const intervalText = parsed.values.get('interval') ?? '60'
    if (!config || parsed.positional.length || !/^\d+$/.test(intervalText)) {
        io.err(GATEWAY_USAGE)
        return 2
    }
    const interval = Number(intervalText)
    if (interval < 1) {
        io.err('--interval must be at least 1 second')
        return 2
    }
    let gateway: Gateway
    let hide: (text: string) => string = (text) => text
    try {
        const cfg = loadConfig(config)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH)) {
            io.err(
                `mainnet gateway spends real money on fees; add --${MAINNET_SWITCH} to go on`
            )
            return 2
        }
        const provider = deps.provider ?? makeProvider(cfg.network)
        let signer: Signer
        try {
            signer = deps.signer ?? makeSigner(cfg, provider as Provider)
        } catch {
            throw new Error('config: [wallet] wif is not a valid key')
        }
        gateway = new Gateway(cfg, provider, signer, {
            bridge: deps.bridge,
            keeper: deps.keeper,
            now: deps.now,
            intervalMs: interval * 1000,
            out: (line) => io.out(hide(line)),
            once: parsed.switches.has('once'),
        })
        io.out(
            `gateway: ${describeConfig(cfg)} bridge=${
                deps.bridge ? 'given' : cfg.serial ?? 'stdin'
            } interval=${interval}s`
        )
    } catch (e) {
        io.err(hide((e as Error).message))
        return 1
    }
    return gateway.run()
}
