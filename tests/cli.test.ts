/**
 * Tests for the k17forth command-line tool: scenario runner, compile
 * sub-command and the line-at-a-time repl. All run on the reference VM.
 */
import { expect } from 'chai'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
    outputLog,
    newAttester,
    signReading,
    stepK,
    initialState,
    K17Machine,
} from 'k17-vm'
import { compileToHex, relayProgram, relayTag, RelayOptions } from '../src'
import { Scenario, formatReport, runScenario } from '../src/cli/scenario'
import { compileCommand } from '../src/cli/compile'
import { runCommand } from '../src/cli/run'
import { Repl } from '../src/cli/repl'
import { main, onUnhandledRejection } from '../src/cli/k17forth'

const T0 = 1_760_000_000
const OPTS: RelayOptions = {
    hops: 3,
    epoch: 1000,
    deadline: T0 + 7 * 86400,
    bountyPerHop: 150,
}
const READINGS = [2231, 2198, 2305]
const SUM = READINGS.reduce((a, b) => a + b, 0)

/** Seed hex of the named test attesters a1..a3. */
const seedOf = (i: number): string => Buffer.alloc(32, i).toString('hex')

/** Scenario equal to the relay reference-VM test: deploy, three hops, retrieve. */
function relayScenario(): Scenario {
    return {
        attesters: { a1: seedOf(1), a2: seedOf(2), a3: seedOf(3) },
        roster: ['a1', 'a2', 'a3'],
        cycles: [
            { lockTime: T0 },
            ...READINGS.map((reading, k) => ({
                lockTime: T0 + 60 * (k + 1),
                witness: [reading],
                sigverify: {
                    attester: `a${k + 1}`,
                    tag: Number(relayTag(OPTS, k)),
                    value: reading,
                },
            })),
            { lockTime: T0 + 600 },
        ],
    }
}

/** Capture the output of a command function. */
function capture(): {
    io: { out: (s: string) => void; err: (s: string) => void }
    text: () => string
} {
    const lines: string[] = []
    return {
        io: { out: (s) => lines.push(s), err: (s) => lines.push(s) },
        text: () => lines.join('\n'),
    }
}

describe('k17forth', function () {
    this.timeout(120_000)

    describe('runScenario', () => {
        it('reproduces the relay output log with three seeded attesters', () => {
            const reports = runScenario(relayProgram(OPTS), relayScenario())
            expect(reports).to.have.length(5)
            expect(reports.map((r) => r.status)).to.deep.equal([
                'ok',
                'ok',
                'ok',
                'ok',
                'halted',
            ])
            expect(reports[4].out).to.deep.equal([
                3n,
                BigInt(SUM),
                BigInt(Math.floor(SUM / 3)),
                2198n,
                2305n,
            ])
            expect(reports[1].bountyDue).to.equal(150n)
            // agrees with driving the VM by hand
            const att = newAttester(Buffer.alloc(32, 1))
            const base = stepK(
                initialState(relayProgram(OPTS)),
                BigInt(T0),
                K17Machine.K
            )
            const manual = stepK(
                base.state,
                {
                    lockTime: BigInt(T0 + 60),
                    who: 0n,
                    witness: [2231n],
                    roster: [att.pub],
                    sig: signReading(att, relayTag(OPTS, 0), 2231n),
                },
                K17Machine.K
            )
            expect(manual.status).to.equal(reports[1].status)
            expect(reports[1].out).to.deep.equal(outputLog(manual.state))
            expect(reports[1].memory.length).to.be.greaterThan(0)
        })

        it('stops with verify_failed on a wrong signer', () => {
            const sc = relayScenario()
            sc.cycles[1].sigverify.attester = 'a2'
            const reports = runScenario(relayProgram(OPTS), sc)
            expect(reports).to.have.length(2)
            expect(reports[1].status).to.equal('verify_failed')
        })

        it('endorses a new member into a memory roster slot', () => {
            const prog = compileToHex('1 0 1 endorse')
            const sc: Scenario = {
                attesters: { boss: seedOf(4), newbie: seedOf(5) },
                slots: { '0': 'boss' },
                cycles: [
                    {
                        lockTime: T0,
                        endorse: {
                            endorser: 'boss',
                            tag: 1,
                            newMember: 'newbie',
                            payoutHex: '11'.repeat(20),
                            newSlot: 1,
                        },
                    },
                ],
            }
            const reports = runScenario(prog, sc)
            expect(reports[0].roster.map((r) => r.slot)).to.deep.equal([0, 1])
            expect(reports[0].roster[1].payoutHex).to.equal('11'.repeat(20))
        })
    })

    describe('MIN_STEP warning', () => {
        it('warns when consecutive alive cycles are less than 60 s apart', () => {
            const prog = compileToHex('yield yield yield yield')
            const reports = runScenario(prog, {
                attesters: {},
                cycles: [
                    { lockTime: T0 },
                    { lockTime: T0 + 30 }, // 30 s after the first: refused
                    { lockTime: T0 + 90 }, // exactly 60 s after the second
                    { lockTime: T0 + 100 }, // 10 s after the third: refused
                ],
            })
            expect(reports.map((r) => r.warning !== undefined)).to.deep.equal([
                false,
                true,
                false,
                true,
            ])
            expect(reports[1].warning).to.contain('MIN_STEP')
            expect(formatReport(reports[1]).join('\n')).to.contain(
                'the chain would refuse this cycle: MIN_STEP'
            )
            expect(formatReport(reports[2]).join('\n')).to.not.contain(
                'MIN_STEP'
            )
        })

        it('does not warn for a cycle that halts', () => {
            const reports = runScenario(compileToHex('yield'), {
                attesters: {},
                cycles: [{ lockTime: T0 }, { lockTime: T0 + 1 }],
            })
            expect(reports[1].status).to.equal('halted')
            expect(reports[1].warning).to.equal(undefined)
        })

        it('the repl warns on a YIELD less than 60 s after the last one', () => {
            const repl = new Repl()
            repl.execute('.time 1000')
            expect(repl.execute('yield').join('\n')).to.not.contain('MIN_STEP')
            repl.execute('.time 1030')
            expect(repl.execute('yield').join('\n')).to.contain('MIN_STEP')
            repl.execute('.time 1090')
            expect(repl.execute('yield').join('\n')).to.not.contain('MIN_STEP')
        })
    })

    describe('compile', () => {
        it('prints hex, disassembly and a cycles: line', () => {
            const c = capture()
            const code = compileCommand(['examples/relay.fs'], c.io)
            expect(code).to.equal(0)
            expect(
                c
                    .text()
                    .split('\n')
                    .some((l) => l.startsWith('cycles:'))
            ).to.be.true
        })

        it('--json prints one parsable object', () => {
            const c = capture()
            compileCommand(['examples/relay.fs', '--json'], c.io)
            const parsed = JSON.parse(c.text())
            expect(parsed.hex).to.be.a('string')
            expect(parsed.cycles).to.be.an('array')
        })

        it('reports a source error and returns 1', () => {
            const dir = mkdtempSync(join(tmpdir(), 'k17f-'))
            const file = join(dir, 'bad.fs')
            writeFileSync(file, 'nosuchword')
            const c = capture()
            expect(compileCommand([file], c.io)).to.equal(1)
            expect(c.text()).to.contain('nosuchword')
        })
    })

    describe('run', () => {
        it('prints a report per cycle and exits 1 on verify_failed', () => {
            const dir = mkdtempSync(join(tmpdir(), 'k17f-'))
            const prog = join(dir, 'relay.fs')
            writeFileSync(prog, readFileSync('examples/relay.fs', 'utf8'))
            const scFile = join(dir, 'sc.json')
            const sc = relayScenario()
            writeFileSync(scFile, JSON.stringify(sc))
            const c = capture()
            expect(runCommand([prog, '--scenario', scFile], c.io)).to.equal(0)
            expect(c.text()).to.contain('halted')
            sc.cycles[1].sigverify.attester = 'a3'
            writeFileSync(scFile, JSON.stringify(sc))
            const c2 = capture()
            expect(runCommand([prog, '--scenario', scFile], c2.io)).to.equal(1)
            expect(c2.text()).to.contain('verify_failed')
        })
    })

    describe('repl', () => {
        it('executes a line and reports the output log', () => {
            const repl = new Repl()
            expect(repl.execute('1 2 + out').join('\n')).to.contain('out [3]')
        })

        it('keeps stacks, variables and words between lines', () => {
            const repl = new Repl()
            repl.execute('variable x')
            repl.execute(': sq dup * ;')
            repl.execute('7 sq x !')
            const text = repl.execute('x @ 1 +').join('\n')
            expect(text).to.contain('ds [50]')
        })

        it('rolls back a line that blocks on a missing witness', () => {
            const repl = new Repl()
            repl.execute('5')
            const text = repl.execute('in').join('\n')
            expect(text).to.contain('need_witness')
            expect(repl.execute('1 +').join('\n')).to.contain('ds [6]')
        })

        it('supplies witness cells and an attestation to the next line', () => {
            const repl = new Repl()
            repl.execute('.attester a1 ' + seedOf(1))
            repl.execute('.enrol 0 a1')
            repl.execute('.witness 77')
            repl.execute('.attest a1 9 77')
            const text = repl.execute('9 in 0 attest').join('\n')
            expect(text).to.not.contain('need_witness')
            expect(text).to.not.contain('verify_failed')
            expect(text).to.contain('ds []')
            // a signature over another value is refused
            repl.execute('.witness 78')
            repl.execute('.attest a1 9 77')
            expect(repl.execute('9 in 0 attest').join('\n')).to.contain(
                'verify_failed'
            )
        })

        it('.reset clears state and .save writes the accepted source', () => {
            const dir = mkdtempSync(join(tmpdir(), 'k17f-'))
            const file = join(dir, 'out.fs')
            const repl = new Repl()
            repl.execute('1 2')
            repl.execute(`.save ${file}`)
            expect(readFileSync(file, 'utf8')).to.contain('1 2')
            expect(repl.execute('.reset').join('\n')).to.contain('ds []')
        })

        it('reports a compile error without changing state', () => {
            const repl = new Repl()
            repl.execute('4')
            expect(repl.execute('bogus').join('\n')).to.contain('line')
            expect(repl.execute('dup').join('\n')).to.contain('ds [4, 4]')
        })
    })

    describe('dispatch', () => {
        it('prints usage for no arguments and for an unknown command', () => {
            const c = capture()
            expect(main([], c.io)).to.equal(2)
            expect(c.text()).to.contain('usage')
            expect(main(['nope'], c.io)).to.equal(2)
        })

        it('warns on a rejected provider connection check and rethrows other rejections', () => {
            const c = capture()
            onUnhandledRejection(
                new Error('connect failed: Too Many Requests'),
                c.io
            )
            expect(c.text()).to.contain('warning: provider connect failed')
            const other = new Error('boom')
            expect(() => onUnhandledRejection(other, c.io)).to.throw('boom')
        })

        it('loads the K17Machine artifact for a chain command in a fresh process', function () {
            this.timeout(120_000)
            // A new process has no artifact loaded, as when a user runs the
            // tool; after `main(['inspect'])` a machine can be made.
            const script = `
                const { main } = require('./src/cli/k17forth')
                Promise.resolve(main(['inspect'], { out() {}, err() {} })).then(() => {
                    const { newMachine, rosterOf } = require('k17-vm')
                    const econ = { beneficiary: '00'.repeat(20), rewardMin: 1n, slope: 0n, rewardMax: 1n }
                    newMachine('00', econ, 0n, rosterOf())
                    console.log('machine ok')
                })`
            const output = execFileSync(
                process.execPath,
                ['-r', 'ts-node/register', '-e', script],
                { cwd: join(__dirname, '..'), encoding: 'utf8' }
            )
            expect(output).to.contain('machine ok')
        })
    })
})
