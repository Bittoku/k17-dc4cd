/**
 * The `k17forth admit` and `k17forth remove` sub-commands: the sponsor of a
 * tree-mode machine admits and removes roster members.
 *
 * Both commands load the sponsor's configuration (the `[attester]` key is
 * the sponsor's Rabin key; `[machine]` names the machine, its deployment
 * `genesis_outpoint` and the `genesis_inscription` of the genesis roster),
 * follow the machine to its newest outpoint and rebuild its roster mirror
 * (`loadRoster`: genesis plus history, checked against the machine's root and
 * sequence number). They refuse before any signing or broadcast when the
 * configured key hash is not the machine's `sponsorKeyHash`, when an
 * admission names a key already in the roster or an occupied leaf, when a
 * removal names an unknown member, and when a dry run of the cycle shows the
 * machine would refuse it or has ended.
 *
 * `admit` signs with `signAdmission` and runs program selector 1 with the
 * sponsor key as `keyA`, the member key as `keyB`, the payout, and the proof
 * of the empty leaf. `remove` signs with `signRemoval` over the member's key
 * hash and payout (v3.1: not over the leaf, so a payment that lands after
 * the signature does not invalidate it) and runs selector 2 with the
 * member's proof. The cycle goes out through `Keeper.tick` (lock time
 * min(now, MTP - 1)). When another cycle lands first and makes the proof or
 * the sequence number stale, the command reloads the mirror once, signs again
 * and retries; a second failure ends the command.
 *
 * Exports: `ADMIT_USAGE`, `REMOVE_USAGE`, `SponsorDeps`, `admitCommand`,
 * `removeCommand`. No output contains a prime or the wallet key.
 */

import type { Provider, Signer } from 'scrypt-ts'
import { bsv } from 'scrypt-ts'
import { RabinPubKey } from 'scrypt-ts-lib'
import {
    CycleTree,
    K17Machine,
    KEY_BYTES,
    SparseMerkleTree,
    keyHash,
    payoutOf,
    planCycle,
    pubKeyFromBytes,
    signAdmission,
    signRemoval,
} from 'k17-vm'
import { readFileSync } from 'fs'
import {
    GatewayConfig,
    describeConfig,
    hideSecrets,
    loadConfig,
    saveTipOutpoint,
} from '../chain/config'
import { decodeInstance } from '../chain/decode'
import { parseOutpoint } from '../chain/history'
import {
    Keeper,
    KeeperOptions,
    PendingInput,
    WAITING_FOR_MTP,
} from '../chain/keeper'
import { loadRoster } from '../chain/loadRoster'
import { makeProvider, makeSigner } from '../chain/provider'
import { RosterMirror } from '../chain/roster'
import { checkInstance, rabinKeyOf } from '../gateway/attester'
import { ADMIT_TAG, REMOVE_TAG } from '../programs/treeConsortium'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the admit sub-command. */
export const ADMIT_USAGE = `usage: k17forth admit <sponsor.toml> --member-key <pubkey file> --payout <address>
         [--index <n>] [--i-know-this-spends-real-money]`

/** Help text of the remove sub-command. */
export const REMOVE_USAGE = `usage: k17forth remove <sponsor.toml> (--member-key <pubkey file> | --index <n>)
         [--i-know-this-spends-real-money]`

/** Switch that allows an admin cycle on a mainnet machine. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Number of leaves of the roster tree (depth 16). */
const LEAF_COUNT = 65536

/**
 * Least size in bits of a decimal member key. `gateway init` makes keys of
 * KEY_BYTES * 8 bits; a modulus below 2048 bits is not a Rabin key of this
 * system (a typo or a leaf index).
 */
const MIN_MODULUS_BITS = 2048

/** Tries of one command: the first, and one after a reload of the mirror. */
const MAX_ATTEMPTS = 2

/**
 * Hint after a plan or tick that waited for the chain clock (v3.1 MIN_STEP):
 * a live cycle needs a lock time 60 s after the one before it, and the lock
 * time is MTP - 1, so the next one needs a new block.
 */
const MTP_HINT =
    'the machine needs the chain time (MTP) to move 60 s past its last cycle. Run the command again after the next block.'

/** Parts of `admit` and `remove` that tests replace. */
export interface SponsorDeps {
    /** Provider to read and send transactions. Default: `makeProvider` of the config. */
    provider?: Pick<
        Provider,
        'getTransaction' | 'getNetwork' | 'sendTransaction'
    >
    /** Wallet signer. Default: `makeSigner` of the config. */
    signer?: Signer
    /** Options of the keeper (chain info, spends lookup). */
    keeper?: KeeperOptions
    /** Wall clock, unix seconds. Default: the system clock. */
    now?: () => number
}

/** An error in the arguments: exit code 2. */
class UsageError extends Error {}

/** A refusal before any broadcast, or a failed cycle: exit code 1. */
class Refusal extends Error {}

/** What an operation decides from the mirror: the input to relay and a label. */
interface Operation {
    /** The signed input for `Keeper.tick`. */
    input: PendingInput
    /** Leaf index the cycle changes. */
    index: number
    /** Words for the success line, for example "admitted". */
    done: string
    /** Key hash of the member the cycle changes (64 hex). */
    memberKeyHash: string
}

/**
 * Read a member's Rabin public key from a file.
 * Input: the file path. The file holds the key as 768 hex characters (the
 * "public key" line of `gateway init`, `KEY_BYTES` bytes) or as a decimal
 * number (p * q); surrounding white space and a trailing newline are
 * ignored. Output: the key. Throws a UsageError for any other content.
 */
export function readMemberKey(path: string): RabinPubKey {
    const text = readFileSync(path, 'utf8').trim()
    if (new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`).test(text))
        return pubKeyFromBytes(text.toLowerCase())
    if (
        /^[0-9]+$/.test(text) &&
        BigInt(text).toString(2).length >= MIN_MODULUS_BITS
    )
        return BigInt(text)
    throw new UsageError(
        `${path}: the member key must be ${
            KEY_BYTES * 2
        } hex characters or a decimal number of at least ${MIN_MODULUS_BITS} bits`
    )
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
 * Read a leaf index.
 * Input: the flag text. Output: the index, 0 to 65535. Throws a UsageError
 * otherwise.
 */
function leafIndexOf(text: string): number {
    if (!/^\d+$/.test(text) || Number(text) >= LEAF_COUNT)
        throw new UsageError(
            `--index must be a whole number 0..${LEAF_COUNT - 1}`
        )
    return Number(text)
}

/**
 * Build the signed admission.
 * Input: the mirror, the machine instance id, the sponsor key, the member
 * key, the payout and the requested index (undefined: lowest free leaf).
 * Output: the operation. Throws a Refusal when the key is a member already,
 * or the leaf is taken.
 */
function admission(
    mirror: RosterMirror,
    instanceId: string,
    sponsor: { priv: { p: bigint; q: bigint }; pub: RabinPubKey },
    member: RabinPubKey,
    payoutHex: string,
    requested: number | undefined
): Operation {
    const existing = mirror.indexOf(keyHash(member))
    if (existing !== undefined)
        throw new Refusal(
            `the member key is in the roster already (leaf ${existing}); nothing signed or sent`
        )
    const index = requested ?? mirror.nextFreeIndex()
    const tree = mirror.proofFor(index)
    if (tree.leafPre !== '')
        throw new Refusal(`leaf ${index} is occupied; nothing signed or sent`)
    return {
        index,
        done: 'admitted',
        memberKeyHash: keyHash(member),
        input: {
            witness: [1n],
            sig: signAdmission(
                sponsor,
                instanceId,
                BigInt(ADMIT_TAG),
                mirror.seq(),
                BigInt(index),
                member,
                payoutHex
            ),
            attestKey: sponsor.pub,
            endorseKey: member,
            payoutHex,
            tree,
        },
    }
}

/**
 * Build the signed removal.
 * Input: the mirror, the machine instance id, the sponsor key, and the
 * member to remove: its key (the key hash is looked up) or its leaf index.
 * Output: the operation; the signature covers the leaf's key hash and
 * payout (its first 52 bytes) and the sequence number. Throws a Refusal
 * when the member is not in the roster.
 */
function removal(
    mirror: RosterMirror,
    instanceId: string,
    sponsor: { priv: { p: bigint; q: bigint }; pub: RabinPubKey },
    member: RabinPubKey | undefined,
    requested: number | undefined,
    expectedKeyHash?: string
): Operation {
    const index =
        member !== undefined ? mirror.indexOf(keyHash(member)) : requested
    if (index === undefined)
        throw new Refusal(
            'the key is not in the roster; nothing signed or sent'
        )
    const tree: CycleTree = mirror.proofFor(index)
    if (tree.leafPre === '')
        throw new Refusal(
            `leaf ${index} holds no member; nothing signed or sent`
        )
    // A removal by leaf index names a leaf, not a member: if the leaf holds
    // another key than on the first attempt, the sponsor meant someone else.
    if (
        expectedKeyHash !== undefined &&
        tree.leafPre.slice(0, 64) !== expectedKeyHash
    )
        throw new Refusal(
            `leaf ${index} now holds another member than at the start; nothing sent`
        )
    return {
        index,
        done: 'removed',
        memberKeyHash: tree.leafPre.slice(0, 64),
        input: {
            witness: [2n],
            sig: signRemoval(
                sponsor,
                instanceId,
                BigInt(REMOVE_TAG),
                mirror.seq(),
                BigInt(index),
                tree.leafPre.slice(0, 64),
                tree.leafPre.slice(64, 104)
            ),
            attestKey: sponsor.pub,
            tree,
        },
    }
}

/** Which operation a run is. */
type Kind = 'admit' | 'remove'

/**
 * Run one admin cycle (shared by `admit` and `remove`).
 * Input: the kind, the arguments after the command name, an output sink and
 * the test parts.
 * Output: exit code: 0 when the cycle went out and the machine holds the
 * predicted root and sequence number; 1 for a refusal (key or leaf state,
 * wrong sponsor key, machine ended or halted, waiting for MTP) or a failed
 * relay; 2 for wrong arguments or a refused mainnet config.
 */
async function sponsorCommand(
    kind: Kind,
    args: string[],
    io: CliIo,
    deps: SponsorDeps
): Promise<number> {
    const usage = kind === 'admit' ? ADMIT_USAGE : REMOVE_USAGE
    const parsed = parseFlags(
        args,
        kind === 'admit'
            ? ['member-key', 'payout', 'index']
            : ['member-key', 'index'],
        [MAINNET_SWITCH]
    )
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(usage)
        return 2
    }
    const flag = (name: string) => parsed.values.get(name)
    const bad =
        parsed.positional.length !== 1 ||
        (kind === 'admit'
            ? !flag('member-key') || !flag('payout')
            : !!flag('member-key') === !!flag('index'))
    if (bad) {
        io.err(usage)
        return 2
    }
    let hide: (text: string) => string = (text) => text
    const say = (line: string) => io.out(hide(line))
    const fail = (line: string) => io.err(hide(`${kind}: ${line}`))
    try {
        const configPath = parsed.positional[0]
        const cfg = loadConfig(configPath)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH))
            throw new UsageError(
                `mainnet ${kind} spends real money on fees; add --${MAINNET_SWITCH} to go on`
            )
        const member = flag('member-key')
            ? readMemberKey(flag('member-key') as string)
            : undefined
        const payoutHex =
            kind === 'admit'
                ? payoutHash(flag('payout') as string, cfg.network)
                : ''
        const requested = flag('index')
            ? leafIndexOf(flag('index') as string)
            : undefined
        const sponsor = rabinKeyOf(cfg)
        const provider = deps.provider ?? makeProvider(cfg.network)
        let signer: Signer
        try {
            signer = deps.signer ?? makeSigner(cfg, provider as Provider)
        } catch {
            throw new Error('config: [wallet] wif is not a valid key')
        }
        const keeper = new Keeper(cfg, provider, signer, deps.keeper)
        const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
        say(`${kind}: ${describeConfig(cfg)}`)

        let lastReason = ''
        /**
         * What the previous attempt tried to do: its roster sequence number,
         * leaf and the first 104 hex characters of the leaf it wanted
         * ('' for a removal). When that attempt fails with a conflict, the
         * cycle can still have landed (the broadcast was accepted but the
         * provider answered with an error).
         */
        let previous: { seq: bigint; index: number; leaf: string } | undefined
        /** Key hash of the leaf removed by index, kept from the first attempt. */
        let targetKeyHash: string | undefined
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            // Follow the machine to its newest cycle, then rebuild the mirror.
            const tip = await keeper.sync()
            if (!tip) throw new Refusal('the machine is halted; nothing to do')
            const { mirror, machine } = await loadRoster(cfg, {
                provider,
                outpoint: tip,
            })
            if (cfg.instanceId)
                checkInstance(cfg.instanceId, machine.instanceId)
            if (machine.sponsorKeyHash.toLowerCase() !== keyHash(sponsor.pub))
                throw new Refusal(
                    'the [attester] key is not the sponsor of this machine (sponsorKeyHash differs); nothing signed or sent'
                )
            if (
                previous &&
                machine.rosterSeq === previous.seq + 1n &&
                mirror.proofFor(previous.index).leafPre.slice(0, 104) ===
                    previous.leaf
            ) {
                // Exactly the requested change is on the chain, one step
                // after the roster that the failed attempt signed.
                saveTipOutpoint(configPath, tip)
                say(
                    `${kind === 'admit' ? 'admitted' : 'removed'} leaf ${
                        previous.index
                    } (the cycle landed although its broadcast was reported as a conflict) rosterSeq ${
                        machine.rosterSeq
                    } rosterRoot ${machine.rosterRoot} -> ${tip}`
                )
                return 0
            }
            const operation =
                kind === 'admit'
                    ? admission(
                          mirror,
                          machine.instanceId,
                          sponsor,
                          member as RabinPubKey,
                          payoutHex,
                          requested
                      )
                    : removal(
                          mirror,
                          machine.instanceId,
                          sponsor,
                          member,
                          requested,
                          targetKeyHash
                      )
            if (kind === 'remove') targetKeyHash = operation.memberKeyHash
            previous = {
                seq: machine.rosterSeq,
                index: operation.index,
                leaf:
                    kind === 'admit'
                        ? `${operation.memberKeyHash}${payoutHex}`.toLowerCase()
                        : '',
            }

            // Dry run: the same plan the tick makes, with no broadcast.
            const attemptTime = now()
            const { time, mtp } = await keeper.chainTime(attemptTime)
            const machineTx = keeper.machineTx
            const { vout } = parseOutpoint(tip)
            const output = machineTx?.outputs[vout]
            const current =
                output &&
                (decodeInstance(output.script.toHex()).instance as K17Machine)
            if (!machineTx || !output || !current)
                throw new Error(`${tip} is not a K17 machine`)
            let plan
            try {
                plan = planCycle(
                    current,
                    BigInt(output.satoshis),
                    BigInt(time),
                    await signer.getDefaultAddress(),
                    operation.input.witness,
                    operation.input.sig,
                    {
                        attestKey: operation.input.attestKey,
                        endorseKey: operation.input.endorseKey,
                        payoutHex: operation.input.payoutHex,
                    },
                    operation.input.tree
                )
            } catch (e) {
                const message = (e as Error).message
                if (/\(MIN_STEP\)|lockTime before lastTime/.test(message))
                    throw new Refusal(MTP_HINT)
                if (/witness rejected/.test(message))
                    throw new Refusal(
                        `the machine refuses this ${kind}; nothing sent`
                    )
                throw new Refusal(`plan: ${message}`)
            }
            if (plan.halted)
                throw new Refusal(
                    plan.deadManHalt
                        ? 'the dead-man interval has passed: the next cycle would halt and refund the machine; nothing sent'
                        : 'the machine has ended (the program halts at its end time); nothing sent'
                )
            const expectedRoot = SparseMerkleTree.rootAfter(
                plan.leafAfter ?? '',
                (operation.input.tree as CycleTree).proof,
                BigInt(operation.index)
            )

            const result = await keeper.tick(attemptTime, operation.input, mtp)
            if (!result.txid) {
                if (result.skipped === WAITING_FOR_MTP)
                    throw new Refusal(MTP_HINT)
                lastReason =
                    result.error ?? result.skipped ?? 'no cycle was made'
                // Another cycle landed first: the proof or the sequence
                // number is stale. The keeper has moved on; load again.
                if (
                    attempt + 1 < MAX_ATTEMPTS &&
                    (result.resynced || /witness rejected/.test(lastReason))
                ) {
                    say(
                        `${kind}: the roster changed while the cycle went out; loading it again`
                    )
                    continue
                }
                throw new Refusal(lastReason)
            }
            const next = keeper.machineTx?.outputs[0]
            const after = next && decodeInstance(next.script.toHex()).instance
            if (
                !after ||
                after.rosterRoot !== expectedRoot ||
                after.rosterSeq !== machine.rosterSeq + 1n
            )
                throw new Refusal(
                    `cycle ${result.txid} ran, but the machine does not hold the predicted roster root and sequence number`
                )
            if (result.outpoint) saveTipOutpoint(configPath, result.outpoint)
            say(
                `${operation.done} leaf ${operation.index} txid ${result.txid} lockTime ${result.lockTime} (mtp ${result.mtp}) rosterSeq ${after.rosterSeq} rosterRoot ${after.rosterRoot} -> ${result.outpoint}`
            )
            return 0
        }
        throw new Refusal(lastReason || 'the cycle could not be sent')
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(e.message)
            return 2
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${(e as NodeJS.ErrnoException).path}: file not found`)
            return 1
        }
        fail((e as Error).message ?? String(e))
        return 1
    }
}

/**
 * Run the admit sub-command: the sponsor admits a member into a free leaf.
 * Input: arguments after `admit` (config path, `--member-key`, `--payout`,
 * optional `--index`), an output sink and optional test parts.
 * Output: exit code, see `sponsorCommand`.
 */
export function admitCommand(
    args: string[],
    io: CliIo,
    deps: SponsorDeps = {}
): Promise<number> {
    return sponsorCommand('admit', args, io, deps)
}

/**
 * Run the remove sub-command: the sponsor removes a member from the roster.
 * Input: arguments after `remove` (config path, and `--member-key` or
 * `--index`), an output sink and optional test parts.
 * Output: exit code, see `sponsorCommand`.
 */
export function removeCommand(
    args: string[],
    io: CliIo,
    deps: SponsorDeps = {}
): Promise<number> {
    return sponsorCommand('remove', args, io, deps)
}
