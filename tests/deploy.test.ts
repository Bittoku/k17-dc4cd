/**
 * Tree-mode deployment tests: `deploy --tree`, the genesis inscription and
 * `inscribe-genesis`. They run on the in-memory chain (no network): a tree
 * machine is deployed, the inscription transaction is read back from the
 * chain and rebuilt into a roster, and the refusals and the failure path are
 * checked. The 1Sat script helpers have their own tests at the end.
 */
import { expect } from 'chai'
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet, bsv } from 'scrypt-ts'
import { K17Machine } from 'k17-vm'
import { describeConfig, loadConfig } from '../src/chain/config'
import { inscriptionScript, parseInscription } from '../src/chain/inscription'
import { GenesisRoster, RosterMirror } from '../src/chain/roster'
import { deployCommand } from '../src/cli/deploy'
import { inscribeGenesisCommand } from '../src/cli/inscribeGenesis'
import { main } from '../src/cli/k17forth'
import { treeConsortiumSource } from '../src/programs/treeConsortium'
import { MemoryChain, WALLET_KEY, sink } from './utils/consortiumChain'

const T0 = 1_760_000_000
const FUNDING = 100_000
const SPONSOR_HASH = '5a'.repeat(32)

/** Chain that refuses the inscription transaction (a 1 satoshi first output) while `failInscription` is set. */
class FlakyChain extends MemoryChain {
    failInscription = false

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const tx = new bsv.Transaction(rawTxHex)
        if (this.failInscription && tx.outputs[0].satoshis === 1)
            throw new Error('inscription broadcast refused')
        return super.sendRawTransaction(rawTxHex)
    }
}

/**
 * Member list fixture.
 * Input: the number of members. Output: members at leaf 0..count-1 with
 * distinct key hashes and payouts.
 */
function membersOf(count: number): GenesisRoster['members'] {
    return Array.from({ length: count }, (_, i) => ({
        index: i,
        keyHash: (i + 1).toString(16).padStart(64, '0'),
        payout: (i + 1).toString(16).padStart(40, 'b'),
        lastRound: 0,
    }))
}

/**
 * Chain whose coin listing lags: it always lists the same wallet coin, as an
 * indexer does that has not yet seen the deploy spend it. `conflictOnce`
 * makes the first inscription broadcast fail with a mempool conflict.
 */
class LaggingChain extends MemoryChain {
    conflictOnce = false
    inscriptionAttempts = 0
    /** The coins the deploy spent; once set, the listing shows only these. */
    stale: {
        txId: string
        outputIndex: number
        script: string
        satoshis: number
    }[] = []
    spentOutpoints: string[] = []

    async listUnspent(
        address: bsv.Address,
        options?: Parameters<MemoryChain['listUnspent']>[1]
    ) {
        if (this.stale.length > 0)
            return this.stale.map((coin) => ({
                ...coin,
                script: bsv.Script.fromAddress(address).toHex(),
            }))
        return super.listUnspent(address, options)
    }

    async sendRawTransaction(rawTxHex: string): Promise<string> {
        const tx = new bsv.Transaction(rawTxHex)
        if (tx.outputs[0].satoshis === 1) {
            this.inscriptionAttempts++
            if (this.conflictOnce && this.inscriptionAttempts === 1)
                throw new Error('258: txn-mempool-conflict')
        } else {
            // The deploy: the indexer keeps listing what it spent.
            this.spentOutpoints.push(
                ...tx.inputs.map(
                    (i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`
                )
            )
            this.stale = this.stale.concat(
                tx.inputs.map((i) => ({
                    txId: i.prevTxId.toString('hex'),
                    outputIndex: i.outputIndex,
                    script: '',
                    satoshis: 9_999_999_999,
                }))
            )
        }
        return super.sendRawTransaction(rawTxHex)
    }
}

describe('deploy --tree and inscribe-genesis', function () {
    this.timeout(120000)
    const dir = mkdtempSync(join(tmpdir(), 'k17tree-'))
    const treeSource = join(dir, 'tree.fs')
    const plainSource = join(dir, 'beat.fs')
    let counter = 0

    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
        writeFileSync(
            treeSource,
            treeConsortiumSource({
                start: T0 + 1000,
                period: 1000,
                rounds: 3,
                bountyPerReading: 150,
                range: { min: 4000, max: 6000 },
            })
        )
        writeFileSync(plainSource, ': beat begin time out again ; beat\n')
    })

    /** Write a private testnet or mainnet config. Output: its path. */
    function configFile(network = 'testnet'): string {
        const path = join(dir, `gw-${counter++}.toml`)
        writeFileSync(
            path,
            `# sponsor config\n[network]\nname = "${network}"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n`
        )
        chmodSync(path, 0o600)
        return path
    }

    /** Write a member list file. Output: its path. */
    function membersFile(members: unknown[]): string {
        const path = join(dir, `members-${counter++}.json`)
        writeFileSync(path, JSON.stringify({ members }))
        return path
    }

    /** Deploy arguments for a source file and config. */
    const args = (source: string, config: string, extra: string[] = []) => [
        source,
        '--config',
        config,
        '--deposit',
        String(FUNDING),
        '--reward-min',
        '100',
        '--slope',
        '1',
        '--reward-max',
        '500',
        ...extra,
    ]

    /** Test parts: the wallet on a chain, a fixed tip and clock. */
    function parts(chain: MemoryChain) {
        return {
            signer: new TestWallet(WALLET_KEY, chain),
            chainInfo: async () => ({ mediantime: T0, blocks: 1 }),
            now: () => T0,
        }
    }

    /** The genesis roster that the inscription of an outpoint holds. */
    function publishedRoster(chain: MemoryChain, outpoint: string) {
        const [txid, vout] = outpoint.split(':')
        const output = chain.txs.get(txid)!.outputs[Number(vout)]
        const found = parseInscription(output.script)!
        return {
            output,
            found,
            genesis: JSON.parse(found.body.toString('utf8')) as GenesisRoster,
        }
    }

    it('deploys with the list root and publishes the list as a 1Sat inscription', async () => {
        const chain = new MemoryChain()
        const config = configFile()
        const list = membersFile(membersOf(5))
        const { lines, io } = sink()
        const code = await deployCommand(
            args(treeSource, config, [
                '--tree',
                list,
                '--sponsor',
                SPONSOR_HASH,
            ]),
            io,
            parts(chain)
        )
        expect(lines.join('\n')).to.not.contain('ERR')
        expect(code).to.equal(0)
        expect(statSync(config).mode & 0o777).to.equal(0o600)
        const cfg = loadConfig(config)
        const [machineTxid] = cfg.machineOutpoint!.split(':')
        const machine = K17Machine.fromTx(
            chain.txs.get(machineTxid)!,
            0
        ) as K17Machine
        const expectedRoot = RosterMirror.fromMembers(membersOf(5)).root()
        expect(machine.rosterRoot).to.equal(expectedRoot)
        expect(machine.sponsorKeyHash).to.equal(SPONSOR_HASH)
        expect(cfg.instanceId).to.equal(machine.instanceId)

        const { output, found, genesis } = publishedRoster(
            chain,
            cfg.genesisInscription!
        )
        expect(output.satoshis).to.equal(1)
        expect(found.contentType).to.equal('application/json')
        expect(genesis.k17).to.equal('roster')
        expect(genesis.instanceId).to.equal(machine.instanceId)
        expect(genesis.rosterRoot).to.equal(expectedRoot)
        expect(RosterMirror.fromGenesis(genesis).root()).to.equal(
            machine.rosterRoot
        )
        // the inscription is owned by the sponsor wallet
        expect(output.script.toHex()).to.contain(
            bsv.Script.buildPublicKeyHashOut(WALLET_KEY.toAddress()).toHex()
        )
        expect(readFileSync(config, 'utf8')).to.contain('# sponsor config')
        expect(lines.join('\n')).to.not.contain(WALLET_KEY.toWIF())
    })

    it('funds the inscription from the deploy change when the listing still shows the spent coins', async () => {
        const chain = new LaggingChain()
        const config = configFile()
        const list = membersFile(membersOf(4))
        const { lines, io } = sink()
        const code = await deployCommand(
            args(treeSource, config, [
                '--tree',
                list,
                '--sponsor',
                SPONSOR_HASH,
            ]),
            io,
            { ...parts(chain), inscriptionPauseMs: 0 }
        )
        expect(lines.join('\n')).to.not.contain('failed')
        expect(code).to.equal(0)
        const cfg = loadConfig(config)
        const [inscriptionTxid] = cfg.genesisInscription!.split(':')
        expect(chain.spentOutpoints).to.have.length.greaterThan(0)
        const inscriptionOutpoints = chain.txs
            .get(inscriptionTxid)!
            .inputs.map((i) => `${i.prevTxId.toString('hex')}:${i.outputIndex}`)
        for (const spent of chain.spentOutpoints)
            expect(inscriptionOutpoints).to.not.include(spent)
        expect(chain.inscriptionAttempts).to.equal(1)
    })

    it('retries the inscription once after a mempool conflict', async () => {
        const chain = new LaggingChain()
        chain.conflictOnce = true
        const config = configFile()
        const retried = sink()
        const code = await deployCommand(
            args(treeSource, config, [
                '--tree',
                membersFile(membersOf(4)),
                '--sponsor',
                SPONSOR_HASH,
            ]),
            retried.io,
            { ...parts(chain), inscriptionPauseMs: 0 }
        )
        expect(code, retried.lines.join('\n')).to.equal(0)
        expect(chain.inscriptionAttempts).to.equal(2)
        expect(loadConfig(config).genesisInscription).to.match(
            /^[0-9a-f]{64}:0$/
        )
    })

    it('a redeploy clears the old genesis fields; inscribe-genesis then succeeds', async () => {
        const chain = new FlakyChain()
        const config = configFile()
        const list = membersFile(membersOf(4))
        const deployArgs = args(treeSource, config, [
            '--tree',
            list,
            '--sponsor',
            SPONSOR_HASH,
        ])
        expect(
            await deployCommand(deployArgs, sink().io, parts(chain))
        ).to.equal(0)
        const first = loadConfig(config)
        expect(first.genesisInscription).to.be.a('string')

        chain.failInscription = true
        expect(
            await deployCommand(deployArgs, sink().io, parts(chain))
        ).to.equal(1)
        const second = loadConfig(config)
        expect(second.machineOutpoint).to.not.equal(first.machineOutpoint)
        expect(second.genesisOutpoint).to.equal(second.machineOutpoint)
        expect(second.genesisInscription).to.equal(undefined)

        chain.failInscription = false
        expect(
            await inscribeGenesisCommand([config, '--tree', list], sink().io, {
                provider: chain,
                signer: new TestWallet(WALLET_KEY, chain),
            })
        ).to.equal(0)
        expect(loadConfig(config).genesisInscription).to.not.equal(
            first.genesisInscription
        )

        // a plain redeploy also drops the old genesis outpoint
        expect(
            await deployCommand(
                args(plainSource, config),
                sink().io,
                parts(chain)
            )
        ).to.equal(0)
        const plain = loadConfig(config)
        expect(plain.genesisOutpoint).to.equal(undefined)
        expect(plain.genesisInscription).to.equal(undefined)
    })

    it('describeConfig names the mode only for a config with a [gateway] table', () => {
        const sponsor = loadConfig(configFile())
        expect(describeConfig(sponsor)).to.not.contain('mode=')
        const path = join(dir, `gw-${counter++}.toml`)
        writeFileSync(
            path,
            `[network]\nname = "testnet"\n[wallet]\nwif = "${WALLET_KEY.toWIF()}"\n[gateway]\nslot = 0\n`
        )
        chmodSync(path, 0o600)
        expect(describeConfig(loadConfig(path))).to.contain('mode=slots')
    })

    it('a 100-member body (over 520 bytes) round-trips through the chain', async () => {
        const chain = new MemoryChain()
        const config = configFile()
        const list = membersFile(membersOf(100))
        const code = await deployCommand(
            args(treeSource, config, [
                '--tree',
                list,
                '--sponsor',
                SPONSOR_HASH,
            ]),
            sink().io,
            parts(chain)
        )
        expect(code).to.equal(0)
        const cfg = loadConfig(config)
        const { found, genesis } = publishedRoster(
            chain,
            cfg.genesisInscription!
        )
        expect(found.body.length).to.be.greaterThan(520)
        const [machineTxid] = cfg.machineOutpoint!.split(':')
        const machine = K17Machine.fromTx(
            chain.txs.get(machineTxid)!,
            0
        ) as K17Machine
        expect(genesis.members).to.have.length(100)
        expect(RosterMirror.fromGenesis(genesis).root()).to.equal(
            machine.rosterRoot
        )
    })

    it('refuses a duplicate key hash or leaf index before any broadcast', async () => {
        const [a, b] = membersOf(2)
        const lists = {
            'duplicate key': [a, { ...b, keyHash: a.keyHash }],
            'duplicate index': [a, { ...b, index: a.index }],
        }
        for (const [label, members] of Object.entries(lists)) {
            const chain = new MemoryChain()
            const config = configFile()
            const before = readFileSync(config, 'utf8')
            const { lines, io } = sink()
            const code = await deployCommand(
                args(treeSource, config, [
                    '--tree',
                    membersFile(members),
                    '--sponsor',
                    SPONSOR_HASH,
                ]),
                io,
                parts(chain)
            )
            expect(code, label).to.equal(2)
            expect(lines.join('\n'), label).to.contain('duplicate')
            expect(chain.txs.size, label).to.equal(0)
            expect(readFileSync(config, 'utf8'), label).to.equal(before)
        }
    })

    it('refuses --tree with a program that is not tree-mode', async () => {
        const chain = new MemoryChain()
        const { lines, io } = sink()
        const code = await deployCommand(
            args(plainSource, configFile(), [
                '--tree',
                membersFile(membersOf(2)),
                '--sponsor',
                SPONSOR_HASH,
            ]),
            io,
            parts(chain)
        )
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('tree-mode')
        expect(chain.txs.size).to.equal(0)
    })

    it('refuses a tree program without --tree, and --tree without --sponsor', async () => {
        const chain = new MemoryChain()
        const first = sink()
        expect(
            await deployCommand(
                args(treeSource, configFile(), ['--sponsor', SPONSOR_HASH]),
                first.io,
                parts(chain)
            )
        ).to.equal(2)
        expect(first.lines.join('\n')).to.contain('empty roster')
        const second = sink()
        expect(
            await deployCommand(
                args(treeSource, configFile(), [
                    '--tree',
                    membersFile(membersOf(2)),
                ]),
                second.io,
                parts(chain)
            )
        ).to.equal(2)
        expect(second.lines.join('\n')).to.contain('--sponsor')
        expect(chain.txs.size).to.equal(0)
    })

    it('a failed inscription keeps the machine outpoint; inscribe-genesis then succeeds', async () => {
        const chain = new FlakyChain()
        chain.failInscription = true
        const config = configFile()
        const list = membersFile(membersOf(4))
        const { lines, io } = sink()
        const code = await deployCommand(
            args(treeSource, config, [
                '--tree',
                list,
                '--sponsor',
                SPONSOR_HASH,
            ]),
            io,
            parts(chain)
        )
        expect(code).to.equal(1)
        const text = lines.join('\n')
        expect(text).to.contain(`inscribe-genesis ${config} --tree ${list}`)
        expect(text).to.not.contain(WALLET_KEY.toWIF())
        const failed = loadConfig(config)
        expect(failed.machineOutpoint).to.match(/^[0-9a-f]{64}:0$/)
        expect(failed.genesisInscription).to.equal(undefined)

        // a list with another root is refused and nothing is broadcast
        chain.failInscription = false
        const sizeBefore = chain.txs.size
        const wrong = sink()
        expect(
            await inscribeGenesisCommand(
                [config, '--tree', membersFile(membersOf(3))],
                wrong.io,
                { provider: chain, signer: new TestWallet(WALLET_KEY, chain) }
            )
        ).to.equal(1)
        expect(wrong.lines.join('\n')).to.contain('roster root')
        expect(chain.txs.size).to.equal(sizeBefore)

        const done = sink()
        expect(
            await inscribeGenesisCommand([config, '--tree', list], done.io, {
                provider: chain,
                signer: new TestWallet(WALLET_KEY, chain),
            })
        ).to.equal(0)
        const cfg = loadConfig(config)
        const { genesis } = publishedRoster(chain, cfg.genesisInscription!)
        const [machineTxid] = cfg.machineOutpoint!.split(':')
        const machine = K17Machine.fromTx(
            chain.txs.get(machineTxid)!,
            0
        ) as K17Machine
        expect(genesis.instanceId).to.equal(machine.instanceId)
        expect(RosterMirror.fromGenesis(genesis).root()).to.equal(
            machine.rosterRoot
        )
        expect(statSync(config).mode & 0o777).to.equal(0o600)

        // a second run would publish the list twice: refused
        const again = sink()
        expect(
            await inscribeGenesisCommand([config, '--tree', list], again.io, {
                provider: chain,
                signer: new TestWallet(WALLET_KEY, chain),
            })
        ).to.equal(1)
        expect(again.lines.join('\n')).to.contain('already inscribed')
    })

    it('inscribe-genesis reads genesis_outpoint and refuses an instance_id mismatch', async () => {
        const chain = new FlakyChain()
        chain.failInscription = true
        const config = configFile()
        const list = membersFile(membersOf(3))
        await deployCommand(
            args(treeSource, config, [
                '--tree',
                list,
                '--sponsor',
                SPONSOR_HASH,
            ]),
            sink().io,
            parts(chain)
        )
        chain.failInscription = false
        const cfg = loadConfig(config)
        expect(cfg.genesisOutpoint).to.equal(cfg.machineOutpoint)
        // the machine outpoint moves on to a transaction that is no machine
        const moved = join(dir, `moved-${counter++}.toml`)
        writeFileSync(
            moved,
            readFileSync(config, 'utf8').replace(
                /^outpoint = .*$/m,
                `outpoint = "${'cd'.repeat(32)}:0"`
            )
        )
        chmodSync(moved, 0o600)
        const deps = {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
        }
        // wrong instance id: refused, nothing broadcast
        const wrongId = join(dir, `wrongid-${counter++}.toml`)
        writeFileSync(
            wrongId,
            readFileSync(moved, 'utf8').replace(
                /^instance_id = .*$/m,
                `instance_id = "${'ee'.repeat(32)}"`
            )
        )
        chmodSync(wrongId, 0o600)
        const size = chain.txs.size
        const bad = sink()
        expect(
            await inscribeGenesisCommand(
                [wrongId, '--tree', list],
                bad.io,
                deps
            )
        ).to.equal(1)
        expect(bad.lines.join('\n')).to.contain('instance_id')
        expect(chain.txs.size).to.equal(size)
        // genesis_outpoint is preferred over the moved outpoint
        const ok = sink()
        expect(
            await inscribeGenesisCommand([moved, '--tree', list], ok.io, deps)
        ).to.equal(0)
        expect(loadConfig(moved).genesisInscription).to.match(
            /^[0-9a-f]{64}:0$/
        )
    })

    it('inscribe-genesis refuses mainnet without the switch and takes no stray arguments', async () => {
        const mainnet = sink()
        expect(
            await inscribeGenesisCommand(
                [configFile('mainnet'), '--tree', membersFile(membersOf(1))],
                mainnet.io
            )
        ).to.equal(2)
        expect(mainnet.lines.join('\n')).to.contain(
            '--i-know-this-spends-real-money'
        )
        const usage = sink()
        expect(await inscribeGenesisCommand([], usage.io)).to.equal(2)
        expect(usage.lines.join('\n')).to.contain(
            'usage: k17forth inscribe-genesis'
        )
        const top = sink()
        expect(await main(['nonsense'], top.io)).to.equal(2)
        expect(top.lines.join('\n')).to.contain('inscribe-genesis')
        expect(top.lines.join('\n')).to.contain('--tree')
    })
})

describe('1Sat inscription script', () => {
    const owner = WALLET_KEY.toAddress()

    it('builds the envelope and the owner P2PKH, and parses it back', () => {
        const body = Buffer.from('{"k17":"roster"}')
        const script = inscriptionScript(owner, 'application/json', body)
        expect(script.toASM()).to.match(/^0 OP_IF 6f7264 OP_1 /)
        expect(
            script
                .toHex()
                .endsWith(bsv.Script.buildPublicKeyHashOut(owner).toHex())
        ).to.equal(true)
        const found = parseInscription(new bsv.Script(script.toBuffer()))!
        expect(found.contentType).to.equal('application/json')
        expect(found.body.equals(body)).to.equal(true)
    })

    it('uses PUSHDATA2 for a body over 520 bytes and keeps every byte', () => {
        const body = Buffer.alloc(3000)
        for (let i = 0; i < body.length; i++) body[i] = i % 251
        const script = inscriptionScript(owner, 'application/json', body)
        expect(
            script.chunks.some((c) => c.opcodenum === bsv.Opcode.OP_PUSHDATA2)
        ).to.equal(true)
        const found = parseInscription(new bsv.Script(script.toBuffer()))!
        expect(found.body.equals(body)).to.equal(true)
    })

    it('finds an envelope that is not at the start, and returns undefined without one', () => {
        const inner = inscriptionScript(owner, 'text/plain', Buffer.from('hi'))
        const prefixed = new bsv.Script('')
            .add(bsv.Opcode.OP_DUP)
            .add(bsv.Opcode.OP_DROP)
            .add(inner)
        const found = parseInscription(prefixed)!
        expect(found.contentType).to.equal('text/plain')
        expect(found.body.toString()).to.equal('hi')
        expect(
            parseInscription(bsv.Script.buildPublicKeyHashOut(owner))
        ).to.equal(undefined)
        expect(parseInscription(bsv.Script.empty())).to.equal(undefined)
    })

    it('handles an empty body', () => {
        const script = inscriptionScript(owner, 'text/plain', Buffer.alloc(0))
        const found = parseInscription(new bsv.Script(script.toBuffer()))!
        expect(found.body.length).to.equal(0)
    })
})
