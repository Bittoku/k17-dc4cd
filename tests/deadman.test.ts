/**
 * Dead-man and MIN_STEP tests on the harness (v3.1): every cycle is built
 * with the k17-vm keeper helpers and checked with the script interpreter
 * (`verifyInputScript`). No test uses the network.
 */
import { expect, use } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {
    DEAD_MAN_FLOOR,
    K17Machine,
    assemble,
    heartbeatProgram,
    newMachine,
} from 'k17-vm'
import { getDefaultSigner } from './utils/txHelper'
import { ECON, FUNDING, T0, cycle, loadMachineArtifact } from './utils/chain'
use(chaiAsPromised)

/** Deploy `prog` with a dead-man interval (seconds) on the harness chain. */
async function deployWithDeadMan(
    prog: string,
    deadMan: bigint
): Promise<K17Machine> {
    const m = newMachine(prog, { ...ECON, deadMan }, T0)
    await m.connect(getDefaultSigner())
    await m.deploy(FUNDING)
    return m
}

describe('dead-man and MIN_STEP: on chain', function () {
    this.timeout(600_000)

    before(loadMachineArtifact)

    it('a cycle past the dead-man halts into the refund without a witness', async () => {
        // IN blocks the program: only the dead-man can end it.
        const m = await deployWithDeadMan(
            assemble(['IN', 'OUT', 'HALT']),
            DEAD_MAN_FLOOR
        )
        const due = T0 + DEAD_MAN_FLOOR
        await expect(cycle(m, BigInt(FUNDING), due - 1n)).to.be.rejectedWith(
            /needs a witness/
        )
        // cycle() verifies the unlocking script with the interpreter.
        const r = await cycle(m, BigInt(FUNDING), due)
        expect(r.plan.deadManHalt).to.equal(true)
        expect(r.plan.halted).to.equal(true)
        expect(r.next).to.equal(undefined)
        // Reward for the whole elapsed time, capped; the rest is refunded.
        expect(r.plan.reward).to.equal(ECON.rewardMax)
        expect(r.plan.remaining).to.equal(BigInt(FUNDING) - ECON.rewardMax)
    })

    it('a live cycle needs lockTime >= lastTime + 60; a halting cycle does not', async () => {
        const m = await deployWithDeadMan(heartbeatProgram(), 0n)
        await expect(cycle(m, BigInt(FUNDING), T0 + 59n)).to.be.rejectedWith(
            /MIN_STEP/
        )
        const r = await cycle(m, BigInt(FUNDING), T0 + 60n)
        expect(r.plan.deadManHalt).to.equal(false)
        expect(r.plan.halted).to.equal(false)
        // A machine that halts at once is exempt from MIN_STEP.
        const halting = await deployWithDeadMan(assemble(['HALT']), 0n)
        const h = await cycle(halting, BigInt(FUNDING), T0)
        expect(h.plan.halted).to.equal(true)
        expect(h.plan.deadManHalt).to.equal(false)
    })
})
