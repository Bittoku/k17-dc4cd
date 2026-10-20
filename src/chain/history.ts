/**
 * History of a K17 machine on the chain.
 *
 * Each cycle spends the machine as input 0 and makes the next machine as
 * output 0. `walkHistory` starts at the current UTXO and follows input 0
 * back until it reaches the deployment transaction (the one whose input 0
 * does not spend a K17 machine). For every cycle it reports the
 * transaction id, nLockTime, the keeper reward, the slot payout and the
 * machine state after the cycle. The reward and payout come from a replay of
 * the cycle (see `replayCycle`), never from guessing at the outputs.
 */

import { bsv } from 'scrypt-ts'
import { RabinPubKey, RabinSig } from 'scrypt-ts-lib'
import {
    CELL,
    CycleTree,
    K17Machine,
    K17State,
    Op,
    PaySlot,
    SparseMerkleTree,
    StepEnv,
    TreeOp,
    BoundMember,
    decodeCell,
    decodeLeafPre,
    deadManDue,
    encodeLeafPre,
    keyHash,
    planCycle,
    pubKeyFromBytes,
    step,
    stateOf,
    whoOf,
} from 'k17-vm'
import { decodeCells } from '../cli/scenario'
import { DecodedInstance, DecodedMachine, decodeInstance } from './decode'

/** The one provider method that the walk needs; tests give an in-memory map. */
export interface TxSource {
    /** Get a transaction by its id (64 hex characters). */
    getTransaction(txid: string): Promise<bsv.Transaction>
}

/** The output that paid a roster slot. */
export interface PayoutOutput {
    vout: number
    satoshis: number
    /** The 20-byte public key hash that was paid, hex. */
    addressHex: string
    /** Roster slot that has this payout address, when one matches. */
    slot?: number
}

/** One cycle of a machine. */
export interface DecodedCycle {
    txid: string
    lockTime: number
    /** Satoshis paid to the keeper (0 when the reward output is absent); null when ambiguous. */
    reward: number | null
    /** The payout output, when the cycle paid a roster slot. */
    payout?: PayoutOutput
    /**
     * True when the cycle could not be replayed or the replay does not match
     * the outputs. Then `reward` is null and `payout` is not set; the outputs
     * are not guessed.
     */
    ambiguous: boolean
    /** True when output 0 is not a machine: the machine halted and refunded. */
    halted: boolean
    /** Machine state after the cycle, or null when halted. */
    state: DecodedMachine | null
    /**
     * The roster-tree operation that the replay found ('none' when the cycle
     * ran no tree instruction, and when the cycle is ambiguous).
     */
    treeOp: TreeOp
    /**
     * The tree arguments of the unlocking script (leafPre, proof, leafIndex);
     * undefined for a 7-chunk (v2) script or an unreadable one.
     */
    tree?: CycleTree
    /**
     * Roster tree root after the cycle (64 hex): from the next machine
     * output, or from the replayed state when the machine halted. For an
     * ambiguous halted cycle it is the root before the cycle (unknown change).
     */
    rosterRoot: string
    /** `rosterSeq` after the cycle (same sources as `rosterRoot`). */
    rosterSeq: bigint
    /**
     * The leaf preimage that the cycle wrote at `tree.leafIndex`: 120 hex
     * characters for an admission or a leaf payment, '' for a removal.
     * Undefined when the cycle left the tree unchanged or is ambiguous.
     * The replay checks that this leaf gives the replayed root.
     */
    leafAfter?: string
}

/** A transaction output reference. */
export interface Outpoint {
    txid: string
    vout: number
}

/**
 * Read an outpoint.
 * Input: `txid` or `txid:vout` (txid is 64 hex characters; vout defaults to 0).
 * Output: the outpoint. Throws an Error with a plain message when malformed.
 */
export function parseOutpoint(text: string): Outpoint {
    const match = /^([0-9a-fA-F]{64})(?::(\d+))?$/.exec(text)
    if (!match) throw new Error(`"${text}" is not a txid or txid:vout`)
    return {
        txid: match[1].toLowerCase(),
        vout: match[2] ? Number(match[2]) : 0,
    }
}

/**
 * Public key hash of a P2PKH script.
 * Input: script hex. Output: 40 hex characters, or undefined for other scripts.
 */
function p2pkhHash(scriptHex: string): string | undefined {
    return /^76a914([0-9a-f]{40})88ac$/.exec(scriptHex)?.[1]
}

/** The parts of a bsv script chunk that the replay reads. */
interface ScriptChunk {
    /** Pushed data, when the chunk is a data push. */
    buf?: Uint8Array
    /** Opcode of the chunk. */
    opcodenum: number
}

/**
 * Bytes of one script push, as hex.
 * Input: a script chunk. Output: its data; empty for OP_0; one byte for the
 * small-number opcodes OP_1NEGATE and OP_1..OP_16.
 */
function chunkHex(chunk: ScriptChunk): string {
    if (chunk.buf) return Buffer.from(chunk.buf).toString('hex')
    const op: number = chunk.opcodenum
    if (op === 0x4f) return '81'
    if (op >= 0x51 && op <= 0x60)
        return (op - 0x50).toString(16).padStart(2, '0')
    return ''
}

/**
 * Number of one script push (script number: little endian, sign in the top bit).
 * Input: a script chunk. Output: the value; 0 for OP_0.
 */
function chunkNumber(chunk: ScriptChunk): bigint {
    const bytes = Buffer.from(chunkHex(chunk), 'hex')
    if (bytes.length === 0) return 0n
    let magnitude = 0n
    for (let i = bytes.length - 1; i >= 0; i--) {
        const byte = i === bytes.length - 1 ? bytes[i] & 0x7f : bytes[i]
        magnitude = (magnitude << 8n) | BigInt(byte)
    }
    return bytes[bytes.length - 1] & 0x80 ? -magnitude : magnitude
}

/** What a replay of the cycle gives. */
interface Replay {
    reward: number
    payout?: PayoutOutput
    treeOp: TreeOp
    /** Root and seq after the cycle, from the replayed state. */
    rosterRoot: string
    rosterSeq: bigint
    leafAfter?: string
}

/** The arguments of `step` that an unlocking script carries. */
export interface UnlockingArguments {
    keeperHex: string
    witnessHex: string
    sig: RabinSig
    keyAHex: string
    keyBHex: string
    payoutHex: string
    /** The roster-tree proof (chunks 7 to 9); undefined for a 7-chunk (v2) script. */
    tree?: CycleTree
}

/**
 * Decode the unlocking script of input 0 of a cycle transaction.
 * The chunks are the arguments of `step` in order: keeper address, witness,
 * sigS, sigPad, keyA, keyB, payout, leafPre, proof, leafIndex. A script with
 * only 7 chunks comes from a v2 machine: it has no tree arguments, so `tree`
 * is undefined.
 * Input: the script chunks. Output: the arguments, or null when there are
 * fewer than 7 chunks or the keeper address is not 20 bytes.
 */
export function decodeUnlocking(
    chunks: ScriptChunk[]
): UnlockingArguments | null {
    if (chunks.length < 7) return null
    const keeperHex = chunkHex(chunks[0])
    if (keeperHex.length !== 40) return null
    const tree: CycleTree | undefined =
        chunks.length >= 10
            ? {
                  leafPre: chunkHex(chunks[7]),
                  proof: chunkHex(chunks[8]),
                  leafIndex: chunkNumber(chunks[9]),
              }
            : undefined
    return {
        keeperHex,
        witnessHex: chunkHex(chunks[1]),
        sig: { s: chunkNumber(chunks[2]), padding: chunkHex(chunks[3]) },
        keyAHex: chunkHex(chunks[4]),
        keyBHex: chunkHex(chunks[5]),
        payoutHex: chunkHex(chunks[6]),
        tree,
    }
}

/**
 * Find the ROUND that an ADMIT or PAYLEAF instruction used in a cycle.
 * The planner does not report it, so this runs the cycle again on the
 * reference VM, one instruction at a time, and reads the top of the data
 * stack just before the first ADMIT or PAYLEAF that succeeds. ROUND is the
 * top cell for both (ADMIT: TAG ROUND; PAYLEAF: N ROUND).
 * Input: the machine before the cycle, the step environment of the cycle
 * (same as the planner uses) and the cycle length K.
 * Output: the ROUND, or undefined when no such instruction succeeded.
 */
function recoverRound(
    previous: K17Machine,
    env: StepEnv,
    cycleLength: number
): bigint | undefined {
    if (deadManDue(env)) return undefined
    let state: K17State = stateOf(previous)
    let witnessIndex = 0
    let bounty = 0n
    let sigUsed = false
    let payslot: PaySlot | undefined
    let treeOp: TreeOp = 'none'
    let member: BoundMember | undefined
    for (let i = 0; i < cycleLength; i++) {
        const program = Buffer.from(state.prog, 'hex')
        const op = program[Number(state.pc)]
        const top =
            state.ds.length >= CELL * 2
                ? decodeCell(state.ds.slice(-CELL * 2))
                : undefined
        const result = step(
            state,
            env,
            witnessIndex,
            bounty,
            sigUsed,
            payslot,
            treeOp,
            member
        )
        if (result.status === 'need_witness' || result.status === 'fault')
            return undefined
        if (result.status === 'verify_failed') return undefined
        if ((op === Op.ADMIT || op === Op.PAYLEAF) && top !== undefined)
            return top
        state = result.state
        witnessIndex = result.witnessIndex
        bounty = result.bountyDue
        sigUsed = result.sigUsed
        payslot = result.payslot
        treeOp = result.treeOp
        member = result.member
        if (result.status !== 'ok') return undefined
    }
    return undefined
}

/**
 * Work out the tree change of a replayed cycle.
 * For an admission the new leaf is the key in `keyB`, the payout and the
 * ROUND; for a leaf payment it is the decoded leaf with the new ROUND; for
 * a removal it is the empty leaf. The leaf is only reported when it gives
 * exactly the root that the replay reached.
 * Input: the machine before the cycle, the tree operation, the replayed
 * root and seq after the cycle, the unlocking arguments, the step
 * environment, and the replayed `rosterSeq`.
 * Output: treeOp, rosterRoot, rosterSeq and leafAfter, or null when the
 * leaf that the arguments imply does not give the replayed root.
 */
function replayTree(
    machine: K17Machine,
    treeOp: TreeOp,
    replayedRoot: string,
    args: UnlockingArguments,
    env: StepEnv,
    replayedSeq: bigint
): Pick<Replay, 'treeOp' | 'rosterRoot' | 'rosterSeq' | 'leafAfter'> | null {
    const base = { treeOp, rosterRoot: replayedRoot, rosterSeq: replayedSeq }
    const tree = args.tree
    if (treeOp === 'none' || !tree) return base
    const rootWith = (leafPre: string): string =>
        SparseMerkleTree.rootAfter(leafPre, tree.proof, tree.leafIndex)
    if (treeOp === 'remove') {
        if (rootWith('') !== replayedRoot) return null
        return { ...base, leafAfter: '' }
    }
    const round = recoverRound(machine, env, K17Machine.K)
    if (treeOp === 'admit') {
        if (round === undefined || !args.keyBHex) return null
        const leafAfter = encodeLeafPre(
            keyHash(pubKeyFromBytes(args.keyBHex)),
            args.payoutHex,
            round,
            0n
        )
        if (rootWith(leafAfter) !== replayedRoot) return null
        return { ...base, leafAfter }
    }
    // 'member': the leaf changes only when PAYLEAF paid; then the root moved.
    if (replayedRoot === machine.rosterRoot) return base
    if (round === undefined) return null
    const old = decodeLeafPre(tree.leafPre)
    const leafAfter = encodeLeafPre(
        old.keyHashHex,
        old.payoutHex,
        round,
        old.flags
    )
    if (rootWith(leafAfter) !== replayedRoot) return null
    return { ...base, leafAfter }
}

/**
 * Replay a cycle with the reference code to find the keeper reward and the
 * payout, then check them against the real outputs.
 * The unlocking script of input 0 is read by `decodeUnlocking`. Output 0
 * is the state (or the refund), then the reward when above 0, then the
 * PAYSLOT or PAYLEAF payout when the cycle made one.
 * Input: the cycle transaction, the decoded machine that it spent, and the
 * value of that machine output.
 * Output: the reward and payout, or null when the unlocking script cannot be
 * read, the replay throws (a tree cycle without tree chunks included), or its
 * amounts differ from the outputs.
 */
function replayCycle(
    tx: bsv.Transaction,
    previous: DecodedInstance,
    previousValue: number
): Replay | null {
    try {
        const args = decodeUnlocking(tx.inputs[0].script.chunks)
        if (!args || !previous.instance) return null
        const machine = previous.instance as K17Machine
        const keeperAddress = bsv.Address.fromPublicKeyHash(
            Buffer.from(args.keeperHex, 'hex')
        )
        const witness = decodeCells(args.witnessHex)
        const attestKey = args.keyAHex
            ? pubKeyFromBytes(args.keyAHex)
            : undefined
        const endorseKey = args.keyBHex
            ? pubKeyFromBytes(args.keyBHex)
            : undefined
        const plan = planCycle(
            machine,
            BigInt(previousValue),
            BigInt(tx.nLockTime),
            keeperAddress,
            witness,
            args.sig,
            {
                attestKey,
                endorseKey,
                payoutHex: args.payoutHex || undefined,
            },
            args.tree
        )
        const expected: number[] = []
        if (plan.reward > 0n) expected.push(Number(plan.reward))
        if (plan.payslot) expected.push(Number(plan.payslot.sats))
        const rest = tx.outputs.slice(1)
        if (tx.outputs[0].satoshis !== Number(plan.remaining)) return null
        if (rest.length < expected.length) return null
        if (expected.some((sats, i) => rest[i].satoshis !== sats)) return null
        const reward = plan.reward > 0n ? Number(plan.reward) : 0
        const treeFields = replayTree(
            machine,
            plan.treeOp,
            plan.nextState.rosterRoot,
            args,
            {
                lockTime: BigInt(tx.nLockTime),
                who: whoOf(args.keeperHex),
                witness,
                roster: (machine.roster as unknown as RabinPubKey[]).slice(),
                sig: args.sig.s === 0n ? undefined : args.sig,
                attestKey,
                endorseKey,
                payout: args.payoutHex || undefined,
                value: BigInt(previousValue),
                instanceId: machine.instanceId,
                tree: args.tree && {
                    leafPre: args.tree.leafPre.toLowerCase(),
                    proof: args.tree.proof.toLowerCase(),
                    leafIndex: args.tree.leafIndex,
                },
                deadMan: machine.deadMan,
                lastTime: machine.lastTime,
            },
            plan.nextState.rosterSeq
        )
        if (!treeFields) return null
        if (!plan.payslot) return { reward, ...treeFields }
        const index = plan.reward > 0n ? 1 : 0
        const hash = p2pkhHash(rest[index].script.toHex())
        if (hash !== plan.payslot.payoutHex) return null
        return {
            reward,
            payout: {
                vout: index + 1,
                satoshis: rest[index].satoshis,
                addressHex: hash,
                slot: plan.payslot.slot,
            },
            ...treeFields,
        }
    } catch {
        return null
    }
}

/**
 * Walk the history of a machine.
 * Input: a transaction source and the machine's outpoint (`txid` or
 * `txid:vout`). Output: the cycles from the oldest to the newest; empty when
 * the outpoint is the deployment output. Each transaction is fetched once.
 * Throws when a transaction cannot be fetched.
 */
export async function walkHistory(
    source: TxSource,
    outpoint: string
): Promise<DecodedCycle[]> {
    const cache = new Map<string, bsv.Transaction>()
    const fetchTx = async (txid: string): Promise<bsv.Transaction> => {
        let tx = cache.get(txid)
        if (!tx) {
            tx = await source.getTransaction(txid)
            cache.set(txid, tx)
        }
        return tx
    }
    const decodeCache = new Map<string, DecodedInstance>()
    const decode = (scriptHex: string): DecodedInstance => {
        let decoded = decodeCache.get(scriptHex)
        if (!decoded) {
            decoded = decodeInstance(scriptHex)
            decodeCache.set(scriptHex, decoded)
        }
        return decoded
    }
    const cycles: DecodedCycle[] = []
    let txid = parseOutpoint(outpoint).txid
    for (;;) {
        const tx = await fetchTx(txid)
        if (tx.inputs.length === 0) break
        const previousTxid = tx.inputs[0].prevTxId.toString('hex')
        const previousOut = (await fetchTx(previousTxid)).outputs[
            tx.inputs[0].outputIndex
        ]
        const previous = previousOut && decode(previousOut.script.toHex())
        if (!previous || !previous.machine) break // this transaction is the deployment
        const after = decode(tx.outputs[0].script.toHex())
        const replay = replayCycle(tx, previous, previousOut.satoshis)
        const unlocking = decodeUnlocking(tx.inputs[0].script.chunks)
        cycles.push({
            txid: tx.id,
            lockTime: tx.nLockTime,
            reward: replay ? replay.reward : null,
            payout: replay?.payout,
            ambiguous: replay === null,
            halted: !after.machine,
            state: after.machine,
            treeOp: replay ? replay.treeOp : 'none',
            tree: unlocking?.tree,
            rosterRoot: after.instance
                ? after.instance.rosterRoot
                : replay
                ? replay.rosterRoot
                : (previous.instance as K17Machine).rosterRoot,
            rosterSeq: after.instance
                ? after.instance.rosterSeq
                : replay
                ? replay.rosterSeq
                : (previous.instance as K17Machine).rosterSeq,
            leafAfter: replay?.leafAfter,
        })
        txid = previousTxid
    }
    return cycles.reverse()
}
