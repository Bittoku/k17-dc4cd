/**
 * Scenario runner for the k17forth tool.
 *
 * A scenario describes a series of cycles (one per spending transaction) for
 * the reference VM: lock time, witness cells, and which named, seeded
 * attester signs what. This module holds the scenario types, the attester
 * book that caches seeded Rabin keys (key generation takes seconds), the
 * builders that turn a cycle description into a VM step environment, the
 * memory and roster view helpers that the repl shares, and `runScenario`.
 */

import {
    Attester,
    K17Machine,
    K17State,
    MEM_CELLS,
    ROSTER_BASE,
    ROSTER_SLOTS,
    StepEnv,
    Status,
    PaySlot,
    initialState,
    keyHash,
    newAttester,
    readSlot,
    signEndorsement,
    signReading,
    signReadingFor,
    slotCells,
    stepK,
    withSlot,
    decodeCell,
} from 'k17-vm'

/** Instance id used when a scenario does not give one: 32 zero bytes. */
export const DEFAULT_INSTANCE_ID = '00'.repeat(32)
/** Payout used for a roster slot when a scenario does not give one: 20 zero bytes. */
export const DEFAULT_PAYOUT = '00'.repeat(20)

/** A number as JSON gives it, a decimal or 0x string for values above 2^53, or a bigint. */
export type NumberLike = number | string | bigint

/** One signed reading: `attester` signs `value` under `tag`. */
export interface ReadingSpec {
    attester: string
    tag: NumberLike
    value: NumberLike
}

/** One endorsement: `endorser` adds `newMember` to roster slot `newSlot`. */
export interface EndorseSpec {
    endorser: string
    tag: NumberLike
    newMember: string
    /** 20-byte payout as 40 hex characters. */
    payoutHex: string
    newSlot: number
}

/** One cycle (one spending transaction) of a scenario. */
export interface CycleSpec {
    lockTime: NumberLike
    /** Witness cells for IN. */
    witness?: NumberLike[]
    /** Spender address cell for WHO; default 0. */
    who?: NumberLike
    /** Balance of the spent output for VALUE; default 0. */
    value?: NumberLike
    /** Supplies the ATTEST signature ("K17M") and key. */
    attest?: ReadingSpec
    /** Supplies the SIGVERIFY signature ("K17A"). */
    sigverify?: ReadingSpec
    /** Supplies the ENDORSE signature, both keys and the payout. */
    endorse?: EndorseSpec
}

/** A whole scenario file. */
export interface Scenario {
    /** Attester name to 32-byte seed (64 hex characters). */
    attesters?: Record<string, string>
    /** Attester names for the fixed SIGVERIFY roster, by slot. */
    roster?: string[]
    /** Attester names pre-filled into memory roster slots (key: slot number). */
    slots?: Record<string, string>
    /** The machine's 32-byte instance id as 64 hex characters. */
    instanceId?: string
    cycles: CycleSpec[]
}

/** One non-empty roster slot as shown in reports. */
export interface RosterView {
    slot: number
    /** First 8 hex characters of the key hash. */
    keyHashShort: string
    payoutHex: string
}

/** What the VM showed after one cycle. */
export interface CycleReport {
    index: number
    status: Status
    lockTime: bigint
    witnessUsed: number
    bountyDue: bigint
    payslot?: PaySlot
    ds: bigint[]
    rs: bigint[]
    out: bigint[]
    roster: RosterView[]
    /** Non-zero program cells below the roster, as [cell, value]. */
    memory: [number, bigint][]
    /**
     * Warning about the cycle, for example that the chain would refuse it
     * (MIN_STEP); absent when there is none.
     */
    warning?: string
}

/** Smallest clock advance between two cycles that keep the machine alive (K17Machine.MIN_STEP, 60 s). */
const MIN_STEP_SECONDS = 60n

/** Statuses after which no later cycle can run. */
const STOPPING: Status[] = ['halted', 'fault', 'need_witness', 'verify_failed']

/**
 * Warning text for a cycle that the chain would refuse because it follows an
 * alive cycle less than MIN_STEP (60 s) later. The VM does not enforce this
 * rule; the contract does (v3.1). A cycle that halts is exempt.
 * Input: nLockTime of the previous alive cycle (undefined for the first
 * cycle), nLockTime of this cycle, and whether this cycle keeps the machine
 * alive. Output: one warning line, or undefined when the cycle is fine.
 */
export function minStepWarning(
    previousLockTime: bigint | undefined,
    lockTime: bigint,
    alive: boolean
): string | undefined {
    if (previousLockTime === undefined || !alive) return undefined
    if (lockTime >= previousLockTime + MIN_STEP_SECONDS) return undefined
    return `warning: the chain would refuse this cycle: MIN_STEP (needs lockTime >= ${
        previousLockTime + MIN_STEP_SECONDS
    }, the previous alive cycle's lockTime plus ${MIN_STEP_SECONDS} s)`
}

/**
 * Seeded attesters by name. Keys are generated on first use and cached,
 * because Rabin key generation takes seconds.
 */
export class AttesterBook {
    private seeds: Map<string, Buffer> = new Map()
    private keys: Map<string, Attester> = new Map()

    /**
     * Input: optional name-to-seed map (64 hex characters each).
     * Output: a book with those names defined.
     */
    constructor(seeds: Record<string, string> = {}) {
        for (const [name, seed] of Object.entries(seeds))
            this.define(name, seed)
    }

    /**
     * Define a name. Input: name, 64-hex-character seed. Output: none.
     * Throws if the seed is malformed; the message never contains the seed.
     */
    define(name: string, seedHex: string): void {
        if (!/^[0-9a-fA-F]{64}$/.test(seedHex))
            throw new Error(
                `seed of attester "${name}" must be 64 hex characters`
            )
        this.seeds.set(name, Buffer.from(seedHex, 'hex'))
        this.keys.delete(name)
    }

    /** Input: name. Output: its attester (generated once). Throws if undefined. */
    get(name: string): Attester {
        let key = this.keys.get(name)
        if (!key) {
            const seed = this.seeds.get(name)
            if (!seed) throw new Error(`unknown attester "${name}"`)
            key = newAttester(seed)
            this.keys.set(name, key)
        }
        return key
    }
}

/** Input: a number-like. Output: a bigint. Throws on non-integers. */
export function toBig(value: NumberLike): bigint {
    return BigInt(value)
}

/**
 * Split a memory image into cells.
 * Input: hex of 4-byte little-endian cells. Output: the cell values.
 */
export function decodeCells(hex: string): bigint[] {
    const cells: bigint[] = []
    for (let i = 0; i < hex.length; i += 8)
        cells.push(decodeCell(hex.slice(i, i + 8)))
    return cells
}

/**
 * Non-empty roster slots of a memory image.
 * Input: memory hex. Output: one view per filled slot, in slot order.
 */
export function rosterView(mem: string): RosterView[] {
    const views: RosterView[] = []
    for (let slot = 0; slot < ROSTER_SLOTS; slot++) {
        const s = readSlot(mem, slot)
        if (!s.empty)
            views.push({
                slot,
                keyHashShort: s.hashHex.slice(0, 8),
                payoutHex: s.payoutHex,
            })
    }
    return views
}

/**
 * Non-zero program cells of a memory image, below the roster.
 * Input: memory hex. Output: [cell index, value] pairs.
 */
export function memoryCells(mem: string): [number, bigint][] {
    const out: [number, bigint][] = []
    decodeCells(mem)
        .slice(0, ROSTER_BASE)
        .forEach((v, i) => {
            if (v !== 0n) out.push([i, v])
        })
    return out
}

/**
 * Memory image with roster slots pre-filled.
 * Input: attester book, slot number to attester name, payout hex.
 * Output: memory hex (all zero cells apart from the slots).
 */
export function memoryWithRoster(
    book: AttesterBook,
    slots: Record<string, string>,
    payoutHex: string = DEFAULT_PAYOUT
): string {
    let mem = '00'.repeat(MEM_CELLS * 4)
    for (const [slot, name] of Object.entries(slots))
        mem = withSlot(
            mem,
            Number(slot),
            slotCells(keyHash(book.get(name).pub), payoutHex)
        )
    return mem
}

/**
 * Build the VM environment of one cycle.
 * Input: attester book, the cycle, the SIGVERIFY roster names (an empty
 * name is an empty slot) and the instance id. Output: a StepEnv with signatures and keys filled in.
 */
export function cycleEnvironment(
    book: AttesterBook,
    spec: CycleSpec,
    rosterNames: string[],
    instanceId: string
): StepEnv {
    const env: StepEnv = {
        lockTime: toBig(spec.lockTime),
        who: toBig(spec.who ?? 0),
        witness: (spec.witness ?? []).map(toBig),
        roster: rosterNames.map((n) => (n ? book.get(n).pub : 0n)),
        instanceId,
        value: toBig(spec.value ?? 0),
    }
    if (spec.sigverify) {
        const r = spec.sigverify
        env.sig = signReading(
            book.get(r.attester),
            toBig(r.tag),
            toBig(r.value)
        )
    }
    if (spec.attest) {
        const r = spec.attest
        const att = book.get(r.attester)
        env.sig = signReadingFor(att, instanceId, toBig(r.tag), toBig(r.value))
        env.attestKey = att.pub
    }
    if (spec.endorse) {
        const e = spec.endorse
        const endorser = book.get(e.endorser)
        const member = book.get(e.newMember)
        env.sig = signEndorsement(
            endorser,
            instanceId,
            toBig(e.tag),
            member.pub,
            e.payoutHex,
            BigInt(e.newSlot)
        )
        env.attestKey = endorser.pub
        env.endorseKey = member.pub
        env.payout = e.payoutHex
    }
    return env
}

/**
 * Describe a machine state after a cycle.
 * Input: index, status, lock time, state and cycle counters. Output: report.
 */
export function reportOf(
    index: number,
    status: Status,
    lockTime: bigint,
    state: K17State,
    witnessUsed: number,
    bountyDue: bigint,
    payslot?: PaySlot
): CycleReport {
    return {
        index,
        status,
        lockTime,
        witnessUsed,
        bountyDue,
        payslot,
        ds: decodeCells(state.ds),
        rs: decodeCells(state.rs),
        out: decodeCells(state.out),
        roster: rosterView(state.mem),
        memory: memoryCells(state.mem),
    }
}

/**
 * Run a program through a scenario on the reference VM, one K-instruction
 * cycle per scenario cycle. Stops after the first cycle that halts, faults
 * or blocks (need_witness, verify_failed).
 * Input: program hex and scenario. Output: one report per cycle that ran.
 */
export function runScenario(
    progHex: string,
    scenario: Scenario
): CycleReport[] {
    const book = new AttesterBook(scenario.attesters)
    const instanceId = scenario.instanceId ?? DEFAULT_INSTANCE_ID
    const rosterNames = scenario.roster ?? []
    let state = initialState(
        progHex,
        scenario.slots ? memoryWithRoster(book, scenario.slots) : undefined
    )
    const reports: CycleReport[] = []
    let previousAliveLockTime: bigint | undefined
    for (let index = 0; index < scenario.cycles.length; index++) {
        const env = cycleEnvironment(
            book,
            scenario.cycles[index],
            rosterNames,
            instanceId
        )
        const r = stepK(state, env, K17Machine.K)
        state = r.state
        const report = reportOf(
            index,
            r.status,
            env.lockTime,
            state,
            r.witnessUsed,
            r.bountyDue,
            r.payslot
        )
        const alive = !STOPPING.includes(r.status)
        const warning = minStepWarning(
            previousAliveLockTime,
            env.lockTime,
            alive
        )
        if (warning) report.warning = warning
        if (alive) previousAliveLockTime = env.lockTime
        reports.push(report)
        if (STOPPING.includes(r.status)) break
    }
    return reports
}

/** Input: cells. Output: text such as `[1, 2, 3]` (decimal, bottom first). */
export function formatCells(cells: bigint[]): string {
    return `[${cells.join(', ')}]`
}

/**
 * Text lines that describe the machine after a cycle or a repl line:
 * stacks, output log, non-zero memory and filled roster slots.
 * Input: a report. Output: lines without a header.
 */
export function formatReport(report: CycleReport): string[] {
    const lines = [
        `ds ${formatCells(report.ds)}`,
        `rs ${formatCells(report.rs)}`,
        `out ${formatCells(report.out)}`,
    ]
    if (report.memory.length)
        lines.push(
            'mem ' + report.memory.map(([i, v]) => `[${i}]=${v}`).join(' ')
        )
    for (const r of report.roster)
        lines.push(
            `roster ${r.slot} key=${r.keyHashShort}.. payout=${r.payoutHex}`
        )
    if (report.warning) lines.push(report.warning)
    if (report.bountyDue > 0n) lines.push(`bounty ${report.bountyDue}`)
    if (report.payslot)
        lines.push(
            `payslot slot=${report.payslot.slot} sats=${report.payslot.sats}`
        )
    return lines
}
