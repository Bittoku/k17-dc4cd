/**
 * Consortium program (sponsor-paid sensing): reference-VM and on-chain tests.
 *
 * A sponsor (roster slot 0 of the initial memory image) endorses three
 * landowners into slots 1..3. In each of two rounds the landowners deliver
 * one signed reading each, in any order; every accepted reading is logged and
 * pays `bountyPerReading` to that landowner's payout address. The reference
 * VM block drives every cycle, checks that each one ends inside K
 * instructions, and covers the refusals; the on-chain block runs the same
 * flow through the sCrypt contract and the script interpreter.
 */
import { expect, use } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {
    K17Machine,
    K17State,
    CycleOutcome,
    StepEnv,
    initialState,
    keyHash,
    newAttester,
    outputLog,
    payoutOf,
    readSlot,
    signEndorsement,
    signReadingFor,
    stepK,
    Attester,
} from 'k17-vm'
import {
    CONSORTIUM_TAG_BASE,
    ConsortiumOptions,
    ENDORSE_TAG_BASE,
    compile,
    consortiumMemory,
    consortiumProgram,
    consortiumSource,
    cycleInstructionCounts,
    endorseTag,
    readingTag,
    roundClose,
} from '../src'
import { T0, FUNDING, cycle, deploy, loadMachineArtifact } from './utils/chain'
import { randomPrivateKey } from './utils/txHelper'
use(chaiAsPromised)

const ENROL_DEADLINE = Number(T0) + 1000

const OPTS: ConsortiumOptions = {
    slots: 3,
    rounds: 2,
    epoch: 7,
    start: ENROL_DEADLINE,
    period: 1000,
    enrolDeadline: ENROL_DEADLINE,
    bountyPerReading: 150,
    floor: 1000,
    sponsorKeyHashHex: '', // set below, once the sponsor key exists
    range: { min: 4000, max: 6000 },
}

// Deterministic Rabin keys; key generation is slow, so it happens once.
const sponsor = newAttester(Buffer.alloc(32, 40))
const landowners = [41, 42, 43].map((i) => newAttester(Buffer.alloc(32, i)))
OPTS.sponsorKeyHashHex = keyHash(sponsor.pub)
// landowners[k] sits in roster slot k + 1 and is paid at payouts[k]
const payoutAddresses = landowners.map(() => randomPrivateKey()[3])
const payouts = payoutAddresses.map((a) => payoutOf(a))

/** Readings per round, indexed by slot - 1 (tenths of a degree + 5000). */
const READINGS = [
    [5231n, 5198n, 5305n],
    [5240n, 5180n, 5290n],
]

/** Fixed instance id for the reference-VM tests. */
const ID = 'c0'.repeat(32)

/** Environment for one VM cycle at `lockTime` with optional extras. */
function envAt(lockTime: bigint, extra: Partial<StepEnv> = {}): StepEnv {
    return {
        lockTime,
        who: 0n,
        witness: [],
        instanceId: ID,
        value: BigInt(FUNDING),
        ...extra,
    }
}

/**
 * Run one cycle on the reference VM and check that it ends inside K
 * instructions: the capped run must equal an uncapped run to the next
 * YIELD, HALT or block. Input: state, environment. Output: the outcome.
 */
function runCycle(s: K17State, env: StepEnv): CycleOutcome {
    const capped = stepK(s, env, K17Machine.K)
    expect(capped).to.deep.equal(stepK(s, env, 10_000))
    return capped
}

/** Environment extras for the sponsor endorsing landowner `k` (0-based) into slot k + 1. */
function endorsement(k: number, instanceId = ID): Partial<StepEnv> {
    const slot = k + 1
    return {
        sig: signEndorsement(
            sponsor,
            instanceId,
            endorseTag(OPTS, slot),
            landowners[k].pub,
            payouts[k],
            BigInt(slot)
        ),
        attestKey: sponsor.pub,
        endorseKey: landowners[k].pub,
        payout: payouts[k],
    }
}

/** Environment extras for `signer` relaying `reading` as slot `slot` in round `round`. */
function delivery(
    signer: Attester,
    round: number,
    slot: number,
    reading: bigint,
    instanceId = ID
): Partial<StepEnv> {
    return {
        witness: [BigInt(slot), reading],
        sig: signReadingFor(
            signer,
            instanceId,
            readingTag(OPTS, round, slot),
            reading
        ),
        attestKey: signer.pub,
    }
}

/** Initial VM state: the program with the sponsor in roster slot 0. */
function freshState(opts: ConsortiumOptions = OPTS): K17State {
    return initialState(consortiumProgram(opts), consortiumMemory(opts))
}

/** Advance through cycle 1 and `n` endorsements; returns the state. */
function enrolled(n: number, opts: ConsortiumOptions = OPTS): K17State {
    let s = runCycle(freshState(opts), envAt(T0)).state
    for (let k = 0; k < n; k++) {
        const r = runCycle(s, envAt(T0 + BigInt(k + 1), endorsement(k)))
        expect(r.status).to.equal('ok')
        s = r.state
    }
    return s
}

/** State at the first reading cycle of round 0, all three slots enrolled. */
function roundZeroOpen(): K17State {
    let r = runCycle(enrolled(3), envAt(T0 + 10n)) // roster full: leave enrolment
    expect(r.status).to.equal('ok')
    r = runCycle(r.state, envAt(T0 + 11n)) // round 0 opens: delivered cells zeroed
    expect(r.status).to.equal('ok')
    return r.state
}

/** Accept one reading: the attest cycle, then the pay cycle. */
function deliver(
    s: K17State,
    lockTime: bigint,
    round: number,
    slot: number,
    reading: bigint
): { state: K17State; pay: CycleOutcome } {
    const a = runCycle(
        s,
        envAt(lockTime, delivery(landowners[slot - 1], round, slot, reading))
    )
    expect(a.status).to.equal('ok')
    expect(a.payslot).to.equal(undefined)
    const pay = runCycle(a.state, envAt(lockTime + 1n))
    expect(pay.status).to.equal('ok')
    return { state: pay.state, pay }
}

describe('consortium: generator', () => {
    it('computes reading and endorsement tags from epoch, round and slot', () => {
        expect(readingTag(OPTS, 1, 3)).to.equal(
            BigInt(CONSORTIUM_TAG_BASE) + 7n * 4096n + 16n + 3n
        )
        expect(endorseTag(OPTS, 2)).to.equal(
            BigInt(ENDORSE_TAG_BASE) + 7n * 16n + 2n
        )
        expect(roundClose(OPTS, 0)).to.equal(OPTS.start + OPTS.period)
        expect(() => readingTag(OPTS, 2, 1)).to.throw(/round/)
        expect(() => readingTag(OPTS, 0, 0)).to.throw(/slot/)
        expect(() => endorseTag(OPTS, 4)).to.throw(/slot/)
    })

    it('keeps every cycle inside K17Machine.K instructions', () => {
        const shapes: ConsortiumOptions[] = [
            OPTS,
            { ...OPTS, range: undefined },
            { ...OPTS, slots: 7, rounds: 36 },
        ]
        for (const opts of shapes) {
            const counts = cycleInstructionCounts(
                compile(consortiumSource(opts)).tokens
            )
            expect(Math.max(...counts)).to.be.at.most(K17Machine.K)
        }
    })

    it('puts the sponsor in roster slot 0 of the initial memory', () => {
        const slot0 = readSlot(consortiumMemory(OPTS), 0)
        expect(slot0.hashHex).to.equal(keyHash(sponsor.pub))
        expect(slot0.payoutHex).to.equal('00'.repeat(20))
        expect(readSlot(consortiumMemory(OPTS), 1).empty).to.equal(true)
    })

    it('refuses slots*rounds above the 256-cell output log', () => {
        expect(() =>
            consortiumSource({ ...OPTS, slots: 7, rounds: 37 })
        ).to.throw('slots*rounds exceeds the 256-cell output log')
    })

    it('refuses out-of-range options', () => {
        const bad: Partial<ConsortiumOptions>[] = [
            { slots: 0 },
            { slots: 8 },
            { rounds: 0 },
            { epoch: 65536 },
            { enrolDeadline: OPTS.start + 1 },
            { period: 0 },
            { bountyPerReading: 0 },
            { floor: OPTS.bountyPerReading },
            { sponsorKeyHashHex: 'ab' },
            { range: { min: 10, max: 9 } },
            { start: 0xffffffff, enrolDeadline: 1 },
        ]
        for (const b of bad) {
            expect(() => consortiumSource({ ...OPTS, ...b })).to.throw()
        }
    })
})

describe('consortium: reference VM', function () {
    this.timeout(120_000)

    it('enrols three landowners, takes readings in any order, pays each slot, halts after two rounds', () => {
        let s = freshState()
        let r = runCycle(s, envAt(T0))
        expect(r.status).to.equal('ok')
        s = r.state
        for (let k = 0; k < 3; k++) {
            r = runCycle(s, envAt(T0 + BigInt(k + 1), endorsement(k)))
            expect(r.status).to.equal('ok')
            s = r.state
            const entry = readSlot(s.mem, k + 1)
            expect(entry.hashHex).to.equal(keyHash(landowners[k].pub))
            expect(entry.payoutHex).to.equal(payouts[k])
        }
        // the roster is full: enrolment ends before its deadline
        r = runCycle(s, envAt(T0 + 10n))
        expect(r.status).to.equal('ok')
        r = runCycle(r.state, envAt(T0 + 11n)) // round 0 opens
        s = r.state

        const t0 = BigInt(OPTS.start) + 100n
        const order = [2, 1, 3]
        order.forEach((slot, i) => {
            const d = deliver(
                s,
                t0 + BigInt(10 * i),
                0,
                slot,
                READINGS[0][slot - 1]
            )
            expect(d.pay.payslot).to.deep.equal({
                slot,
                payoutHex: payouts[slot - 1],
                sats: BigInt(OPTS.bountyPerReading),
            })
            s = d.state
        })

        // round 0 closes; the next cycle opens round 1
        const close0 = BigInt(roundClose(OPTS, 0))
        r = runCycle(s, envAt(close0))
        expect(r.status).to.equal('ok')
        r = runCycle(r.state, envAt(close0 + 1n))
        expect(r.status).to.equal('ok')
        s = r.state
        for (const slot of [3, 1, 2]) {
            const d = deliver(
                s,
                close0 + 10n + BigInt(slot),
                1,
                slot,
                READINGS[1][slot - 1]
            )
            expect(d.pay.payslot?.slot).to.equal(slot)
            s = d.state
        }

        r = runCycle(s, envAt(BigInt(roundClose(OPTS, 1))))
        expect(r.status).to.equal('halted')
        expect(outputLog(r.state)).to.deep.equal([
            READINGS[0][1],
            READINGS[0][0],
            READINGS[0][2],
            READINGS[1][2],
            READINGS[1][0],
            READINGS[1][1],
        ])
    })

    it('refuses a second reading from the same slot in one round', () => {
        const t = BigInt(OPTS.start) + 100n
        const s = deliver(roundZeroOpen(), t, 0, 2, READINGS[0][1]).state
        const again = runCycle(
            s,
            envAt(t + 10n, delivery(landowners[1], 0, 2, READINGS[0][1]))
        )
        expect(again.status).to.equal('verify_failed')
    })

    it('refuses a round-0 reading relayed after round 0 closes', () => {
        const close0 = BigInt(roundClose(OPTS, 0))
        const late = delivery(landowners[0], 0, 1, READINGS[0][0])
        // the closing cycle ignores the witness: nothing logged, nothing paid
        const closing = runCycle(roundZeroOpen(), envAt(close0, late))
        expect(closing.status).to.equal('ok')
        expect(closing.payslot).to.equal(undefined)
        expect(outputLog(closing.state)).to.deep.equal([])
        const opened = runCycle(closing.state, envAt(close0 + 1n)).state
        // in round 1 the round-0 signature does not match the tag
        const stale = runCycle(opened, envAt(close0 + 2n, late))
        expect(stale.status).to.equal('verify_failed')
    })

    it('refuses a signed reading outside the range', () => {
        const t = BigInt(OPTS.start) + 100n
        for (const reading of [3999n, 6001n]) {
            const r = runCycle(
                roundZeroOpen(),
                envAt(t, delivery(landowners[0], 0, 1, reading))
            )
            expect(r.status).to.equal('verify_failed')
        }
        for (const reading of [4000n, 6000n]) {
            const r = runCycle(
                roundZeroOpen(),
                envAt(t, delivery(landowners[0], 0, 1, reading))
            )
            expect(r.status).to.equal('ok')
        }
    })

    it('refuses slot 0, unenrolled slots and slots past the roster without halting', () => {
        const s = roundZeroOpen()
        const t = BigInt(OPTS.start) + 100n
        for (const slot of [0, 4, 7, 9, 0xffffffff]) {
            const r = runCycle(
                s,
                envAt(t, {
                    ...delivery(landowners[0], 0, 1, READINGS[0][0]),
                    witness: [BigInt(slot), READINGS[0][0]],
                })
            )
            expect(r.status, `slot ${slot}`).to.equal('verify_failed')
        }
        // the sponsor's own signature does not get slot 0 a reading either
        const slotZeroTag = BigInt(CONSORTIUM_TAG_BASE) + 7n * 4096n
        const bySponsor = runCycle(
            s,
            envAt(t, {
                witness: [0n, READINGS[0][0]],
                sig: signReadingFor(sponsor, ID, slotZeroTag, READINGS[0][0]),
                attestKey: sponsor.pub,
            })
        )
        expect(bySponsor.status).to.equal('verify_failed')
    })

    it("refuses a landowner signing for another landowner's slot", () => {
        const t = BigInt(OPTS.start) + 100n
        const r = runCycle(
            roundZeroOpen(),
            envAt(t, {
                ...delivery(landowners[0], 0, 1, READINGS[0][0]),
                witness: [2n, READINGS[0][0]],
            })
        )
        expect(r.status).to.equal('verify_failed')
    })

    it('waits for a missing signature only until the round closes', () => {
        const s = roundZeroOpen()
        const t = BigInt(OPTS.start) + 100n
        const unsigned = runCycle(
            s,
            envAt(t, { witness: [1n, READINGS[0][0]] })
        )
        expect(unsigned.status).to.equal('need_witness')
        const closed = runCycle(s, envAt(BigInt(roundClose(OPTS, 0))))
        expect(closed.status).to.equal('ok')
    })

    it('halts without paying once VALUE falls under the floor', () => {
        const t = BigInt(OPTS.start) + 100n
        const a = runCycle(
            roundZeroOpen(),
            envAt(t, delivery(landowners[0], 0, 1, READINGS[0][0]))
        )
        expect(a.status).to.equal('ok')
        const pay = runCycle(
            a.state,
            envAt(t + 1n, { value: BigInt(OPTS.floor) - 1n })
        )
        expect(pay.status).to.equal('halted')
        expect(pay.payslot).to.equal(undefined)
        const atFloor = runCycle(
            a.state,
            envAt(t + 1n, { value: BigInt(OPTS.floor) })
        )
        expect(atFloor.status).to.equal('ok')
        expect(atFloor.payslot?.sats).to.equal(BigInt(OPTS.bountyPerReading))
    })

    it('ends enrolment at the deadline and accepts only the enrolled slots', () => {
        const s = enrolled(2)
        // before the deadline a cycle without an endorsement is blocked
        expect(runCycle(s, envAt(T0 + 20n)).status).to.equal('need_witness')
        let r = runCycle(s, envAt(BigInt(OPTS.enrolDeadline)))
        expect(r.status).to.equal('ok')
        r = runCycle(r.state, envAt(BigInt(OPTS.enrolDeadline) + 1n))
        expect(r.status).to.equal('ok')
        const t = BigInt(OPTS.start) + 100n
        const third = runCycle(
            r.state,
            envAt(t, delivery(landowners[2], 0, 3, READINGS[0][2]))
        )
        expect(third.status).to.equal('verify_failed')
        const second = runCycle(
            r.state,
            envAt(t, delivery(landowners[1], 0, 2, READINGS[0][1]))
        )
        expect(second.status).to.equal('ok')
    })

    it('refuses an endorsement signed for a different slot', () => {
        const s = runCycle(freshState(), envAt(T0)).state
        const forSlot2 = {
            ...endorsement(0),
            sig: signEndorsement(
                sponsor,
                ID,
                endorseTag(OPTS, 2),
                landowners[0].pub,
                payouts[0],
                2n
            ),
        }
        expect(runCycle(s, envAt(T0 + 1n, forSlot2)).status).to.equal(
            'verify_failed'
        )
        // and one signed by a landowner rather than the sponsor
        const byLandowner = {
            ...endorsement(0),
            attestKey: landowners[1].pub,
            sig: signEndorsement(
                landowners[1],
                ID,
                endorseTag(OPTS, 1),
                landowners[0].pub,
                payouts[0],
                1n
            ),
        }
        expect(runCycle(s, envAt(T0 + 1n, byLandowner)).status).to.equal(
            'verify_failed'
        )
    })
})

describe('consortium: on chain', function () {
    this.timeout(600_000)

    before(loadMachineArtifact)

    it('sponsor endorses three landowners, two rounds of any-order readings, output 2 pays each landowner', async () => {
        const prog = consortiumProgram(OPTS)
        const m = await deploy(prog, undefined, consortiumMemory(OPTS))
        const id = m.instanceId
        let value = BigInt(FUNDING)
        let r = await cycle(m, value, T0 + 1n)
        value = r.plan.remaining
        for (let k = 0; k < 3; k++) {
            const e = endorsement(k, id)
            r = await cycle(
                r.next as K17Machine,
                value,
                T0 + BigInt(k + 2),
                [],
                e.sig,
                {
                    attestKey: e.attestKey,
                    endorseKey: e.endorseKey,
                    payoutHex: e.payout,
                }
            )
            value = r.plan.remaining
        }
        r = await cycle(r.next as K17Machine, value, T0 + 10n) // roster full
        value = r.plan.remaining
        r = await cycle(r.next as K17Machine, value, T0 + 11n) // round 0 opens
        value = r.plan.remaining

        const relay = async (
            lockTime: bigint,
            round: number,
            slot: number
        ): Promise<void> => {
            const reading = READINGS[round][slot - 1]
            const d = delivery(landowners[slot - 1], round, slot, reading, id)
            r = await cycle(
                r.next as K17Machine,
                value,
                lockTime,
                d.witness,
                d.sig,
                { attestKey: d.attestKey }
            )
            value = r.plan.remaining
            r = await cycle(r.next as K17Machine, value, lockTime + 1n)
            value = r.plan.remaining
            const out = r.tx.outputs[2]
            expect(r.plan.reward > 0n).to.equal(true)
            expect(out.satoshis).to.equal(OPTS.bountyPerReading)
            expect(out.script.toAddress().toString()).to.equal(
                payoutAddresses[slot - 1].toString()
            )
        }

        const t0 = BigInt(OPTS.start) + 100n
        for (const [i, slot] of [2, 1, 3].entries()) {
            await relay(t0 + BigInt(10 * i), 0, slot)
        }
        const close0 = BigInt(roundClose(OPTS, 0))
        r = await cycle(r.next as K17Machine, value, close0)
        value = r.plan.remaining
        r = await cycle(r.next as K17Machine, value, close0 + 1n)
        value = r.plan.remaining
        for (const [i, slot] of [3, 1, 2].entries()) {
            await relay(close0 + 10n + BigInt(10 * i), 1, slot)
        }
        r = await cycle(
            r.next as K17Machine,
            value,
            BigInt(roundClose(OPTS, 1))
        )
        expect(r.plan.halted).to.equal(true)
        expect(outputLog(r.plan.nextState)).to.deep.equal([
            READINGS[0][1],
            READINGS[0][0],
            READINGS[0][2],
            READINGS[1][2],
            READINGS[1][0],
            READINGS[1][1],
        ])
    })

    it('an endorsement signed for another machine instance is refused', async () => {
        const m = await deploy(
            consortiumProgram(OPTS),
            undefined,
            consortiumMemory(OPTS)
        )
        let value = BigInt(FUNDING)
        const r = await cycle(m, value, T0 + 1n)
        value = r.plan.remaining
        const e = endorsement(0, ID) // signed for the VM-test instance id
        await expect(
            cycle(r.next as K17Machine, value, T0 + 2n, [], e.sig, {
                attestKey: e.attestKey,
                endorseKey: e.endorseKey,
                payoutHex: e.payout,
            })
        ).to.be.rejectedWith(/rejected/)
    })
})
