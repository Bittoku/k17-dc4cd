/**
 * Roster mirror for tree-mode K17 machines.
 *
 * A v3 machine keeps only the root of a sparse Merkle tree (depth 16) and a
 * sequence number for its member roster. A keeper, sponsor or gateway that
 * must build a proof needs the whole tree. `RosterMirror` is that off-chain
 * copy: it starts from the genesis roster that the sponsor published, and
 * follows the machine by applying each replayed cycle from `walkHistory`.
 * After every cycle it checks its root against the machine's root, so a
 * mirror that drifts from the chain throws instead of giving bad proofs.
 *
 * Exports: `GenesisRoster` (published starting roster), `RosterMirror` (the
 * mirror) and `replayRoster` (build a mirror from genesis and the history).
 */

import { SparseMerkleTree, encodeLeafPre } from 'k17-vm'
import { DecodedCycle } from './history'

/** Number of leaves in the roster tree (depth 16). */
const LEAF_COUNT = 65536

/**
 * The roster that a sponsor publishes with a deployment.
 * `rosterRoot` is the root the machine was deployed with; the members must
 * rebuild exactly that root.
 */
export interface GenesisRoster {
    k17: 'roster'
    /** Instance id of the machine (64 hex). */
    instanceId: string
    /** Roster tree root at deployment (64 hex). */
    rosterRoot: string
    members: {
        /** Leaf position, 0 to 65535. */
        index: number
        /** sha256 of the member's Rabin public key (64 hex). */
        keyHash: string
        /** The member's 20-byte payout address (40 hex). */
        payout: string
        /** Last round the member was paid in (integer, 0 or more). */
        lastRound: number
    }[]
}

/**
 * Off-chain copy of the roster tree of one machine.
 * Build with `fromGenesis`; move it forward with `apply`, one cycle at a
 * time, oldest first.
 */
export class RosterMirror {
    private readonly tree = new SparseMerkleTree()
    /** Leaf index to key hash, for every occupied leaf. */
    private readonly keyAt = new Map<number, string>()
    /** Key hash to leaf index. */
    private readonly indexByKey = new Map<string, number>()
    private rosterSeq = 0n

    private constructor() {
        // use RosterMirror.fromGenesis
    }

    /**
     * Build a mirror from the genesis roster.
     * Input: the genesis roster. Output: the mirror at seq 0.
     * Throws when a member field is malformed, two members share an index or
     * a key hash, or the rebuilt root differs from `g.rosterRoot`.
     */
    static fromGenesis(g: GenesisRoster): RosterMirror {
        if (g.k17 !== 'roster') throw new Error('not a k17 roster file')
        if (!/^[0-9a-fA-F]{64}$/.test(g.rosterRoot)) {
            throw new Error('rosterRoot must be 64 hex characters')
        }
        if (!/^[0-9a-fA-F]{64}$/.test(g.instanceId)) {
            throw new Error('instanceId must be 64 hex characters')
        }
        const mirror = RosterMirror.fromMembers(g.members)
        if (mirror.tree.root() !== g.rosterRoot.toLowerCase()) {
            throw new Error(
                `genesis members give root ${mirror.tree.root()}, not the deployed ${
                    g.rosterRoot
                }`
            )
        }
        return mirror
    }

    /**
     * Build a mirror from a member list alone, with no root to compare.
     * A sponsor uses it to find the root that a machine must be deployed
     * with; `fromGenesis` uses it and then checks the root.
     * Input: the members, in the form of `GenesisRoster.members`.
     * Output: the mirror at seq 0. Throws when a member field is malformed
     * or two members share an index or a key hash.
     */
    static fromMembers(members: GenesisRoster['members']): RosterMirror {
        if (!Array.isArray(members)) {
            throw new Error('members must be an array')
        }
        const mirror = new RosterMirror()
        for (const member of members) {
            if (
                typeof member.index !== 'number' ||
                !Number.isInteger(member.index) ||
                member.index < 0 ||
                member.index >= LEAF_COUNT
            ) {
                throw new Error(`member index ${member.index} is not 0..65535`)
            }
            if (!/^[0-9a-fA-F]{64}$/.test(member.keyHash)) {
                throw new Error(
                    `member ${member.index}: keyHash must be 64 hex characters`
                )
            }
            if (!/^[0-9a-fA-F]{40}$/.test(member.payout)) {
                throw new Error(
                    `member ${member.index}: payout must be 40 hex characters`
                )
            }
            if (
                !Number.isSafeInteger(member.lastRound) ||
                member.lastRound < 0 ||
                member.lastRound > 0xffffffff
            ) {
                throw new Error(
                    `member ${member.index}: lastRound must be an integer from 0 to 4294967295`
                )
            }
            const key = member.keyHash.toLowerCase()
            if (mirror.keyAt.has(member.index)) {
                throw new Error(`duplicate member index ${member.index}`)
            }
            if (mirror.indexByKey.has(key)) {
                throw new Error(
                    `duplicate key hash ${key} (index ${member.index})`
                )
            }
            mirror.tree.set(
                member.index,
                encodeLeafPre(
                    key,
                    member.payout.toLowerCase(),
                    BigInt(member.lastRound),
                    0n
                )
            )
            mirror.keyAt.set(member.index, key)
            mirror.indexByKey.set(key, member.index)
        }
        return mirror
    }

    /** Output: the current tree root (64 hex). */
    root(): string {
        return this.tree.root()
    }

    /** Output: the current `rosterSeq` (admissions and removals so far). */
    seq(): bigint {
        return this.rosterSeq
    }

    /**
     * Input: a member key hash (64 hex, any case).
     * Output: the member's leaf index, or undefined when it is not a member.
     */
    indexOf(keyHashHex: string): number | undefined {
        return this.indexByKey.get(keyHashHex.toLowerCase())
    }

    /** Input: a key hash (64 hex). Output: true when the key is a member. */
    hasKey(keyHashHex: string): boolean {
        return this.indexByKey.has(keyHashHex.toLowerCase())
    }

    /**
     * Output: the lowest leaf index with no member (for the next admission).
     * Throws when all 65536 leaves are taken.
     */
    nextFreeIndex(): number {
        for (let index = 0; index < LEAF_COUNT; index++) {
            if (!this.keyAt.has(index)) return index
        }
        throw new Error('the roster tree is full')
    }

    /**
     * Proof for one leaf, in the form that `planCycle` takes as its tree
     * argument. Input: leaf index. Output: the leaf preimage ('' when
     * empty), the 16-sibling proof (1024 hex) and the index.
     */
    proofFor(index: number): {
        leafPre: string
        proof: string
        leafIndex: bigint
    } {
        return this.tree.proof(index)
    }

    /**
     * Move the mirror forward by one cycle of the machine.
     * The new leaf comes from the replay (`cycle.leafAfter`), not from the
     * raw arguments alone: an admission writes the new member, a payment
     * writes the member's new lastRound, a removal clears the leaf. The
     * mirror then checks its root and seq against the cycle's state after
     * the cycle. For a halted cycle the post-cycle root comes from the
     * replay itself, so that check shows self-consistency only. On any mismatch it restores its old state and throws.
     * Input: a decoded cycle from `walkHistory`, oldest first. Output: none.
     * Throws for an ambiguous cycle, a tree cycle without tree arguments, an
     * admission into an occupied leaf, a removal of an empty leaf, or a root
     * or seq mismatch.
     */
    apply(cycle: DecodedCycle): void {
        if (cycle.ambiguous) {
            throw new Error(
                `cycle ${cycle.txid} is ambiguous: it cannot be replayed, so the roster cannot follow it`
            )
        }
        const index = cycle.tree ? Number(cycle.tree.leafIndex) : undefined
        const oldLeaf = index === undefined ? '' : this.tree.get(index) ?? ''
        const oldSeq = this.rosterSeq
        // A MEMBER cycle without a payment leaves the tree as it was.
        const changesTree =
            cycle.treeOp === 'admit' ||
            cycle.treeOp === 'remove' ||
            (cycle.treeOp === 'member' && cycle.leafAfter !== undefined)
        if (changesTree) {
            if (index === undefined || cycle.leafAfter === undefined) {
                throw new Error(
                    `cycle ${cycle.txid}: ${cycle.treeOp} without a replayed leaf`
                )
            }
            if (cycle.treeOp === 'admit' && oldLeaf !== '') {
                throw new Error(
                    `cycle ${cycle.txid}: admission into occupied leaf ${index}`
                )
            }
            if (cycle.treeOp !== 'admit' && oldLeaf === '') {
                throw new Error(
                    `cycle ${cycle.txid}: ${cycle.treeOp} on empty leaf ${index}`
                )
            }
            this.write(index, cycle.leafAfter)
            if (cycle.treeOp !== 'member') this.rosterSeq += 1n
        }
        if (
            this.tree.root() !== cycle.rosterRoot ||
            this.rosterSeq !== cycle.rosterSeq
        ) {
            const got = `${this.tree.root()} seq ${this.rosterSeq}`
            if (index !== undefined) this.write(index, oldLeaf)
            this.rosterSeq = oldSeq
            throw new Error(
                `cycle ${cycle.txid}: roster mirror gives root ${got}, the machine has ${cycle.rosterRoot} seq ${cycle.rosterSeq}`
            )
        }
    }

    /** Set one leaf ('' clears it) and keep the key indexes in step. */
    private write(index: number, leafPre: string): void {
        const oldKey = this.keyAt.get(index)
        if (oldKey !== undefined) {
            this.keyAt.delete(index)
            // a key at two leaves keeps its other mapping
            if (this.indexByKey.get(oldKey) === index) {
                this.indexByKey.delete(oldKey)
            }
        }
        this.tree.set(index, leafPre)
        if (leafPre !== '') {
            const key = leafPre.slice(0, 64)
            this.keyAt.set(index, key)
            this.indexByKey.set(key, index)
        }
    }
}

/**
 * Build the roster mirror of a machine from its genesis and its history.
 * Input: the genesis roster and the decoded cycles, oldest first (the
 * output of `walkHistory`). Output: the mirror after the last cycle.
 * Throws when the genesis does not rebuild its root, or when a replayed
 * root differs from a cycle's state after the cycle.
 */
export function replayRoster(
    g: GenesisRoster,
    cycles: DecodedCycle[]
): RosterMirror {
    const mirror = RosterMirror.fromGenesis(g)
    for (const cycle of cycles) mirror.apply(cycle)
    return mirror
}
