# k17-dc4cd

DC4CD-style symbolic distributed processing on a UTXO chain.

Gaglio, Lo Re, Martorella and Peri built DC4CD (ACM TECS 2017): sensor motes that
run Forth as their operating system and cooperate by sending each other Forth
source. This repository ports their two case studies to **K17+**, a Koopman
canonical stack machine hosted in a Bitcoin SV covenant
([`../k17-vm`](../k17-vm)). The UTXO is the message: it carries the program and
its state from hop to hop. The chain supplies what the radio did not — signed
readings, ordering, replay protection, payment for whoever relays, and an audit
trail — at the price of block latency and transaction fees.

## Contents

| Path                              | What                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/forth/`                      | A Forth-subset compiler to K17 bytecode (`compile`, `compileToHex`, CLI). Colon definitions, variables, constants, `if/else/then`, `begin/until/again/while/repeat`, and the K17 primitives including `sigverify`, `bounty`, `min`, `max`, `/`.                          |
| `src/programs/relay.ts`           | DC4CD §5.1: roster-attested aggregation relay. Each hop's reading must be Rabin-signed by that hop's roster member; any keeper may relay it and is paid a bounty. Output log at HALT: `[hops, sum, average, min, max]`.                                                  |
| `src/programs/fuzzy.ts`           | DC4CD §5.2: distributed fuzzy fire detection as a demo. Attested packed opinions, fuzzy AND/OR with `min`/`max`, threshold, alarm bounty.                                                                                                                                |
| `examples/*.fs`                   | The generated Forth source of both programs, for `npm run forth`.                                                                                                                                                                                                        |
| `src/gateway/`                    | The gateway (`k17forth gateway init` / `run`): reads `R <reading>` lines from a bridge mote, signs each reading for its consortium slot and round, and relays it through the keeper. It refuses a closed round, a slot that is not enrolled, and a reading out of range. |
| `docs/tutorial-dc4cd-gateway.md`  | Tutorial: a sponsor and three landowners on testnet, from `gateway init` to `inspect --history`, with a worked example.                                                                                                                                                  |
| `docs/bridge-mote.fs`             | DC4CD words for the bridge mote (`>gateway`, `report`) and the `tell:` line that makes nodes report one time in each period.                                                                                                                                             |
| `docs/inter-machine-tell.md`      | Design note for two machines messaging in one transaction (DC4CD's nested `tell:`). Parked: blocked on interpreter size.                                                                                                                                                 |
| `docs/euroforth-writeup-draft.md` | Draft write-up. Not for circulation until the K17 defensive publication is public.                                                                                                                                                                                       |
| `tests/`                          | Reference-VM and on-chain tests. Every on-chain cycle is verified with the bundled Bitcoin script interpreter.                                                                                                                                                           |

## Run

Requires `../k17-vm` built and compiled first (`cd ../k17-vm && npm test`), since
this package imports its contract artifact.

```bash
npm install
npm test
npm run forth examples/relay.fs
```

## Commands

`npm run k17forth -- <command>` runs the tool from the source.

| Command                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compile <file.fs>`                                                         | Prints the hex, the disassembly and the instructions per cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run <file.fs> --scenario <file.json>`                                      | Runs a program on the reference VM, one cycle per scenario entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `repl [file.fs]`                                                            | Runs Forth one line at a time and shows the machine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `inspect <txid[:vout]> [--history]`                                         | Shows a machine on the chain and, with `--history`, each cycle back to the deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `deploy <file.fs> --config <toml> ...`                                      | Deploys a machine and writes its outpoint into the config. `--dead-man <seconds>` (default 0, off; else 21600 or more) sets the refund interval: when no cycle ran for that long, any keeper can halt the machine and refund the deposit. Use 30 days (2592000) for daily rounds.                                                                                                                                                                                                                                                                                                                    |
| `deploy <file.fs> --tree <members.json> --sponsor <key> ...`                | Deploys a tree-mode machine (v3.1): the root of the member list and the sponsor key hash go into the machine, then the sponsor's wallet publishes the list as a 1Sat inscription (`application/json`, the `GenesisRoster` shape). Both outpoints go into the config (`[machine] outpoint`, `genesis_inscription`). Refuses a duplicate key or index, a non-tree program with `--tree`, and a tree program without it.                                                                                                                                                                                |
| `inscribe-genesis <toml> --tree <members.json>`                             | Publishes the genesis inscription of a deployed tree machine when `deploy` could not (the machine outpoint was saved, the broadcast failed). Refuses a list whose root differs from the machine's `rosterRoot`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `admit <toml> --member-key <file> --payout <addr> [--index <n>]`            | Tree mode: the sponsor admits a member. Rebuilds the roster from the genesis inscription and the history, signs at the roster seq, relays with the keeper (lock time min(now, MTP - 1)). Refuses a key already in the roster, an occupied leaf, a key that is not the machine sponsor, and a machine that has ended. The key file holds the 768-hex public key of `gateway init` or a decimal number of at least 2048 bits. After each relay the command writes `[machine] tip_outpoint`; every forward-follow (keeper, gateway, admit, remove) starts there, so a long history is not walked again. |
| `remove <toml> (--member-key <file> \| --index <n>)`                        | Tree mode: the sponsor removes a member. The signature covers the member's key hash and payout, so a payment after the signature does not invalidate it. Refuses an unknown member. After another cycle lands first, both commands reload the roster once and sign again.                                                                                                                                                                                                                                                                                                                            |
| `endorse --config <sponsor.toml> --member <key> --payout <addr> --slot <n>` | The sponsor enrols a landowner key into a roster slot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `keeper --config <toml>`                                                    | Advances the machine, one cycle per tick, until it stops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gateway init --config <toml>`                                              | Makes the Rabin key of a landowner and prints what the sponsor needs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `gateway run --config <toml> [--once]`                                      | Signs the bridge readings and relays them. With `--once` it stops after one reading: exit code 0 when the machine paid it, 3 when it was refused or rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

History note: `inspect --history` reads 10 unlocking-script chunks, the 3 last ones are the tree proof of the v3 machine. Machines made before v3.1 do not decode under the v3.1 artifact (`TEMPLATE_MISMATCH`), because the dead-man field changed the locking script. A cycle with only 7 chunks (v2) shows as `ambiguous`.

Each command that spends money refuses mainnet without `--i-know-this-spends-real-money`. No command prints the wallet key or a Rabin prime.

## Operational rules

These rules come from the testnet spike and the rehearsal of 2026-10-19.

- A node mines a cycle only when its lock time is below the median time past (MTP). The keeper and the gateway use min(now, MTP - 1). On testnet, MTP is 40 to 50 minutes behind the clock.

- The consortium program reads its round from the lock time. A round closes when the MTP passes the close time. Make `period` much longer than the MTP lag.

- The chain accepts chains of unconfirmed cycles. The tools do not wait for confirmations.

- A full cycle is about 720 KB and costs about 720 satoshis in fees on testnet.

- The tools list wallet coins from WhatsOnChain without the coins that a mempool transaction spends. They retry rate-limited calls (HTTP 429) and reads of a transaction that is not yet indexed.

- The config file keeps the deployment outpoint. The tools follow the machine forward from it.

## The relay in Forth

```
variable sum  variable lo  variable hi
: accumulate ( reading -- )
  dup sum @ + sum !   dup lo @ min lo !   hi @ max hi ! ;
$ffffffff lo !  yield
time DEADLINE - $80000000 and 0= if halt then     \ refund past the deadline
TAG0 in over over 0 sigverify swap drop           \ hop 0: slot 0 attests (TAG0, reading)
150 bounty  accumulate  yield
...
3 out  sum @ out  sum @ 3 / out  lo @ out  hi @ out  halt
```

Each hop is 36 K17 instructions and fits one 40-instruction cycle, so the
attestation check, the bounty and the end of the hop are one transaction.

## Honest limits

- Not a wireless sensor network. Readings reach the chain through a gateway, and a
  hop is a block, not a millisecond. Candidates are control loops with periods of
  minutes or more.
- The interpreter is 202 KB of script at K=40; fees per cycle follow from that, not
  from the program. Shrinking it is the open engineering item.
- Roster keys are fixed at deployment (four slots). An open roster needs a Merkle
  root and inclusion proofs; not built.
- The nChain byte-interpretation patent family reads on the architecture. See
  `k17-vm/CLAUDE.md`; freedom-to-operate opinion before any commercial use.

## Licence

MIT. Design documents live in the Obsidian vault (`notes/projects/Stack Computers/`),
not here.
