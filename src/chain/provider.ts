/**
 * Chain access: the scrypt-ts provider and signer, plus two direct
 * WhatsOnChain calls that testnet needs.
 *
 * Testnet findings that bind this module: a keeper must pick nLockTime at or
 * below the chain's median time past (`chainInfo` gives it), and
 * `DefaultProvider.getBalance` counts coins twice on testnet, so
 * `addressBalance` reads the balance from WhatsOnChain instead.
 */

import { DefaultProvider, Provider, TestWallet, bsv } from 'scrypt-ts'
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

/**
 * Make the chain provider for a network.
 * Input: network name. Output: a `DefaultProvider` for it.
 */
export function makeProvider(network: NetworkName): Provider {
    return new DefaultProvider({
        network:
            network === 'testnet' ? bsv.Networks.testnet : bsv.Networks.mainnet,
    })
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
    fetchFn: FetchLike = fetch as unknown as FetchLike
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
    fetchFn: FetchLike = fetch as unknown as FetchLike
): Promise<number> {
    const body = await wocJson(
        `${wocBase(network)}/address/${address}/balance`,
        fetchFn
    )
    return Number(body?.confirmed ?? 0) + Number(body?.unconfirmed ?? 0)
}
