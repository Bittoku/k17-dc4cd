/**
 * Aggregation relay (DC4CD §5.1 port): reference-VM and on-chain tests.
 *
 * Three roster members attest one temperature reading each. Every cycle is
 * planned with the reference VM and, in the on-chain block, executed by the
 * sCrypt contract and verified with the script interpreter, so a passing
 * on-chain run is also a differential test of the K17+ instructions.
 */
import { expect, use } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {
    K17Machine,
    StepEnv,
    initialState,
    newAttester,
    outputLog,
    rosterOf,
    signReading,
    stepK,
} from 'k17-vm'
import { relayProgram, relaySource, relayTag, RelayOptions } from '../src'
import { compile } from '../src'
import { T0, FUNDING, cycle, deploy, loadMachineArtifact } from './utils/chain'
use(chaiAsPromised)

const OPTS: RelayOptions = {
    hops: 3,
    epoch: 1000,
    deadline: Number(T0) + 7 * 86400,
    bountyPerHop: 150,
}
const READINGS = [2231n, 2198n, 2305n] // tenths of a degree
const SUM = READINGS.reduce((a, b) => a + b, 0n)

// Deterministic attesters; key generation is slow, so it happens once.
const attesters = [1, 2, 3].map((i) => newAttester(Buffer.alloc(32, i)))
const roster = rosterOf(attesters.map((a) => a.pub))

/** Count the instructions in one hop of the compiled program. */
function hopInstructionCount(): number {
    const tokens = compile(relaySource(OPTS)).tokens
    const yields: number[] = []
    let count = 0
    for (const t of tokens) {
        if (typeof t === 'string' && t.endsWith(':')) continue
        if (typeof t === 'number') continue
        count++
        if (t === 'YIELD') yields.push(count)
    }
    // yields[0] is the deployment cycle; the hop is between yields 0 and 1.
    return yields[1] - yields[0]
}

describe('relay: reference VM', function () {
    this.timeout(120_000)

    it('each hop fits in one 40-instruction cycle', () => {
        expect(hopInstructionCount()).to.be.at.most(K17Machine.K)
    })

    it('aggregates three attested readings and emits [hops, sum, avg, min, max]', () => {
        const prog = relayProgram(OPTS)
        let s = initialState(prog)
        const env = (
            lockTime: bigint,
            witness: bigint[] = [],
            sig?: StepEnv['sig']
        ): StepEnv => ({
            lockTime,
            who: 0n,
            witness,
            roster: attesters.map((a) => a.pub),
            sig,
        })
        // deployment cycle
        let r = stepK(s, env(T0), K17Machine.K)
        expect(r.status).to.equal('ok')
        s = r.state
        // three hops, each relayed with that hop's attestation
        for (let k = 0; k < 3; k++) {
            const sig = signReading(
                attesters[k],
                relayTag(OPTS, k),
                READINGS[k]
            )
            r = stepK(
                s,
                env(T0 + BigInt(k + 1), [READINGS[k]], sig),
                K17Machine.K
            )
            expect(r.status).to.equal('ok')
            expect(r.bountyDue).to.equal(BigInt(OPTS.bountyPerHop))
            s = r.state
        }
        // retrieval cycle
        r = stepK(s, env(T0 + 10n), K17Machine.K)
        expect(r.status).to.equal('halted')
        expect(outputLog(r.state)).to.deep.equal([
            3n,
            SUM,
            SUM / 3n,
            2198n,
            2305n,
        ])
    })

    it("rejects a reading relayed with another hop's signature or no signature", () => {
        const prog = relayProgram(OPTS)
        const base = stepK(initialState(prog), T0, K17Machine.K).state
        const rosterKeys = attesters.map((a) => a.pub)
        // hop 1's key signing hop 0's tag
        const wrong = stepK(
            base,
            {
                lockTime: T0 + 1n,
                who: 0n,
                witness: [READINGS[0]],
                roster: rosterKeys,
                sig: signReading(attesters[1], relayTag(OPTS, 0), READINGS[0]),
            },
            K17Machine.K
        )
        expect(wrong.status).to.equal('verify_failed')
        // a correct hop-0 signature replayed with a different reading
        const altered = stepK(
            base,
            {
                lockTime: T0 + 1n,
                who: 0n,
                witness: [READINGS[0] + 1n],
                roster: rosterKeys,
                sig: signReading(attesters[0], relayTag(OPTS, 0), READINGS[0]),
            },
            K17Machine.K
        )
        expect(altered.status).to.equal('verify_failed')
        // plain keeper with no attestation
        const none = stepK(
            base,
            {
                lockTime: T0 + 1n,
                who: 0n,
                witness: [READINGS[0]],
                roster: rosterKeys,
            },
            K17Machine.K
        )
        expect(none.status).to.equal('need_witness')
    })

    it('past the deadline any keeper can halt it with nothing attested', () => {
        const prog = relayProgram(OPTS)
        const base = stepK(initialState(prog), T0, K17Machine.K).state
        const r = stepK(base, BigInt(OPTS.deadline), K17Machine.K)
        expect(r.status).to.equal('halted')
        expect(outputLog(r.state)).to.deep.equal([])
    })
})

describe('relay: on chain', function () {
    this.timeout(600_000)

    before(loadMachineArtifact)

    it('three attested hops, every cycle script-verified, retrieval in the output log', async () => {
        const m = await deploy(relayProgram(OPTS), roster)
        let value = BigInt(FUNDING)
        let r = await cycle(m, value, T0 + 1n)
        value = r.plan.remaining
        let paidBounty = 0n
        for (let k = 0; k < 3; k++) {
            const sig = signReading(
                attesters[k],
                relayTag(OPTS, k),
                READINGS[k]
            )
            r = await cycle(
                r.next as K17Machine,
                value,
                T0 + BigInt(k + 2),
                [READINGS[k]],
                sig
            )
            value = r.plan.remaining
            paidBounty += r.plan.bounty
        }
        expect(paidBounty).to.equal(3n * BigInt(OPTS.bountyPerHop))
        r = await cycle(r.next as K17Machine, value, T0 + 10n)
        expect(r.plan.halted).to.be.true
        expect(outputLog(r.plan.nextState)).to.deep.equal([
            3n,
            SUM,
            SUM / 3n,
            2198n,
            2305n,
        ])
        console.log(`      hop tx size: ${r.tx.toBuffer().length} bytes`)
    })

    it('a hop attested by the wrong roster member is refused', async () => {
        const m = await deploy(relayProgram(OPTS), roster)
        const r = await cycle(m, BigInt(FUNDING), T0 + 1n)
        await expect(
            cycle(
                r.next as K17Machine,
                r.plan.remaining,
                T0 + 2n,
                [READINGS[0]],
                signReading(attesters[2], relayTag(OPTS, 0), READINGS[0])
            )
        ).to.be.rejectedWith(/SIGVERIFY/)
    })
})
