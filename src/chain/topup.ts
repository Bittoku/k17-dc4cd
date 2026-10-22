/**
 * Third-party escrow top-up: the funder pays the top-up of one cycle that a
 * keeper builds, and the two never share a key or a process.
 *
 * The flow has three files. Each is plain JSON and holds no private key.
 *
 * 1. Offer (`topup offer`, funder): a coin of exactly `amount` sats on the
 *    funder's P2PKH key, the funder public key, the machine instance id and
 *    the network.
 * 2. Request (a cycle command with `--top-up-offer`, keeper): the final cycle
 *    transaction with the offered coin as an input and `topUp = amount` on
 *    the machine input. The keeper signs all of its own inputs; only the
 *    funder input is left empty. The request also names the funder input
 *    index, the machine input index and prevout, the amount and the instance
 *    id.
 * 3. Signature (`topup sign`, funder): the unlocking script of the funder
 *    input (SIGHASH_ALL | FORKID) and the id of the request it is for.
 *
 * `topup complete` (keeper) puts the funder's unlocking script into the
 * request transaction and broadcasts it. BIP143 (FORKID) sighashes do not
 * cover the unlocking scripts of other inputs, so the keeper's signatures
 * stay valid.
 *
 * Rulings that bind this module:
 * - The files are the only state that passes between the processes;
 *   nothing is built again between them.
 * - A request is stale when the machine prevout is spent (checked by the
 *   machine tip, not by a clock).
 * - The funder trusts nothing in the request. It reads the machine prevout
 *   and its own coin from the chain provider, checks the `topUp` argument
 *   and runs the script interpreter on the machine input against the real
 *   prevout. The covenant then forces output 0 to `remaining + topUp`, so
 *   the funder does not replay planCycle.
 *
 * Exports: the file types and their readers (`readOffer`, `readRequest`,
 * `readSignature`), `offerCoin`, `requestIdOf`, `buildFundedCycle`,
 * `checkRequestForFunder`, `signFunderInput`, `completeRequest`,
 * `makeExactCoin`, and the error classes `TopUpRefusal` and
 * `OfferExpired`.
 */

import { createHash } from 'crypto'
import { Signer, bsv } from 'scrypt-ts'
import { CyclePlan, FunderInput, K17Machine, sendCycle } from 'k17-vm'
import type { NetworkName } from './config'
import { Outpoint, TxSource, decodeUnlocking, parseOutpoint } from './history'
import { decodeMachine } from './decode'

/** `kind` of an offer file. */
export const OFFER_KIND = 'k17-topup-offer'
/** `kind` of a request file. */
export const REQUEST_KIND = 'k17-topup-request'
/** `kind` of a signature file. */
export const SIGNATURE_KIND = 'k17-topup-signature'
/** Format version of the three files. */
export const TOPUP_FILE_VERSION = 1

/** Sighash type of the funder signature: SIGHASH_ALL | SIGHASH_FORKID. */
export const FUNDER_SIGHASH =
    bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID

/** The funder's offer: one coin of exactly `amount` sats for one machine. */
export interface TopUpOffer {
    kind: typeof OFFER_KIND
    version: number
    network: NetworkName
    /** Instance id of the machine (64 hex), read from the chain. */
    instanceId: string
    /** Coin outpoint, `txid:vout`. The coin is P2PKH on `funderPubKey`. */
    coin: string
    /** Value of the coin and size of the top-up, in sats (decimal text). */
    amount: string
    /** The funder's compressed public key, 66 hex. */
    funderPubKey: string
}

/** The keeper's request: a cycle transaction that waits for the funder. */
export interface TopUpRequest {
    kind: typeof REQUEST_KIND
    version: number
    network: NetworkName
    /** Instance id of the machine (64 hex). */
    instanceId: string
    /** The machine output the cycle spends, `txid:vout`. */
    machinePrevout: string
    /** Input index of the machine (always 0; the contract needs it there). */
    machineInputIndex: number
    /** Input index of the offered coin. */
    funderInputIndex: number
    /** The top-up in sats (decimal text); equals the offer amount. */
    amount: string
    /** The offered coin, `txid:vout`. */
    coin: string
    /**
     * The final transaction, hex. Every input is signed except the funder
     * input, whose unlocking script is empty.
     */
    txHex: string
}

/** The funder's answer: the unlocking script of its input. */
export interface TopUpSignature {
    kind: typeof SIGNATURE_KIND
    version: number
    /** `requestIdOf(request.txHex)` of the request this signs. */
    requestId: string
    /** Input index of the funder input. */
    inputIndex: number
    /** Unlocking script of the funder input, hex (`<sig> <pubkey>`). */
    unlockingScript: string
}

/** A check failed: the tool refuses and does nothing. Exit code 1. */
export class TopUpRefusal extends Error {}

/** The machine moved after the request was built. Exit code 1. */
export class OfferExpired extends TopUpRefusal {
    constructor() {
        super('offer expired: the machine moved; build a new request')
    }
}

/** Spends lookup: the txid that spent an outpoint, or undefined. */
export type SpentBy = (outpoint: Outpoint) => Promise<string | undefined>

/**
 * Read a JSON object.
 * Input: the file text and a name for messages. Output: the object.
 * Throws a TopUpRefusal when the text is not a JSON object.
 */
function jsonObject(text: string, what: string): Record<string, unknown> {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        throw new TopUpRefusal(`${what} is not valid JSON`)
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TopUpRefusal(`${what} is not a JSON object`)
    return value as Record<string, unknown>
}

/**
 * Read one string field that must match a pattern.
 * Input: the object, the field name, the pattern and a name for messages.
 * Output: the value. Throws a TopUpRefusal when it is missing or wrong.
 */
function field(
    obj: Record<string, unknown>,
    name: string,
    pattern: RegExp,
    what: string
): string {
    const value = obj[name]
    if (typeof value !== 'string' || !pattern.test(value))
        throw new TopUpRefusal(`${what}: field "${name}" is missing or wrong`)
    return value
}

/**
 * Read one whole-number field (an input index).
 * Input: the object, the field name and a name for messages. Output: the
 * value. Throws a TopUpRefusal when it is not a whole number 0 or more.
 */
function indexField(
    obj: Record<string, unknown>,
    name: string,
    what: string
): number {
    const value = obj[name]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
        throw new TopUpRefusal(`${what}: field "${name}" is missing or wrong`)
    return value
}

/**
 * Check the `kind` and `version` fields.
 * Input: the object, the wanted kind and a name for messages. Output: none.
 * Throws a TopUpRefusal when they do not match.
 */
function checkKind(
    obj: Record<string, unknown>,
    kind: string,
    what: string
): void {
    if (obj.kind !== kind)
        throw new TopUpRefusal(`${what} is not a ${kind} file`)
    if (obj.version !== TOPUP_FILE_VERSION)
        throw new TopUpRefusal(
            `${what}: version ${String(
                obj.version
            )} is not supported (${TOPUP_FILE_VERSION} is)`
        )
}

const HEX64 = /^[0-9a-f]{64}$/
const OUTPOINT = /^[0-9a-f]{64}:\d+$/
const SATS = /^[1-9]\d*$/
const NETWORK = /^(testnet|mainnet)$/
const PUBKEY = /^0[23][0-9a-f]{64}$/
const HEX = /^([0-9a-f]{2})+$/

/**
 * Read an offer file.
 * Input: the file text and its name. Output: the offer. Throws a
 * TopUpRefusal that names the bad field.
 */
export function readOffer(text: string, what = 'offer'): TopUpOffer {
    const obj = jsonObject(text, what)
    checkKind(obj, OFFER_KIND, what)
    return {
        kind: OFFER_KIND,
        version: TOPUP_FILE_VERSION,
        network: field(obj, 'network', NETWORK, what) as NetworkName,
        instanceId: field(obj, 'instanceId', HEX64, what),
        coin: field(obj, 'coin', OUTPOINT, what),
        amount: field(obj, 'amount', SATS, what),
        funderPubKey: field(obj, 'funderPubKey', PUBKEY, what),
    }
}

/**
 * Read a request file.
 * Input: the file text and its name. Output: the request. Throws a
 * TopUpRefusal that names the bad field.
 */
export function readRequest(text: string, what = 'request'): TopUpRequest {
    const obj = jsonObject(text, what)
    checkKind(obj, REQUEST_KIND, what)
    return {
        kind: REQUEST_KIND,
        version: TOPUP_FILE_VERSION,
        network: field(obj, 'network', NETWORK, what) as NetworkName,
        instanceId: field(obj, 'instanceId', HEX64, what),
        machinePrevout: field(obj, 'machinePrevout', OUTPOINT, what),
        machineInputIndex: indexField(obj, 'machineInputIndex', what),
        funderInputIndex: indexField(obj, 'funderInputIndex', what),
        amount: field(obj, 'amount', SATS, what),
        coin: field(obj, 'coin', OUTPOINT, what),
        txHex: field(obj, 'txHex', HEX, what),
    }
}

/**
 * Read a signature file.
 * Input: the file text and its name. Output: the signature. Throws a
 * TopUpRefusal that names the bad field.
 */
export function readSignature(
    text: string,
    what = 'signature'
): TopUpSignature {
    const obj = jsonObject(text, what)
    checkKind(obj, SIGNATURE_KIND, what)
    return {
        kind: SIGNATURE_KIND,
        version: TOPUP_FILE_VERSION,
        requestId: field(obj, 'requestId', HEX64, what),
        inputIndex: indexField(obj, 'inputIndex', what),
        unlockingScript: field(obj, 'unlockingScript', HEX, what),
    }
}

/**
 * The identifier of a request: SHA-256 of its transaction hex, with the
 * funder input still empty. It does not depend on the funder's unlocking
 * script, so both sides compute it from the request file alone.
 * Input: the request transaction hex. Output: 64 hex.
 */
export function requestIdOf(txHex: string): string {
    return createHash('sha256').update(txHex.toLowerCase()).digest('hex')
}

/**
 * The locking script of the funder's coin.
 * Input: the funder public key (66 hex). Output: the P2PKH script hex.
 */
function funderScript(pubKeyHex: string): string {
    return bsv.Script.buildPublicKeyHashOut(
        bsv.PublicKey.fromHex(pubKeyHex).toAddress()
    ).toHex()
}

/**
 * The offered coin as a k17-vm funder input.
 * Input: the offer. Output: the coin (txid, output index, value and the
 * P2PKH script of the funder key).
 */
export function offerCoin(offer: TopUpOffer): FunderInput {
    const { txid, vout } = parseOutpoint(offer.coin)
    return {
        txId: txid,
        outputIndex: vout,
        satoshis: BigInt(offer.amount),
        script: funderScript(offer.funderPubKey),
    }
}

/** `txid:vout` of an input. */
function prevoutOf(input: bsv.Transaction.Input): string {
    return `${input.prevTxId.toString('hex')}:${input.outputIndex}`
}

/**
 * Indices of the inputs of a transaction that spend an outpoint.
 * Input: the transaction and the outpoint. Output: the indices, in order.
 */
function inputsSpending(tx: bsv.Transaction, outpoint: string): number[] {
    return tx.inputs
        .map((input, i) => (prevoutOf(input) === outpoint ? i : -1))
        .filter((i) => i >= 0)
}

/** Thrown inside the funder callback of sendCycle to stop it there. */
class Captured extends Error {
    constructor(readonly tx: bsv.Transaction, readonly index: number) {
        super('captured for the funder')
    }
}

/** A funded cycle that waits for the funder's signature. */
export interface FundedCycle {
    /** The final transaction; the funder input has an empty script. */
    tx: bsv.Transaction
    /** Input index of the machine. */
    machineInputIndex: number
    /** Input index of the offered coin. */
    funderInputIndex: number
}

/**
 * Build the final cycle transaction with the offered coin as an input,
 * and stop before the funder signs.
 * It runs k17-vm `sendCycle` with `funding` and no broadcast. sendCycle
 * checks the transaction (output 0 holds remaining + topUp, a change output,
 * the machine input passes the interpreter) and then calls the funder
 * callback; this callback keeps the transaction and stops sendCycle.
 * Input: the machine (connected to the keeper's signer), the plan (its
 * topUp must equal the coin value), the keeper address, the lock time and
 * the coin. Output: the transaction and the two input indices. Throws when
 * sendCycle refuses the transaction, and when the coin is an input more
 * than once (the keeper wallet holds the same key as the funder).
 */
export async function buildFundedCycle(
    m: K17Machine,
    plan: CyclePlan,
    keeper: bsv.Address,
    lockTime: bigint,
    coin: FunderInput
): Promise<FundedCycle> {
    let captured: Captured | undefined
    try {
        await sendCycle(m, plan, keeper, lockTime, {
            broadcast: false,
            funding: {
                inputs: [coin],
                sign: (tx, index) => {
                    throw new Captured(tx, index)
                },
            },
        })
    } catch (e) {
        if (!(e instanceof Captured)) throw e
        captured = e
    }
    if (!captured)
        throw new Error('the cycle was built without the funder input')
    const { tx, index } = captured
    const coinOutpoint = `${coin.txId}:${coin.outputIndex}`
    if (inputsSpending(tx, coinOutpoint).length !== 1)
        throw new Error(
            'the offered coin is an input more than once (the keeper wallet holds the funder key?); no request written'
        )
    return { tx, machineInputIndex: 0, funderInputIndex: index }
}

/**
 * Read one output of a transaction from the chain.
 * Input: a transaction source, the outpoint and a name for messages.
 * Output: the output. Throws a TopUpRefusal when the transaction cannot be
 * read or has no such output.
 */
async function chainOutput(
    source: TxSource,
    outpoint: string,
    what: string
): Promise<bsv.Transaction.Output> {
    const { txid, vout } = parseOutpoint(outpoint)
    let tx: bsv.Transaction
    try {
        tx = await source.getTransaction(txid)
    } catch (e) {
        throw new TopUpRefusal(
            `${what} ${outpoint}: cannot read it from the chain (${
                (e as Error).message
            })`
        )
    }
    const output = tx.outputs[vout]
    if (!output) throw new TopUpRefusal(`${what} ${outpoint} does not exist`)
    return output
}

/**
 * Run the script interpreter on one input.
 * Input: the transaction, the input index and the real prevout output.
 * Output: none; the input gets the prevout. Throws a TopUpRefusal that
 * names the input when the script fails.
 */
function verifyInput(
    tx: bsv.Transaction,
    index: number,
    prevout: bsv.Transaction.Output,
    what: string
): void {
    tx.inputs[index].output = new bsv.Transaction.Output({
        script: prevout.script,
        satoshis: prevout.satoshis,
    })
    let verdict: { success: boolean; error: string }
    try {
        verdict = tx.verifyInputScript(index)
    } catch (e) {
        verdict = { success: false, error: (e as Error).message }
    }
    if (!verdict.success)
        throw new TopUpRefusal(
            `${what} (input ${index}) fails the script interpreter: ${verdict.error}`
        )
}

/** What the funder reads from the chain. */
export interface FunderChain {
    /** Read a transaction. */
    source: TxSource
    /** Spends lookup. */
    spentBy: SpentBy
}

/**
 * The funder's checks of a request, all on data the funder reads itself.
 * Checks, in order:
 * - the request and the offer agree on network, instance id, coin and
 *   amount, and the offer is for the funder's own key;
 * - (a) the machine prevout (read from the transaction itself, input 0) is
 *   unspent, is a K17 machine and has the offer's instance id;
 * - (b) the machine input's unlocking script decodes and its `topUp`
 *   equals the offer amount; the coin on the chain holds exactly the amount
 *   on the funder's P2PKH script;
 * - (d) the coin is an input exactly once, at the stated index, with an
 *   empty unlocking script, and the coin is unspent;
 * - (c) last, the machine input passes the script interpreter against the
 *   real prevout script and value (the covenant then pins output 0 to
 *   remaining + topUp and every other output).
 * Input: the request, the funder's own offer, the funder's public key and
 * the chain. Output: the transaction, ready for `signFunderInput`. Throws a
 * TopUpRefusal with a clear reason on the first failed check.
 */
export async function checkRequestForFunder(
    request: TopUpRequest,
    offer: TopUpOffer,
    funderPub: bsv.PublicKey,
    chain: FunderChain
): Promise<bsv.Transaction> {
    if (offer.funderPubKey !== funderPub.toString())
        throw new TopUpRefusal(
            'the offer is not for the key of this funder config'
        )
    if (request.network !== offer.network)
        throw new TopUpRefusal(
            `the request is for ${request.network}, the offer for ${offer.network}`
        )
    if (request.instanceId !== offer.instanceId)
        throw new TopUpRefusal(
            'the request names another machine instance id than the offer'
        )
    if (request.coin !== offer.coin)
        throw new TopUpRefusal('the request names another coin than the offer')
    if (request.amount !== offer.amount)
        throw new TopUpRefusal(
            `the request amount ${request.amount} is not the offer amount ${offer.amount}`
        )
    let tx: bsv.Transaction
    try {
        tx = new bsv.Transaction(request.txHex)
    } catch {
        throw new TopUpRefusal('the request transaction does not parse')
    }
    const amount = BigInt(offer.amount)

    // (a) The machine prevout, from the transaction, not from the claims.
    if (request.machineInputIndex !== 0 || tx.inputs.length < 2)
        throw new TopUpRefusal(
            'the machine must be input 0 of a transaction with a funder input'
        )
    const machinePrevout = prevoutOf(tx.inputs[0])
    if (machinePrevout !== request.machinePrevout)
        throw new TopUpRefusal(
            `the request says the machine is ${request.machinePrevout}, but input 0 spends ${machinePrevout}`
        )
    const machineOutput = await chainOutput(
        chain.source,
        machinePrevout,
        'machine prevout'
    )
    const machine = decodeMachine(machineOutput.script.toHex()).machine
    if (!machine)
        throw new TopUpRefusal(
            `input 0 spends ${machinePrevout}, which is not a K17 machine`
        )
    if (machine.instanceId.toLowerCase() !== offer.instanceId)
        throw new TopUpRefusal(
            `input 0 spends machine ${machine.instanceId}, not the offer's machine ${offer.instanceId}`
        )
    if ((await chain.spentBy(parseOutpoint(machinePrevout))) !== undefined)
        throw new TopUpRefusal(
            `the machine prevout ${machinePrevout} is not the current tip (it is spent); ask for a new request`
        )

    // (b) The topUp argument and the coin value.
    const args = decodeUnlocking(tx.inputs[0].script.chunks)
    if (!args)
        throw new TopUpRefusal(
            'the machine input unlocking script does not decode'
        )
    if (args.topUp !== amount)
        throw new TopUpRefusal(
            `the machine input tops up ${args.topUp} sats, not the offer amount ${amount}`
        )
    const coinOutput = await chainOutput(chain.source, offer.coin, 'coin')
    if (BigInt(coinOutput.satoshis) !== amount)
        throw new TopUpRefusal(
            `the coin holds ${coinOutput.satoshis} sats, not the amount ${amount}; refusing (the rest would go to change)`
        )
    if (coinOutput.script.toHex() !== funderScript(offer.funderPubKey))
        throw new TopUpRefusal("the coin is not on this funder's P2PKH script")

    // (d) The coin is an input exactly once, at the stated index, unsigned,
    // and nothing else spends it.
    const uses = inputsSpending(tx, offer.coin)
    if (uses.length === 0)
        throw new TopUpRefusal('the coin is not an input of the request')
    if (uses.length > 1)
        throw new TopUpRefusal('the coin is an input more than once')
    if (uses[0] !== request.funderInputIndex)
        throw new TopUpRefusal(
            `the coin is input ${uses[0]}, not the stated funder input ${request.funderInputIndex}`
        )
    if (tx.inputs[uses[0]].script.toBuffer().length !== 0)
        throw new TopUpRefusal('the funder input already has a script')
    if ((await chain.spentBy(parseOutpoint(offer.coin))) !== undefined)
        throw new TopUpRefusal(`the coin ${offer.coin} is spent already`)
    // (c) The covenant, through the interpreter on the real prevout.
    verifyInput(tx, 0, machineOutput, 'the machine input')

    return tx
}

/**
 * Sign the funder input of a checked request.
 * Input: the transaction (from `checkRequestForFunder`), the input index,
 * the coin value and the funder's private key. Output: the unlocking script
 * hex `<sig> <pubkey>` with SIGHASH_ALL | FORKID. The function checks the
 * result with the script interpreter before it returns; it throws when that
 * fails. The key never leaves this function.
 */
export function signFunderInput(
    tx: bsv.Transaction,
    index: number,
    amount: bigint,
    key: bsv.PrivateKey
): string {
    const script = bsv.Script.buildPublicKeyHashOut(key.toAddress())
    const sig = bsv.Transaction.Sighash.sign(
        tx,
        key,
        FUNDER_SIGHASH,
        index,
        script,
        new bsv.crypto.BN(amount.toString())
    )
    const unlocking = new bsv.Script('')
        .add(Buffer.concat([sig.toDER(), Buffer.from([FUNDER_SIGHASH])]))
        .add(key.publicKey.toBuffer())
    const signed = new bsv.Transaction(tx.uncheckedSerialize())
    signed.inputs[index].setScript(unlocking)
    verifyInput(
        signed,
        index,
        new bsv.Transaction.Output({ script, satoshis: Number(amount) }),
        'the funder input'
    )
    return unlocking.toHex()
}

/** What `completeRequest` needs from the chain. */
export interface CompleteChain extends FunderChain {
    /** Broadcast a transaction. */
    send: (tx: bsv.Transaction) => Promise<unknown>
}

/** Result of `completeRequest`. */
export interface CompletedTopUp {
    /** The broadcast transaction. */
    tx: bsv.Transaction
    /** Value of the new machine output (output 0), sats. */
    machineValue: bigint
}

/**
 * Finish a request: insert the funder's unlocking script, check every
 * input, check that the machine has not moved, and broadcast.
 * Input: the request, the signature and the chain. Output: the broadcast
 * transaction and the new machine value. Throws OfferExpired when the
 * machine prevout is spent (before or during the broadcast), and a
 * TopUpRefusal when the signature is for another request or input, or an
 * input fails the script interpreter. Nothing is broadcast on a refusal.
 */
export async function completeRequest(
    request: TopUpRequest,
    signature: TopUpSignature,
    chain: CompleteChain
): Promise<CompletedTopUp> {
    if (signature.requestId !== requestIdOf(request.txHex))
        throw new TopUpRefusal(
            'the signature file is for another request (request id differs)'
        )
    if (signature.inputIndex !== request.funderInputIndex)
        throw new TopUpRefusal(
            `the signature is for input ${signature.inputIndex}, the request funder input is ${request.funderInputIndex}`
        )
    const tx = new bsv.Transaction(request.txHex)
    const funderInput = tx.inputs[request.funderInputIndex]
    if (!funderInput || prevoutOf(funderInput) !== request.coin)
        throw new TopUpRefusal(
            'the request funder input does not spend the offered coin'
        )
    const machinePrevout = parseOutpoint(prevoutOf(tx.inputs[0]))
    if ((await chain.spentBy(machinePrevout)) !== undefined)
        throw new OfferExpired()
    funderInput.setScript(bsv.Script.fromHex(signature.unlockingScript))
    for (let i = 0; i < tx.inputs.length; i++) {
        const prevout = await chainOutput(
            chain.source,
            prevoutOf(tx.inputs[i]),
            `prevout of input ${i}`
        )
        verifyInput(
            tx,
            i,
            prevout,
            i === 0
                ? 'the machine input'
                : i === request.funderInputIndex
                ? 'the funder input'
                : 'a keeper input'
        )
    }
    // The change-output rule (assertChangeOutput) ran on the keeper side
    // before the request was written; a parsed transaction no longer knows
    // which output is change, and the machine input's sighash pins every
    // output, so the interpreter check above covers it.
    try {
        await chain.send(tx)
    } catch (e) {
        // A rival cycle can land between the check and the broadcast.
        let moved = false
        try {
            moved = (await chain.spentBy(machinePrevout)) !== undefined
        } catch {
            moved = false
        }
        if (moved) throw new OfferExpired()
        throw e
    }
    return { tx, machineValue: BigInt(tx.outputs[0].satoshis) }
}

/** Result of `makeExactCoin`. */
export interface ExactCoin {
    /** Coin outpoint, `txid:vout`. */
    outpoint: string
    /** True when the coin was made now (a transaction was broadcast). */
    made: boolean
}

/**
 * Find or make a coin of exactly `amount` sats on the signer's own P2PKH
 * address.
 * When the wallet lists such a coin (other than the ones in `exclude`), it
 * is used. Otherwise one transaction pays `amount` to the signer's address
 * (output 0) with the change back to the same address, from the largest
 * coins first.
 * Input: the signer (connected to a provider), the amount and outpoints to
 * leave out. Output: the coin. Throws when the wallet has too little money.
 */
export async function makeExactCoin(
    signer: Signer,
    amount: bigint,
    exclude: Set<string> = new Set()
): Promise<ExactCoin> {
    const owner = await signer.getDefaultAddress()
    const listed = await signer.listUnspent(owner)
    const exact = listed.find(
        (coin) =>
            BigInt(coin.satoshis) === amount &&
            !exclude.has(`${coin.txId}:${coin.outputIndex}`)
    )
    if (exact)
        return { outpoint: `${exact.txId}:${exact.outputIndex}`, made: false }
    const feePerKb = await signer.connectedProvider.getFeePerKb()
    const coins = [...listed]
        .filter((coin) => !exclude.has(`${coin.txId}:${coin.outputIndex}`))
        .sort((a, b) => b.satoshis - a.satoshis)
    for (let count = 1; count <= coins.length; count++) {
        const tx = new bsv.Transaction()
            .from(coins.slice(0, count))
            .addOutput(
                new bsv.Transaction.Output({
                    script: bsv.Script.buildPublicKeyHashOut(owner),
                    satoshis: Number(amount),
                })
            )
            .feePerKb(feePerKb)
            .change(owner)
        if (tx.getChangeOutput() === null) continue
        await signer.signAndsendTransaction(tx)
        return { outpoint: `${tx.id}:0`, made: true }
    }
    throw new Error(
        `the funder wallet has too little money for a coin of ${amount} sats`
    )
}
