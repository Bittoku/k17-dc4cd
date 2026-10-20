/**
 * The `k17forth inscribe-genesis` sub-command.
 *
 * Finishes a tree-mode deployment whose genesis inscription did not go out
 * (for example when the broadcast failed after `deploy` had deployed the
 * machine). It reads the machine at the `[machine] outpoint` of the config,
 * rebuilds the genesis roster from the member list, refuses when the list
 * does not give the machine's `rosterRoot`, then broadcasts the 1Sat
 * inscription from the config's wallet and records its outpoint as
 * `[machine] genesis_inscription`. A config that already holds an inscription
 * outpoint is refused, so the list is not published twice.
 * Mainnet needs the switch `--i-know-this-spends-real-money`.
 */

import { Provider, Signer } from 'scrypt-ts'
import { K17Machine } from 'k17-vm'
import {
    hideSecrets,
    loadConfig,
    saveGenesisInscription,
} from '../chain/config'
import { parseOutpoint } from '../chain/history'
import {
    GENESIS_CONTENT_TYPE,
    broadcastInscription,
    genesisRosterOf,
    readMembersFile,
} from '../chain/inscription'
import { makeProvider, makeSigner } from '../chain/provider'
import { RosterMirror } from '../chain/roster'
import { UsageError } from './deploy'
import { parseFlags } from './flags'
import type { CliIo } from './k17forth'

/** Help text of the inscribe-genesis sub-command. */
export const INSCRIBE_USAGE = `usage: k17forth inscribe-genesis <gw.toml> --tree <members.json>
         [--i-know-this-spends-real-money]`

/** Switch that allows a mainnet inscription. */
const MAINNET_SWITCH = 'i-know-this-spends-real-money'

/** Parts of `inscribe-genesis` that tests replace. */
export interface InscribeDeps {
    /** Provider that reads the machine. Default: `makeProvider` of the config. */
    provider?: Pick<Provider, 'getTransaction'>
    /** Wallet signer. Default: `makeSigner` of the config. */
    signer?: Signer
}

/**
 * Run the inscribe-genesis sub-command.
 * Input: arguments after `inscribe-genesis` (config path, `--tree`), an
 * output sink and optional test parts.
 * Output: exit code: 0 when the inscription went out and is recorded; 1
 * when the machine cannot be read, the list does not give the machine's
 * root, an inscription is already recorded, or the broadcast fails; 2 on
 * wrong arguments or a refused mainnet config.
 */
export async function inscribeGenesisCommand(
    args: string[],
    io: CliIo,
    deps: InscribeDeps = {}
): Promise<number> {
    const parsed = parseFlags(args, ['tree'], [MAINNET_SWITCH])
    if (typeof parsed === 'string') {
        io.err(parsed)
        io.err(INSCRIBE_USAGE)
        return 2
    }
    const treePath = parsed.values.get('tree')
    if (parsed.positional.length !== 1 || !treePath) {
        io.err(INSCRIBE_USAGE)
        return 2
    }
    const [configPath] = parsed.positional
    let hide: (text: string) => string = (text) => text
    try {
        const cfg = loadConfig(configPath)
        hide = (text) => hideSecrets(text, cfg)
        if (cfg.network === 'mainnet' && !parsed.switches.has(MAINNET_SWITCH))
            throw new UsageError(
                `a mainnet inscription spends real money; add --${MAINNET_SWITCH} to go on`
            )
        if (!cfg.machineOutpoint)
            throw new Error('config: [machine] outpoint is required')
        if (cfg.genesisInscription)
            throw new Error(
                `config: the genesis roster is already inscribed (${cfg.genesisInscription})`
            )
        let members: ReturnType<typeof readMembersFile>
        try {
            members = readMembersFile(treePath)
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw e
            throw new UsageError((e as Error).message)
        }
        const provider = deps.provider ?? makeProvider(cfg.network)
        let signer: Signer
        try {
            signer = deps.signer ?? makeSigner(cfg, provider as Provider)
        } catch {
            throw new Error('config: [wallet] wif is not a valid key')
        }
        const { txid, vout } = parseOutpoint(cfg.machineOutpoint)
        const tx = await provider.getTransaction(txid)
        const machine = K17Machine.fromTx(tx, vout) as K17Machine
        const rosterRoot = machine.rosterRoot
        const found = RosterMirror.fromMembers(members).root()
        if (found !== rosterRoot)
            throw new Error(
                `${treePath} gives roster root ${found}, but the machine ${cfg.machineOutpoint} has ${rosterRoot}; nothing was broadcast`
            )
        const genesis = genesisRosterOf(machine.instanceId, rosterRoot, members)
        const outpoint = await broadcastInscription(
            signer,
            GENESIS_CONTENT_TYPE,
            Buffer.from(JSON.stringify(genesis), 'utf8')
        )
        saveGenesisInscription(configPath, outpoint)
        io.out(`genesis inscription ${outpoint}`)
        io.out(`wrote [machine] genesis_inscription to ${configPath}`)
        return 0
    } catch (e) {
        if (e instanceof UsageError) {
            io.err(e.message)
            return 2
        }
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            io.err(`${(e as NodeJS.ErrnoException).path}: file not found`)
            return 1
        }
        io.err(hide(`inscribe-genesis: ${(e as Error).message ?? String(e)}`))
        return 1
    }
}
