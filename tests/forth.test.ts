/**
 * Tests for the Forth-subset compiler: programs are compiled, run on the
 * k17-vm reference VM and compared with hand-written reference programs, and
 * token-level checks cover the words the installed VM cannot run yet.
 */

import { expect } from 'chai'
import { fibonacciProgram, initialState, outputLog, run } from 'k17-vm'
import {
    compile,
    compileToHex,
    cycleInstructionCounts,
    ForthCompileError,
} from '../src/forth'
import { relaySource } from '../src/programs/relay'

const LOCK_TIME = 1760000000n

/** Compile and run source on the reference VM. Output: the output log. */
function runForth(source: string): bigint[] {
    return outputLog(run(initialState(compileToHex(source)), LOCK_TIME).state)
}

/** Compile source expecting failure. Output: the thrown ForthCompileError. */
function compileError(source: string): ForthCompileError {
    try {
        compile(source)
    } catch (e) {
        expect(e).to.be.instanceOf(ForthCompileError)
        return e as ForthCompileError
    }
    throw new Error('expected a compile error')
}

describe('forth compiler', () => {
    it('matches fibonacciProgram(10) output', () => {
        const source = `
            variable a variable b variable n   \\ cells 0, 1, 2
            0 a !  1 b !  10 n !
            begin
                a @ out
                a @ b @ +      ( sum )
                a @ b !        ( b = a )
                a !            ( a = sum )
                n @ 1 - dup n ! 0=
            until`
        const expected = outputLog(
            run(initialState(fibonacciProgram(10)), LOCK_TIME).state
        )
        expect(expected.length).to.equal(10)
        expect(runForth(source)).to.deep.equal(expected)
    })

    it('runs a colon definition with CALL/EXIT', () => {
        const source = `
            : emit out ;
            5 begin dup emit 1 - dup 0= until drop`
        const result = compile(source)
        expect(result.words).to.deep.equal(['emit'])
        expect(result.tokens).to.include('CALL')
        expect(runForth(source)).to.deep.equal([5n, 4n, 3n, 2n, 1n])
    })

    it('handles if/else/then in both branches', () => {
        const source = (flag: number) => `
            : pick if 11 else 22 then out ;
            ${flag} pick`
        expect(runForth(source(1))).to.deep.equal([11n])
        expect(runForth(source(0))).to.deep.equal([22n])
    })

    it('handles begin/while/repeat', () => {
        const source = `3 begin dup while dup out 1 - repeat drop`
        expect(runForth(source)).to.deep.equal([3n, 2n, 1n])
    })

    it('handles variables, constants, hex and negative literals', () => {
        const source = `
            7 constant seven
            variable x
            seven x !  x @ out  $ffff0000 out  -1 out`
        expect(compile(source).variables).to.deep.equal({ x: 0 })
        expect(runForth(source)).to.deep.equal([7n, 0xffff0000n, 0xffffffffn])
    })

    it('folds bounty and sigverify literals; emits min and max', () => {
        expect(compile('40000 bounty').tokens).to.deep.equal([
            'BOUNTY',
            40000,
            'HALT',
        ])
        expect(compile('2 sigverify').tokens).to.deep.equal([
            'SIGVERIFY',
            2,
            'HALT',
        ])
        expect(compile('MIN max').tokens).to.deep.equal(['MIN', 'MAX', 'HALT'])
    })

    describe('errors', () => {
        it('reports unknown words', () => {
            const e = compileError('1 out\n  frobnicate')
            expect(e.line).to.equal(2)
            expect(e.message).to.contain('frobnicate')
        })

        it('reports unbalanced then', () => {
            expect(compileError('1\n2 out\nthen').line).to.equal(3)
        })

        it('reports unterminated control flow at its opener', () => {
            expect(compileError('1\nif 2 out').line).to.equal(2)
        })

        it('reports bounty without a literal', () => {
            const e = compileError('1\n2\ndup bounty')
            expect(e.line).to.equal(3)
        })

        it('reports forward references', () => {
            const e = compileError(': a\n  b ;\n: b 1 out ;')
            expect(e.line).to.equal(2)
            expect(e.message).to.contain('forward')
        })
    })

    describe('v2 instructions and roster constants', () => {
        it('compiles attest endorse payslot value to mnemonics', () => {
            expect(
                compile('attest endorse payslot value').tokens
            ).to.deep.equal(['ATTEST', 'ENDORSE', 'PAYSLOT', 'VALUE', 'HALT'])
        })

        it('compiles roster constants to literals', () => {
            expect(
                compile('roster-base slot-cells roster-slots mem-cells out-max')
                    .tokens
            ).to.deep.equal([
                'LIT',
                152,
                'LIT',
                13,
                'LIT',
                8,
                'LIT',
                256,
                'LIT',
                256,
                'HALT',
            ])
        })

        it('rejects a user word named value', () => {
            expect(compileError(': value 1 ;').message).to.contain(
                'invalid name'
            )
        })

        it('rejects a user constant named roster-base', () => {
            expect(compileError('5 constant roster-base').message).to.contain(
                'invalid name'
            )
        })
    })

    describe('cycleInstructionCounts', () => {
        it('counts instructions between yields', () => {
            expect(
                cycleInstructionCounts([
                    'LIT',
                    1,
                    'YIELD',
                    'L:',
                    'DUP',
                    'DROP',
                    'YIELD',
                    'HALT',
                ])
            ).to.deep.equal([2, 3, 1])
        })

        it('gives a 4 instruction deployment cycle for the relay', () => {
            const counts = cycleInstructionCounts(
                compile(
                    relaySource({
                        hops: 3,
                        epoch: 1000,
                        deadline: 1760000000 + 7 * 86400,
                        bountyPerHop: 150,
                    })
                ).tokens
            )
            expect(counts[0]).to.equal(4)
            counts.forEach((count) => expect(count).to.be.at.most(40))
        })
    })
})
