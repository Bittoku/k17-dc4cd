/**
 * Tests for `k17forth endorse` (`src/cli/endorse.ts`): the sponsor endorses
 * a landowner into a roster slot of a consortium machine, and then a
 * gateway reading for that slot is paid. Also the refusals: a key that is
 * not the sponsor's (roster slot 0), and a mainnet config without the
 * switch, both before any broadcast.
 *
 * No test uses the network: the chain is the in-memory chain of
 * `tests/utils/consortiumChain.ts`.
 */
import { expect } from 'chai'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TestWallet } from 'scrypt-ts'
import { K17Machine, keyHash, pubKeyBytes, readSlot } from 'k17-vm'
import { Attester } from 'k17-vm'
import { GatewayConfig } from '../src/chain/config'
import { decodeMachine } from '../src/chain/decode'
import { endorseCommand } from '../src/cli/endorse'
import { main } from '../src/cli/k17forth'
import { Gateway } from '../src/gateway/gateway'
import {
    MemoryChain,
    OPTS,
    PAYOUT_ADDRESS,
    WALLET_KEY,
    consortiumOnChain,
    expectNoSecret,
    keeperOptions,
    landowner,
    sink,
    sponsor,
    stranger,
    tickUntil,
} from './utils/consortiumChain'

const dir = mkdtempSync(join(tmpdir(), 'k17endorse-'))

/**
 * Write a private sponsor config for a machine.
 * Input: file name, the gateway config of the machine (outpoint, instance
 * id, [consortium]), the Rabin key to put in [attester], and the network.
 * Output: the path.
 */
function sponsorConfig(
    name: string,
    machine: GatewayConfig,
    key: Attester = sponsor,
    network = 'testnet'
): string {
    const c = machine.consortium!
    const path = join(dir, name)
    writeFileSync(
        path,
        [
            '[network]',
            `name = "${network}"`,
            '[wallet]',
            `wif = "${WALLET_KEY.toWIF()}"`,
            '[attester]',
            `rabin_p = "${key.priv.p}"`,
            `rabin_q = "${key.priv.q}"`,
            '[machine]',
            `outpoint = "${machine.machineOutpoint}"`,
            `instance_id = "${machine.instanceId}"`,
            '[consortium]',
            `start = ${c.start}`,
            `period = ${c.period}`,
            `epoch = ${c.epoch}`,
            `slots = ${c.slots}`,
            `rounds = ${c.rounds}`,
            '',
        ].join('\n')
    )
    chmodSync(path, 0o600)
    return path
}

/** Arguments that endorse the landowner into slot 1. */
function endorseArgs(config: string): string[] {
    return [
        '--config',
        config,
        '--member',
        pubKeyBytes(landowner.pub),
        '--payout',
        PAYOUT_ADDRESS.toString(),
        '--slot',
        '1',
    ]
}

/** Text that must never be printed: the wallet key and all primes. */
function expectNoSponsorSecret(lines: string[]): void {
    expectNoSecret(lines)
    const text = lines.join('\n')
    for (const key of [sponsor, stranger])
        for (const prime of [key.priv.p, key.priv.q])
            expect(text).to.not.contain(prime.toString())
}

describe('k17forth endorse', function () {
    this.timeout(300_000)
    before(async () => {
        await K17Machine.loadArtifact(
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('k17-vm/artifacts/k17Machine.json')
        )
    })

    it('endorses slot 1, then a gateway reading for slot 1 is paid', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(false)
        const config = sponsorConfig('sponsor.toml', cfg)
        const { lines, io } = sink()
        const code = await endorseCommand(endorseArgs(config), io, {
            provider: chain,
            signer,
            keeper: keeperOptions(chain),
            now: () => OPTS.start - 100,
        })
        expect(lines.join('\n')).to.not.contain('ERR')
        expect(code).to.equal(0)
        const endorsed = lines.find((l) => /^endorsed slot 1 /.test(l))
        expect(endorsed).to.match(/txid [0-9a-f]{64}/)
        expectNoSponsorSecret(lines)
        // The machine now holds the landowner's key hash and payout in slot 1.
        const txid = /txid ([0-9a-f]{64})/.exec(endorsed!)![1]
        const mem = decodeMachine(
            chain.txs.get(txid)!.outputs[0].script.toHex()
        ).machine!.mem
        const slot = readSlot(mem, 1)
        expect(slot.hashHex).to.equal(keyHash(landowner.pub))
        // The landowner's gateway, from the deployment outpoint (it
        // resyncs), relays a reading of round 0 and is paid for it.
        const gateway = new Gateway(cfg, chain, signer, {
            keeper: keeperOptions(chain),
            now: () => OPTS.start + 100,
        })
        const line = await gateway.handleReading(5231)
        expect(line).to.not.contain('refused')
        await tickUntil(gateway, /delivered 1 earned 150 sats/)
        expect(chain.verifyMachineSpends()).to.be.greaterThan(3)
    })

    it('refuses a key that is not roster slot 0, before any broadcast', async () => {
        const { chain, signer, cfg } = await consortiumOnChain(false)
        const config = sponsorConfig('stranger.toml', cfg, stranger)
        const before = chain.cycleBroadcasts
        const { lines, io } = sink()
        const code = await endorseCommand(endorseArgs(config), io, {
            provider: chain,
            signer,
            keeper: keeperOptions(chain),
            now: () => OPTS.start - 100,
        })
        expect(code).to.equal(1)
        expect(lines.join('\n')).to.contain('not the sponsor')
        expect(chain.cycleBroadcasts).to.equal(before)
        expectNoSponsorSecret(lines)
    })

    it('refuses mainnet without --i-know-this-spends-real-money', async () => {
        const { chain, cfg } = await consortiumOnChain(false)
        const config = sponsorConfig('main.toml', cfg, sponsor, 'mainnet')
        const before = chain.cycleBroadcasts
        const { lines, io } = sink()
        const code = await endorseCommand(endorseArgs(config), io, {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
            keeper: keeperOptions(chain),
        })
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--i-know-this-spends-real-money')
        expect(chain.cycleBroadcasts).to.equal(before)
        expectNoSponsorSecret(lines)
    })

    it('refuses a member key that is not 384 bytes of hex', async () => {
        const chain = new MemoryChain()
        const { cfg } = await consortiumOnChain(false)
        const config = sponsorConfig('badkey.toml', cfg)
        const args = endorseArgs(config)
        args[3] = 'abcd'
        const { lines, io } = sink()
        const code = await endorseCommand(args, io, {
            provider: chain,
            signer: new TestWallet(WALLET_KEY, chain),
        })
        expect(code).to.equal(2)
        expect(lines.join('\n')).to.contain('--member')
    })

    it('is reachable from the main dispatcher', async () => {
        const { lines, io } = sink()
        expect(await main(['endorse'], io)).to.equal(2)
        expect(lines.join('\n')).to.contain('usage: k17forth endorse')
    })
})
