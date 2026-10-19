/**
 * On-chain test helpers: deploy a K17+ machine for a program and drive it
 * one cycle at a time through the k17-vm keeper helpers, verifying every
 * cycle with the bundled Bitcoin script interpreter.
 */
import { bsv, toByteString } from 'scrypt-ts'
import { RabinSig } from 'scrypt-ts-lib'
import {
    K17Machine,
    CycleKeys,
    CyclePlan,
    CycleTree,
    NO_SIG,
    Roster,
    addrOf,
    bindCycleBuilder,
    newMachine,
    planCycle,
    rosterOf,
} from 'k17-vm'
import { getDefaultSigner, randomPrivateKey } from './txHelper'

/** Deployment time used by all tests (unix seconds). */
export const T0 = 1_760_000_000n
/** Satoshis locked at deployment. */
export const FUNDING = 200_000

export const [, , , keeper] = randomPrivateKey()
export const [, , , beneficiary] = randomPrivateKey()

/** Economics shared by the tests: 100 sats floor, +1 sat/s, 500 cap. */
export const ECON = {
    beneficiary: addrOf(beneficiary),
    rewardMin: 100n,
    slope: 1n,
    rewardMax: 500n,
}

/** Load the compiled contract artifact from the k17-vm package once. */
export async function loadMachineArtifact(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const artifact = require('k17-vm/artifacts/k17Machine.json')
    await K17Machine.loadArtifact(artifact)
}

/**
 * Deploy `prog` and return the live instance.
 * Input: program hex, fixed SIGVERIFY roster (default empty), optional
 * initial memory image (e.g. with the sponsor in memory roster slot 0).
 * Output: the deployed machine; its random `instanceId` is what ATTEST and
 * ENDORSE signatures must bind.
 */
export async function deploy(
    prog: string,
    roster: Roster = rosterOf(),
    initialMemHex?: string
): Promise<K17Machine> {
    const m = newMachine(prog, ECON, T0, roster, initialMemHex)
    await m.connect(getDefaultSigner())
    await m.deploy(FUNDING)
    return m
}

/** Result of one on-chain cycle. */
export interface CycleResult {
    plan: CyclePlan
    tx: bsv.Transaction
    next?: K17Machine
}

/**
 * Run one cycle at `lockTime`, verify the unlocking script with the
 * interpreter, and return the next instance (undefined once halted).
 * Input: instance, its UTXO value, nLockTime, witness cells, the cycle's
 * Rabin signature, the ATTEST/ENDORSE keys and payout (CycleKeys), and the
 * cycle's roster-tree proof (CycleTree, only for cycles that run MEMBER).
 * The plan's leafPre, proof and leafIndex go to `step` as its last three
 * arguments ('', '' and 0n when the cycle has no tree proof).
 * Output: the plan, the transaction and the next instance.
 */
export async function cycle(
    m: K17Machine,
    value: bigint,
    lockTime: bigint,
    witness: bigint[] = [],
    sig: RabinSig = NO_SIG,
    keys: CycleKeys = {},
    tree?: CycleTree
): Promise<CycleResult> {
    const plan = planCycle(m, value, lockTime, keeper, witness, sig, keys, tree)
    const opts = bindCycleBuilder(m, plan, keeper, lockTime)
    const { tx, atInputIndex } = await m.methods.step(
        addrOf(keeper),
        toByteString(plan.witnessHex),
        plan.sig.s,
        toByteString(plan.sig.padding),
        toByteString(plan.keyAHex),
        toByteString(plan.keyBHex),
        toByteString(plan.payoutHex),
        toByteString(plan.leafPre),
        toByteString(plan.proof),
        plan.leafIndex,
        opts
    )
    const verdict = tx.verifyInputScript(atInputIndex)
    if (!verdict.success) throw new Error(`script failed: ${verdict.error}`)
    return { plan, tx, next: plan.halted ? undefined : plan.next }
}
