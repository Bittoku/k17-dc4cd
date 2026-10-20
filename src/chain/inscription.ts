/**
 * 1Sat ordinal inscriptions for the genesis roster.
 *
 * A sponsor of a tree-mode machine publishes the genesis member list as a
 * 1Sat inscription: one output of exactly 1 satoshi whose script is the
 * ordinal envelope `OP_FALSE OP_IF "ord" OP_1 <content type> OP_0 <body>
 * OP_ENDIF` followed by the owner's P2PKH lock. Anyone who knows the outpoint
 * can read the list and rebuild the roster (`RosterMirror.fromGenesis`).
 * No 1Sat library is a dependency; the script is built with bsv's Script.
 *
 * Exports: `GENESIS_CONTENT_TYPE`, `inscriptionScript`, `parseInscription`,
 * `readMembersFile` (read the sponsor's member list), `genesisRosterOf`
 * (build the published list) and `broadcastInscription` (fund, sign and
 * send the inscription transaction from a wallet).
 */

import { readFileSync } from 'fs'
import { Signer, bsv } from 'scrypt-ts'
import { GenesisRoster, RosterMirror } from './roster'

/** Content type of the genesis roster inscription. */
export const GENESIS_CONTENT_TYPE = 'application/json'

/** Satoshis of the inscription output: a 1Sat ordinal carries exactly one. */
const INSCRIPTION_SATS = 1

/** Marker push of the ordinal envelope. */
const ORD_MARKER = Buffer.from('ord')

/**
 * Build the locking script of a 1Sat inscription.
 * Input: the owner's address, the content type (text) and the body (bytes).
 * Output: the script: envelope, then the owner's P2PKH. Pushes use the
 * shortest push opcode that fits (bsv picks PUSHDATA1/2/4 for long bodies).
 */
export function inscriptionScript(
    ownerAddress: bsv.Address,
    contentType: string,
    body: Buffer
): bsv.Script {
    const script = bsv.Script.empty()
        .add(bsv.Opcode.OP_0)
        .add(bsv.Opcode.OP_IF)
        .add(ORD_MARKER)
        .add(bsv.Opcode.OP_1)
        .add(Buffer.from(contentType, 'utf8'))
        .add(bsv.Opcode.OP_0)
        .add(body)
        .add(bsv.Opcode.OP_ENDIF)
    return script.add(bsv.Script.buildPublicKeyHashOut(ownerAddress))
}

/**
 * Data a script chunk pushes.
 * Input: a script chunk. Output: the pushed bytes (empty for OP_0), or
 * undefined when the chunk is not a data push.
 */
function pushed(chunk: {
    opcodenum: number
    buf?: Buffer
}): Buffer | undefined {
    if (chunk.opcodenum === bsv.Opcode.OP_0) return Buffer.alloc(0)
    return chunk.buf
}

/**
 * Find an ordinal envelope in a script.
 * Input: any script. Output: the content type and body of the first
 * envelope `OP_FALSE OP_IF "ord" OP_1 <type> OP_0 <body> OP_ENDIF`, wherever
 * it sits in the script, or undefined when there is none. The content type
 * is read as UTF-8 text.
 */
export function parseInscription(
    script: bsv.Script
): { contentType: string; body: Buffer } | undefined {
    const chunks = script.chunks
    for (let i = 0; i + 7 < chunks.length; i++) {
        const [zero, branch, marker, tag, type, separator, body, end] =
            chunks.slice(i, i + 8)
        if (
            zero.opcodenum === bsv.Opcode.OP_0 &&
            branch.opcodenum === bsv.Opcode.OP_IF &&
            pushed(marker)?.equals(ORD_MARKER) &&
            tag.opcodenum === bsv.Opcode.OP_1 &&
            separator.opcodenum === bsv.Opcode.OP_0 &&
            end.opcodenum === bsv.Opcode.OP_ENDIF
        ) {
            const typeBytes = pushed(type)
            const bodyBytes = pushed(body)
            if (typeBytes && bodyBytes)
                return {
                    contentType: typeBytes.toString('utf8'),
                    body: bodyBytes,
                }
        }
    }
    return undefined
}

/**
 * Read the member list file of `--tree`.
 * Input: the path of a JSON file `{ "members": [ { index, keyHash, payout,
 * lastRound }, ... ] }`. Output: the members, checked and in the form of
 * `GenesisRoster['members']`. Throws an Error (message names the path) when
 * the file is not JSON, has no `members` array, a member is malformed, or
 * two members share a leaf index or a key hash.
 */
export function readMembersFile(path: string): GenesisRoster['members'] {
    let doc: unknown
    try {
        doc = JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e
        throw new Error(`${path} is not valid JSON`)
    }
    const members = (doc as { members?: unknown } | null)?.members
    if (!Array.isArray(members))
        throw new Error(`${path} must hold { "members": [ ... ] }`)
    if (members.some((m) => typeof m !== 'object' || m === null))
        throw new Error(`${path}: every member must be an object`)
    try {
        RosterMirror.fromMembers(members)
    } catch (e) {
        throw new Error(`${path}: ${(e as Error).message}`)
    }
    return members
}

/**
 * Build the genesis roster document of a deployment.
 * Input: the machine's instance id, its deployed roster root (64 hex) and
 * the member list. Output: the `GenesisRoster` with lower-case hex and the
 * members sorted by leaf index. Throws when the members are malformed,
 * repeat an index or a key hash, or do not rebuild `rosterRoot`.
 */
export function genesisRosterOf(
    instanceId: string,
    rosterRoot: string,
    members: GenesisRoster['members']
): GenesisRoster {
    const genesis: GenesisRoster = {
        k17: 'roster',
        instanceId: instanceId.toLowerCase(),
        rosterRoot: rosterRoot.toLowerCase(),
        members: members
            .map((m) => ({
                index: m.index,
                keyHash: m.keyHash.toLowerCase(),
                payout: m.payout.toLowerCase(),
                lastRound: m.lastRound,
            }))
            .sort((a, b) => a.index - b.index),
    }
    RosterMirror.fromGenesis(genesis) // checks every field and the root
    return genesis
}

/**
 * Fund, sign and broadcast a transaction with one 1Sat inscription.
 * Input: the wallet signer (it pays the fee and owns the inscription), the
 * content type and the body. The wallet's coins are taken largest first
 * until they cover the fee; change goes back to the wallet's default
 * address. Output: the inscription outpoint `txid:0`. Throws when the
 * wallet cannot pay or the broadcast fails.
 */
export async function broadcastInscription(
    signer: Signer,
    contentType: string,
    body: Buffer
): Promise<string> {
    const owner = await signer.getDefaultAddress()
    const script = inscriptionScript(owner, contentType, body)
    const feePerKb = await signer.connectedProvider.getFeePerKb()
    const coins = (await signer.listUnspent(owner)).sort(
        (a, b) => b.satoshis - a.satoshis
    )
    for (let count = 1; count <= coins.length; count++) {
        const tx = new bsv.Transaction()
            .from(coins.slice(0, count))
            .addOutput(
                new bsv.Transaction.Output({
                    script,
                    satoshis: INSCRIPTION_SATS,
                })
            )
            .feePerKb(feePerKb)
            .change(owner)
        if (tx.getChangeOutput() === null) continue
        await signer.signAndsendTransaction(tx)
        return `${tx.id}:0`
    }
    throw new Error('the wallet has too little money for the inscription')
}
