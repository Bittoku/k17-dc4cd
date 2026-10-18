/**
 * Test signer key. Local tests use scrypt-ts's DummyProvider, so the key is
 * never funded; it is generated once and kept in `.env` (git-ignored).
 */
import { bsv } from 'scrypt-ts'
import * as dotenv from 'dotenv'
import * as fs from 'fs'

/** Load PRIVATE_KEY from .env or generate one and save it. */
export function genPrivKey(network: bsv.Networks.Network): bsv.PrivateKey {
    dotenv.config({ path: '.env' })
    const privKeyStr = process.env.PRIVATE_KEY
    if (privKeyStr) return bsv.PrivateKey.fromWIF(privKeyStr)
    const privKey = bsv.PrivateKey.fromRandom(network)
    fs.writeFileSync('.env', `PRIVATE_KEY="${privKey}"`)
    return privKey
}

export const myPrivateKey = genPrivKey(bsv.Networks.testnet)
