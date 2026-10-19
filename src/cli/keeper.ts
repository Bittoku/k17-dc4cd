/**
 * The `k17forth keeper` sub-command.
 *
 * Runs `Keeper.tick` for the machine in the config file, once every
 * `--interval` seconds (default 60, at least 1), and prints one line per
 * tick. It stops when the machine halts. Broadcast errors are printed and
 * the loop goes on; the keeper itself retries a conflicting spend once per
 * tick. A mainnet config needs `--i-know-this-spends-real-money`, because
 * the keeper pays fees.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { describeConfig, hideSecrets, loadConfig } from '../chain/config'
import { Keeper, KeeperOptions, TickResult } from '../chain/keeper'
import { makeProvider, makeSigner } from '../chain/provider'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the keeper sub-command. */
export const KEEPER_USAGE =
    'usage: k17forth keeper --config <gw.toml> [--interval <seconds>] [--i-know-this-spends-real-money]'

/** Switch that allows a keeper on a mainnet machine. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of `keeper` that tests replace. */
export interface KeeperCommandDeps {
    /** Provider to read transactions. Default: `makeProvider` of the config. */
    provider?: Pick<Provider, 'getTransaction' | 'getNetwork'>
    /** Wallet signer. Default: `makeSigner` of the config. */
    signer?: Signer
    /** Options of the keeper (chain info, spends lookup). */
    keeper?: KeeperOptions
    /** Number of ticks to run; default: run until the machine halts. */
    ticks?: number
    /** Wall clock, unix seconds. Default: the system clock. */
    now?: () => number
    /** Wait. Default: a timer. */
    sleep?: (ms: number) => Promise<void>
}

/**
 * One line that describes a tick.
 * Input: the tick result. Output: the line.
 */
export function tickLine(result: TickResult): string {
    const resync = result.resynced ? ' (after resync)' : ''
    if (result.txid)
        return `cycle ${result.txid} lockTime ${result.lockTime} (mtp ${
            result.mtp
        }) reward ${result.reward}${resync} -> ${
            result.halted ? 'halted' : result.outpoint
        }`
    if (result.skipped) return `skipped: ${result.skipped}${resync}`
    return `error: ${result.error}${resync}`
}

/**
 * Run the keeper sub-command.
 * Input: arguments after `keeper`, an output sink and optional test parts.
 * Output: exit code: 0 when the loop ends (machine halted or tick limit),
 * 1 when the config cannot be used, 2 on wrong arguments.
 */
export async function keeperCommand(
    args: string[],
    io: CliIo,
    deps: KeeperCommandDeps = {}
): Promise<number> {
    const parsed = parseFlags(args, ['config', 'interval'], [MAINNET_SWITCH])
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(KEEPER_USAGE)
        return 2
    }
    const config = parsed.values.get('config')
    const intervalText = parsed.values.get('interval') ?? '60'
    if (!config || parsed.positional.length || !/^\d+$/.test(intervalText)) {
        io.err(KEEPER_USAGE)
        return 2
    }
    const interval = Number(intervalText)
    if (interval < 1) {
        io.err('--interval must be at least 1 second')
        return 2
    }
    let keeper: Keeper
    let hide: (text: string) => string = (text) => text
    try {
        const cfg = loadConfig(config)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH)) {
            io.err(
                `mainnet keeper spends real money on fees; add --${MAINNET_SWITCH} to go on`
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
        keeper = new Keeper(cfg, provider, signer, deps.keeper)
        io.out(`keeper: ${describeConfig(cfg)} interval=${interval}s`)
    } catch (e) {
        io.err(hide((e as Error).message))
        return 1
    }
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    const sleep =
        deps.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let tick = 1; deps.ticks === undefined || tick <= deps.ticks; tick++) {
        const result = await keeper.tick(now())
        const line = hide(tickLine(result))
        if (result.error) io.err(line)
        else io.out(line)
        if (result.halted) return 0
        if (deps.ticks === undefined || tick < deps.ticks)
            await sleep(interval * 1000)
    }
    return 0
}
