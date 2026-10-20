/**
 * Tree-mode consortium program (src/programs/treeConsortium.ts): generator,
 * reference-VM and on-chain tests.
 *
 * The roster is a sparse Merkle tree. Alice is a genesis member (leaf 3,
 * lastRound 0); the sponsor admits Bob and removes members with signed
 * ADMIT and REMOVE cycles. The reference-VM block drives single cycles with
 * signed fixtures, checks that each one ends inside K instructions, and
 * covers the payments and the refusals. A static walk of the compiled
 * tokens checks that every branch of every cycle is at most K
 * instructions. The on-chain block runs one cycle of each branch and the
 * end halt through the sCrypt contract and the script interpreter.
 */
import { expect } from 'chai'
import { createHash } from 'crypto'
import {
    Attester,
    CycleOutcome,
    HAS_OPERAND,
    K17Machine,
    K17State,
    MNEMONIC,
    SparseMerkleTree,
    StepEnv,
    decodeLeafPre,
    encodeLeafPre,
    initialState,
    keyHash,
    newAttester,
    newMachine,
    planCycle,
    signAdmission,
    signMemberReading,
    signRemoval,
    stepK,
} from 'k17-vm'
import { compile, isTreeProgram } from '../src'
import {
    ADMIT_TAG,
    READING_TAG_BASE,
    REMOVE_TAG,
    TreeConsortiumOptions,
    readingTag,
    roundAt,
    treeConsortiumProgram,
    treeConsortiumSource,
} from '../src/programs/treeConsortium'
import {
    ECON,
    FUNDING,
    T0,
    cycle,
    keeper,
    loadMachineArtifact,
} from './utils/chain'
import { getDefaultSigner } from './utils/txHelper'

const START = Number(T0) + 1000
const PERIOD = 1000

const OPTS: TreeConsortiumOptions = {
    start: START,
    period: PERIOD,
    rounds: 3,
    bountyPerReading: 150,
    range: { min: 4000, max: 6000 },
}
/** First unix time at which the machine has ended. */
const END = START + OPTS.rounds * PERIOD

// Deterministic Rabin keys; key generation is slow, so it happens once.
const sponsor = newAttester(Buffer.alloc(32, 60))
const alice = newAttester(Buffer.alloc(32, 61))
const bob = newAttester(Buffer.alloc(32, 62))

const ALICE_INDEX = 3
const BOB_INDEX = 7
const ALICE_PAYOUT = 'a1'.repeat(20)
const BOB_PAYOUT = 'b2'.repeat(20)

/** Fixed instance id for the reference-VM tests. */
const ID = 'd4'.repeat(32)

/** Unix time inside round r (1-based), `offset` seconds after it opens. */
function inRound(r: number, offset = 100): bigint {
    return BigInt(START + (r - 1) * PERIOD + offset)
}

/** Genesis roster: Alice at ALICE_INDEX with lastRound 0. */
function genesisTree(): SparseMerkleTree {
    const tree = new SparseMerkleTree()
    tree.set(ALICE_INDEX, encodeLeafPre(keyHash(alice.pub), ALICE_PAYOUT, 0n))
    return tree
}

/**
 * A reference-VM machine and its off-chain roster mirror.
 * `state` is the VM state; `tree` matches `state.rosterRoot`.
 */
interface Machine {
    state: K17State
    tree: SparseMerkleTree
}

/** Initial machine for `opts` over the genesis roster. */
function freshMachine(opts: TreeConsortiumOptions = OPTS): Machine {
    const tree = genesisTree()
    const state = initialState(treeConsortiumProgram(opts), undefined, {
        rosterRoot: tree.root(),
        sponsorKeyHash: keyHash(sponsor.pub),
    })
    return { state, tree }
}

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

/** Environment extras for `signer` relaying `reading` for leaf `index` in `round`. */
function reading(
    m: Machine,
    signer: Attester,
    index: number,
    round: number,
    value: bigint
): Partial<StepEnv> {
    return {
        witness: [0n, value],
        sig: signMemberReading(signer, ID, readingTag(round), value),
        attestKey: signer.pub,
        tree: m.tree.proof(index),
    }
}

/** Environment extras for the sponsor admitting Bob at BOB_INDEX. */
function admitBob(m: Machine): Partial<StepEnv> {
    return {
        witness: [1n],
        sig: signAdmission(
            sponsor,
            ID,
            BigInt(ADMIT_TAG),
            m.state.rosterSeq,
            BigInt(BOB_INDEX),
            bob.pub,
            BOB_PAYOUT
        ),
        attestKey: sponsor.pub,
        endorseKey: bob.pub,
        payout: BOB_PAYOUT,
        tree: m.tree.proof(BOB_INDEX),
    }
}

/** Environment extras for the sponsor removing the member at `index`. */
function removeAt(m: Machine, index: number): Partial<StepEnv> {
    const leaf = decodeLeafPre(m.tree.get(index) as string)
    return {
        witness: [2n],
        sig: signRemoval(
            sponsor,
            ID,
            BigInt(REMOVE_TAG),
            m.state.rosterSeq,
            BigInt(index),
            leaf.keyHashHex,
            leaf.payoutHex
        ),
        attestKey: sponsor.pub,
        tree: m.tree.proof(index),
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

/**
 * Number of instructions a cycle executes: the least k for which a run
 * capped at k equals an uncapped run. Input: state, environment.
 * Output: the count (at most 100; throws above).
 */
function executedCount(s: K17State, env: StepEnv): number {
    const full = stepK(s, env, 10_000)
    for (let k = 1; k <= 100; k++) {
        try {
            expect(stepK(s, env, k)).to.deep.equal(full)
            return k
        } catch {
            // not yet at the end of the cycle
        }
    }
    throw new Error('cycle longer than 100 instructions')
}

/**
 * Run an accepted cycle on machine `m` and update its roster mirror.
 * Input: machine, environment, the leaf index the cycle's proof names.
 * Output: the next machine and the outcome. Fails the test unless the
 * cycle is accepted.
 */
function accept(
    m: Machine,
    env: StepEnv,
    index: number
): { next: Machine; out: CycleOutcome } {
    const out = runCycle(m.state, env)
    expect(out.status).to.equal('ok')
    if (out.leafAfter !== undefined) m.tree.set(index, out.leafAfter)
    return { next: { state: out.state, tree: m.tree }, out }
}

/** lastRound of the leaf at `index` in the mirror. */
function lastRoundOf(m: Machine, index: number): bigint {
    return decodeLeafPre(m.tree.get(index) as string).lastRound
}

/**
 * Longest path, in instructions, from each cycle start to the YIELD or HALT
 * that ends the cycle (or the `LIT 0 VERIFY` that refuses it). Cycle starts
 * are the program start and the token after each YIELD. Every IF is
 * followed both ways, except `LIT 0 IF`, which always jumps. Labels and
 * operands are not counted (as in cycleInstructionCounts).
 * Input: tokens from compile(). Output: one count per cycle start.
 */
function longestBranches(tokens: (string | number)[]): number[] {
    const labels = new Map<string, number>()
    tokens.forEach((t, i) => {
        if (typeof t === 'string' && t.endsWith(':'))
            labels.set(t.slice(0, -1), i)
    })
    const afterLitZero = (i: number) =>
        tokens[i - 2] === 'LIT' && tokens[i - 1] === 0
    const walk = (i: number, count: number): number => {
        while (i < tokens.length) {
            const t = tokens[i]
            if (typeof t !== 'string') throw new Error(`operand at ${i}`)
            if (t.endsWith(':')) {
                i++
                continue
            }
            count++
            if (count > 1000) throw new Error('loop without a YIELD')
            if (t === 'YIELD' || t === 'HALT') return count
            if (t === 'VERIFY' && afterLitZero(i)) return count
            if (t === 'IF') {
                const target = labels.get(tokens[i + 1] as string)
                if (target === undefined) throw new Error('unknown label')
                const jumped = walk(target, count)
                if (afterLitZero(i)) return jumped
                return Math.max(jumped, walk(i + 2, count))
            }
            i += HAS_OPERAND.has(MNEMONIC[t]) ? 2 : 1
        }
        return count
    }
    const starts = [0]
    tokens.forEach((t, i) => {
        if (t === 'YIELD') starts.push(i + 1)
    })
    return starts.map((s) => walk(s, 0))
}

describe('tree consortium: generator', () => {
    it('computes tags and exports the tag constants', () => {
        expect(READING_TAG_BASE).to.equal(0x40000000)
        expect(ADMIT_TAG).to.equal(0x48000000)
        expect(REMOVE_TAG).to.equal(0x4c000000)
        expect(readingTag(0)).to.equal(0x40000000n)
        expect(readingTag(7)).to.equal(0x40000007n)
        expect(readingTag(0x0fffffff)).to.equal(0x4fffffffn)
        expect(() => readingTag(0x10000000)).to.throw(/round/)
        expect(() => readingTag(-1)).to.throw(/round/)
        expect(() => readingTag(1.5)).to.throw(/round/)
        // the longest valid machine (start 60, period 60) still has every
        // reading tag below ADMIT_TAG: rounds < 2^32 / 60 < 2^27
        const maxRounds = Math.floor((0xffffffff - 60) / 60)
        expect(() =>
            treeConsortiumSource({
                ...OPTS,
                start: 60,
                period: 60,
                rounds: maxRounds,
            })
        ).not.to.throw()
        expect(() =>
            treeConsortiumSource({
                ...OPTS,
                start: 60,
                period: 60,
                rounds: maxRounds + 1,
            })
        ).to.throw(/END/)
        expect(readingTag(maxRounds) < BigInt(ADMIT_TAG)).to.equal(true)
    })

    it('computes roundAt at the round boundaries', () => {
        expect(roundAt(OPTS, START - 1)).to.equal(0)
        expect(roundAt(OPTS, 0)).to.equal(0)
        expect(roundAt(OPTS, START)).to.equal(1)
        expect(roundAt(OPTS, START + PERIOD - 1)).to.equal(1)
        expect(roundAt(OPTS, START + PERIOD)).to.equal(2)
        expect(roundAt(OPTS, END - 1)).to.equal(OPTS.rounds)
        expect(roundAt(OPTS, END)).to.equal(OPTS.rounds + 1)
        expect(() => roundAt(OPTS, -1)).to.throw(/t must/)
    })

    it('refuses invalid options', () => {
        const bad: [Partial<TreeConsortiumOptions>, RegExp][] = [
            [{ start: 0 }, /start/],
            [{ start: 1.5 }, /start/],
            [{ period: 59 }, /period/],
            [{ rounds: 0 }, /rounds/],
            [{ rounds: 2.5 }, /rounds/],
            [{ start: 0xffffffff - 2000, rounds: 3 }, /END/],
            [{ start: 1, period: 0x80000001, rounds: 1 }, /rounds \+ 1/],
            [{ bountyPerReading: 0 }, /bountyPerReading/],
            [{ bountyPerReading: 2 ** 32 }, /bountyPerReading/],
            [{ range: { min: 10, max: 9 } }, /range/],
            [{ range: { min: -1, max: 9 } }, /range/],
        ]
        for (const [change, message] of bad) {
            expect(
                () => treeConsortiumSource({ ...OPTS, ...change }),
                JSON.stringify(change)
            ).to.throw(message)
        }
    })

    it('keeps every branch of every cycle inside K17Machine.K instructions', () => {
        const shapes: TreeConsortiumOptions[] = [
            OPTS,
            { ...OPTS, range: undefined },
            { ...OPTS, range: { min: 0, max: 100 } },
            { ...OPTS, range: { min: 0, max: 0xffffffff } },
            {
                start: 0xfffffff0 - 60 * 0x0ffffff,
                period: 60,
                rounds: 0x0ffffff,
                bountyPerReading: 0xffffffff,
                range: { min: 0xfffffff0, max: 0xfffffffe },
            },
        ]
        for (const opts of shapes) {
            const { tokens } = compile(treeConsortiumSource(opts))
            const counts = longestBranches(tokens)
            expect(counts.length).to.be.greaterThan(1)
            for (const n of counts)
                expect(n, JSON.stringify(opts)).to.be.at.most(K17Machine.K)
        }
        // the reading branch after a YIELD: 36 with a range, 34 with a
        // range from 0 (no subtraction), 30 without
        const longest = (opts: TreeConsortiumOptions) =>
            Math.max(
                ...longestBranches(compile(treeConsortiumSource(opts)).tokens)
            )
        expect(longest(OPTS)).to.equal(36)
        expect(longest({ ...OPTS, range: { min: 0, max: 100 } })).to.equal(34)
        expect(longest({ ...OPTS, range: undefined })).to.equal(30)
        expect(treeConsortiumSource({ ...OPTS, range: { min: 0, max: 100 } }))
            .to.contain('dup 101 / if 0 verify then')
            .and.not.contain(' 0 - ')
        expect(isTreeProgram(treeConsortiumProgram(OPTS))).to.equal(true)
    })
})

describe('tree consortium: reference VM', function () {
    this.timeout(120_000)

    before(loadMachineArtifact)

    it("pays a genesis member's round-1 reading and sets lastRound = 1", () => {
        const m = freshMachine()
        const env = envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, 5231n))
        expect(executedCount(m.state, env)).to.equal(35) // first cycle: no 'until' jump
        const { next, out } = accept(m, env, ALICE_INDEX)
        expect(out.payslot).to.deep.equal({
            slot: -1,
            payoutHex: ALICE_PAYOUT,
            sats: 150n,
        })
        expect(out.treeOp).to.equal('member')
        expect(lastRoundOf(next, ALICE_INDEX)).to.equal(1n)
        expect(next.state.rosterRoot).to.equal(next.tree.root())
        // OUTH folded the reading into the log hash
        const expected = createHash('sha256')
            .update(Buffer.from('00'.repeat(32) + '6f140000', 'hex'))
            .digest('hex')
        expect(next.state.logHash).to.equal(expected)
        // the selector (0) stays for 'until', the first instruction of the next cycle
        expect(next.state.ds).to.equal('00000000')
    })

    it('refuses a second reading in the same round and pays it in the next', () => {
        let m = freshMachine()
        m = accept(
            m,
            envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, 5231n)),
            ALICE_INDEX
        ).next
        const again = runCycle(
            m.state,
            envAt(inRound(1, 200), reading(m, alice, ALICE_INDEX, 1, 5232n))
        )
        // refused by PAYLEAF itself: round 1 is not above lastRound 1
        expect(again.status).to.equal('verify_failed')
        // a round-1 signature relayed in round 2 does not match the tag
        const stale = runCycle(
            m.state,
            envAt(inRound(2), reading(m, alice, ALICE_INDEX, 1, 5232n))
        )
        expect(stale.status).to.equal('verify_failed')
        const env = envAt(inRound(2), reading(m, alice, ALICE_INDEX, 2, 5240n))
        expect(executedCount(m.state, env)).to.equal(36) // after a YIELD
        const { next, out } = accept(m, env, ALICE_INDEX)
        expect(out.payslot?.sats).to.equal(150n)
        expect(lastRoundOf(next, ALICE_INDEX)).to.equal(2n)
    })

    it('refuses selector 3 and other unknown selectors', () => {
        const m = freshMachine()
        for (const sel of [3n, 4n, 0xffffffffn]) {
            const r = runCycle(
                m.state,
                envAt(inRound(1), {
                    ...removeAt(m, ALICE_INDEX),
                    witness: [sel],
                })
            )
            expect(r.status, `selector ${sel}`).to.equal('verify_failed')
        }
    })

    it('refuses a reading before start', () => {
        const m = freshMachine()
        // round 0 is not a reading round; T0 is more than a period before start
        for (const t of [
            BigInt(START - 1),
            BigInt(START - PERIOD),
            T0 - 5000n,
        ]) {
            const r = runCycle(
                m.state,
                envAt(t, reading(m, alice, ALICE_INDEX, 1, 5231n))
            )
            expect(r.status, `t = ${t}`).to.equal('verify_failed')
        }
    })

    it('refuses a reading outside the range and accepts its bounds', () => {
        const m = freshMachine()
        for (const value of [3999n, 6001n, 0n, 0xffffffffn]) {
            const r = runCycle(
                m.state,
                envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, value))
            )
            expect(r.status, `reading ${value}`).to.equal('verify_failed')
        }
        for (const value of [4000n, 6000n]) {
            const r = runCycle(
                m.state,
                envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, value))
            )
            expect(r.status, `reading ${value}`).to.equal('ok')
        }
    })

    it('refuses a reading signed by another key', () => {
        const m = freshMachine()
        const r = runCycle(
            m.state,
            envAt(inRound(1), {
                ...reading(m, alice, ALICE_INDEX, 1, 5231n),
                sig: signMemberReading(bob, ID, readingTag(1), 5231n),
                attestKey: bob.pub,
            })
        )
        expect(r.status).to.equal('verify_failed')
    })

    it('admits a member in round 1 with lastRound 1: refused in round 1, paid in round 2', () => {
        let m = freshMachine()
        const env = envAt(inRound(1), admitBob(m))
        const admitted = accept(m, env, BOB_INDEX)
        expect(admitted.out.treeOp).to.equal('admit')
        m = admitted.next
        expect(m.state.rosterSeq).to.equal(1n)
        expect(lastRoundOf(m, BOB_INDEX)).to.equal(1n)
        const early = runCycle(
            m.state,
            envAt(inRound(1, 200), reading(m, bob, BOB_INDEX, 1, 5100n))
        )
        expect(early.status).to.equal('verify_failed')
        const { next, out } = accept(
            m,
            envAt(inRound(2), reading(m, bob, BOB_INDEX, 2, 5100n)),
            BOB_INDEX
        )
        expect(out.payslot).to.deep.equal({
            slot: -1,
            payoutHex: BOB_PAYOUT,
            sats: 150n,
        })
        expect(lastRoundOf(next, BOB_INDEX)).to.equal(2n)
    })

    it('admits a member before start with lastRound 0, payable in round 1', () => {
        let m = freshMachine()
        // T0 is more than a period before start: round 0, no wrap
        for (const t of [T0, BigInt(START - 1)]) {
            const fresh = freshMachine()
            accept(fresh, envAt(t, admitBob(fresh)), BOB_INDEX)
            expect(lastRoundOf(fresh, BOB_INDEX), `t = ${t}`).to.equal(0n)
        }
        m = accept(m, envAt(T0, admitBob(m)), BOB_INDEX).next
        const { next, out } = accept(
            m,
            envAt(inRound(1), reading(m, bob, BOB_INDEX, 1, 5100n)),
            BOB_INDEX
        )
        expect(out.payslot?.payoutHex).to.equal(BOB_PAYOUT)
        expect(lastRoundOf(next, BOB_INDEX)).to.equal(1n)
    })

    it("refuses a removed member's reading", () => {
        let m = freshMachine()
        // pay Alice once, so the removal also covers a leaf PAYLEAF changed
        m = accept(
            m,
            envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, 5231n)),
            ALICE_INDEX
        ).next
        const removed = accept(
            m,
            envAt(inRound(1, 200), removeAt(m, ALICE_INDEX)),
            ALICE_INDEX
        )
        expect(removed.out.treeOp).to.equal('remove')
        m = removed.next
        expect(m.tree.get(ALICE_INDEX)).to.equal(undefined)
        expect(m.state.rosterRoot).to.equal(m.tree.root())
        // the empty leaf proves nothing for MEMBER
        const r = runCycle(
            m.state,
            envAt(inRound(2), reading(m, alice, ALICE_INDEX, 2, 5240n))
        )
        expect(r.status).to.equal('verify_failed')
        // nor does the old leaf with its pre-removal proof
        const old = genesisTree()
        old.set(
            ALICE_INDEX,
            encodeLeafPre(keyHash(alice.pub), ALICE_PAYOUT, 1n)
        )
        const stale = runCycle(
            m.state,
            envAt(inRound(2), {
                ...reading(m, alice, ALICE_INDEX, 2, 5240n),
                tree: old.proof(ALICE_INDEX),
            })
        )
        expect(stale.status).to.equal('verify_failed')
    })

    it('halts without a witness at END, and not at END - 1', () => {
        let m = freshMachine()
        // a first cycle, so the halt below runs after a YIELD
        m = accept(
            m,
            envAt(inRound(1), reading(m, alice, ALICE_INDEX, 1, 5231n)),
            ALICE_INDEX
        ).next
        const before = runCycle(m.state, envAt(BigInt(END - 1)))
        expect(before.status).to.equal('need_witness') // IN ran: not ended
        const last = accept(
            m,
            envAt(
                BigInt(END - 1),
                reading(m, alice, ALICE_INDEX, OPTS.rounds, 5300n)
            ),
            ALICE_INDEX
        )
        expect(lastRoundOf(last.next, ALICE_INDEX)).to.equal(
            BigInt(OPTS.rounds)
        )
        for (const s of [m.state, last.next.state, freshMachine().state]) {
            const end = runCycle(s, envAt(BigInt(END)))
            expect(end.status).to.equal('halted')
            expect(end.witnessUsed).to.equal(0)
            expect(end.payslot).to.equal(undefined)
            expect(end.treeOp).to.equal('none')
        }
        // a relayed reading after END is ignored: the halt comes first
        const late = runCycle(
            m.state,
            envAt(BigInt(END + 500), reading(m, alice, ALICE_INDEX, 4, 5300n))
        )
        expect(late.status).to.equal('halted')
        expect(late.witnessUsed).to.equal(0)
    })

    it('pays in rounds 1 and 2 when start < period (wrapped round base)', () => {
        const opts: TreeConsortiumOptions = {
            start: 30,
            period: 60,
            rounds: 3,
            bountyPerReading: 150,
        }
        let m = freshMachine(opts)
        // before start: refused
        const early = runCycle(
            m.state,
            envAt(29n, reading(m, alice, ALICE_INDEX, 1, 7n))
        )
        expect(early.status).to.equal('verify_failed')
        const times: [bigint, number][] = [
            [30n, 1], // round 1 opens at start
            [90n, 2], // start + period: round 2
        ]
        for (const [t, round] of times) {
            expect(roundAt(opts, Number(t))).to.equal(round)
            const r = accept(
                m,
                envAt(t, reading(m, alice, ALICE_INDEX, round, 7n)),
                ALICE_INDEX
            )
            expect(r.out.payslot?.sats, `t = ${t}`).to.equal(150n)
            m = r.next
            expect(lastRoundOf(m, ALICE_INDEX)).to.equal(BigInt(round))
        }
        // the round-2 signature again in round 2 (t = 149) is refused
        const again = runCycle(
            m.state,
            envAt(149n, reading(m, alice, ALICE_INDEX, 2, 7n))
        )
        expect(again.status).to.equal('verify_failed')
        // END = 210 halts
        expect(runCycle(m.state, envAt(210n)).status).to.equal('halted')
    })

    it('halts and refunds when the bounty is unaffordable', () => {
        const opts = { ...OPTS, bountyPerReading: FUNDING }
        const tree = genesisTree()
        const machine = newMachine(
            treeConsortiumProgram(opts),
            ECON,
            T0,
            undefined,
            undefined,
            ID,
            { rosterRoot: tree.root(), sponsorKeyHash: keyHash(sponsor.pub) }
        )
        const sig = signMemberReading(alice, ID, readingTag(1), 5231n)
        const plan = planCycle(
            machine,
            BigInt(FUNDING),
            inRound(1),
            keeper,
            [0n, 5231n],
            sig,
            { attestKey: alice.pub },
            tree.proof(ALICE_INDEX)
        )
        expect(plan.halted).to.equal(true)
        expect(plan.payslot).to.equal(undefined)
        expect(plan.next).to.equal(undefined)
        expect(plan.remaining).to.equal(BigInt(FUNDING) - plan.reward)
        // an affordable bounty pays and keeps the machine alive
        const paid = planCycle(
            newMachine(
                treeConsortiumProgram(OPTS),
                ECON,
                T0,
                undefined,
                undefined,
                ID,
                {
                    rosterRoot: tree.root(),
                    sponsorKeyHash: keyHash(sponsor.pub),
                }
            ),
            BigInt(FUNDING),
            inRound(1),
            keeper,
            [0n, 5231n],
            sig,
            { attestKey: alice.pub },
            tree.proof(ALICE_INDEX)
        )
        expect(paid.halted).to.equal(false)
        expect(paid.payslot?.sats).to.equal(150n)
    })
})

describe('tree consortium: on chain', function () {
    this.timeout(600_000)

    before(loadMachineArtifact)

    it('runs admissions (round 0 and round 1), paid readings, a removal and the end halt', async () => {
        const tree = genesisTree()
        const m0 = newMachine(
            treeConsortiumProgram(OPTS),
            ECON,
            T0,
            undefined,
            undefined,
            undefined,
            { rosterRoot: tree.root(), sponsorKeyHash: keyHash(sponsor.pub) }
        )
        await m0.connect(getDefaultSigner())
        await m0.deploy(FUNDING)
        const id = m0.instanceId
        let machine = m0
        let value = BigInt(FUNDING)
        let seq = 0n

        /** Run one script-verified cycle and advance machine, value and mirror. */
        const step = async (
            lockTime: bigint,
            witness: bigint[] = [],
            sig?: ReturnType<typeof signMemberReading>,
            keys = {},
            index?: number
        ) => {
            const r = await cycle(
                machine,
                value,
                lockTime,
                witness,
                sig,
                keys,
                index === undefined ? undefined : tree.proof(index)
            )
            if (index !== undefined && r.plan.leafAfter !== undefined)
                tree.set(index, r.plan.leafAfter)
            if (r.next) machine = r.next
            value = r.plan.remaining
            return r
        }
        const admit = (lockTime: bigint) =>
            step(
                lockTime,
                [1n],
                signAdmission(
                    sponsor,
                    id,
                    BigInt(ADMIT_TAG),
                    seq++,
                    BigInt(BOB_INDEX),
                    bob.pub,
                    BOB_PAYOUT
                ),
                {
                    attestKey: sponsor.pub,
                    endorseKey: bob.pub,
                    payoutHex: BOB_PAYOUT,
                },
                BOB_INDEX
            )
        const read = (lockTime: bigint, round: number, v: bigint) =>
            step(
                lockTime,
                [0n, v],
                signMemberReading(alice, id, readingTag(round), v),
                { attestKey: alice.pub },
                ALICE_INDEX
            )
        const lastRound = (index: number) =>
            decodeLeafPre(tree.get(index) as string).lastRound

        // cycle 1 (first cycle, before start): the sponsor admits Bob in round 0
        const c1 = await admit(T0 + 60n)
        expect(c1.plan.treeOp).to.equal('admit')
        expect(lastRound(BOB_INDEX)).to.equal(0n)

        // cycle 2 (after a YIELD, round 1): Alice's reading, the longest path
        const c2 = await read(BigInt(START), 1, 5231n)
        expect(c2.plan.halted).to.equal(false)
        expect(c2.plan.payslot?.sats).to.equal(150n)
        expect(c2.plan.payslot?.payoutHex).to.equal(ALICE_PAYOUT)
        expect(lastRound(ALICE_INDEX)).to.equal(1n)

        // cycle 3: the sponsor removes Bob
        const c3 = await step(
            BigInt(START) + 60n,
            [2n],
            signRemoval(
                sponsor,
                id,
                BigInt(REMOVE_TAG),
                seq++,
                BigInt(BOB_INDEX),
                keyHash(bob.pub),
                BOB_PAYOUT
            ),
            { attestKey: sponsor.pub },
            BOB_INDEX
        )
        expect(c3.plan.treeOp).to.equal('remove')
        expect(tree.get(BOB_INDEX)).to.equal(undefined)
        expect(c3.plan.nextState.rosterRoot).to.equal(tree.root())

        // cycle 4: the sponsor admits Bob again, in round 1
        await admit(BigInt(START) + 120n)
        expect(lastRound(BOB_INDEX)).to.equal(1n)

        // cycle 5 (round 2): Alice's second reading, after the admin cycles
        const c5 = await read(BigInt(START + PERIOD), 2, 5240n)
        expect(c5.plan.payslot?.sats).to.equal(150n)
        expect(lastRound(ALICE_INDEX)).to.equal(2n)
        expect(c5.plan.nextState.rosterRoot).to.equal(tree.root())

        // cycle 6: at END the machine halts with no witness and refunds
        const c6 = await step(BigInt(END))
        expect(c6.plan.halted).to.equal(true)
        expect(c6.plan.witnessHex).to.equal('')
        expect(c6.next).to.equal(undefined)
    })
})
