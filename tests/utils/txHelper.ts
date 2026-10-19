import { DummyProvider, DefaultProvider, TestWallet, bsv } from 'scrypt-ts'
import { myPrivateKey } from './privateKey'

import * as dotenv from 'dotenv'

// Load the .env file
dotenv.config()

/**
 * The test wallet of a network, made when it is first asked for. A
 * `DefaultProvider` connects to the network when it is made, so the
 * testnet and mainnet wallets exist only when NETWORK names them.
 * Input: network name ('local', 'testnet' or 'mainnet'). Output: the wallet.
 */
const wallets: Record<string, TestWallet> = {}
function walletOf(network: string): TestWallet {
    if (!wallets[network])
        wallets[network] =
            network === 'local'
                ? new TestWallet(myPrivateKey, new DummyProvider())
                : new TestWallet(
                      myPrivateKey,
                      new DefaultProvider({
                          network:
                              network === 'mainnet'
                                  ? bsv.Networks.mainnet
                                  : bsv.Networks.testnet,
                      })
                  )
    return wallets[network]
}

/**
 * The signer of the tests: the wallet of the NETWORK environment variable
 * (default 'local', an offline DummyProvider).
 * Input: optional extra private keys. Output: the wallet.
 */
export function getDefaultSigner(
    privateKey?: bsv.PrivateKey | bsv.PrivateKey[]
): TestWallet {
    const wallet = walletOf(process.env.NETWORK || 'local')

    if (privateKey) {
        wallet.addPrivateKey(privateKey)
    }

    return wallet
}

export const sleep = async (seconds: number) => {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve({})
        }, seconds * 1000)
    })
}

export function randomPrivateKey() {
    const privateKey = bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
    const publicKey = bsv.PublicKey.fromPrivateKey(privateKey)
    const publicKeyHash = bsv.crypto.Hash.sha256ripemd160(publicKey.toBuffer())
    const address = publicKey.toAddress()
    return [privateKey, publicKey, publicKeyHash, address] as const
}
