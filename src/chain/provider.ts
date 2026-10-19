/**
 * Chain access: the scrypt-ts provider and signer, plus two direct
 * WhatsOnChain calls that testnet needs.
 *
 * Testnet findings that bind this module: a keeper must pick nLockTime at or
 * below the chain's median time past (`chainInfo` gives it), and
 * `DefaultProvider.getBalance` counts coins twice on testnet, so
 * `addressBalance` reads the balance from WhatsOnChain instead.
 *
 * WhatsOnChain `/address/<addr>/unspent`, which `DefaultProvider` lists the
 * wallet coins with, still lists a confirmed coin that a mempool
 * transaction spends. A second process (the sponsor's `endorse` after its
 * `deploy`, a gateway after another) then picks that coin again and its
 * broadcast fails with "txn-mempool-conflict" until the next block. The
 * provider of `makeProvider` therefore lists coins with `wocUnspent`, which
 * drops coins spent in the mempool and adds unconfirmed change.
 *
 * WhatsOnChain also limits the call rate (HTTP 429 "Too Many Requests") and
 * answers "Not Found" for a transaction for some seconds after its
 * broadcast. `wocFetch` retries a 429, and the provider retries
 * `getTransaction` and `sendRawTransaction` on these transient errors.
 */

import {
    AddressOption,
    DefaultProvider,
    Provider,
    TestWallet,
    UTXO,
    bsv,
} from 'scrypt-ts'
import type { GatewayConfig, NetworkName } from './config'

/** The part of `fetch` that these helpers use; tests pass a fake. */
export type FetchLike = (url: string) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
}>

/** What `chainInfo` returns. */
export interface ChainInfo {
    /** Median time past of the best block, unix seconds. */
    mediantime: number
    /** Block height. */
    blocks: number
}

/** Wait. Input: milliseconds. Output: a promise that settles after them. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrap a fetch function so that it retries a rate-limited call.
 * Input: the fetch function, the most attempts (default 5) and the first
 * wait in ms (default 1500; attempt n waits n times it).
 * Output: a fetch function that calls again while the answer is HTTP 429,
 * and gives the last answer back after the last attempt.
 */
export function retryOn429(
    fetchFn: FetchLike,
    attempts = 5,
    delayMs = 1500
): FetchLike {
    return async (url) => {
        for (let attempt = 1; ; attempt++) {
            const response = await fetchFn(url)
            if (response.status !== 429 || attempt >= attempts) return response
            await sleep(delayMs * attempt)
        }
    }
}

/** The default fetch of the WhatsOnChain helpers: `fetch` with 429 retries. */
export const wocFetch: FetchLike = retryOn429(fetch as unknown as FetchLike)

/**
 * Run a call again while it fails with a transient error.
 * Input: the call, a pattern of the transient error texts, the most
 * attempts (default 6) and the first wait in ms (default 2000; attempt n
 * waits n times it). Output: the first result. Throws at once on an error
 * that does not match, and throws the last error after the last attempt.
 */
export async function withRetry<T>(
    call: () => Promise<T>,
    transient: RegExp,
    attempts = 6,
    delayMs = 2000
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await call()
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            if (!transient.test(message) || attempt >= attempts) throw e
            await sleep(delayMs * attempt)
        }
    }
}

/** Errors of a transaction read that go away after some seconds. */
const TRANSIENT_READ = /Not Found|Too Many Requests|\b429\b/

/** Broadcast errors that go away after some seconds (rate limit only). */
const TRANSIENT_SEND = /Too Many Requests|\b429\b/

/**
 * Network name of a provider or a name.
 * Input: a network name or a provider. Output: "testnet" or "mainnet".
 */
function networkNameOf(network: NetworkName | Provider): NetworkName {
    if (typeof network === 'string') return network
    return network.getNetwork().name === 'testnet' ? 'testnet' : 'mainnet'
}

/**
 * Base URL of the WhatsOnChain API for a network.
 * Input: network name or provider. Output: URL without trailing slash.
 */
function wocBase(network: NetworkName | Provider): string {
    return `https://api.whatsonchain.com/v1/bsv/${
        networkNameOf(network) === 'testnet' ? 'test' : 'main'
    }`
}

/**
 * Get JSON from WhatsOnChain.
 * Input: full URL and a fetch function. Output: the parsed body. Throws with
 * the HTTP status when the call fails.
 */
async function wocJson(url: string, fetchFn: FetchLike): Promise<any> {
    const response = await fetchFn(url)
    if (!response.ok)
        throw new Error(`WhatsOnChain ${url} failed: HTTP ${response.status}`)
    return response.json()
}

/** One coin of a WhatsOnChain confirmed or unconfirmed unspent answer. */
interface WocCoin {
    tx_hash: string
    tx_pos: number
    value: number
    isSpentInMempoolTx?: boolean
}

/**
 * The coins of an address that a new transaction can spend, from
 * WhatsOnChain `/address/<addr>/confirmed/unspent` and
 * `/address/<addr>/unconfirmed/unspent` (checked on testnet on 2026-10-19:
 * `{ "result": [ { tx_hash, tx_pos, value, isSpentInMempoolTx } ] }`).
 * Input: network name or provider, the address, an optional fetch function.
 * Output: the confirmed coins, then the unconfirmed ones, without the coins
 * that a mempool transaction spends, as P2PKH UTXOs of the address. Throws
 * on an HTTP error, and "unspent list: unexpected response" when a body has
 * no `result` list.
 */
export async function wocUnspent(
    network: NetworkName | Provider,
    address: string,
    fetchFn: FetchLike = wocFetch
): Promise<UTXO[]> {
    const base = `${wocBase(network)}/address/${address}`
    const lists = await Promise.all(
        ['confirmed', 'unconfirmed'].map(async (kind) => {
            const body = await wocJson(`${base}/${kind}/unspent`, fetchFn)
            if (!Array.isArray(body?.result))
                throw new Error('unspent list: unexpected response')
            return body.result as WocCoin[]
        })
    )
    const script = bsv.Script.buildPublicKeyHashOut(
        bsv.Address.fromString(address)
    ).toHex()
    return lists
        .flat()
        .filter((coin) => !coin.isSpentInMempoolTx)
        .map((coin) => ({
            txId: coin.tx_hash,
            outputIndex: coin.tx_pos,
            satoshis: coin.value,
            script,
        }))
}

/** Options of `makeProvider`. */
export interface ProviderOptions {
    /** Fetch function of the coin lists. Default: `wocFetch`. */
    fetch?: FetchLike
    /**
     * The provider to wrap. Default: a scrypt-ts `DefaultProvider` for the
     * network (it connects to WhatsOnChain when it is made). Tests pass a
     * stub so that no test reaches the network.
     */
    base?: Provider
    /**
     * Most attempts of a transaction read that fails with "Not Found" or a
     * rate limit. Default: READ_ATTEMPTS_AFTER_BROADCAST, for tools that
     * read their own new transactions. A reader of old transactions
     * (`inspect`) passes a small number, so a wrong txid fails fast.
     */
    readAttempts?: number
}

/** Read attempts for a transaction that can be a few seconds old. */
export const READ_ATTEMPTS_AFTER_BROADCAST = 6

/**
 * Make the chain provider for a network.
 * Input: network name and options. Output: the base provider (by default a
 * `DefaultProvider` for the network), changed in place so that it lists
 * coins with `wocUnspent`, retries "Not Found" and rate-limited reads up to
 * `readAttempts` times, and retries rate-limited broadcasts (`withRetry`).
 */
export function makeProvider(
    network: NetworkName,
    options: ProviderOptions = {}
): Provider {
    const fetchFn = options.fetch ?? wocFetch
    const readAttempts = options.readAttempts ?? READ_ATTEMPTS_AFTER_BROADCAST
    const provider =
        options.base ??
        new DefaultProvider({
            network:
                network === 'testnet'
                    ? bsv.Networks.testnet
                    : bsv.Networks.mainnet,
        })
    const getTransaction = provider.getTransaction.bind(provider)
    const sendRawTransaction = provider.sendRawTransaction.bind(provider)
    // The query options of the base listUnspent are not used: the wallet
    // picks from the whole list.
    provider.listUnspent = (address: AddressOption): Promise<UTXO[]> =>
        wocUnspent(network, address.toString(), fetchFn)
    provider.getTransaction = (txid: string): Promise<bsv.Transaction> =>
        withRetry(() => getTransaction(txid), TRANSIENT_READ, readAttempts)
    provider.sendRawTransaction = (rawTxHex: string): Promise<string> =>
        withRetry(() => sendRawTransaction(rawTxHex), TRANSIENT_SEND)
    return provider
}

/**
 * Make the wallet signer of a configuration.
 * Input: the configuration (uses `wif` and `network`) and optionally a
 * provider to use. Output: a `TestWallet` that signs with the wallet key.
 * The key is never logged.
 */
export function makeSigner(
    cfg: GatewayConfig,
    provider: Provider = makeProvider(cfg.network)
): TestWallet {
    return new TestWallet(bsv.PrivateKey.fromWIF(cfg.wif), provider)
}

/**
 * Chain tip data from WhatsOnChain `/chain/info`.
 * Input: network name or provider, and an optional fetch function.
 * Output: the median time past (`mediantime`) and the height (`blocks`).
 * A keeper must use an nLockTime at or below `mediantime`.
 */
export async function chainInfo(
    network: NetworkName | Provider,
    fetchFn: FetchLike = wocFetch
): Promise<ChainInfo> {
    const body = await wocJson(`${wocBase(network)}/chain/info`, fetchFn)
    const mediantime = Number(body?.mediantime)
    const blocks = Number(body?.blocks)
    if (!Number.isFinite(mediantime) || !Number.isFinite(blocks))
        throw new Error('WhatsOnChain chain/info has no mediantime or blocks')
    return { mediantime, blocks }
}

/**
 * Balance of an address from WhatsOnChain `/address/<addr>/balance`.
 * Input: network name or provider, the address, an optional fetch function.
 * Output: confirmed plus unconfirmed satoshis.
 */
export async function addressBalance(
    network: NetworkName | Provider,
    address: string,
    fetchFn: FetchLike = wocFetch
): Promise<number> {
    const body = await wocJson(
        `${wocBase(network)}/address/${address}/balance`,
        fetchFn
    )
    return Number(body?.confirmed ?? 0) + Number(body?.unconfirmed ?? 0)
}
