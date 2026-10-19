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
 * - `round closed`: the chain time (the nLockTime the keeper will stamp,
 *   min(now, MTP - 1)) is at or after start + rounds * period, the close
 *   of the last round, so no round is open (Review Focus 1);
 * - `reading out of range`: the reading is outside `[consortium]
 *   range_min..range_max`, unless `[gateway] sign_anyway` is true. A value
 *   that is not a 32-bit cell is always refused.
 *
 * The primes never leave this module: no error text and no property holds
 * them.
 */

import { RabinPubKey } from 'scrypt-ts-lib'
import { Attester, keyHash, readSlot, signReadingFor } from 'k17-vm'
import { ConsortiumSettings, GatewayConfig } from '../chain/config'
import { PendingInput } from '../chain/keeper'
import { ConsortiumOptions, readingTag } from '../programs/consortium'

/** Largest cell value. */
const CELL_MAX = 0xffffffff

/** The machine fields the enrolment check reads. */
export interface MachineMemory {
    /** Memory image, hex. */
    mem: string
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
     * or holds a key hash that is not this attester's.
     */
    currentRound(now: number, machine: MachineMemory): number | null {
        if (this.slot < 1 || this.slot > this.settings.slots)
            throw new Error('slot not enrolled')
        const roster = readSlot(machine.mem, this.slot)
        if (roster.empty || roster.hashHex.toLowerCase() !== this.keyHashHex)
            throw new Error('slot not enrolled')
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
