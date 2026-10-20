/**
 * Loading the roster mirror of a tree-mode machine from the chain.
 *
 * The sponsor commands (`admit`, `remove`) and later the keeper and the
 * gateway need the off-chain `RosterMirror` of a machine. The mirror starts
 * from the genesis roster that the sponsor inscribed at deployment and
 * follows every cycle in the machine's history. `loadRoster` does all of it
 * from a config and a transaction source, and refuses any source of
 * disagreement: a genesis that is not the deployment's roster, a history
 * that does not replay, or a mirror that ends at a different root or
 * sequence number than the machine at the tip.
 *
 * Exports: `LoadRosterDeps` (what the loader reads from) and `loadRoster`.
 */

import { K17Machine } from 'k17-vm'
import { GatewayConfig } from './config'
import { decodeInstance } from './decode'
import { TxSource, parseOutpoint, walkHistory } from './history'
import { GenesisRoster, RosterMirror, replayRoster } from './roster'
import { parseInscription } from './inscription'

/** What `loadRoster` reads from. */
export interface LoadRosterDeps {
    /** Transaction source (a provider). */
    provider: TxSource
    /**
     * Outpoint (`txid` or `txid:vout`) of the machine at the tip of its
     * history. Default: `[machine] outpoint` of the config.
     */
    outpoint?: string
}

/**
 * Read the machine that an outpoint holds.
 * Input: the transaction source, the outpoint and a name for messages.
 * Output: the contract instance. Throws when the output is not a machine.
 */
async function machineAt(
    provider: TxSource,
    outpoint: string,
    name: string
): Promise<K17Machine> {
    const { txid, vout } = parseOutpoint(outpoint)
    const output = (await provider.getTransaction(txid)).outputs[vout]
    const decoded = output && decodeInstance(output.script.toHex())
    if (!decoded || !decoded.instance)
        throw new Error(`${name} ${outpoint} is not a K17 machine`)
    return decoded.instance
}

/**
 * Load the roster mirror of a tree-mode machine.
 * Reads the genesis inscription transaction (`[machine] genesis_inscription`),
 * checks that its roster belongs to the deployment at `genesis_outpoint`
 * (same instance id, same root), builds the mirror from it, replays the
 * history from the deployment to the tip and checks the end state against
 * the machine at the tip.
 * Input: the config and the read sources (see `LoadRosterDeps`).
 * Output: the mirror and the machine at the tip (with `rosterRoot`,
 * `rosterSeq`, `sponsorKeyHash`, `instanceId`). Throws a message when the
 * config lacks `genesis_outpoint` or `genesis_inscription`, the inscription
 * is missing or not a roster, the genesis does not match the deployment, a
 * cycle does not replay, or the mirror's root or seq differs from the
 * machine's.
 */
export async function loadRoster(
    cfg: GatewayConfig,
    deps: LoadRosterDeps
): Promise<{ mirror: RosterMirror; machine: K17Machine }> {
    const tip = deps.outpoint ?? cfg.machineOutpoint
    if (!tip) throw new Error('config: [machine] outpoint is required')
    if (!cfg.genesisOutpoint)
        throw new Error(
            'config: [machine] genesis_outpoint is required (a tree-mode machine saves it at deploy)'
        )
    if (!cfg.genesisInscription)
        throw new Error(
            'config: [machine] genesis_inscription is required (run inscribe-genesis when deploy could not publish it)'
        )
    const { txid, vout } = parseOutpoint(cfg.genesisInscription)
    const inscribed = (await deps.provider.getTransaction(txid)).outputs[vout]
    const found = inscribed && parseInscription(inscribed.script)
    if (!found)
        throw new Error(
            `${cfg.genesisInscription} holds no inscription (genesis roster)`
        )
    let genesis: GenesisRoster
    try {
        genesis = JSON.parse(found.body.toString('utf8')) as GenesisRoster
    } catch {
        throw new Error(
            `${cfg.genesisInscription}: the inscription is not a JSON roster`
        )
    }
    const deployed = await machineAt(
        deps.provider,
        cfg.genesisOutpoint,
        'genesis_outpoint'
    )
    if (
        String(genesis.instanceId).toLowerCase() !==
        deployed.instanceId.toLowerCase()
    )
        throw new Error(
            'the genesis roster is for another machine (instance id differs from the deployment)'
        )
    if (
        String(genesis.rosterRoot).toLowerCase() !==
        deployed.rosterRoot.toLowerCase()
    )
        throw new Error(
            'the genesis roster root differs from the root the machine was deployed with'
        )
    const machine = await machineAt(deps.provider, tip, 'machine outpoint')
    if (machine.instanceId.toLowerCase() !== deployed.instanceId.toLowerCase())
        throw new Error('the machine outpoint is not of the deployed machine')
    const cycles = await walkHistory(deps.provider, tip)
    const mirror = replayRoster(genesis, cycles)
    if (
        mirror.root() !== machine.rosterRoot ||
        mirror.seq() !== machine.rosterSeq
    )
        throw new Error(
            `roster mirror (root ${mirror.root()}, seq ${mirror.seq()}) does not match the machine (root ${
                machine.rosterRoot
            }, seq ${machine.rosterSeq})`
        )
    return { mirror, machine }
}
