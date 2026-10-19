/**
 * The `k17forth deploy` sub-command.
 *
 * Compiles a Forth file, builds a K17 machine for it with `newMachine` and
 * deploys it with the wallet of the config file. It prints the outpoint and
 * the machine's instance id, then writes both into the config file's
 * `[machine]` table (atomic write, file mode kept). The deployment time is
 * below the chain's median time past. Since v3.1 the first cycle needs an
 * nLockTime at least 60 s after it (MIN_STEP). The optional `--dead-man`
 * interval makes the machine refund the beneficiary when no cycle ran for
 * that long.
 * Mainnet needs the switch `--i-know-this-spends-real-money`.
 */

import { readFileSync } from 'fs'
import { Signer, bsv } from 'scrypt-ts'
import { RabinPubKey } from 'scrypt-ts-lib'
import {
    CELL,
    DEAD_MAN_FLOOR,
    MEM_CELLS,
    addrOf,
    keyHash,
    newMachine,
    rosterOf,
} from 'k17-vm'
import { ForthCompileError, compileToHex } from '../forth/compiler'
import { sponsorMemory } from '../programs/consortium'
import {
    GatewayConfig,
    hideSecrets,
    loadConfig,
    saveMachine,
} from '../chain/config'
import { ChainInfo, chainInfo, makeSigner } from '../chain/provider'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the deploy sub-command. */
export const DEPLOY_USAGE = `usage: k17forth deploy <file.fs> --config <gw.toml> --deposit <sats>
         --reward-min <sats> --slope <sats/s> --reward-max <sats>
         [--beneficiary <address>] [--roster <key1,key2,...>]
         [--initial-mem <hexfile> | --sponsor <keyhash|rabin public key>]
         [--dead-man <seconds>]
         [--network testnet|mainnet] [--i-know-this-spends-real-money]`

/** Switch that allows a mainnet deployment. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of `deploy` that tests replace. */
export interface DeployDeps {
    /** Wallet signer. Default: `makeSigner` of the config. */
    signer?: Signer
    /** Chain tip reader. Default: WhatsOnChain `/chain/info`. */
    chainInfo?: () => Promise<ChainInfo>
    /** Wall clock, unix seconds. Default: the system clock. */
    now?: () => number
}

/** An error in the arguments: exit code 2. */
class UsageError extends Error {}

/**
 * Read a whole number of satoshis or seconds.
 * Input: flag name and text. Output: the value. Throws when it is not a
 * whole number, 0 or more.
 */
function wholeNumber(name: string, text: string): bigint {
    if (!/^\d+$/.test(text))
        throw new UsageError(`--${name} must be a whole number`)
    return BigInt(text)
}

/**
 * Read the `--dead-man` interval.
 * Input: the flag text, or undefined when the flag is absent. Output: the
 * interval in seconds; 0 (the default) means off. Throws a UsageError unless
 * the value is 0 or at least DEAD_MAN_FLOOR (6 hours).
 */
function deadManSeconds(text: string | undefined): bigint {
    if (text === undefined) return 0n
    const seconds = wholeNumber('dead-man', text)
    if (seconds !== 0n && seconds < DEAD_MAN_FLOOR)
        throw new UsageError(
            `--dead-man must be 0 (off) or at least ${DEAD_MAN_FLOOR} seconds (6 hours); a shorter interval lets any keeper kill a healthy machine`
        )
    return seconds
}

/**
 * Read the fixed roster keys of `--roster`.
 * Input: comma-separated Rabin public keys (decimal or 0x hex).
 * Output: the keys. Throws a UsageError for a key that is not a number.
 */
function rosterKeys(text: string): RabinPubKey[] {
    return text.split(',').map((key) => {
        const trimmed = key.trim()
        if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(trimmed))
            throw new UsageError(`--roster key "${trimmed}" is not a number`)
        return BigInt(trimmed)
    })
}

/**
 * Memory image of `--sponsor`.
 * Input: the sponsor's key hash (64 hex characters) or Rabin public key
 * (decimal or 0x hex). Output: memory hex with roster slot 0 set.
 */
function sponsorImage(text: string): string {
    if (/^[0-9a-fA-F]{64}$/.test(text)) return sponsorMemory(text)
    if (/^(\d+|0x[0-9a-fA-F]+)$/.test(text))
        return sponsorMemory(keyHash(BigInt(text)))
    throw new UsageError(
        '--sponsor must be a 64 hex character key hash or a Rabin public key'
    )
}

/**
 * Memory image of `--initial-mem`.
 * Input: path of a file that holds the memory as hex (white space ignored).
 * Output: the hex. Throws when it is not hex of the full memory size.
 */
function memoryImage(path: string): string {
    const hex = readFileSync(path, 'utf8').replace(/\s+/g, '').toLowerCase()
    const size = MEM_CELLS * CELL * 2
    if (!/^[0-9a-f]*$/.test(hex) || hex.length !== size)
        throw new UsageError(
            `--initial-mem ${path} must hold ${size} hex characters`
        )
    return hex
}

/**
 * Run the deploy sub-command.
 * Input: arguments after `deploy`, an output sink and optional test parts.
 * Output: exit code: 0 on success, 1 when compile, chain or file work
 * fails, 2 on wrong arguments or a refused mainnet deployment.
 */
export async function deployCommand(
    args: string[],
    io: CliIo,
    deps: DeployDeps = {}
): Promise<number> {
    const parsed = parseFlags(
        args,
        [
            'config',
            'deposit',
            'reward-min',
            'slope',
            'reward-max',
            'beneficiary',
            'roster',
            'initial-mem',
            'sponsor',
            'network',
            'dead-man',
        ],
        [MAINNET_SWITCH]
    )
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(DEPLOY_USAGE)
        return 2
    }
    const flag = (name: string) => parsed.values.get(name)
    const required = ['config', 'deposit', 'reward-min', 'slope', 'reward-max']
    if (parsed.positional.length !== 1 || required.some((n) => !flag(n))) {
        io.err(DEPLOY_USAGE)
        return 2
    }
    const [source] = parsed.positional
    let cfg: GatewayConfig | undefined
    try {
        cfg = loadConfig(flag('config') as string)
        const network = flag('network') ?? cfg.network
        if (network !== cfg.network)
            throw new UsageError(
                `--network ${network} does not match the config network ${cfg.network}`
            )
        if (network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH))
            throw new UsageError(
                `mainnet deployment spends real money; add --${MAINNET_SWITCH} to go on`
            )
        const deposit = wholeNumber('deposit', flag('deposit') as string)
        if (deposit < 1n || deposit > BigInt(Number.MAX_SAFE_INTEGER))
            throw new UsageError('--deposit must be at least 1 satoshi')
        const econNumbers = {
            rewardMin: wholeNumber('reward-min', flag('reward-min') as string),
            slope: wholeNumber('slope', flag('slope') as string),
            rewardMax: wholeNumber('reward-max', flag('reward-max') as string),
            deadMan: deadManSeconds(flag('dead-man')),
        }
        if (flag('initial-mem') && flag('sponsor'))
            throw new UsageError('use --initial-mem or --sponsor, not both')
        const roster = rosterOf(
            flag('roster') ? rosterKeys(flag('roster') as string) : []
        )
        const memory = flag('initial-mem')
            ? memoryImage(flag('initial-mem') as string)
            : flag('sponsor')
            ? sponsorImage(flag('sponsor') as string)
            : undefined
        const prog = compileToHex(readFileSync(source, 'utf8'))
        let signer: Signer
        try {
            signer = deps.signer ?? makeSigner(cfg)
        } catch {
            throw new Error('config: [wallet] wif is not a valid key')
        }
        const beneficiaryText = flag('beneficiary')
        let beneficiary: bsv.Address
        try {
            beneficiary = beneficiaryText
                ? bsv.Address.fromString(beneficiaryText)
                : await signer.getDefaultAddress()
        } catch {
            throw new UsageError(
                `--beneficiary ${beneficiaryText} is not an address`
            )
        }
        const readChain = deps.chainInfo ?? (() => chainInfo(network))
        const { mediantime } = await readChain()
        const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000)
        const deployTime = BigInt(Math.min(now, mediantime - 1))
        const m = newMachine(
            prog,
            { beneficiary: addrOf(beneficiary), ...econNumbers },
            deployTime,
            roster,
            memory
        )
        await m.connect(signer)
        const tx = await m.deploy(Number(deposit))
        const outpoint = `${tx.id}:0`
        io.out(`outpoint ${outpoint}`)
        io.out(`instance ${m.instanceId}`)
        io.out(`lastTime ${deployTime} (median time past ${mediantime})`)
        saveMachine(flag('config') as string, outpoint, m.instanceId)
        io.out(`wrote [machine] outpoint and instance_id to ${flag('config')}`)
        return 0
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(e.message)
            return 2
        }
        if (e instanceof ForthCompileError) {
            io.err(`${source}: ${e.message}`)
            return 1
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${(e as NodeJS.ErrnoException).path}: file not found`)
            return 1
        }
        const message = (e as Error).message ?? String(e)
        io.err(`deploy: ${cfg ? hideSecrets(message, cfg) : message}`)
        return 1
    }
}
