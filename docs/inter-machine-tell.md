# Inter-machine `tell:` on a UTXO chain — design note (parked)

Status: design only, not implemented. Blocked on interpreter script size.
Context: [[2026-10-18-dc4cd-forth-wsn-analysis]] §3D in the Stack Computers vault folder.

## What DC4CD does

`A tell: B tell: code :tell :tell` — node A sends node B a frame whose payload is
Forth source; B interprets it, and part of what it interprets is another `tell:` to C.
A reply is also code (`1 nodes +! ~fm fcount +! ...`) that mutates the requester's
state when interpreted. Messages are code; routing is in the program.

## The on-chain shape

Two K17 machines, A and B, each a UTXO. One transaction spends both. A's program
writes a cell to its output log; B's program reads the same cell as a witness. For
this to be a _message_ rather than two unrelated witnesses, both covenants must
constrain the same bytes.

The cheap carrier is a third, tiny output in the same transaction: an
`OP_FALSE OP_RETURN <msg>` output at a fixed index. Both machines see
`hashOutputs` in their sighash preimage, so both can assert what that output
contains:

- A asserts `outputs[2] == OP_RETURN || cell(outLog[last])`.
- B asserts its witness cell equals the payload of `outputs[2]`.

No new opcode is needed. The message is atomic (same transaction), authenticated
(A's covenant produced it), and ordered (A's UTXO is consumed). This is the
`tell:` construct with the chain as the radio.

## Why it is blocked

1. **`SIGHASH_ALL` commits to every output.** To check `hashOutputs`, each machine
   must be handed the full serialised outputs, including the _other_ machine's new
   locking script. At 202 KB per interpreter (K=40, 32 handlers; now 183 KB with 43 handlers), the unlocking
   script of each input carries the other's 202 KB, so the transaction roughly
   triples in size.
2. **`SIGHASH_SINGLE` fixes (1) and breaks the message.** Under SINGLE each input
   commits only to the output at its own index, so neither machine can see
   `outputs[2]`.
3. **`SIGHASH_ALL | ANYONECANPAY`** commits to all outputs but only this input; it
   does not help with (1) and weakens the input-0 uniqueness check.
4. **The input-0 rule.** The output-sharing defence requires the machine at input
   index 0. Two machines in one transaction need "machine at input _i_ with its
   state output at output _i_", and the defence has to be re-argued: two machines
   with identical scripts and values spent together must still each get their
   own state output.

## What would unblock it

- Interpreter size down by an order of magnitude (the P2 item "shrink
  per-instruction script cost": dispatch restructuring, dropping AND/OR/XOR from
  the core, Merkleised memory). At 20 KB a machine, carrying the sibling's script
  is tolerable.
- Or a Merkle commitment to the outputs instead of the raw serialisation. The
  sighash preimage gives only `hashOutputs = hash256(serialised outputs)`, so
  this needs a different commitment scheme and is not available in Bitcoin script
  as it stands.

## What it would buy

DC4CD's nested `tell:` becomes a chain of covenants messaging each other
atomically. A pipeline of K17 machines (sensor aggregation feeding a fuzzy
verdict feeding a payout) runs with each stage's state and program in its own
UTXO, composable without redeploying any of them. That is the active-network
picture with a settlement layer, and it is the strongest research claim on the
list once the cost problem is solved. Until then: parked.
