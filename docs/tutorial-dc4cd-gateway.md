# Tutorial: pay DC4CD landowners on the chain

This tutorial connects a DC4CD sensor network to a K17 consortium machine on Bitcoin SV. Each landowner has a sensor. A sponsor pays each landowner for one signed reading in each round. The machine checks each reading and pays the landowner. The chain keeps every reading and every payment.

Use testnet for all the steps in this tutorial. Read the section "Before you go to mainnet" before you use real money.

## What you keep and what you add

You keep your DC4CD network. The motes, the radio and the Forth words on the motes do not change.

You add one gateway for each landowner. A gateway is a computer that has a serial line to one mote of the network, the bridge mote. The gateway does these steps:

1. It reads one line from the bridge mote for each reading.

2. It signs the reading with the Rabin key of the landowner.

3. It sends the signed reading to the consortium machine on the chain.

The sponsor deploys the machine, enrols the landowners and funds the payments. Each person has a TOML config file for the `k17forth` tool. A config file holds secrets: the wallet key and the Rabin key. The tool refuses a config file that other users can read. Give each config file mode 600.

A minimum config file for a landowner:

```toml
[network]
name = "testnet"

[wallet]
wif = "<the WIF of a funded testnet wallet>"

[gateway]
slot = 1
```

Add `[bridge] serial = "/dev/ttyUSB0"` to read a serial device. Without it, the gateway reads standard input. Add `[attester] payout_address` to get the payments at an address that is not the wallet address.

## The two mote words

The file `docs/bridge-mote.fs` holds two DC4CD words for the bridge mote:

- `>gateway ( n -- )` sends one reading to the gateway. The line is `R`, a space, the reading as a decimal number, and a new line.

- `report ( -- )` reads the sensor with `temperature` and sends the value with `>gateway`.

The reading must be in the cell range 0 to 4294967295. Add an offset in the mote, for example tenths of a degree plus 5000. The gateway ignores all other lines from the mote.

To make the nodes report one time in each round, send this line to the network. Use the round length of the machine in seconds:

```forth
all tell: ' report 1800 every :tell
```

`all` and `every` are the names in the example. Use the names that your DC4CD build has for the broadcast destination and the repeat word.

## Step 1: each landowner makes a key

Each landowner runs `gateway init` on their own config file:

```bash
k17forth gateway init --config land1.toml
```

The command makes a Rabin key and writes it into the config file. This takes some seconds. The command prints the public parts:

```
give these to the sponsor:
  public key hash: 90ca1c85b573bde880dbdfb665fcc449117fd2b03a9e757a870d864290a80f26
  public key: <768 hex characters>
  payout address: mna7mVra5dB7xiJiR4GYTzu1dGkXGjz3Md (the wallet address)
  payout hash: 4d6209433a8c33a20492502a27cb7b9358badcf2
  slot: 1
```

Send the public key and the payout address to the sponsor. Do not send the config file. The command never prints the Rabin primes or the wallet key.

The sponsor also runs `gateway init` on the sponsor config. The sponsor key endorses the landowners. It goes into roster slot 0 of the machine.

## Step 2: the sponsor deploys the machine

The sponsor chooses the consortium settings:

Settings of the rounds:

| Setting  | Meaning                                                |
| -------- | ------------------------------------------------------ |
| `slots`  | Number of landowners, 1 to 7.                          |
| `rounds` | Number of rounds, each with one paid reading per slot. |
| `start`  | Unix time at which round 0 is due to open.             |
| `period` | Length of a round in seconds.                          |

Settings of the enrolment and the readings:

| Setting                  | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `epoch`                  | A number from 0 to 65535 that makes the tags of this machine unique. |
| `range_min`, `range_max` | The readings that the machine accepts.                               |
| `enrolDeadline`          | The last time to enrol a landowner, not after `start`.               |

Settings of the money:

| Setting            | Meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `bountyPerReading` | Satoshis that the machine pays for one reading.                          |
| `floor`            | When the machine holds less than this, it stops and refunds the sponsor. |

Read the chain time first. A cycle can only use a lock time below the median time past (MTP) of the chain. On testnet, MTP is 40 to 50 minutes behind the clock. Set `start` from the MTP, not from the clock:

```bash
curl -s https://api.whatsonchain.com/v1/bsv/test/chain/info
```

Write the program with `consortiumSource` from this package:

```bash
npx ts-node -e "
const { consortiumSource } = require('./src')
const { keyHash } = require('k17-vm')
require('fs').writeFileSync('consortium.fs', consortiumSource({
  slots: 3, rounds: 2, epoch: 7, start: 1792391947, period: 1800,
  enrolDeadline: 1792391947, bountyPerReading: 200, floor: 1000,
  sponsorKeyHashHex: '5a021e1f49100c5e753a94ab89a6d094221d2155fc5a61964e93df08d3cfb5a2',
  range: { min: 0, max: 10000 },
}))"
```

Put the same settings into a `[consortium]` table in the sponsor config and in each landowner config:

```toml
[consortium]
start = 1792391947
period = 1800
epoch = 7
slots = 3
rounds = 2
range_min = 0
range_max = 10000
```

Deploy the machine. The `--sponsor` value is the public key hash of the sponsor key:

```bash
k17forth deploy consortium.fs --config sponsor.toml --deposit 50000 \
  --reward-min 100 --slope 1 --reward-max 500 \
  --sponsor 5a021e1f49100c5e753a94ab89a6d094221d2155fc5a61964e93df08d3cfb5a2
```

The command prints the outpoint and the instance id. It writes both into the `[machine]` table of the sponsor config. Send the `[machine]` table and the `[consortium]` table to each landowner. Each landowner adds them to their config file.

The deposit pays the landowners and the keepers. A keeper gets 100 to 500 satoshis for each cycle in this example. When the machine stops, the rest of the deposit goes back to the sponsor.

## Step 3: the sponsor enrols each landowner

Run `endorse` one time for each landowner, in slot order:

```bash
k17forth endorse --config sponsor.toml --member <public key of landowner 1> \
  --payout <payout address of landowner 1> --slot 1
```

The command checks that the sponsor key is in roster slot 0 of the machine. It signs the endorsement and relays it in one cycle. On the first endorsement it runs the first cycle of the program before the endorsement. It prints the txid and the slot:

```
endorsed slot 1 txid 9be22d15495cc21f4986629477bb69aa9b5c8ac3d115f9f99c68eccc16accd3b lockTime 1792391346 (mtp 1792391347) -> 9be22d15...:0
```

The machine enrols slots in order: 1, then 2, then 3. It refuses an endorsement after `enrolDeadline`. Enrol all landowners before that time.

## Step 4: run the gateways and the keeper

Each landowner starts a gateway:

```bash
k17forth gateway run --config land1.toml --interval 60
```

The gateway reads the bridge mote. For each reading it prints one status line:

```
round 0 slot 1 delivered 1 earned 200 sats: cycle 46a14d1f... lockTime 1792391346 (mtp 1792391347) reward 100 -> 46a14d1f...:0
```

The line shows the round and the slot. It shows the paid readings and the satoshis that the slot earned. Then it shows the cycle of this tick. To relay one reading and stop, add `--once`. Then the gateway stops after the machine pays the reading.

The sponsor starts a keeper:

```bash
k17forth keeper --config sponsor.toml --interval 60
```

The keeper runs the cycles that need no reading. These cycles open and close the rounds, and stop the machine after the last round. The keeper stops when the machine stops. Any person can run a keeper. The machine pays the keeper reward to the person who relays the cycle.

## Step 5: read the results

Use `inspect --history` on the newest outpoint of the machine:

```bash
k17forth inspect <txid>:0 --history --network testnet
```

The command prints the state of the machine. Then it prints each cycle back to the deployment, with the txid, lock time, keeper reward and slot payout. The output log (`out`) holds each accepted reading in the order of acceptance.

## What a landowner earns

A landowner earns `bountyPerReading` satoshis for each accepted reading. The machine accepts one reading from each slot in each round.

A landowner earns nothing in these cases:

- The gateway was offline for the whole round. The machine does not wait for a slot. When the round closes, the machine goes to the next round.

- The reading is out of range. The gateway refuses to sign it. With `[gateway] sign_anyway = true` the gateway signs it, but the machine rejects it.

- The slot is not enrolled yet. The gateway refuses the reading with "slot not enrolled".

- The last round closed. After that, the gateway refuses each reading.

- The deposit is below `floor`. The machine stops and refunds the sponsor.

## Operational rules

- **Lock time.** A node mines a cycle only when its lock time is below the MTP of the chain. The keeper and the gateway use the lock time min(now, MTP - 1). You do not set it.

- **Rounds follow the chain time.** The machine reads the round from the lock time of the cycle. A round closes when the MTP passes its close time, not when the clock does. On testnet this is 40 to 50 minutes after the clock.

- **The period.** Make `period` much longer than the MTP lag and the block interval. A period of 30 minutes or more works on testnet. A short period can close a round before a gateway gets a cycle in.

- **Unconfirmed cycles.** The chain accepts a chain of unconfirmed cycles. The tools do not wait for a confirmation between cycles.

- **Fees.** A full cycle is about 720 KB and costs about 720 satoshis in fees on testnet. The fee comes from the wallet of the person who relays the cycle. The keeper reward comes from the machine.

- **One wallet in many processes.** The tools list wallet coins without the coins that a mempool transaction spends. Two processes can use one wallet, one after the other. Do not run two of them with one wallet at the same time.

- **Old outpoints.** The config file keeps the outpoint of the deployment. The tools follow the machine forward from it to the newest cycle.

- **Rate limits.** The tools use the free WhatsOnChain API. They retry an answer of "Too Many Requests" and a transaction that is "Not Found" some seconds after its broadcast.

## Before you go to mainnet

On mainnet, each command needs the switch `--i-know-this-spends-real-money`.

The nChain patent US 12,020,249 B2 and its continuations read on the architecture of the K17 machine. Get a freedom-to-operate opinion before any commercial use on mainnet.
