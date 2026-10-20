/**
 * The gateway attester: signs sensor readings for one consortium slot.
 *
 * It holds the slot's Rabin key (`[attester] rabin_p`, `rabin_q`), and
 * signs a reading for round r under `readingTag(round, slot)` with
 * `signReadingFor` (ATTEST message "K17M", bound to the machine's instance
 * id). It refuses, with a reason, what the chain would reject:
 *
 * - `slot not enrolled`: the machine's memory roster has no key in this
 *   slot, or a key that is not this attester's (Review Focus 5);
 * - `slot payout is not this gateway's address`: the slot pays another
 *   address than `[attester] payout_address` (else the wallet address);
 * - `round closed`: the chain time (the nLockTime the keeper will stamp,
 *   min(now, MTP - 1)) is at or after start + rounds * period, the close
 *   of the last round, so no round is open (Review Focus 1);
 * - `reading out of range`: the reading is outside `[consortium]
 *   range_min..range_max`, unless `[gateway] sign_anyway` is true. A value
 *   that is not a 32-bit cell is always refused.
 *
 * `MemberAttester` is the tree-mode attester. It has no slot: it finds the
 * leaf of its own key hash in the roster mirror, and signs under
 * `readingTag(roundAt(opts, lockTime))` of the tree program, with
 * `signMemberReading`. It refuses what the chain would reject:
 * `no round is open` (before `start`), `round closed` (at or after the end),
 * and `reading out of range` (as above).
 *
 * The primes never leave this module: no error text and no property holds
 * them.
 */

import { RabinPubKey } from 'scrypt-ts-lib'
import { bsv } from 'scrypt-ts'
import {
    Attester,
    keyHash,
    payoutOf,
    readSlot,
    signMemberReading,
    signReadingFor,
} from 'k17-vm'
import {
    ConsortiumSettings,
    GatewayConfig,
    TreeSettings,
    treeOptionsOf,
} from '../chain/config'
import { PendingInput } from '../chain/keeper'
import { ConsortiumOptions, readingTag } from '../programs/consortium'
import {
    TreeConsortiumOptions,
    readingTag as treeReadingTag,
    roundAt as treeRoundAt,
} from '../programs/treeConsortium'

/** Largest cell value. */
const CELL_MAX = 0xffffffff

/** The machine fields the enrolment check reads. */
export interface MachineMemory {
    /** Memory image, hex. */
    mem: string
}

/**
 * The payout address of a gateway.
 * Input: the configuration. Output: `[attester] payout_address`, else the
 * address of the wallet key on the config's network. Throws "config:
 * [wallet] wif is not a valid key" (never the key) when the key is bad.
 */
export function payoutAddressOf(cfg: GatewayConfig): bsv.Address {
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
 * Check that a machine is the one a configuration names.
 * Input: the configured instance id (64 hex) and the machine's instance id.
 * Output: none. Throws "config [machine] instance_id is not the instance id
 * of the machine" when they differ (case is ignored).
 */
export function checkInstance(configured: string, actual: string): void {
    if (configured.toLowerCase() !== actual.toLowerCase())
        throw new Error(
            'config [machine] instance_id is not the instance id of the machine'
        )
}

/**
 * Read a Rabin prime from the configuration.
 * Input: the key name and the text. Output: the prime. Throws a message
 * that names the key but not the value when the text is not a positive
 * whole number.
 */
function prime(name: string, text: string | undefined): bigint {
    if (!text) throw new Error(`config: [attester] ${name} is required`)
    let value: bigint
    try {
        value = BigInt(text)
    } catch {
        throw new Error(`config: [attester] ${name} is not a whole number`)
    }
    if (value < 2n) throw new Error(`config: [attester] ${name} is too small`)
    return value
}

/**
 * Consortium options that are enough to compute reading and endorsement
 * tags. A tag depends on epoch, round and slot only; the other fields get
 * values that pass the checks of `readingTag` and `endorseTag` and are
 * never used.
 * Input: the `[consortium]` settings. Output: the options.
 */
export function tagOptions(settings: ConsortiumSettings): ConsortiumOptions {
    return {
        slots: settings.slots,
        rounds: settings.rounds,
        epoch: settings.epoch,
        start: settings.start,
        period: settings.period,
        enrolDeadline: Math.max(1, settings.start),
        bountyPerReading: 1,
        floor: 2,
        sponsorKeyHashHex: '00'.repeat(32),
    }
}

/**
 * The Rabin key of a configuration (`[attester] rabin_p`, `rabin_q`).
 * Input: the configuration. Output: the key, with the public key p * q.
 * Throws a message that names the missing or wrong key, never a value.
 */
export function rabinKeyOf(cfg: GatewayConfig): Attester {
    const p = prime('rabin_p', cfg.rabinP)
    const q = prime('rabin_q', cfg.rabinQ)
    // rabinsig's privKeyToPubKey is p * q; k17-vm has no helper for it.
    return { priv: { p, q }, pub: p * q }
}

/** Signs readings for one slot of one consortium machine. */
export class GatewayAttester {
    /** sha256 of the public key bytes, as the roster stores it (64 hex). */
    readonly keyHashHex: string
    /** Roster slot of this gateway. */
    readonly slot: number
    /** 20-byte payout hash of this gateway (`payoutAddressOf`), 40 hex. */
    readonly payoutHex: string
    /** The Rabin key; private. */
    private readonly attester: Attester
    private readonly settings: ConsortiumSettings
    private readonly options: ConsortiumOptions
    private readonly instanceId: string
    private readonly signAnyway: boolean

    /**
     * Make the attester from a configuration.
     * Input: the configuration; it needs `[attester] rabin_p` and `rabin_q`,
     * `[gateway] slot`, `[machine] instance_id` and `[consortium]`.
     * Throws a plain message (no secret) when one is missing or wrong.
     */
    constructor(cfg: GatewayConfig) {
        this.attester = rabinKeyOf(cfg)
        this.keyHashHex = keyHash(this.attester.pub)
        if (cfg.slot === undefined)
            throw new Error('config: [gateway] slot is required')
        if (!cfg.instanceId || !/^[0-9a-fA-F]{64}$/.test(cfg.instanceId))
            throw new Error(
                'config: [machine] instance_id (64 hex characters) is required'
            )
        if (!cfg.consortium)
            throw new Error('config: the [consortium] table is required')
        this.slot = cfg.slot
        this.payoutHex = payoutOf(payoutAddressOf(cfg)).toLowerCase()
        this.instanceId = cfg.instanceId.toLowerCase()
        this.settings = cfg.consortium
        this.options = tagOptions(cfg.consortium)
        this.signAnyway = cfg.signAnyway
        // Fails early, with the reason, on settings that make no tag.
        readingTag(this.options, 0, 1)
    }

    /** The public key that verifies this attester's signatures. */
    get publicKey(): RabinPubKey {
        return this.attester.pub
    }

    /**
     * The round that is open at a chain time, after the enrolment check.
     * Input: the chain time (unix seconds; the nLockTime of the next cycle,
     * not the wall clock) and the machine's memory.
     * Output: as `roundAt`. Throws
     * Error('slot not enrolled') when the slot is outside 1..slots, empty,
     * or holds a key hash that is not this attester's, and Error("slot
     * payout is not this gateway's address") when the slot pays another
     * address than `payoutAddressOf(cfg)`.
     */
    currentRound(now: number, machine: MachineMemory): number | null {
        if (this.slot < 1 || this.slot > this.settings.slots)
            throw new Error('slot not enrolled')
        const roster = readSlot(machine.mem, this.slot)
        if (roster.empty || roster.hashHex.toLowerCase() !== this.keyHashHex)
            throw new Error('slot not enrolled')
        if (roster.payoutHex.toLowerCase() !== this.payoutHex)
            throw new Error("slot payout is not this gateway's address")
        return this.roundAt(now)
    }

    /**
     * The round that is open at a chain time, from the time alone.
     * Input: the chain time t (unix seconds). Output: 0 when t is before
     * start + period (the machine opens round 0 when enrolment ends, which
     * can be before start); r when start + r * period <= t <
     * start + (r + 1) * period and r < rounds; null at or after the close
     * of the last round.
     */
    roundAt(t: number): number | null {
        const { start, period, rounds } = this.settings
        if (t < start) return 0
        const round = Math.floor((t - start) / period)
        return round < rounds ? round : null
    }

    /**
     * Sign a reading for a round.
     * Input: the reading (a whole number) and the round from `currentRound`.
     * Output: the pending input for the keeper: witness [slot, reading],
     * the signature, and this attester's public key as the ATTEST key.
     * Throws Error('round closed') when the round is null or not below
     * `rounds`, and Error('reading out of range') when the reading is not
     * a cell, or is outside the range while `sign_anyway` is false.
     */
    sign(reading: number | bigint, round: number | null): PendingInput {
        if (
            round === null ||
            !Number.isInteger(round) ||
            round < 0 ||
            round >= this.settings.rounds
        )
            throw new Error('round closed')
        if (typeof reading === 'number' && !Number.isInteger(reading))
            throw new Error('reading out of range')
        const value = BigInt(reading)
        if (value < 0n || value > BigInt(CELL_MAX))
            throw new Error('reading out of range')
        const { rangeMin, rangeMax } = this.settings
        if (
            !this.signAnyway &&
            rangeMin !== undefined &&
            rangeMax !== undefined &&
            (value < BigInt(rangeMin) || value > BigInt(rangeMax))
        )
            throw new Error('reading out of range')
        const tag = readingTag(this.options, round, this.slot)
        return {
            witness: [BigInt(this.slot), value],
            sig: signReadingFor(this.attester, this.instanceId, tag, value),
            attestKey: this.attester.pub,
        }
    }
}

/** What `MemberAttester.sign` gives: the input to relay and the round it was signed for. */
export interface MemberSigned {
    /** Witness `[0, reading]`, the signature and the member's key (no proof yet). */
    input: PendingInput
    /** The round of the lock time, the one the signature is bound to. */
    round: number
}

/** Signs readings for one leaf of a tree-mode consortium machine. */
export class MemberAttester {
    /** sha256 of the public key bytes, as a roster leaf stores it (64 hex). */
    readonly keyHashHex: string
    /** 20-byte payout hash of this gateway (`payoutAddressOf`), 40 hex. */
    readonly payoutHex: string
    /** The Rabin key; private. */
    private readonly attester: Attester
    private readonly settings: TreeSettings
    private readonly options: TreeConsortiumOptions
    private readonly signAnyway: boolean

    /**
     * Make the attester from a configuration.
     * Input: the configuration; it needs `[attester] rabin_p` and `rabin_q`
     * and, in tree mode, `[consortium]` start, period and rounds.
     * Throws a plain message (no secret) when one is missing or wrong.
     */
    constructor(cfg: GatewayConfig) {
        this.attester = rabinKeyOf(cfg)
        this.keyHashHex = keyHash(this.attester.pub)
        if (!cfg.tree)
            throw new Error('config: the [consortium] table is required')
        this.settings = cfg.tree
        this.options = treeOptionsOf(cfg.tree)
        this.payoutHex = payoutOf(payoutAddressOf(cfg)).toLowerCase()
        this.signAnyway = cfg.signAnyway
        // Fails early, with the reason, on settings that make no round.
        treeRoundAt(this.options, cfg.tree.start)
    }

    /** The public key that verifies this attester's signatures. */
    get publicKey(): RabinPubKey {
        return this.attester.pub
    }

    /** Number of rounds of the machine (`[consortium] rounds`). */
    get rounds(): number {
        return this.settings.rounds
    }

    /**
     * The round the program computes at a lock time.
     * Input: the nLockTime of the cycle (unix seconds). Output: `roundAt` of
     * the tree program: 0 before `start`, r for r in 1..rounds, above
     * `rounds` once the machine has ended.
     */
    roundAt(lockTime: number): number {
        return treeRoundAt(this.options, lockTime)
    }

    /**
     * Sign a reading for the round of a lock time.
     * Input: the reading (a whole number), the exact nLockTime the cycle
     * will carry, and the instance id of the machine (64 hex). The round is
     * `roundAt(lockTime)`, so the signature and the program use the same
     * round.
     * Output: the pending input (witness `[0, reading]`, signature, own key
     * as `attestKey`) and the round. Add the roster proof as `tree`.
     * Throws Error('no round is open') before `start`, Error('round closed')
     * at or after the end, and Error('reading out of range') when the
     * reading is not a cell or is outside the range with `sign_anyway` off.
     */
    sign(
        reading: number | bigint,
        lockTime: number,
        instanceIdHex: string
    ): MemberSigned {
        const round = this.roundAt(lockTime)
        if (round < 1) throw new Error('no round is open')
        if (round > this.settings.rounds) throw new Error('round closed')
        if (typeof reading === 'number' && !Number.isInteger(reading))
            throw new Error('reading out of range')
        const value = BigInt(reading)
        if (value < 0n || value > BigInt(CELL_MAX))
            throw new Error('reading out of range')
        const { rangeMin, rangeMax } = this.settings
        if (
            !this.signAnyway &&
            rangeMin !== undefined &&
            rangeMax !== undefined &&
            (value < BigInt(rangeMin) || value > BigInt(rangeMax))
        )
            throw new Error('reading out of range')
        return {
            round,
            input: {
                witness: [0n, value],
                sig: signMemberReading(
                    this.attester,
                    instanceIdHex.toLowerCase(),
                    treeReadingTag(round),
                    value
                ),
                attestKey: this.attester.pub,
            },
        }
    }
}
