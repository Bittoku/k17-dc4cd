/**
 * THROWAWAY SPIKE (Task 0): BSV testnet broadcast feasibility for K17+ cycles.
 *
 * Deploys a heartbeat machine and an attestation machine from the funding key
 * in .env (PRIVATE_KEY, testnet only), advances them ten cycles in total with
 * nLockTime one minute apart, and prints for each cycle the txid, size, fee,
 * the provider response and broadcast duration. Afterwards polls WhatsOnChain
 * for confirmation of the first and last txids.
 *
 * Usage:  npx ts-node spikes/testnet-broadcast.ts
 * Env:    SPIKE_PROVIDER=default|woc (default: default)
 *         SPIKE_DRY=1 uses a DummyProvider and a random key (no network).
 * Output: console log only; not part of the build (see tsconfig exclude).
 */
import {
    bsv,
    DefaultProvider,
    DummyProvider,
    TestWallet,
    WhatsonchainProvider,
    toByteString,
} from 'scrypt-ts'
import {
    K17Machine,
    addrOf,
    attestProgram,
    bindCycleBuilder,
    heartbeatProgram,
    newAttester,
    newMachine,
    planCycle,
    rosterOf,
    signReading,
    NO_SIG,
} from 'k17-vm'
import * as dotenv from 'dotenv'
import { RabinSig } from 'scrypt-ts-lib'

dotenv.config({ path: '.env' })

const DRY = process.env.SPIKE_DRY === '1'
const PROVIDER_NAME = process.env.SPIKE_PROVIDER || 'default'
const WOC = 'https://api.whatsonchain.com/v1/bsv/test'
const DEPOSIT = 20_000
const ECON_NUMBERS = { rewardMin: 100n, slope: 1n, rewardMax: 500n }

/** Sleep for `ms` milliseconds. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fetch JSON from WhatsOnChain; returns text on non-JSON, null on network error. */
async function wocGet(path: string): Promise<any> {
    try {
        const res = await fetch(`${WOC}${path}`)
        const text = await res.text()
        try {
            return JSON.parse(text)
        } catch {
            return `HTTP ${res.status}: ${text}`
        }
    } catch (e) {
        return `fetch error: ${(e as Error).message}`
    }
}

/** Fee of a transaction: sum of input satoshis minus sum of output satoshis. */
function feeOf(tx: bsv.Transaction): number {
    const inSum = tx.inputs.reduce((a, i: any) => a + (i.output?.satoshis ?? 0), 0)
    const outSum = tx.outputs.reduce((a, o) => a + o.satoshis, 0)
    return inSum - outSum
}

interface Row {
    label: string
    txid: string
    size: number
    fee: number
    ms: number
    response: string
}
const rows: Row[] = []

/** Run one cycle live and record a Row. Returns the next machine (or undefined). */
async function runCycle(
    label: string,
    m: K17Machine,
    value: bigint,
    lockTime: bigint,
    keeper: bsv.Address,
    witness: bigint[] = [],
    sig: RabinSig = NO_SIG
): Promise<{ next?: K17Machine; remaining: bigint }> {
    const plan = planCycle(m, value, lockTime, keeper, witness, sig)
    const opts = bindCycleBuilder(m, plan, keeper, lockTime)
    const t0 = Date.now()
    let tx: bsv.Transaction
    try {
        const res = await m.methods.step(
            addrOf(keeper),
            toByteString(plan.witnessHex),
            plan.sig.s,
            toByteString(plan.sig.padding),
            toByteString(plan.keyAHex),
            toByteString(plan.keyBHex),
            toByteString(plan.payoutHex),
            opts
        )
        tx = res.tx
    } catch (e) {
        const msg = (e as Error).message || String(e)
        console.log(`[${label}] REJECTED after ${Date.now() - t0} ms: ${msg}`)
        rows.push({ label, txid: '-', size: 0, fee: 0, ms: Date.now() - t0, response: `REJECTED: ${msg}` })
        throw e
    }
    const ms = Date.now() - t0
    const size = tx.toBuffer().length
    const row: Row = {
        label,
        txid: tx.id,
        size,
        fee: feeOf(tx),
        ms,
        response: `accepted (txid ${tx.id})`,
    }
    rows.push(row)
    console.log(`[${label}] txid=${row.txid} size=${size} fee=${row.fee} broadcast_ms=${ms} response=${row.response}`)
    return { next: plan.halted ? undefined : plan.next, remaining: plan.remaining }
}

/** Poll WhatsOnChain once a minute (up to 10 min) for a block height on `txid`. */
async function pollConfirm(txid: string, startedAt: number): Promise<string> {
    for (let i = 0; i < 10; i++) {
        const r = await wocGet(`/tx/hash/${txid}`)
        if (r && typeof r === 'object' && r.blockheight) {
            return `confirmed at height ${r.blockheight} after ${Math.round((Date.now() - startedAt) / 1000)} s`
        }
        const brief = typeof r === 'string' ? r.slice(0, 120) : 'in mempool/no height'
        console.log(`  poll ${i + 1}/10 ${txid.slice(0, 12)}: ${brief}`)
        if (i < 9) await sleep(60_000)
    }
    return 'unconfirmed after 10 min'
}

async function main() {
    const artifact = require('k17-vm/artifacts/k17Machine.json')
    await K17Machine.loadArtifact(artifact)

    const privateKey = DRY
        ? bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
        : bsv.PrivateKey.fromWIF(process.env.PRIVATE_KEY as string)
    const address = privateKey.toAddress(bsv.Networks.testnet)
    console.log(`network=testnet dry=${DRY} provider=${DRY ? 'dummy' : PROVIDER_NAME}`)
    console.log(`funding address: ${address.toString()}`)

    const provider = DRY
        ? new DummyProvider()
        : PROVIDER_NAME === 'woc'
        ? new WhatsonchainProvider(bsv.Networks.testnet)
        : new DefaultProvider({ network: bsv.Networks.testnet })
    const signer = new TestWallet(privateKey, provider)

    if (!DRY) {
        const bal = await wocGet(`/address/${address.toString()}/balance`)
        console.log(`WhatsOnChain balance: ${JSON.stringify(bal)}`)
        try {
            console.log(`provider.getBalance: ${JSON.stringify(await signer.getBalance())}`)
        } catch (e) {
            console.log(`provider.getBalance error: ${(e as Error).message}`)
        }
    }

    const econ = { beneficiary: addrOf(address), ...ECON_NUMBERS }
    const start = Math.floor(Date.now() / 1000) - 600
    const deployTime = BigInt(start)
    let n = 0
    const nextLock = () => BigInt(start + 60 * ++n)

    // Machine 1: heartbeat, 8 cycles.
    const m1 = newMachine(heartbeatProgram(), econ, deployTime)
    await m1.connect(signer)
    let t0 = Date.now()
    const dep1 = await m1.deploy(DEPOSIT)
    console.log(`deploy heartbeat: txid=${dep1.id} size=${dep1.toBuffer().length} ms=${Date.now() - t0}`)
    const startedAt = Date.now()

    let m: K17Machine | undefined = m1
    let value = BigInt(DEPOSIT)
    for (let i = 1; i <= 8 && m; i++) {
        const r = await runCycle(`hb-${i}`, m, value, nextLock(), address)
        m = r.next
        value = r.remaining
    }

    // Machine 2: attestation, 2 cycles.
    const attA = newAttester(Buffer.alloc(32, 1))
    const attB = newAttester(Buffer.alloc(32, 2))
    const m2 = newMachine(attestProgram(1), econ, deployTime, rosterOf([attA.pub, attB.pub]))
    await m2.connect(signer)
    t0 = Date.now()
    const dep2 = await m2.deploy(DEPOSIT)
    console.log(`deploy attest: txid=${dep2.id} size=${dep2.toBuffer().length} ms=${Date.now() - t0}`)
    let a: K17Machine | undefined = m2
    value = BigInt(DEPOSIT)
    let r = await runCycle('at-1', a, value, nextLock(), address)
    a = r.next
    value = r.remaining
    r = await runCycle('at-2', a as K17Machine, value, nextLock(), address, [5n, 2231n], signReading(attB, 5n, 2231n))

    console.log('\n=== SUMMARY ===')
    for (const x of rows) console.log(JSON.stringify(x))

    if (!DRY) {
        const first = rows[0].txid
        const last = rows[rows.length - 1].txid
        console.log('\npolling confirmation of first and last txid')
        console.log(`first ${first}: ${await pollConfirm(first, startedAt)}`)
        console.log(`last ${last}: ${await pollConfirm(last, startedAt)}`)
        const bal = await wocGet(`/address/${address.toString()}/balance`)
        console.log(`final WhatsOnChain balance: ${JSON.stringify(bal)}`)
    }
}

main().catch((e) => {
    console.error('SPIKE FAILED:', (e as Error).message)
    process.exit(1)
})
