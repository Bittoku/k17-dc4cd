/**
 * The `k17forth topup` sub-commands: a third party (the funder) pays the
 * escrow top-up of one cycle that a keeper builds.
 *
 * - `topup offer <funder.toml> --machine <outpoint> --amount <sats>`
 *   (funder): finds or makes a coin of exactly `amount` sats on the funder's
 *   P2PKH key and writes `offer.json` (coin, amount, funder public key, the
 *   instance id read from the machine, network).
 * - A cycle command with `--top-up-offer offer.json` (keeper: `admit`,
 *   `remove`, `endorse`) builds the final cycle with the coin as an input
 *   and writes `topup-request.json`. Nothing is broadcast.
 * - `topup sign <funder.toml> topup-request.json` (funder): checks the
 *   request against the chain (see `checkRequestForFunder`), signs its own
 *   input and writes `sig.json`.
 * - `topup complete topup-request.json sig.json` (keeper): inserts the
 *   funder's unlocking script, checks every input and the machine tip, and
 *   broadcasts.
 *
 * No file and no output line holds a private key. A mainnet network needs
 * `--i-know-this-spends-real-money` on each sub-command.
 *
 * Exports: `TOPUP_USAGE`, `TopUpDeps`, `topupCommand`, `loadOffer`,
 * `writeRequest`, `requestNextSteps`.
 */

import { readFileSync, writeFileSync } from 'fs'
import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import { GatewayConfig, hideSecrets, loadConfig } from '../chain/config'
import { decodeMachine } from '../chain/decode'
import { parseOutpoint } from '../chain/history'
import { wocSpentBy } from '../chain/keeper'
import { FetchLike, makeProvider, makeSigner } from '../chain/provider'
import {
    OFFER_KIND,
    SIGNATURE_KIND,
    SpentBy,
    TOPUP_FILE_VERSION,
    TopUpOffer,
    TopUpRefusal,
    TopUpRequest,
    checkRequestForFunder,
    completeRequest,
    makeExactCoin,
    readOffer,
    readRequest,
    readSignature,
    requestIdOf,
    signFunderInput,
} from '../chain/topup'
import { parseFlags, parseSats } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the topup sub-commands. */
export const TOPUP_USAGE = `usage: k17forth topup offer <funder.toml> --machine <outpoint> --amount <sats> [--out offer.json]
       k17forth topup sign <funder.toml> <topup-request.json> [--offer offer.json] [--out sig.json]
       k17forth topup complete <topup-request.json> <sig.json>
         offer: the funder makes a coin of exactly <sats> and writes the offer file
         the keeper runs admit, remove or endorse with --top-up-offer <offer.json>; this writes topup-request.json
         sign: the funder checks the request on the chain and signs its coin
         complete: the keeper adds the funder signature and sends the cycle
         add --i-know-this-spends-real-money on mainnet`

/** Switch that allows a sub-command on mainnet. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of the topup commands that tests replace. */
export interface TopUpDeps {
    /** Provider to read and send transactions. Default: `makeProvider`. */
    provider?: Pick<
        Provider,
        'getTransaction' | 'getNetwork' | 'sendTransaction'
    >
    /** Funder wallet signer (offer). Default: `makeSigner` of the config. */
    signer?: Signer
    /** Spends lookup (sign, complete). Default: WhatsOnChain. */
    spentBy?: SpentBy
    /** Fetch function for the default WhatsOnChain calls. */
    fetch?: FetchLike
}

/** An error in the arguments: exit code 2. */
class UsageError extends Error {}

/**
 * Read an offer file.
 * Input: the path. Output: the offer. Throws a TopUpRefusal when the file
 * is not a valid offer, and the fs error when it cannot be read.
 */
export function loadOffer(path: string): TopUpOffer {
    return readOffer(readFileSync(path, 'utf8'), path)
}

/**
 * Write a JSON file that holds no secret.
 * Input: the path and the value. Output: none.
 */
function writeJson(path: string, value: object): void {
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 })
}

/**
 * Write a request file.
 * Input: the path and the request. Output: none.
 */
export function writeRequest(path: string, request: TopUpRequest): void {
    writeJson(path, request)
}

/**
 * The lines a cycle command prints after it wrote a request.
 * Input: the request path, the request, the lock time, the next machine
 * value, and what lands with the cycle (for example "the admission").
 * Output: the lines, in order.
 */
export function requestNextSteps(
    path: string,
    request: TopUpRequest,
    lockTime: number | undefined,
    machineValue: bigint | undefined,
    what = 'the cycle'
): string[] {
    return [
        `top-up request written to ${path}: top-up ${request.amount} sats, lockTime ${lockTime}, next machine value ${machineValue} sats. Nothing was sent.`,
        'next steps:',
        `  1. give ${path} to the funder. The funder runs: k17forth topup sign <funder.toml> ${path}`,
        `  2. when the funder gives you sig.json, run: k17forth topup complete ${path} sig.json`,
        `  ${what} lands only at step 2. If the machine moves before step 2, the request expires: build a new one.`,
    ]
}

/**
 * Check the mainnet switch.
 * Input: the network, the parsed switches and the sub-command name.
 * Output: none. Throws a UsageError on mainnet without the switch.
 */
function checkNetwork(
    network: string,
    switches: Set<string>,
    sub: string
): void {
    if (network === 'mainnet' && !switches.has(MAINNET_SWITCH))
        throw new UsageError(
            `mainnet topup ${sub} moves real money; add --${MAINNET_SWITCH} to go on`
        )
}

/**
 * Run a topup sub-command.
 * Input: arguments after `topup`, an output sink and optional test parts.
 * Output: exit code: 0 on success; 1 for a refusal, a bad file or a chain
 * error; 2 for wrong arguments or a mainnet run without the switch.
 */
export async function topupCommand(
    args: string[],
    io: CliIo,
    deps: TopUpDeps = {}
): Promise<number> {
    const [sub, ...rest] = args
    let hide: (text: string) => string = (text) => text
    try {
        if (sub === 'offer')
            return await offerCommand(rest, io, deps, (cfg) => {
                hide = (text) => hideSecrets(text, cfg)
            })
        if (sub === 'sign')
            return await signCommand(rest, io, deps, (cfg) => {
                hide = (text) => hideSecrets(text, cfg)
            })
        if (sub === 'complete') return await completeCommand(rest, io, deps)
        throw new UsageError('')
    } catch (e) {
        if (e instanceof UsageError) {
            if (e.message) io.err(e.message)
            io.err(TOPUP_USAGE)
            return 2
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${(e as NodeJS.ErrnoException).path}: file not found`)
            return 1
        }
        io.err(hide(`topup ${sub}: ${(e as Error).message ?? String(e)}`))
        return 1
    }
}

/**
 * Parse the arguments of a sub-command.
 * Input: the arguments, the value flags and the number of positional
 * arguments. Output: the parsed arguments. Throws a UsageError.
 */
function parseSub(args: string[], valueFlags: string[], positional: number) {
    const parsed = parseFlags(args, valueFlags, [MAINNET_SWITCH])
    if (typeof parsed === 'string') throw new UsageError(parsed)
    if (parsed.positional.length !== positional) throw new UsageError('')
    return parsed
}

/**
 * Load the funder config and its provider.
 * Input: the config path, the test parts and a callback that gets the
 * config (to hide its secrets in errors). Output: the config and provider.
 */
function funderSetup(
    path: string,
    deps: TopUpDeps,
    onConfig: (cfg: GatewayConfig) => void
): {
    cfg: GatewayConfig
    provider: NonNullable<TopUpDeps['provider']>
} {
    const cfg = loadConfig(path)
    onConfig(cfg)
    return { cfg, provider: deps.provider ?? makeProvider(cfg.network) }
}

/**
 * `topup offer`: find or make a coin of exactly the amount and write the
 * offer file.
 * Input: arguments after `offer`, output sink, test parts, config callback.
 * Output: exit code 0; throws for the caller to map other outcomes.
 */
async function offerCommand(
    args: string[],
    io: CliIo,
    deps: TopUpDeps,
    onConfig: (cfg: GatewayConfig) => void
): Promise<number> {
    const parsed = parseSub(args, ['machine', 'amount', 'out'], 1)
    const machineText = parsed.values.get('machine')
    const amountText = parsed.values.get('amount')
    if (!machineText || amountText === undefined) throw new UsageError('')
    const amount = parseSats(amountText, '--amount')
    if (typeof amount === 'string') throw new UsageError(amount)
    if (amount === 0n) throw new UsageError('--amount must be at least 1 sat')
    let machineOutpoint: string
    try {
        const { txid, vout } = parseOutpoint(machineText)
        machineOutpoint = `${txid}:${vout}`
    } catch (e) {
        throw new UsageError(`--machine: ${(e as Error).message}`)
    }
    const out = parsed.values.get('out') ?? 'offer.json'
    const { cfg, provider } = funderSetup(parsed.positional[0], deps, onConfig)
    checkNetwork(cfg.network, parsed.switches, 'offer')
    let signer: Signer
    try {
        signer = deps.signer ?? makeSigner(cfg, provider as Provider)
    } catch {
        throw new Error('config: [wallet] wif is not a valid key')
    }
    const { txid, vout } = parseOutpoint(machineOutpoint)
    const output = (await provider.getTransaction(txid)).outputs[vout]
    const machine = output && decodeMachine(output.script.toHex()).machine
    if (!machine)
        throw new TopUpRefusal(`${machineOutpoint} is not a K17 machine`)
    const coin = await makeExactCoin(signer, amount)
    const offer: TopUpOffer = {
        kind: OFFER_KIND,
        version: TOPUP_FILE_VERSION,
        network: cfg.network,
        instanceId: machine.instanceId.toLowerCase(),
        coin: coin.outpoint,
        amount: amount.toString(),
        funderPubKey: (await signer.getDefaultPubKey()).toString(),
    }
    writeJson(out, offer)
    io.out(
        `offer written to ${out}: coin ${coin.outpoint} (${
            coin.made ? 'made now' : 'already in the wallet'
        }) amount ${amount} sats, machine instance ${offer.instanceId}`
    )
    io.out(
        `give ${out} to the keeper. The keeper runs admit, remove or endorse with --top-up-offer ${out}. Do not spend the coin until the top-up lands.`
    )
    return 0
}

/**
 * `topup sign`: check a request on the chain and sign the funder input.
 * Input: arguments after `sign`, output sink, test parts, config callback.
 * Output: exit code 0; throws a TopUpRefusal (exit 1) when a check fails.
 */
async function signCommand(
    args: string[],
    io: CliIo,
    deps: TopUpDeps,
    onConfig: (cfg: GatewayConfig) => void
): Promise<number> {
    const parsed = parseSub(args, ['offer', 'out'], 2)
    const [configPath, requestPath] = parsed.positional
    const offerPath = parsed.values.get('offer') ?? 'offer.json'
    const out = parsed.values.get('out') ?? 'sig.json'
    const { cfg, provider } = funderSetup(configPath, deps, onConfig)
    checkNetwork(cfg.network, parsed.switches, 'sign')
    let key: bsv.PrivateKey
    try {
        key = bsv.PrivateKey.fromWIF(cfg.wif)
    } catch {
        throw new Error('config: [wallet] wif is not a valid key')
    }
    const offer = loadOffer(offerPath)
    const request = readRequest(readFileSync(requestPath, 'utf8'), requestPath)
    if (offer.network !== cfg.network)
        throw new TopUpRefusal(
            `the offer is for ${offer.network}, this config for ${cfg.network}`
        )
    const spentBy =
        deps.spentBy ?? ((op) => wocSpentBy(cfg.network, op, deps.fetch))
    const tx = await checkRequestForFunder(request, offer, key.publicKey, {
        source: provider,
        spentBy,
    })
    const unlockingScript = signFunderInput(
        tx,
        request.funderInputIndex,
        BigInt(offer.amount),
        key
    )
    writeJson(out, {
        kind: SIGNATURE_KIND,
        version: TOPUP_FILE_VERSION,
        requestId: requestIdOf(request.txHex),
        inputIndex: request.funderInputIndex,
        unlockingScript,
    })
    io.out(
        `checked: machine ${request.machinePrevout} is the unspent tip of instance ${offer.instanceId}, the cycle tops it up by ${offer.amount} sats, the machine input passes the script interpreter, and coin ${offer.coin} is input ${request.funderInputIndex} only`
    )
    io.out(`signature written to ${out}. Give it to the keeper.`)
    return 0
}

/**
 * `topup complete`: insert the funder signature, check and broadcast.
 * Input: arguments after `complete`, output sink and test parts.
 * Output: exit code 0; throws OfferExpired or a TopUpRefusal (exit 1).
 */
async function completeCommand(
    args: string[],
    io: CliIo,
    deps: TopUpDeps
): Promise<number> {
    const parsed = parseSub(args, [], 2)
    const [requestPath, sigPath] = parsed.positional
    const request = readRequest(readFileSync(requestPath, 'utf8'), requestPath)
    const signature = readSignature(readFileSync(sigPath, 'utf8'), sigPath)
    checkNetwork(request.network, parsed.switches, 'complete')
    const provider = deps.provider ?? makeProvider(request.network)
    const spentBy =
        deps.spentBy ?? ((op) => wocSpentBy(request.network, op, deps.fetch))
    const { tx, machineValue } = await completeRequest(request, signature, {
        source: provider,
        spentBy,
        send: (t) => provider.sendTransaction(t),
    })
    io.out(
        `top-up cycle sent: txid ${tx.id}, top-up ${request.amount} sats, new machine value ${machineValue} sats -> ${tx.id}:0`
    )
    return 0
}
