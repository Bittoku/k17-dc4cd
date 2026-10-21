/**
 * Tests for the live-rehearsal driver `spikes/tree-rehearsal.ts`.
 *
 * The whole driver runs on the in-memory chain of the other tests with a
 * virtual clock: every `sleep` moves the chain time (MTP) forward by ten
 * minutes, one block, so no test sleeps or uses the network. The chain's
 * script interpreter verifies every machine spend. The run must end with
 * `logHash: verified`, eight paid readings, the admission of C and the
 * removal of B, a refusal of B in round 3, and a halted machine; a second
 * run on the same state must do nothing; no log or summary may hold a secret.
 */
import { expect } from 'chai'
import { mkdtempSync, readFileSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv } from 'scrypt-ts'
import { newAttester } from 'k17-vm'
import {
    DEPOSIT_CAP,
    GATEWAYS,
    RehearsalDeps,
    RehearsalState,
    depositFor,
    runRehearsal,
} from '../spikes/tree-rehearsal'
import { loadConfig } from '../src/chain/config'
import { MemoryChain, T0, keeperOptions } from './utils/consortiumChain'

// Rabin keys from fixed seeds (sponsor, A, B, C); made once (seconds each).
const KEYS = [90, 91, 92, 93].map((seed) => newAttester(Buffer.alloc(32, seed)))

/** One block, seconds: how far a `sleep` moves the virtual chain. */
const BLOCK = 600

describe('tree rehearsal driver', function () {
    this.timeout(1_800_000)

    const dir = mkdtempSync(join(tmpdir(), 'k17rehearsal-'))
    const chain = new MemoryChain()
    const fundingKey = bsv.PrivateKey.fromRandom('testnet')
    const gatewayKeys: bsv.PrivateKey[] = []
    /** Virtual chain time (the median time past). */
    const tip = { mtp: T0 + 10_000 }
    let keyCount = 0
    let sleeps = 0
    let balance = 1_000_000

    /** Dependencies of a run on the in-memory chain. */
    function depsOf(base: string): RehearsalDeps {
        return {
            baseDir: join(base, 'work'),
            logPath: join(base, 'rehearsal.log'),
            fundingWif: () => fundingKey.toWIF(),
            provider: chain,
            signerFor: (cfg) =>
                new TestWallet(bsv.PrivateKey.fromWIF(cfg.wif), chain),
            keeper: keeperOptions(chain, tip),
            balanceOf: async () => balance,
            // The wall clock runs ahead of the chain time, as on testnet.
            now: () => tip.mtp + 300,
            sleep: async () => {
                sleeps++
                tip.mtp += BLOCK
            },
            generateKey: () => KEYS[keyCount++ % KEYS.length],
            newWalletKey: () => {
                const key = bsv.PrivateKey.fromRandom('testnet')
                gatewayKeys.push(key)
                return key
            },
            echo: () => undefined,
        }
    }

    it('sizes the deposit for about 15 cycles and 8 readings, below the cap', () => {
        expect(depositFor()).to.equal(10_500)
        expect(depositFor()).to.be.at.most(DEPOSIT_CAP)
    })

    it('refuses a mainnet funding key and a poor funding key', async () => {
        const mainnet = mkdtempSync(join(tmpdir(), 'k17rehearsal-main-'))
        const code = await runRehearsal({
            ...depsOf(mainnet),
            fundingWif: () => bsv.PrivateKey.fromRandom('livenet').toWIF(),
        })
        expect(code).to.equal(2)
        expect(readFileSync(join(mainnet, 'rehearsal.log'), 'utf8')).to.contain(
            'testnet only'
        )
        const poor = mkdtempSync(join(tmpdir(), 'k17rehearsal-poor-'))
        balance = 199_999
        const poorCode = await runRehearsal(depsOf(poor))
        balance = 1_000_000
        expect(poorCode).to.equal(2)
        expect(readFileSync(join(poor, 'rehearsal.log'), 'utf8')).to.contain(
            'at least 200000 are needed'
        )
    })

    it('runs the whole rehearsal and ends with a verified log hash', async () => {
        const code = await runRehearsal(depsOf(dir))
        const log = readFileSync(join(dir, 'rehearsal.log'), 'utf8')
        if (process.env.REHEARSAL_SHOW) console.log(log)
        expect(code, log.split('\n').slice(-12).join('\n')).to.equal(0)

        const state = JSON.parse(
            readFileSync(join(dir, 'work', 'state.json'), 'utf8')
        ) as RehearsalState
        const summary = JSON.parse(
            readFileSync(join(dir, 'work', 'summary.json'), 'utf8')
        )
        expect(summary.ok).to.equal(true)
        expect(state.verified?.logHash).to.equal('verified')
        expect(state.verified?.problems).to.deep.equal([])
        const readings = state.verified?.readings as {
            round: number
            member: number
        }[]
        expect(readings).to.have.length(8)
        expect(
            readings.map((r) => `${r.round}:${r.member}`).sort()
        ).to.deep.equal(
            ['1:0', '1:1', '1:2', '2:0', '2:1', '2:2', '3:0', '3:2'].sort()
        )
        expect(state.verified?.admissions).to.deep.equal([2])
        expect(state.verified?.removals).to.deep.equal([1])

        // B was refused in round 3 with the roster message.
        expect(state.refusals).to.have.length(1)
        expect(state.refusals[0].gateway).to.equal('B')
        expect(state.refusals[0].message).to.match(/not in the roster/)
        expect(log).to.contain('REFUSAL B round 3')
        expect(state.missed).to.deep.equal([])
        expect(state.halted?.txid).to.match(/^[0-9a-f]{64}$/)

        // Every machine spend passes the script interpreter, and the log
        // names txids with sizes and fees.
        expect(chain.verifyMachineSpends()).to.be.at.least(11)
        expect(log).to.match(/CYCLE round 1 A txid=[0-9a-f]{64} size=\d+/)
        expect(log).to.contain('CYCLE halt')
        expect(log).to.contain('deposit 10500 sats')

        // Configs: mode 600, testnet, git-ignored folder is the caller's job.
        for (const name of [
            'sponsor',
            ...GATEWAYS.map((g) => `gateway-${g}`),
        ]) {
            const path = join(dir, 'work', `${name}.toml`)
            expect(statSync(path).mode & 0o777).to.equal(0o600)
            expect(loadConfig(path).network).to.equal('testnet')
        }

        // No secret in the log, the summary or the state.
        const texts = [
            log,
            readFileSync(join(dir, 'work', 'summary.json'), 'utf8'),
            readFileSync(join(dir, 'work', 'state.json'), 'utf8'),
        ].join('\n')
        const secrets = [
            fundingKey.toWIF(),
            ...gatewayKeys.map((k) => k.toWIF()),
            ...KEYS.flatMap((k) => [k.priv.p.toString(), k.priv.q.toString()]),
        ]
        for (const secret of secrets) expect(texts).to.not.contain(secret)
        expect(existsSync(join(dir, 'work', 'gateway-C.pub'))).to.equal(true)
    })

    it('a second run on the same state does nothing', async () => {
        const before = chain.cycleBroadcasts
        const sleepsBefore = sleeps
        const logBefore = readFileSync(
            join(dir, 'rehearsal.log'),
            'utf8'
        ).length
        const code = await runRehearsal(depsOf(dir))
        expect(code).to.equal(0)
        expect(chain.cycleBroadcasts).to.equal(before)
        expect(sleeps).to.equal(sleepsBefore)
        // The log is append-only: it only grew.
        expect(
            readFileSync(join(dir, 'rehearsal.log'), 'utf8').length
        ).to.be.greaterThan(logBefore)
    })

    it('stops with exit code 3 when a step makes no progress', async () => {
        const stalled = mkdtempSync(join(tmpdir(), 'k17rehearsal-stall-'))
        // The chain clock never moves: the admission waits for MTP for ever.
        const code = await runRehearsal({
            ...depsOf(stalled),
            sleep: async () => {
                sleeps++
            },
            now: (() => {
                let wall = tip.mtp + 300
                return () => (wall += 400)
            })(),
        })
        expect(code).to.equal(3)
        expect(readFileSync(join(stalled, 'rehearsal.log'), 'utf8')).to.match(
            /no progress for 45 minutes|time bound/
        )
    })
})
