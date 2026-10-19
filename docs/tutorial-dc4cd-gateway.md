# Tutorial: pay DC4CD landowners on the chain

This tutorial connects a DC4CD sensor network to a K17 consortium machine on Bitcoin SV. Each landowner has a sensor. A sponsor pays each landowner for one signed reading in each round. The machine checks each reading and pays the landowner. The chain keeps every reading and every payment.

Use testnet for all the steps in this tutorial. Read the section "Before you go to mainnet" before you use real money.

The examples call the tool `k17forth`. To get this command, run `npm install`, `npm run build` and `npm link` in this repository. Without the link, use `npm run k17forth --` in place of `k17forth`.

## What you keep and what you add

You keep your DC4CD network. The motes, the radio and the Forth words on the motes do not change.

You add one gateway for each landowner. A gateway is a computer that has a serial line to one mote of the network, the bridge mote. The gateway does these steps:

1. It reads one line from the bridge mote for each reading.

2. It signs the reading with the Rabin key of the landowner.

3. It sends the signed reading to the consortium machine on the chain.

The sponsor deploys the machine, enrols the landowners and funds the payments. Each person has a TOML config file for the `k17forth` tool. A config file holds secrets: the wallet key and the Rabin key. The tool refuses a config file that other users can read. Give each config file mode 600.

Keep each config file outside the repository, or in the `gateways/` folder. Git ignores `*.toml` files and `gateways/` in this repository, so a config file does not go into a commit.

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

The line shows the round and the slot. It shows the paid readings and the satoshis that the slot earned. Then it shows the cycle of this tick.

To relay one reading and stop, add `--once`. Then the gateway stops after the machine pays the reading. With `--once`, the exit code is 0 only when the machine accepted the reading. It is 3 when the gateway refused the reading or the machine rejected it.

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

- The sponsor enrolled the slot with another payout address. The gateway refuses the reading with "slot payout is not this gateway's address". Ask the sponsor to enrol the address that `gateway init` printed.

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

## Worked example: three gateways on testnet

We ran this tutorial on BSV testnet on 2026-10-19 with one sponsor and three landowners on one computer. All four config files used one wallet. Each landowner had their own Rabin key. Each gateway read one line from standard input, for example `echo "R 5231" | k17forth gateway run --config land1.toml --interval 10 --once`.

The settings were `slots = 3`, `rounds = 2`, `period = 1800`, `epoch = 7`, a range of 0 to 10000, `bountyPerReading = 200` and `floor = 1000`. The value of `start` was the MTP plus 600 seconds. The deposit was 50,000 satoshis, with keeper rewards from 100 to 500 satoshis.

The deployment:

```
outpoint 6e9ac92dab2a45a41c74ebb05e8efaa8df11606858c89499e22eaeef16b5ea27:0
instance f8a87a7e6e631b314dff252b18dda0039cfbc83fbd15e2abdb481d70d4eeaaa5
lastTime 1792391346 (median time past 1792391347)
```

The endorsements (the first one also ran the first cycle of the program):

```
cycle before the endorsement: cycle 4572d25f24b73e45cecc279b03bfdb202dca85192f3509f1779d4351b1fea9f3 lockTime 1792391346 (mtp 1792391347) reward 100
endorsed slot 2 txid c7a4616de5201977798d4e694d8bf4655458b032f2c14ce9ef9e8b70c2a6b979 lockTime 1792391346 (mtp 1792391347)
endorsed slot 3 txid ecd103145a9006203d680e2b594e5f108bd705e4c6266a7233a4d166eabdeb29 lockTime 1792391346 (mtp 1792391347)
```

Cycle `9be22d15...` endorsed slot 1. Its command stopped with "Not Found" after the broadcast, because WhatsOnChain did not yet have the new transaction. The tools now read the new cycle from the keeper and retry this error.

Round 0, the last status line of each gateway:

```
round 0 slot 1 delivered 1 earned 200 sats: cycle 46a14d1f96895d741d121624faf36e9df90df1a7fc4bd68df7de662972e60b15 lockTime 1792391346 (mtp 1792391347) reward 100
round 0 slot 2 delivered 1 earned 200 sats: cycle ce0171182bf44dc2b8fb7436e4ab1c211e0a1eb5464765684ca0bfffb8690f03 lockTime 1792391363 (mtp 1792391364) reward 117
round 0 slot 3 delivered 1 earned 200 sats: cycle 6abce623ed0930f5020474f6fdf5cc13cc63397915f83cf8d3bb970e4e2307c9 lockTime 1792391994 (mtp 1792391995) reward 500
```

Round 0 closed at 1792393747. The MTP passed that time at 07:34 UTC, 18 minutes after the last reading. Then the sponsor keeper closed round 0 and opened round 1:

```
cycle 647b0e50bea3386cb3ed46058044ce89a8641288bdd2ea96a4a30f000b9f3f0c lockTime 1792394347 (mtp 1792394348) reward 500 (after resync)
cycle d18b234cc306cb82524945a54108129f58d14054d53bba7d04ffe3902fe8dc82 lockTime 1792394367 (mtp 1792394368) reward 120
skipped: needs witness
```

Round 1, the last status line of each gateway:

```
round 1 slot 1 delivered 2 earned 400 sats: cycle b6dcb8289377b276f2b0f9833e0bbe163e7d3caa01c480108ec3d426c6f94ee8 lockTime 1792394367 (mtp 1792394368) reward 100
round 1 slot 2 delivered 2 earned 400 sats: cycle 76e93e276d9a4be9e28b7b5c32ad27cc0ca66142e5b41324f088b9c9aa60f63c lockTime 1792394367 (mtp 1792394368) reward 100
round 1 slot 3 delivered 2 earned 400 sats: cycle 411459a808e33ccaae5a47115f9cdbe18603aa79fe4b061edd58d79ffd93d54b lockTime 1792394367 (mtp 1792394368) reward 100
```

Round 1 closed at 1792395547. The MTP passed that time at 08:40 UTC. The keeper then stopped the machine:

```
cycle 292e3272959a01167c2630b2920d464240e05b2b15c254e0545892c10fa3f254 lockTime 1792396087 (mtp 1792396088) reward 500 (after resync) -> halted
```

The output of `k17forth inspect 411459a808e33ccaae5a47115f9cdbe18603aa79fe4b061edd58d79ffd93d54b:0 --history --network testnet`, without the disassembly:

```
output 411459a808e33ccaae5a47115f9cdbe18603aa79fe4b061edd58d79ffd93d54b:0  45963 sats
pc 382  lastTime 1792394367
ds []
rs []
out [5231 4987 6102 5302 5010 6048]
mem [0]=4 [2]=1 [3]=1 [4]=1
roster 0 key=5a021e1f.. payout=0000000000000000000000000000000000000000
roster 1 key=90ca1c85.. payout=4d6209433a8c33a20492502a27cb7b9358badcf2
roster 2 key=9291e080.. payout=4d6209433a8c33a20492502a27cb7b9358badcf2
roster 3 key=2b80e2eb.. payout=4d6209433a8c33a20492502a27cb7b9358badcf2
instance f8a87a7e6e631b314dff252b18dda0039cfbc83fbd15e2abdb481d70d4eeaaa5
beneficiary 4d6209433a8c33a20492502a27cb7b9358badcf2  reward min 100 slope 1 max 500
history (20 cycles, oldest first):
  4572d25f24b73e45cecc279b03bfdb202dca85192f3509f1779d4351b1fea9f3 lockTime 1792391346 reward 100 -> pc 12
  9be22d15495cc21f4986629477bb69aa9b5c8ac3d115f9f99c68eccc16accd3b lockTime 1792391346 reward 100 -> pc 12
  c7a4616de5201977798d4e694d8bf4655458b032f2c14ce9ef9e8b70c2a6b979 lockTime 1792391346 reward 100 -> pc 12
  ecd103145a9006203d680e2b594e5f108bd705e4c6266a7233a4d166eabdeb29 lockTime 1792391346 reward 100 -> pc 12
  37e492ce596c49281634614e6e0c2f0f3ad808509bdbf0d124676bb48fb414e5 lockTime 1792391346 reward 100 -> pc 91
  a419dc3fea0c2f6288ddf338d4151deb0c66b0ac1b53fc05fe0149ca0172651b lockTime 1792391346 reward 100 -> pc 180
  171bd98a0523042959dc8d5a126ba64fa3d1e2dbb115caab732f534c95433bf6 lockTime 1792391346 reward 100 -> pc 247
  46a14d1f96895d741d121624faf36e9df90df1a7fc4bd68df7de662972e60b15 lockTime 1792391346 reward 100 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 1) -> pc 180
  c014302caa5eb043fe39b4803c15e90e12fa0e48dcfde50a178edcb720149573 lockTime 1792391346 reward 100 -> pc 247
  ce0171182bf44dc2b8fb7436e4ab1c211e0a1eb5464765684ca0bfffb8690f03 lockTime 1792391363 reward 117 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 2) -> pc 180
  3ccddcd952121a966098883ec8e31d81a139902ba870b6672a13ceb10aaba50c lockTime 1792391363 reward 100 -> pc 247
  6abce623ed0930f5020474f6fdf5cc13cc63397915f83cf8d3bb970e4e2307c9 lockTime 1792391994 reward 500 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 3) -> pc 180
  647b0e50bea3386cb3ed46058044ce89a8641288bdd2ea96a4a30f000b9f3f0c lockTime 1792394347 reward 500 -> pc 293
  d18b234cc306cb82524945a54108129f58d14054d53bba7d04ffe3902fe8dc82 lockTime 1792394367 reward 120 -> pc 382
  0597e82d4fcb519174f86dabbd47a671591f2cfb66c291d877a9cca9985265f7 lockTime 1792394367 reward 100 -> pc 449
  b6dcb8289377b276f2b0f9833e0bbe163e7d3caa01c480108ec3d426c6f94ee8 lockTime 1792394367 reward 100 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 1) -> pc 382
  c02ba529b38723c71af05f7a3497a32031c4c2a9be6f728568666133563a9b6a lockTime 1792394367 reward 100 -> pc 449
  76e93e276d9a4be9e28b7b5c32ad27cc0ca66142e5b41324f088b9c9aa60f63c lockTime 1792394367 reward 100 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 2) -> pc 382
  7ff45fc59930d002b1dee8ce3fea8003215b41211b2933653534d17eee9d1c11 lockTime 1792394367 reward 100 -> pc 449
  411459a808e33ccaae5a47115f9cdbe18603aa79fe4b061edd58d79ffd93d54b lockTime 1792394367 reward 100 payout 200 to 4d6209433a8c33a20492502a27cb7b9358badcf2 (slot 3) -> pc 382
```

The output log holds the six readings: three in round 0 and three in round 1. Each slot earned 400 satoshis. The keepers earned 3,337 satoshis in 21 cycles. The stop cycle refunded 45,463 satoshis to the sponsor. Together these are the deposit of 50,000 satoshis.

The wallet paid 15,207 satoshis in fees for the whole example. This includes the deployment, 21 cycles and the fee splits of the wallet. From the deployment to the stop took 91 minutes. Most of that time was the wait for the MTP to pass the close of each round.

## Before you go to mainnet

On mainnet, each command needs the switch `--i-know-this-spends-real-money`.

The nChain patent US 12,020,249 B2 and its continuations read on the architecture of the K17 machine. Get a freedom-to-operate opinion before any commercial use on mainnet.
