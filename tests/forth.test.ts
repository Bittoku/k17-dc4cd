/**
 * Tests for the Forth-subset compiler: programs are compiled, run on the
 * k17-vm reference VM and compared with hand-written reference programs, and
 * token-level checks cover the words the installed VM cannot run yet.
 */

import { expect } from 'chai'
import {
    assemble,
    encodeLeafPre,
    envOf,
    fibonacciProgram,
    initialState,
    outputLog,
    run,
    SparseMerkleTree,
    stepK,
} from 'k17-vm'
import {
    compile,
    compileToHex,
    cycleInstructionCounts,
    ForthCompileError,
    isTreeProgram,
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
                "invalid name 'value'"
            )
        })

        it('allows 152 variables and rejects the 153rd with its line', () => {
            const names = Array.from({ length: 153 }, (_, i) => `v${i}`)
            const lines = names.map((name) => `variable ${name}`)
            const ok = compile(lines.slice(0, 152).join('\n'))
            expect(Object.keys(ok.variables)).to.have.length(152)
            const e = compileError(lines.join('\n'))
            expect(e.line).to.equal(153)
            expect(e.message).to.contain('max 152')
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

        it('does not count IF labels or CALL word names as instructions', () => {
            // main: LIT 1 IF L0 LIT 2 OUT L0: CALL twice YIELD | HALT | twice: LIT 3 OUT EXIT
            const tokens = compile(
                ': twice 3 out ; 1 if 2 out then twice yield'
            ).tokens
            expect(cycleInstructionCounts(tokens)).to.deep.equal([6, 4])
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

    describe('tree instruction words', () => {
        const TREE_WORDS: [string, string][] = [
            ['member', '24'],
            ['lastround', '25'],
            ['attestm', '26'],
            ['payleaf', '27'],
            ['admit', '28'],
            ['remove', '29'],
            ['outh', '2a'],
        ]

        it('compiles each word to its opcode byte', () => {
            for (const [word, byte] of TREE_WORDS)
                expect(compileToHex(word)).to.equal(byte + '00')
        })

        it('rejects redefining any of the words', () => {
            for (const [word] of TREE_WORDS)
                expect(compileError(`: ${word} 1 ;`).message).to.contain(
                    'invalid name'
                )
        })

        it('counts each word as one instruction', () => {
            for (const [word] of TREE_WORDS)
                expect(
                    cycleInstructionCounts(compile(word).tokens)
                ).to.deep.equal([2])
        })

        it('runs member drop lastround out halt on the reference VM', () => {
            const tree = new SparseMerkleTree()
            tree.set(5, encodeLeafPre('11'.repeat(32), '33'.repeat(20), 7n, 1n))
            const state = initialState(
                compileToHex('member drop lastround out halt'),
                undefined,
                { rosterRoot: tree.root() }
            )
            const result = stepK(
                state,
                { ...envOf(0n), tree: tree.proof(5) },
                40
            )
            expect(result.status).to.equal('halted')
            expect(outputLog(result.state)).to.deep.equal([7n])
        })
    })

    describe('isTreeProgram', () => {
        it('is true for a tree program', () => {
            expect(isTreeProgram(compileToHex('member drop halt'))).to.equal(
                true
            )
        })

        it('is false for a non-tree program', () => {
            expect(isTreeProgram(compileToHex('1 2 + out'))).to.equal(false)
        })

        it('ignores tree opcode values inside a LIT operand', () => {
            // LIT 0x24 puts the byte 0x24 into the operand
            const hex = assemble(['LIT', 0x24, 'OUT', 'HALT'])
            expect(hex).to.contain('24')
            expect(isTreeProgram(hex)).to.equal(false)
        })
    })
})
