/**
 * Live testnet rehearsal driver for tree-mode tooling (Task 8).
 *
 * Runs the whole rehearsal unattended and resumably by calling the real
 * `k17forth` command functions in-process (`deploy`, `inspect`, `admit`,
 * `remove`, `gateway init|run --once`, `keeper`); it holds no deploy, admit,
 * relay or inspect logic of its own. The steps are:
 *   1. setup: a sponsor config and three gateway configs (A, B, C), mode 600,
 *      under `spikes/tree-rehearsal/`; each gateway wallet gets a small
 *      amount for fees from the funding key;
 *   2. deploy a tree machine (genesis members A and B, sponsor, dead-man
 *      6 h) and inspect the genesis;
 *   3. admit C before round 1; every gateway relays one reading in rounds 1
 *      and 2; the sponsor removes B before round 3; in round 3 A and C
 *      relay and B must be refused;
 *   4. after END a keeper tick halts the machine and refunds the sponsor;
 *      `inspect --history` must show `logHash: verified`, the expected paid
 *      readings and the two roster events (admit C, remove B).
 *
 * State is kept in `state.json` next to the configs, so a run that stops can
 * be started again with the same command and goes on where it was. The log
 * `spikes/tree-rehearsal.log` is append-only (timestamps, txids, cycle sizes,
 * fees, every refusal); `summary.json` holds the final record. All text goes
 * through `scrub` (which uses `hideSecrets` of every config) before it is
 * logged, so no WIF or Rabin prime is printed.
 *
 * Waiting is a loop with a 60 s sleep. The chain clock (MTP) decides when a
 * round is open, not the wall clock. A whole run is bounded at 8 hours and
 * any step that makes no progress for 45 minutes (after the time at which it
 * is due) stops the run with a non-zero exit code.
 *
 * Usage:   npm run rehearsal:tree
 *          (same as: npx ts-node spikes/tree-rehearsal.ts)
 * Env:     REHEARSAL_ENV  path of the .env file with PRIVATE_KEY (default
 *                         ../k17-dc4cd/.env, relative to this repository).
 * Exit:    0 success; 1 a step or a check failed; 2 refused to start (not
 *          testnet, funding key too poor); 3 a step stalled or the 8 h
 *          bound was reached.
 * Every dependency (provider, signer factory, clock, sleep, key makers) is
 * injectable through `RehearsalDeps`; `tests/treeRehearsal.test.ts` runs the
 * whole driver on the in-memory chain.
 */

import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { join, resolve } from 'path'
import * as dotenv from 'dotenv'
import { Provider, Signer, bsv } from 'scrypt-ts'
import {
    Attester,
    keyHash,
    newAttester,
    payoutOf,
    pubKeyBytes,
} from 'k17-vm'
import { loadK17Artifact } from '../src/chain/artifact'
import {
    GatewayConfig,
    hideSecrets,
    loadConfig,
    saveGenesisInscription,
    saveMachine,
    saveTipOutpoint,
} from '../src/chain/config'
import { Keeper, KeeperOptions } from '../src/chain/keeper'
import {
    ChainInfo,
    addressBalance,
    chainInfo,
    makeProvider,
    makeSigner,
} from '../src/chain/provider'
import { admitCommand, removeCommand } from '../src/cli/admit'
import { deployCommand } from '../src/cli/deploy'
import { gatewayCommand } from '../src/cli/gateway'
import { inscribeGenesisCommand } from '../src/cli/inscribeGenesis'
import { inspectCommand } from '../src/cli/inspect'
import { keeperCommand } from '../src/cli/keeper'
import type { CliIo } from '../src/cli/k17forth'
import {
    TreeConsortiumOptions,
    roundAt,
    treeConsortiumSource,
} from '../src/programs/treeConsortium'

/** Seconds between the setup chain time and round 1. */
export const START_DELAY = 1800
/** Length of a round, seconds. */
export const PERIOD = 3600
/** Number of rounds. */
export const ROUNDS = 3
/** Satoshis the machine pays per accepted reading. */
export const BOUNTY = 150
/** Accepted reading range. */
export const RANGE = { min: 0, max: 100000 }
/** Dead-man interval, seconds (the 6 h floor). */
export const DEAD_MAN = 21600
/** Cycle reward settings given to `deploy`. */
export const ECON = { rewardMin: 100, slope: 1, rewardMax: 500 }
/** Cycles the deposit is sized for. */
export const DEPOSIT_CYCLES = 15
/** Paid readings the deposit is sized for (3 + 3 + 2). */
export const DEPOSIT_READINGS = 8
/** Largest deposit, satoshis. */
export const DEPOSIT_CAP = 50_000
/** The run aborts when the funding key holds less than this, satoshis. */
export const MIN_FUNDING = 200_000
/** Satoshis sent to each gateway wallet for fees. */
export const GATEWAY_FUNDS = 6_000
/** Seconds between two attempts of a waiting step. */
export const POLL_SECONDS = 60
/** A step may make no progress for this long, seconds (45 minutes). */
export const STALL_SECONDS = 45 * 60
/** The whole run is bounded at this many seconds (8 hours). */
export const TOTAL_SECONDS = 8 * 60 * 60

/** The three gateways. */
export const GATEWAYS = ['A', 'B', 'C'] as const
/** Name of a gateway. */
export type GatewayName = typeof GATEWAYS[number]

/** Fixed test reading of a gateway in a round. */
export function readingOf(name: GatewayName, round: number): number {
    return { A: 1000, B: 2000, C: 3000 }[name] + round
}

/** Deposit for the cycles and readings above, plus a 20 percent margin. */
export function depositFor(): number {
    const raw =
        DEPOSIT_CYCLES * ECON.rewardMax + DEPOSIT_READINGS * BOUNTY
    return Math.min(DEPOSIT_CAP, Math.ceil((raw * 1.2) / 100) * 100)
}

/** One broadcast cycle, as recorded in the summary. */
export interface CycleRecord {
    label: string
    txid: string
    size?: number
    fee?: number | string
    machineSats?: number
    lockTime?: number
    mtp?: number
    round?: number
}

/** The persistent state of a rehearsal (`state.json`). */
export interface RehearsalState {
    version: 1
    network: 'testnet'
    createdAt: number
    program?: TreeConsortiumOptions & { startedMtp: number }
    fundingAddress?: string
    fundingBefore?: number
    deposit?: number
    funded?: string
    deployed?: boolean
    inscribed?: boolean
    genesisChecked?: boolean
    admitted?: { leaf: number; txid: string }
    delivered: Record<string, string>
    removed?: { leaf: number; txid: string }
    refusals: { stage: string; gateway: GatewayName; message: string }[]
    missed: string[]
    tip?: string
    finalTip?: string
    halted?: { txid: string; refund?: number }
    cycles: CycleRecord[]
    verified?: Record<string, unknown>
}

/** Parts of the driver that a test replaces. */
export interface RehearsalDeps {
    /** Folder for configs and state (default `spikes/tree-rehearsal`). */
    baseDir: string
    /** Log file (default `spikes/tree-rehearsal.log`). */
    logPath: string
    /** WIF of the funding key. SECRET: never logged. */
    fundingWif: () => string
    /** Provider that reads and sends transactions. */
    provider: Provider
    /** Wallet signer of a config (default `makeSigner`). */
    signerFor: (cfg: GatewayConfig) => Signer
    /** Keeper options (chain info, spends lookup). */
    keeper?: KeeperOptions
    /** Balance of a testnet address, satoshis. */
    balanceOf: (address: string) => Promise<number>
    /** Wall clock, unix seconds. */
    now: () => number
    /** Wait this many milliseconds. */
    sleep: (ms: number) => Promise<void>
    /** Make a Rabin key. */
    generateKey: () => Attester
    /** Make a wallet key for a gateway. */
    newWalletKey: () => bsv.PrivateKey
    /** Check that git ignores the config folder; throws when it does not. */
    checkIgnored?: (baseDir: string) => void
    /** Console output (default `console.log`). */
    echo?: (line: string) => void
    /** Seconds without progress before a step stops the run. */
    stallSeconds?: number
    /** Seconds bound of the whole run. */
    totalSeconds?: number
    /** Seconds between attempts of a waiting step. */
    pollSeconds?: number
}

/** A step stalled or the run reached its time bound: exit code 3. */
export class StallError extends Error {}
/** The run must not start (mainnet, too little money): exit code 2. */
export class RefusedToStart extends Error {}
/** A step or a check failed: exit code 1. */
export class RehearsalFailure extends Error {}

/** Output sink that keeps the lines of one command. */
function capture(): { lines: string[]; io: CliIo } {
    const lines: string[] = []
    return {
        lines,
        io: {
            out: (line) => lines.push(line),
            err: (line) => lines.push(`ERR ${line}`),
        },
    }
}

/** Matches a WIF key (base58, 51 or 52 characters) and long decimal numbers. */
const SECRET_SHAPES = [
    /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,
    /\b\d{300,}\b/g,
]

/**
 * Run one rehearsal.
 * Input: the dependencies. Output: the exit code (see the header). Never
 * throws; every failure is logged and turned into an exit code.
 */
export async function runRehearsal(deps: RehearsalDeps): Promise<number> {
    const run = new Rehearsal(deps)
    return run.execute()
}

/** The state machine of one rehearsal. */
class Rehearsal {
    private readonly d: RehearsalDeps
    private readonly statePath: string
    private readonly runStart: number
    private state!: RehearsalState
    /** Configs loaded so far, for `scrub`. */
    private readonly known: GatewayConfig[] = []
    private opts!: TreeConsortiumOptions
    private readonly stallMs: number
    private readonly totalMs: number
    private readonly pollMs: number

    constructor(deps: RehearsalDeps) {
        this.d = deps
        this.statePath = join(deps.baseDir, 'state.json')
        this.runStart = deps.now()
        this.stallMs = (deps.stallSeconds ?? STALL_SECONDS) * 1000
        this.totalMs = (deps.totalSeconds ?? TOTAL_SECONDS) * 1000
        this.pollMs = (deps.pollSeconds ?? POLL_SECONDS) * 1000
    }

    // ----- logging and secrets -------------------------------------------

    /** Remove every secret from a text (configs, WIF shapes, long numbers). */
    scrub(text: string): string {
        let result = text
        for (const cfg of this.known) result = hideSecrets(result, cfg)
        for (const shape of SECRET_SHAPES)
            result = result.replace(shape, '[hidden]')
        return result
    }

    /** Append one timestamped line to the log and echo it. */
    log(line: string): void {
        const stamp = new Date(this.d.now() * 1000).toISOString()
        const text = `${stamp} ${this.scrub(line)}`
        appendFileSync(this.d.logPath, text + '\n')
        ;(this.d.echo ?? console.log)(text)
    }

    /** Remember a config so that `scrub` hides its secrets. */
    private remember(cfg: GatewayConfig): GatewayConfig {
        this.known.push(cfg)
        return cfg
    }

    // ----- state ---------------------------------------------------------

    /** Write the state atomically, mode 600. */
    private save(): void {
        const temp = `${this.statePath}.tmp`
        writeFileSync(temp, JSON.stringify(this.state, null, 2), {
            mode: 0o600,
        })
        renameSync(temp, this.statePath)
    }

    private path(name: string): string {
        return join(this.d.baseDir, name)
    }

    private configPath(who: 'sponsor' | GatewayName): string {
        return this.path(who === 'sponsor' ? 'sponsor.toml' : `gateway-${who}.toml`)
    }

    /** Load a config and register it for `scrub`. */
    private config(who: 'sponsor' | GatewayName): GatewayConfig {
        return this.remember(loadConfig(this.configPath(who)))
    }

    // ----- time and waiting ----------------------------------------------

    private async chainInfo(): Promise<ChainInfo> {
        const read =
            this.d.keeper?.chainInfo ?? (() => chainInfo('testnet'))
        return read()
    }

    /** Chain time the next cycle gets: MTP - 1. */
    private async chainTime(): Promise<number> {
        return (await this.chainInfo()).mediantime - 1
    }

    /** Sleep, after checking the bound of the whole run. */
    private async nap(): Promise<void> {
        this.checkTotal()
        await this.d.sleep(this.pollMs)
    }

    private checkTotal(): void {
        if ((this.d.now() - this.runStart) * 1000 > this.totalMs)
            throw new StallError(
                `the run reached its time bound of ${this.totalMs / 3_600_000} hours`
            )
    }

    /**
     * Wait until the chain time reaches `time`. Waiting for a scheduled time
     * is not a stall; only the bound of the whole run applies.
     */
    private async untilChainTime(label: string, time: number): Promise<void> {
        let told = false
        for (;;) {
            let now: number | undefined
            try {
                now = await this.chainTime()
            } catch (e) {
                this.log(`${label}: chain info failed: ${(e as Error).message}`)
            }
            if (now !== undefined && now >= time) return
            if (!told && now !== undefined) {
                this.log(
                    `${label}: waiting for chain time ${time} (now ${now}, ${time - now} s)`
                )
                told = true
            }
            await this.nap()
        }
    }

    /**
     * Try a step until it succeeds. The step returns `undefined` to try
     * again after a pause, or a value when done; it throws for a failure
     * that no retry can change. No progress for the stall time stops the run.
     */
    private async attempts<T>(
        label: string,
        step: () => Promise<T | undefined>
    ): Promise<T> {
        const began = this.d.now()
        for (let n = 1; ; n++) {
            const value = await step()
            if (value !== undefined) return value
            if ((this.d.now() - began) * 1000 > this.stallMs)
                throw new StallError(
                    `${label}: no progress for ${this.stallMs / 60_000} minutes (${n} attempts)`
                )
            await this.nap()
        }
    }

    /** Run a command with a time limit; its lines go to the log. */
    private async command(
        label: string,
        call: (io: CliIo) => Promise<number>
    ): Promise<{ code: number; text: string }> {
        const { lines, io } = capture()
        let timer: ReturnType<typeof setTimeout> | undefined
        const limit = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new StallError(
                            `${label}: the command did not end in ${this.stallMs / 60_000} minutes`
                        )
                    ),
                this.stallMs
            )
        })
        let code: number
        try {
            code = await Promise.race([call(io), limit])
        } finally {
            clearTimeout(timer)
        }
        for (const line of lines) this.log(`[${label}] ${line}`)
        this.log(`[${label}] exit ${code}`)
        return { code, text: lines.join('\n') }
    }

    // ----- chain helpers -------------------------------------------------

    private keeperOf(cfg: GatewayConfig): Keeper {
        return new Keeper(cfg, this.d.provider, this.d.signerFor(cfg), this.d.keeper)
    }

    /** Follow the machine from the sponsor config to its newest output. */
    private async syncTip(): Promise<string | undefined> {
        const tip = await this.keeperOf(this.config('sponsor')).sync()
        if (tip) {
            this.state.tip = tip
            for (const who of ['sponsor', ...GATEWAYS] as const)
                if (existsSync(this.configPath(who)))
                    saveTipOutpoint(this.configPath(who), tip)
            this.save()
        }
        return tip
    }

    /** Fee, size and balance of a cycle transaction; best effort. */
    private async describeCycle(
        label: string,
        text: string,
        round?: number
    ): Promise<CycleRecord | undefined> {
        const txid = /(?:cycle|txid) ([0-9a-f]{64})/.exec(text)?.[1]
        if (!txid) return undefined
        const record: CycleRecord = { label, txid, round }
        const lock = /lockTime (\d+)/.exec(text)
        const mtp = /\(mtp (\d+)\)/.exec(text)
        if (lock) record.lockTime = Number(lock[1])
        if (mtp) record.mtp = Number(mtp[1])
        try {
            const tx = await this.d.provider.getTransaction(txid)
            record.size = tx.toBuffer().length
            record.machineSats = tx.outputs[0]?.satoshis
            let inSats = 0
            for (const input of tx.inputs) {
                const prev = await this.d.provider.getTransaction(
                    input.prevTxId.toString('hex')
                )
                inSats += prev.outputs[input.outputIndex].satoshis
            }
            record.fee = inSats - tx.outputs.reduce((a, o) => a + o.satoshis, 0)
        } catch (e) {
            record.fee = `n/a (${(e as Error).message.slice(0, 60)})`
        }
        this.state.cycles.push(record)
        this.save()
        this.log(
            `CYCLE ${label} txid=${txid} size=${record.size ?? 'n/a'} fee=${
                record.fee ?? 'n/a'
            } machine=${record.machineSats ?? 'n/a'} lockTime=${
                record.lockTime ?? 'n/a'
            } mtp=${record.mtp ?? 'n/a'}${round ? ` round=${round}` : ''}`
        )
        return record
    }

    // ----- the run -------------------------------------------------------

    async execute(): Promise<number> {
        try {
            loadK17Artifact()
            mkdirSync(this.d.baseDir, { recursive: true, mode: 0o700 })
            this.d.checkIgnored?.(this.d.baseDir)
            this.state = existsSync(this.statePath)
                ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as RehearsalState)
                : {
                      version: 1,
                      network: 'testnet',
                      createdAt: this.d.now(),
                      delivered: {},
                      refusals: [],
                      missed: [],
                      cycles: [],
                  }
            this.log(`=== tree rehearsal start (resume: ${existsSync(this.statePath)}) ===`)
            if (this.state.network !== 'testnet')
                throw new RefusedToStart('state is not for testnet')
            await this.setup()
            await this.deploy()
            await this.checkGenesis()
            await this.admit()
            await this.rounds()
            await this.finish()
            await this.verify()
            this.writeSummary(true)
            this.log('=== tree rehearsal PASSED ===')
            return 0
        } catch (e) {
            const message = this.scrub((e as Error).message ?? String(e))
            this.log(`FAILED: ${message}`)
            try {
                if (this.state) this.writeSummary(false, message)
            } catch {
                // the failure is already logged
            }
            if (e instanceof RefusedToStart) return 2
            if (e instanceof StallError) return 3
            return 1
        }
    }

    // ----- step 1: setup -------------------------------------------------

    private async setup(): Promise<void> {
        const wif = this.d.fundingWif()
        const fundingKey = bsv.PrivateKey.fromWIF(wif)
        const network = fundingKey.network.name
        if (network !== 'testnet')
            throw new RefusedToStart(
                `the funding key is for ${network}; this driver runs on testnet only`
            )
        if (this.d.provider.getNetwork().name !== 'testnet')
            throw new RefusedToStart('the provider is not a testnet provider')
        const fundingAddress = fundingKey.toAddress().toString()
        this.state.fundingAddress = fundingAddress
        if (this.state.fundingBefore === undefined) {
            const balance = await this.d.balanceOf(fundingAddress)
            this.log(`funding address ${fundingAddress} balance ${balance} sats`)
            if (balance < MIN_FUNDING)
                throw new RefusedToStart(
                    `the funding key holds ${balance} sats; at least ${MIN_FUNDING} are needed`
                )
            this.state.fundingBefore = balance
        }
        if (!this.state.program) {
            const mtp = (await this.chainInfo()).mediantime
            this.state.program = {
                start: mtp + START_DELAY,
                period: PERIOD,
                rounds: ROUNDS,
                bountyPerReading: BOUNTY,
                range: RANGE,
                startedMtp: mtp,
            }
            this.state.deposit = depositFor()
            this.log(
                `program: start ${this.state.program.start} (mtp ${mtp} + ${START_DELAY}) period ${PERIOD} rounds ${ROUNDS} bounty ${BOUNTY} range ${RANGE.min}..${RANGE.max}; END ${
                    this.state.program.start + ROUNDS * PERIOD
                }`
            )
            this.log(
                `deposit ${this.state.deposit} sats = ceil(1.2 * (${DEPOSIT_CYCLES} cycles * ${ECON.rewardMax} + ${DEPOSIT_READINGS} readings * ${BOUNTY})), cap ${DEPOSIT_CAP}`
            )
            this.save()
        }
        const { startedMtp, ...options } = this.state.program
        void startedMtp
        this.opts = options
        await this.writeConfigs(wif)
        await this.fund()
    }

    /** Write the sponsor and gateway configs and make their Rabin keys. */
    private async writeConfigs(wif: string): Promise<void> {
        const program = this.opts
        const sponsorPath = this.configPath('sponsor')
        if (!existsSync(sponsorPath)) {
            writeFileSync(
                sponsorPath,
                `[network]\nname = "testnet"\n\n[wallet]\nwif = "${wif}"\n`,
                { mode: 0o600 }
            )
            chmodSync(sponsorPath, 0o600)
        }
        for (const name of GATEWAYS) {
            const path = this.configPath(name)
            if (existsSync(path)) continue
            const key = this.d.newWalletKey().toWIF()
            writeFileSync(
                path,
                `[network]\nname = "testnet"\n\n[wallet]\nwif = "${key}"\n\n` +
                    `[gateway]\nmode = "tree"\n\n[consortium]\nstart = ${program.start}\n` +
                    `period = ${program.period}\nrounds = ${program.rounds}\n` +
                    `range_min = ${RANGE.min}\nrange_max = ${RANGE.max}\n`,
                { mode: 0o600 }
            )
            chmodSync(path, 0o600)
        }
        for (const who of ['sponsor', ...GATEWAYS] as const) {
            if (this.config(who).rabinP) continue
            const { code } = await this.command(`init ${who}`, (io) =>
                gatewayCommand(['init', '--config', this.configPath(who)], io, {
                    generate: this.d.generateKey,
                })
            )
            if (code !== 0) throw new RehearsalFailure(`gateway init ${who} failed`)
            this.config(who)
        }
    }

    /** Public identity of a config: key hash, public key hex, payout. */
    private identity(who: 'sponsor' | GatewayName): {
        keyHash: string
        pubKey: string
        payout: string
        address: string
    } {
        const cfg = this.config(who)
        const pub = BigInt(cfg.rabinP as string) * BigInt(cfg.rabinQ as string)
        const address = bsv.PrivateKey.fromWIF(cfg.wif).toAddress().toString()
        return {
            keyHash: keyHash(pub),
            pubKey: pubKeyBytes(pub),
            payout: payoutOf(bsv.Address.fromString(address)),
            address,
        }
    }

    /** One transaction from the funding wallet pays the three gateway wallets. */
    private async fund(): Promise<void> {
        if (this.state.funded) return
        const sponsor = this.config('sponsor')
        const signer = this.d.signerFor(sponsor)
        const owner = await signer.getDefaultAddress()
        const feePerKb = await signer.connectedProvider.getFeePerKb()
        const coins = (await signer.listUnspent(owner)).sort(
            (a, b) => b.satoshis - a.satoshis
        )
        for (let count = 1; count <= coins.length; count++) {
            const tx = new bsv.Transaction().from(coins.slice(0, count))
            for (const name of GATEWAYS)
                tx.to(this.identity(name).address, GATEWAY_FUNDS)
            tx.feePerKb(feePerKb).change(owner)
            if (tx.getChangeOutput() === null) continue
            await signer.signAndsendTransaction(tx)
            this.state.funded = tx.id
            this.save()
            this.log(
                `funded gateways A B C with ${GATEWAY_FUNDS} sats each: txid ${tx.id}`
            )
            return
        }
        throw new RehearsalFailure('the funding wallet cannot pay the gateways')
    }

    // ----- step 2: deploy and genesis -----------------------------------

    private membersPath(): string {
        return this.path('members.json')
    }

    private async deploy(): Promise<void> {
        const sponsorPath = this.configPath('sponsor')
        const sponsor = this.config('sponsor')
        const program = this.opts
        const source = this.path('tree.fs')
        writeFileSync(source, treeConsortiumSource(program))
        const a = this.identity('A')
        const b = this.identity('B')
        writeFileSync(
            this.membersPath(),
            JSON.stringify({
                members: [
                    { index: 0, keyHash: a.keyHash, payout: a.payout, lastRound: 0 },
                    { index: 1, keyHash: b.keyHash, payout: b.payout, lastRound: 0 },
                ],
            })
        )
        if (!this.state.deployed && !sponsor.machineOutpoint) {
            const { code } = await this.command('deploy', (io) =>
                deployCommand(
                    [
                        source,
                        '--config',
                        sponsorPath,
                        '--deposit',
                        String(this.state.deposit),
                        '--reward-min',
                        String(ECON.rewardMin),
                        '--slope',
                        String(ECON.slope),
                        '--reward-max',
                        String(ECON.rewardMax),
                        '--tree',
                        this.membersPath(),
                        '--sponsor',
                        this.identity('sponsor').keyHash,
                        '--dead-man',
                        String(DEAD_MAN),
                    ],
                    io,
                    {
                        signer: this.d.signerFor(sponsor),
                        chainInfo: () => this.chainInfo(),
                        now: this.d.now,
                    }
                )
            )
            const after = this.config('sponsor')
            // A failed inscription leaves the machine deployed: finish it.
            if (code !== 0 && !after.machineOutpoint)
                throw new RehearsalFailure('deploy failed')
        }
        let cfg = this.config('sponsor')
        if (!cfg.genesisInscription) {
            const { code } = await this.command('inscribe-genesis', (io) =>
                inscribeGenesisCommand(
                    [sponsorPath, '--tree', this.membersPath()],
                    io,
                    {
                        provider: this.d.provider,
                        signer: this.d.signerFor(cfg),
                    }
                )
            )
            if (code !== 0) throw new RehearsalFailure('inscribe-genesis failed')
            cfg = this.config('sponsor')
        }
        this.state.deployed = true
        this.state.inscribed = true
        this.save()
        this.log(
            `machine ${cfg.machineOutpoint} instance ${cfg.instanceId} genesis inscription ${cfg.genesisInscription}`
        )
        if (!this.state.cycles.some((c) => c.label === 'deploy') && cfg.machineOutpoint)
            await this.describeCycle(
                'deploy',
                `txid ${cfg.machineOutpoint.split(':')[0]}`
            )
        // The gateways serve the same machine.
        for (const name of GATEWAYS) {
            saveMachine(
                this.configPath(name),
                cfg.machineOutpoint as string,
                cfg.instanceId as string,
                cfg.genesisOutpoint
            )
            saveGenesisInscription(
                this.configPath(name),
                cfg.genesisInscription as string
            )
        }
    }

    private async checkGenesis(): Promise<void> {
        if (this.state.genesisChecked) return
        const cfg = this.config('sponsor')
        const { code, text } = await this.command('inspect genesis', (io) =>
            inspectCommand(
                [
                    cfg.machineOutpoint as string,
                    '--genesis',
                    cfg.genesisInscription as string,
                ],
                io,
                this.d.provider
            )
        )
        if (code !== 0) throw new RehearsalFailure('inspect of the genesis failed')
        if (!/tree: 2 members/.test(text))
            throw new RehearsalFailure(
                'the genesis inscription does not show the roster of 2 members'
            )
        this.state.genesisChecked = true
        this.save()
    }

    // ----- step 3: admit C ----------------------------------------------

    /** Messages of a command that go away after a block or a pause. */
    private static readonly TRANSIENT =
        /next block|waiting for MTP|timed out|Too Many|\b429\b|Not Found|ECONN|ETIMEDOUT|fetch failed|socket|txn-mempool-conflict|chain info/i

    private async admit(): Promise<void> {
        if (this.state.admitted) return
        const c = this.identity('C')
        const pubFile = this.path('gateway-C.pub')
        writeFileSync(pubFile, c.pubKey, { mode: 0o600 })
        const sponsorPath = this.configPath('sponsor')
        const done = await this.attempts('admit C', async () => {
            await this.syncTip()
            const { code, text } = await this.command('admit C', (io) =>
                admitCommand(
                    [sponsorPath, '--member-key', pubFile, '--payout', c.address],
                    io,
                    this.sponsorDeps()
                )
            )
            if (code === 0) return text
            if (Rehearsal.TRANSIENT.test(text)) return undefined
            throw new RehearsalFailure(`admit C failed: ${text}`)
        })
        const leaf = Number(/admitted leaf (\d+)/.exec(done)?.[1])
        const record = await this.describeCycle('admit C', done)
        const chainTime = await this.chainTime().catch(() => undefined)
        this.state.admitted = { leaf, txid: record?.txid ?? '' }
        this.save()
        await this.syncTip()
        this.log(
            `admitted C at leaf ${leaf} (chain time ${chainTime}, round ${
                chainTime === undefined ? '?' : roundAt(this.opts, chainTime)
            })`
        )
    }

    private sponsorDeps() {
        const cfg = this.config('sponsor')
        return {
            provider: this.d.provider,
            signer: this.d.signerFor(cfg),
            keeper: this.d.keeper,
            now: this.d.now,
        }
    }

    // ----- step 4: rounds 1 to 3 ----------------------------------------

    private roundStart(round: number): number {
        return this.opts.start + (round - 1) * this.opts.period
    }

    private async rounds(): Promise<void> {
        for (let round = 1; round <= ROUNDS; round++) {
            const members: GatewayName[] =
                round < 3 ? ['A', 'B', 'C'] : ['A', 'C']
            if (round === 3) {
                await this.removeB()
            }
            for (const name of members) await this.relay(round, name)
            if (round === 3) await this.refuseB()
        }
    }

    /** One gateway relays its fixed reading in a round (`gateway run --once`). */
    private async relay(round: number, name: GatewayName): Promise<void> {
        const key = `${round}:${name}`
        if (this.state.delivered[key] || this.state.missed.includes(key)) return
        const label = `round ${round} ${name}`
        await this.untilChainTime(label, this.roundStart(round))
        const reading = readingOf(name, round)
        const outcome = await this.attempts(label, async () => {
            const now = await this.chainTime().catch(() => undefined)
            if (now !== undefined && roundAt(this.opts, now) > round)
                return { missed: true as const, text: '' }
            await this.syncTip()
            const { code, text } = await this.command(label, (io) =>
                gatewayCommand(
                    [
                        'run',
                        '--config',
                        this.configPath(name),
                        '--interval',
                        '30',
                        '--once',
                    ],
                    io,
                    {
                        provider: this.d.provider,
                        signer: this.d.signerFor(this.config(name)),
                        keeper: this.d.keeper,
                        now: this.d.now,
                        bridge: oneReading(reading),
                    }
                )
            )
            if (code === 0) return { missed: false as const, text }
            const paid = /waiting for next round \(paid in round (\d+)\)/.exec(text)
            if (paid && Number(paid[1]) >= round)
                return { missed: false as const, text: '', already: true }
            if (/not in the roster/.test(text))
                throw new RehearsalFailure(
                    `${label}: refused although it should be a member: ${text}`
                )
            if (/the machine rejects it|refused|has ended/.test(text))
                throw new RehearsalFailure(`${label} failed: ${text}`)
            return undefined
        })
        if (outcome.missed) {
            this.state.missed.push(key)
            this.save()
            this.log(`${label}: the round ended before the reading went out (missed)`)
            return
        }
        const record = await this.describeCycle(label, outcome.text, round)
        this.state.delivered[key] = record?.txid ?? 'already paid'
        this.save()
        await this.syncTip()
        this.log(`${label}: delivered reading ${reading}`)
    }

    /** The sponsor removes B once all of round 2 is paid, before round 3. */
    private async removeB(): Promise<void> {
        if (this.state.removed) return
        const pubFile = this.path('gateway-B.pub')
        writeFileSync(pubFile, this.identity('B').pubKey, { mode: 0o600 })
        const sponsorPath = this.configPath('sponsor')
        const text = await this.attempts('remove B', async () => {
            await this.syncTip()
            const { code, text } = await this.command('remove B', (io) =>
                removeCommand(
                    [sponsorPath, '--member-key', pubFile],
                    io,
                    this.sponsorDeps()
                )
            )
            if (code === 0) return text
            if (Rehearsal.TRANSIENT.test(text)) return undefined
            throw new RehearsalFailure(`remove B failed: ${text}`)
        })
        const record = await this.describeCycle('remove B', text)
        const chainTime = await this.chainTime().catch(() => undefined)
        const leaf = Number(/removed leaf (\d+)/.exec(text)?.[1])
        this.state.removed = { leaf, txid: record?.txid ?? '' }
        this.save()
        await this.syncTip()
        const round = chainTime === undefined ? undefined : roundAt(this.opts, chainTime)
        this.log(
            `removed B (leaf ${leaf}) at chain time ${chainTime} in round ${round}` +
                (round !== undefined && round >= 3
                    ? ' WARNING: after round 3 opened'
                    : '')
        )
    }

    /** B must be refused in round 3: "not in the roster". */
    private async refuseB(): Promise<void> {
        if (this.state.refusals.some((r) => r.stage === 'round 3')) return
        const message = await this.attempts('B refused in round 3', async () => {
            await this.syncTip()
            const { text } = await this.command('round 3 B (must be refused)', (io) =>
                gatewayCommand(
                    [
                        'run',
                        '--config',
                        this.configPath('B'),
                        '--interval',
                        '30',
                        '--once',
                    ],
                    io,
                    {
                        provider: this.d.provider,
                        signer: this.d.signerFor(this.config('B')),
                        keeper: this.d.keeper,
                        now: this.d.now,
                        bridge: oneReading(readingOf('B', 3)),
                    }
                )
            )
            const line = text
                .split('\n')
                .find((l) => /not in the roster/.test(l))
            if (line) return line
            if (/cycle [0-9a-f]{64}/.test(text))
                throw new RehearsalFailure(
                    'B relayed a reading in round 3 although it was removed'
                )
            return undefined
        })
        this.state.refusals.push({ stage: 'round 3', gateway: 'B', message })
        this.save()
        this.log(`REFUSAL B round 3: ${message}`)
    }

    // ----- step 5: END, halt, refund ------------------------------------

    private async finish(): Promise<void> {
        if (this.state.halted) return
        const end = this.opts.start + ROUNDS * this.opts.period
        await this.untilChainTime('END', end + 1)
        // The last live machine output stays inspectable after the halt.
        const tip = await this.syncTip()
        if (tip) this.state.finalTip = tip
        this.save()
        const balanceBefore = await this.d.balanceOf(
            this.state.fundingAddress as string
        )
        const sponsorPath = this.configPath('sponsor')
        const text = await this.attempts('halt', async () => {
            const { code, text } = await this.command('keeper tick', (io) =>
                keeperCommand(['--config', sponsorPath, '--interval', '1'], io, {
                    provider: this.d.provider,
                    signer: this.d.signerFor(this.config('sponsor')),
                    keeper: this.d.keeper,
                    now: this.d.now,
                    sleep: async () => undefined,
                    ticks: 1,
                })
            )
            if (/-> halted/.test(text)) return text
            if (code !== 0 && !Rehearsal.TRANSIENT.test(text))
                throw new RehearsalFailure(`keeper tick failed: ${text}`)
            return undefined
        })
        const record = await this.describeCycle('halt', text)
        const refund = await this.refundOf(record?.txid)
        this.state.halted = { txid: record?.txid ?? '', refund }
        this.save()
        this.log(
            `machine halted: txid ${record?.txid} refund ${refund ?? 'n/a'} sats (funding balance before ${balanceBefore})`
        )
    }

    /** Satoshis the halting cycle sent to the sponsor address; best effort. */
    private async refundOf(txid?: string): Promise<number | undefined> {
        if (!txid) return undefined
        try {
            const tx = await this.d.provider.getTransaction(txid)
            const address = this.state.fundingAddress as string
            return tx.outputs
                .filter((o) => o.script.isPublicKeyHashOut())
                .filter((o) => o.script.toAddress('testnet').toString() === address)
                .reduce((a, o) => a + o.satoshis, 0)
        } catch {
            return undefined
        }
    }

    // ----- step 6: verify -----------------------------------------------

    private async verify(): Promise<void> {
        const sponsorPath = this.configPath('sponsor')
        const tip = this.state.finalTip
        if (!tip) throw new RehearsalFailure('no final machine output was recorded')
        const { code, text } = await this.command('inspect --history', (io) =>
            inspectCommand([tip, '--history', '--config', sponsorPath], io, this.d.provider)
        )
        const problems: string[] = []
        if (code !== 0) problems.push(`inspect exited ${code}`)
        if (!/logHash: verified/.test(text)) problems.push('logHash is not verified')
        const readings = [
            ...text.matchAll(
                /^\s+round (\d+) member (\d+) logged \[([^\]]*)\] paid (\d+) sats/gm
            ),
        ].map((m) => ({
            round: Number(m[1]),
            member: Number(m[2]),
            logged: m[3],
            paid: Number(m[4]),
        }))
        const leafOf = { A: 0, B: 1, C: this.state.admitted?.leaf ?? 2 }
        const expected = new Set<string>()
        for (let r = 1; r <= ROUNDS; r++)
            for (const name of r < 3 ? GATEWAYS : (['A', 'C'] as const))
                expected.add(`${r}:${leafOf[name]}`)
        const got = new Set(readings.map((r) => `${r.round}:${r.member}`))
        for (const e of expected) if (!got.has(e)) problems.push(`paid reading missing: round:leaf ${e}`)
        for (const g of got) if (!expected.has(g)) problems.push(`unexpected paid reading: round:leaf ${g}`)
        if (readings.length !== expected.size)
            problems.push(`${readings.length} paid readings, expected ${expected.size}`)
        for (const r of readings)
            if (r.paid !== BOUNTY)
                problems.push(`round ${r.round} member ${r.member} paid ${r.paid}, expected ${BOUNTY}`)
        const admits = [...text.matchAll(/seq \d+ admit leaf (\d+)/g)].map((m) => Number(m[1]))
        const removes = [...text.matchAll(/seq \d+ remove leaf (\d+)/g)].map((m) => Number(m[1]))
        if (admits.length !== 1 || admits[0] !== leafOf.C)
            problems.push(`admissions ${JSON.stringify(admits)}, expected [${leafOf.C}]`)
        if (removes.length !== 1 || removes[0] !== leafOf.B)
            problems.push(`removals ${JSON.stringify(removes)}, expected [${leafOf.B}]`)
        if (!/roster \(2 members\)/.test(text))
            problems.push('the roster at the tip does not hold 2 members')
        const history = /history \((\d+) cycles/.exec(text)?.[1]
        this.state.verified = {
            tip,
            logHash: /logHash: (\w+)/.exec(text)?.[1],
            historyCycles: history ? Number(history) : undefined,
            readings,
            admissions: admits,
            removals: removes,
            problems,
        }
        this.save()
        this.log(
            `VERIFY logHash ${(this.state.verified.logHash as string) ?? '?'}, ${readings.length} paid readings, admissions ${JSON.stringify(admits)}, removals ${JSON.stringify(removes)}, history cycles ${history}`
        )
        if (problems.length)
            throw new RehearsalFailure(`verification failed: ${problems.join('; ')}`)
        if (this.state.missed.length)
            throw new RehearsalFailure(`missed relays: ${this.state.missed.join(', ')}`)
    }

    // ----- summary -------------------------------------------------------

    private writeSummary(ok: boolean, failure?: string): void {
        const cfg = existsSync(this.configPath('sponsor'))
            ? loadConfig(this.configPath('sponsor'))
            : undefined
        const fees = this.state.cycles
            .map((c) => c.fee)
            .filter((f): f is number => typeof f === 'number')
        const summary = {
            ok,
            failure,
            network: 'testnet',
            program: this.state.program,
            deposit: this.state.deposit,
            machine: cfg?.machineOutpoint,
            instanceId: cfg?.instanceId,
            genesisInscription: cfg?.genesisInscription,
            fundingTx: this.state.funded,
            cycles: this.state.cycles,
            totalCycleFees: fees.reduce((a, b) => a + b, 0),
            delivered: this.state.delivered,
            missed: this.state.missed,
            admitted: this.state.admitted,
            removed: this.state.removed,
            refusals: this.state.refusals,
            halted: this.state.halted,
            verified: this.state.verified,
            fundingBefore: this.state.fundingBefore,
        }
        writeFileSync(
            this.path('summary.json'),
            this.scrub(JSON.stringify(summary, null, 2)),
            { mode: 0o600 }
        )
    }
}

/** A bridge with a single reading. */
async function* oneReading(reading: number): AsyncGenerator<number> {
    yield reading
}

/** Read the funding WIF from the .env file without printing it. */
function fundingWifFromEnv(): string {
    const root = resolve(__dirname, '..')
    const envPath =
        process.env.REHEARSAL_ENV ?? resolve(root, '..', 'k17-dc4cd', '.env')
    const wif = dotenv.parse(readFileSync(envPath))['PRIVATE_KEY']
    if (!wif) throw new RefusedToStart(`${envPath} has no PRIVATE_KEY`)
    return wif
}

/** Throw unless git ignores the configs under `baseDir`. */
function gitIgnores(baseDir: string): void {
    try {
        execFileSync('git', ['check-ignore', '-q', join(baseDir, 'sponsor.toml')], {
            cwd: resolve(__dirname, '..'),
        })
    } catch {
        throw new RefusedToStart(
            `git does not ignore ${baseDir}; add spikes/tree-rehearsal/ to .gitignore`
        )
    }
}

/** The dependencies of a live testnet run. */
export function liveDeps(): RehearsalDeps {
    const root = resolve(__dirname, '..')
    const provider = makeProvider('testnet')
    return {
        baseDir: join(root, 'spikes', 'tree-rehearsal'),
        logPath: join(root, 'spikes', 'tree-rehearsal.log'),
        fundingWif: fundingWifFromEnv,
        provider,
        signerFor: (cfg) => makeSigner(cfg, provider),
        balanceOf: (address) => addressBalance('testnet', address),
        now: () => Math.floor(Date.now() / 1000),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        generateKey: () => newAttester(),
        newWalletKey: () => bsv.PrivateKey.fromRandom('testnet'),
        checkIgnored: gitIgnores,
    }
}

if (require.main === module) {
    process.on('unhandledRejection', (reason) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        // Providers leave a failed connection check unhandled; it is a warning.
        if (/^connect failed/.test(message)) console.error(`warning: ${message}`)
        else throw reason
    })
    runRehearsal(liveDeps()).then((code) => {
        process.exitCode = code
    })
}
