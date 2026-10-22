/**
 * The `k17forth keeper` sub-command.
 *
 * Runs `Keeper.tick` for the machine in the config file, once every
 * `--interval` seconds (default 60, at least 1), and prints one line per
 * tick. It stops when the machine halts. `--top-up <sats>` adds sats to the
 * machine escrow with the FIRST cycle that goes out (once, not every cycle):
 * the wallet of the command pays it, and later cycles add nothing. A halting
 * cycle takes no top-up, so the keeper refuses it, prints why, drops it and
 * goes on (the next tick can halt the machine). Broadcast errors are printed and
 * the loop goes on; the keeper itself retries a conflicting spend once per
 * tick. A mainnet config needs `--i-know-this-spends-real-money`, because
 * the keeper pays fees. `--top-up-offer` (a funder's coin) is refused with
 * exit code 2: it needs one cycle that waits for the funder, and the keeper
 * runs a loop.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { describeConfig, hideSecrets, loadConfig } from '../chain/config'
import { Keeper, KeeperOptions, TickResult } from '../chain/keeper'
import { makeProvider, makeSigner } from '../chain/provider'
import {
    TOP_UP_BOTH,
    offerRefusedInLoop,
    parseFlags,
    parseTopUp,
} from './flags'
import type { CliIo } from './k17forth'

/** Help text of the keeper sub-command. */
export const KEEPER_USAGE = `usage: k17forth keeper --config <gw.toml> [--interval <seconds>] [--top-up <sats>] [--i-know-this-spends-real-money]
         --top-up <sats>: add sats to the machine escrow with the first cycle that goes out (once, not every cycle);
         the wallet of this command pays it; a cycle that halts the machine takes no top-up and the keeper drops it
         (--top-up-offer is refused here: the keeper runs a loop; use admit, remove or endorse for a funder offer)`

/** Switch that allows a keeper on a mainnet machine. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of `keeper` that tests replace. */
export interface KeeperCommandDeps {
    /** Provider to read transactions. Default: `makeProvider` of the config. */
    provider?: Pick<
        Provider,
        'getTransaction' | 'getNetwork' | 'sendTransaction'
    >
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
 * Input: the tick result. Output: the line; a cycle that the dead-man
 * halted carries the words "dead-man halt".
 */
export function tickLine(result: TickResult): string {
    const resync = result.resynced ? ' (after resync)' : ''
    if (result.txid)
        return `cycle ${result.txid} lockTime ${result.lockTime} (mtp ${
            result.mtp
        }) reward ${result.reward}${
            result.topUp ? ` top-up: ${result.topUp} sats` : ''
        }${
            result.topUpLanded
                ? ` top-up: ${result.topUpLanded} sats (added by an earlier send)`
                : ''
        }${result.deadManHalt ? ' (dead-man halt)' : ''}${resync} -> ${
            result.halted ? 'halted' : result.outpoint
        }`
    if (result.skipped) return `skipped: ${result.skipped}${resync}`
    return `error: ${result.error}${resync}`
}

/**
 * Run the keeper sub-command.
 * Input: arguments after `keeper`, an output sink and optional test parts.
 * Output: exit code: 0 when the loop ends (machine halted or tick limit),
 * 1 when the config cannot be used, 2 on wrong arguments (also for
 * `--top-up-offer`, which a loop does not take).
 */
export async function keeperCommand(
    args: string[],
    io: CliIo,
    deps: KeeperCommandDeps = {}
): Promise<number> {
    const parsed = parseFlags(
        args,
        ['config', 'interval', 'top-up', 'top-up-offer'],
        [MAINNET_SWITCH]
    )
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(KEEPER_USAGE)
        return 2
    }
    // A funder offer needs one cycle that waits for the funder; the keeper
    // runs a loop, so it refuses the offer.
    if (parsed.values.has('top-up-offer')) {
        io.err(
            parsed.values.has('top-up')
                ? TOP_UP_BOTH
                : offerRefusedInLoop('keeper')
        )
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
    const topUp = parseTopUp(parsed.values.get('top-up'))
    if (typeof topUp === 'string') {
        io.err(topUp)
        io.err(KEEPER_USAGE)
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
        keeper = new Keeper(cfg, provider, signer, { ...deps.keeper, topUp })
        io.out(
            `keeper: ${describeConfig(cfg)} interval=${interval}s${
                topUp > 0n ? ` top-up=${topUp} sats (first cycle only)` : ''
            }`
        )
    } catch (e) {
        io.err(hide((e as Error).message))
        return 1
    }
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    const sleep =
        deps.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    /**
     * End the run: print a closing line when a top-up was not added.
     * Input: none. Output: exit code 0.
     */
    const closeRun = (): number => {
        if (keeper.unaddedTopUp > 0n)
            io.out(`top-up of ${keeper.unaddedTopUp} sats was not added`)
        return 0
    }
    for (let tick = 1; deps.ticks === undefined || tick <= deps.ticks; tick++) {
        const result = await keeper.tick(now())
        const line = hide(tickLine(result))
        if (result.error) io.err(line)
        else io.out(line)
        if (result.halted) return closeRun()
        if (deps.ticks === undefined || tick < deps.ticks)
            await sleep(interval * 1000)
    }
    return closeRun()
}
