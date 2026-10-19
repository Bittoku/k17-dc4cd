/**
 * The `k17forth endorse` sub-command: the sponsor enrols a landowner.
 *
 * `endorse --config <sponsor.toml> --member <public key hex> --payout
 * <address> --slot <n>` loads the sponsor's configuration, whose
 * `[attester]` key is the sponsor's Rabin key. It refuses, before any
 * broadcast, a config whose `[machine] instance_id` is not the instance id
 * of the machine, and a key whose hash is not in roster slot 0. It
 * signs the endorsement of the member key and payout into the slot under
 * `endorseTag(slot)` of `[consortium]` (`signEndorsement`, bound to the
 * machine's instance id), and relays it with `Keeper.tick` (lock time
 * min(now, MTP - 1), resync when the configured outpoint is old).
 *
 * The consortium program endorses slots in order (1, 2, ...), one cycle
 * each, after its first cycle. When the machine does not wait for an
 * endorsement yet (its first cycle has not run), the command runs that one
 * cycle first. It prints the txid and the slot. It never prints a prime or
 * the wallet key. A mainnet config needs `--i-know-this-spends-real-money`.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import {
    KEY_BYTES,
    keyHash,
    payoutOf,
    pubKeyFromBytes,
    readSlot,
    signEndorsement,
} from 'k17-vm'
import {
    GatewayConfig,
    describeConfig,
    hideSecrets,
    loadConfig,
} from '../chain/config'
import { Keeper, KeeperOptions, PendingInput } from '../chain/keeper'
import { parseOutpoint } from '../chain/history'
import { decodeMachine } from '../chain/decode'
import { makeProvider, makeSigner } from '../chain/provider'
import { checkInstance, rabinKeyOf, tagOptions } from '../gateway/attester'
import { endorseTag } from '../programs/consortium'
import { tickLine } from './keeper'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the endorse sub-command. */
export const ENDORSE_USAGE = `usage: k17forth endorse --config <sponsor.toml> --member <public key hex>
         --payout <address> --slot <n> [--i-know-this-spends-real-money]`

/** Switch that allows an endorsement on a mainnet machine. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Most cycles the command runs before the endorsement cycle. */
const MAX_LEAD_CYCLES = 1

/** Parts of `endorse` that tests replace. */
export interface EndorseDeps {
    /** Provider to read transactions. Default: `makeProvider` of the config. */
    provider?: Pick<Provider, 'getTransaction' | 'getNetwork'>
    /** Wallet signer. Default: `makeSigner` of the config. */
    signer?: Signer
    /** Options of the keeper (chain info, spends lookup). */
    keeper?: KeeperOptions
    /** Wall clock, unix seconds. Default: the system clock. */
    now?: () => number
}

/** An error in the arguments: exit code 2. */
class UsageError extends Error {}

/**
 * Read the member's public key.
 * Input: the key as KEY_BYTES bytes of hex (the "public key" line of
 * `gateway init`). Output: the key. Throws a UsageError otherwise.
 */
function memberKey(text: string): bigint {
    if (!new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`).test(text))
        throw new UsageError(
            `--member must be the ${KEY_BYTES}-byte public key as ${
                KEY_BYTES * 2
            } hex characters`
        )
    return pubKeyFromBytes(text.toLowerCase())
}

/**
 * Read the payout address.
 * Input: the address text and the config network. Output: the 20-byte
 * payout hash, 40 hex. Throws a UsageError when it is not an address of
 * that network.
 */
function payoutHash(text: string, network: GatewayConfig['network']): string {
    let address: bsv.Address
    try {
        address = bsv.Address.fromString(text)
    } catch {
        throw new UsageError(`--payout ${text} is not an address`)
    }
    const want = network === 'mainnet' ? 'livenet' : 'testnet'
    if (address.network.name !== want)
        throw new UsageError(`--payout ${text} is not a ${network} address`)
    return payoutOf(address)
}

/**
 * Run the endorse sub-command.
 * Input: arguments after `endorse`, an output sink and optional test parts.
 * Output: exit code: 0 when the slot holds the member key; 1 when the
 * config cannot be used, the key is not the sponsor's, or the chain work
 * fails; 2 on wrong arguments or a refused mainnet config.
 */
export async function endorseCommand(
    args: string[],
    io: CliIo,
    deps: EndorseDeps = {}
): Promise<number> {
    const parsed = parseFlags(
        args,
        ['config', 'member', 'payout', 'slot'],
        [MAINNET_SWITCH]
    )
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(ENDORSE_USAGE)
        return 2
    }
    const flag = (name: string) => parsed.values.get(name)
    const required = ['config', 'member', 'payout', 'slot']
    if (parsed.positional.length || required.some((n) => !flag(n))) {
        io.err(ENDORSE_USAGE)
        return 2
    }
    let hide: (text: string) => string = (text) => text
    const say = (line: string) => io.out(hide(line))
    try {
        const cfg = loadConfig(flag('config') as string)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH))
            throw new UsageError(
                `mainnet endorsement spends real money on fees; add --${MAINNET_SWITCH} to go on`
            )
        const member = memberKey(flag('member') as string)
        const payoutHex = payoutHash(flag('payout') as string, cfg.network)
        const slotText = flag('slot') as string
        if (!/^\d+$/.test(slotText))
            throw new UsageError('--slot must be a whole number')
        const slot = Number(slotText)
        if (!cfg.consortium)
            throw new Error('config: the [consortium] table is required')
        if (slot < 1 || slot > cfg.consortium.slots)
            throw new UsageError(
                `--slot must be 1..${cfg.consortium.slots} ([consortium] slots)`
            )
        if (!cfg.instanceId || !/^[0-9a-fA-F]{64}$/.test(cfg.instanceId))
            throw new Error(
                'config: [machine] instance_id (64 hex characters) is required'
            )
        const sponsor = rabinKeyOf(cfg)
        const provider = deps.provider ?? makeProvider(cfg.network)
        let signer: Signer
        try {
            signer = deps.signer ?? makeSigner(cfg, provider as Provider)
        } catch {
            throw new Error('config: [wallet] wif is not a valid key')
        }
        const keeper = new Keeper(cfg, provider, signer, deps.keeper)
        say(`endorse: ${describeConfig(cfg)}`)

        // Roster slot 0 never changes, so the configured outpoint is enough.
        const { txid, vout } = parseOutpoint(cfg.machineOutpoint as string)
        const output = (await provider.getTransaction(txid)).outputs[vout]
        const machine = output && decodeMachine(output.script.toHex()).machine
        if (!machine)
            throw new Error(`${cfg.machineOutpoint} is not a K17 machine`)
        checkInstance(cfg.instanceId, machine.instanceId)
        if (readSlot(machine.mem, 0).hashHex !== keyHash(sponsor.pub))
            throw new Error(
                'the [attester] key is not the sponsor of this machine (roster slot 0 holds another key hash)'
            )

        const input: PendingInput = {
            witness: [],
            sig: signEndorsement(
                sponsor,
                cfg.instanceId.toLowerCase(),
                endorseTag(tagOptions(cfg.consortium), slot),
                member,
                payoutHex,
                BigInt(slot)
            ),
            attestKey: sponsor.pub,
            endorseKey: member,
            payoutHex,
        }
        const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
        for (let lead = 0; lead <= MAX_LEAD_CYCLES; lead++) {
            const { mtp } = await keeper.chainTime(now())
            // A tick with no input runs a cycle that needs no endorsement,
            // and reports "needs witness" at the endorsement cycle.
            const first = await keeper.tick(now(), undefined, mtp)
            if (first.txid) {
                say(`cycle before the endorsement: ${tickLine(first)}`)
                continue
            }
            if (first.skipped !== 'needs witness') {
                io.err(hide(`endorse: ${tickLine(first)}`))
                return 1
            }
            const result = await keeper.tick(now(), input, mtp)
            if (!result.txid) {
                io.err(hide(`endorse: ${tickLine(result)}`))
                if (/witness rejected/.test(result.error ?? ''))
                    io.err(
                        `endorse: the machine refuses the endorsement; slots are endorsed in order (1, 2, ...), each one time, before the enrolment deadline`
                    )
                return 1
            }
            // The keeper keeps the new cycle; a fetch can fail for some
            // seconds after the broadcast.
            const next = keeper.machineTx?.outputs[0]
            const after = next && decodeMachine(next.script.toHex()).machine
            if (
                !after ||
                readSlot(after.mem, slot).hashHex !== keyHash(member)
            ) {
                io.err(
                    hide(
                        `endorse: cycle ${result.txid} ran, but slot ${slot} does not hold the member key`
                    )
                )
                return 1
            }
            say(
                `endorsed slot ${slot} txid ${result.txid} lockTime ${result.lockTime} (mtp ${result.mtp}) -> ${result.outpoint}`
            )
            return 0
        }
        io.err(
            'endorse: the machine does not wait for an endorsement; enrolment may have ended'
        )
        return 1
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(e.message)
            return 2
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${(e as NodeJS.ErrnoException).path}: file not found`)
            return 1
        }
        io.err(hide(`endorse: ${(e as Error).message ?? String(e)}`))
        return 1
    }
}
