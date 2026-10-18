/**
 * Fuzzy fire detection (DC4CD §5.2 port): reference-VM and on-chain tests.
 */
import { expect } from 'chai'
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
import {
    fuzzyProgram,
    fuzzyTag,
    packOpinion,
    relayTag,
    FuzzyOptions,
} from '../src'
import { T0, FUNDING, cycle, deploy, loadMachineArtifact } from './utils/chain'

const OPTS: FuzzyOptions = {
    neighbours: 2,
    epoch: 2000,
    threshold: 500,
    alarmBounty: 1000,
    deadline: Number(T0) + 7 * 86400,
}
// slot 0 local, slots 1..2 neighbours: (temp.high, smoke.high) in 0..1000
const OPINIONS = [
    packOpinion(800, 900), // local  -> 800
    packOpinion(700, 600), // n1     -> 600
    packOpinion(900, 1000), // n2    -> 900
]
// neighbourhood average 750, fire.high = min(800, 750) = 750 >= 500 -> alarm
const EXPECTED = [750n, 1n]

const attesters = [4, 5, 6].map((i) => newAttester(Buffer.alloc(32, i)))
const roster = rosterOf(attesters.map((a) => a.pub))

describe('fuzzy: reference VM', function () {
    this.timeout(120_000)

    it('combines local and neighbour opinions and raises the alarm', () => {
        let s = initialState(fuzzyProgram(OPTS))
        const keys = attesters.map((a) => a.pub)
        let r = stepK(s, T0, K17Machine.K)
        s = r.state
        for (let k = 0; k < 3; k++) {
            const env: StepEnv = {
                lockTime: T0 + BigInt(k + 1),
                who: 0n,
                witness: [OPINIONS[k]],
                roster: keys,
                sig: signReading(attesters[k], fuzzyTag(OPTS, k), OPINIONS[k]),
            }
            r = stepK(s, env, K17Machine.K)
            expect(r.status).to.equal('ok')
            s = r.state
        }
        r = stepK(s, T0 + 9n, K17Machine.K)
        expect(r.status).to.equal('halted')
        expect(outputLog(r.state)).to.deep.equal(EXPECTED)
        expect(r.bountyDue).to.equal(BigInt(OPTS.alarmBounty))
    })

    it('past the deadline any keeper can halt it and nothing is logged', () => {
        const base = stepK(
            initialState(fuzzyProgram(OPTS)),
            T0,
            K17Machine.K
        ).state
        const r = stepK(base, BigInt(OPTS.deadline), K17Machine.K)
        expect(r.status).to.equal('halted')
        expect(outputLog(r.state)).to.deep.equal([])
    })

    it('a relay attestation with the same epoch and slot is not a fuzzy attestation', () => {
        const relayOpts = {
            hops: 3,
            epoch: OPTS.epoch,
            deadline: OPTS.deadline,
            bountyPerHop: 0,
        }
        expect(relayTag(relayOpts, 1)).to.not.equal(fuzzyTag(OPTS, 1))
        const base = stepK(
            initialState(fuzzyProgram(OPTS)),
            T0,
            K17Machine.K
        ).state
        const r = stepK(
            base,
            {
                lockTime: T0 + 1n,
                who: 0n,
                witness: [OPINIONS[0]],
                roster: attesters.map((a) => a.pub),
                sig: signReading(
                    attesters[0],
                    relayTag(relayOpts, 0),
                    OPINIONS[0]
                ),
            },
            K17Machine.K
        )
        expect(r.status).to.equal('verify_failed')
    })

    it('stays quiet below the threshold and pays no bounty', () => {
        const quiet = { ...OPTS, threshold: 900 }
        let s = initialState(fuzzyProgram(quiet))
        const keys = attesters.map((a) => a.pub)
        s = stepK(s, T0, K17Machine.K).state
        for (let k = 0; k < 3; k++) {
            s = stepK(
                s,
                {
                    lockTime: T0 + 1n,
                    who: 0n,
                    witness: [OPINIONS[k]],
                    roster: keys,
                    sig: signReading(
                        attesters[k],
                        fuzzyTag(quiet, k),
                        OPINIONS[k]
                    ),
                },
                K17Machine.K
            ).state
        }
        const r = stepK(s, T0 + 9n, K17Machine.K)
        expect(outputLog(r.state)).to.deep.equal([750n, 0n])
        expect(r.bountyDue).to.equal(0n)
    })
})

describe('fuzzy: on chain', function () {
    this.timeout(600_000)

    before(loadMachineArtifact)

    it('attested opinions, script-verified, alarm bounty released', async () => {
        const m = await deploy(fuzzyProgram(OPTS), roster)
        let value = BigInt(FUNDING)
        let r = await cycle(m, value, T0 + 1n)
        value = r.plan.remaining
        for (let k = 0; k < 3; k++) {
            r = await cycle(
                r.next as K17Machine,
                value,
                T0 + BigInt(k + 2),
                [OPINIONS[k]],
                signReading(attesters[k], fuzzyTag(OPTS, k), OPINIONS[k])
            )
            value = r.plan.remaining
        }
        r = await cycle(r.next as K17Machine, value, T0 + 9n)
        expect(r.plan.halted).to.be.true
        expect(outputLog(r.plan.nextState)).to.deep.equal(EXPECTED)
        expect(r.plan.bounty).to.equal(BigInt(OPTS.alarmBounty))
    })
})
