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

| Path | What |
|---|---|
| `src/forth/` | A Forth-subset compiler to K17 bytecode (`compile`, `compileToHex`, CLI). Colon definitions, variables, constants, `if/else/then`, `begin/until/again/while/repeat`, and the K17 primitives including `sigverify`, `bounty`, `min`, `max`, `/`. |
| `src/programs/relay.ts` | DC4CD §5.1: roster-attested aggregation relay. Each hop's reading must be Rabin-signed by that hop's roster member; any keeper may relay it and is paid a bounty. Output log at HALT: `[hops, sum, average, min, max]`. |
| `src/programs/fuzzy.ts` | DC4CD §5.2: distributed fuzzy fire detection as a demo. Attested packed opinions, fuzzy AND/OR with `min`/`max`, threshold, alarm bounty. |
| `examples/*.fs` | The generated Forth source of both programs, for `npm run forth`. |
| `docs/inter-machine-tell.md` | Design note for two machines messaging in one transaction (DC4CD's nested `tell:`). Parked: blocked on interpreter size. |
| `docs/euroforth-writeup-draft.md` | Draft write-up. Not for circulation until the related provisional is filed. |
| `tests/` | Reference-VM and on-chain tests. Every on-chain cycle is verified with the bundled Bitcoin script interpreter. |

## Run

Requires `../k17-vm` built and compiled first (`cd ../k17-vm && npm test`), since
this package imports its contract artifact.

```bash
npm install
npm test
npm run forth examples/relay.fs
```

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
