# Midnight Bar Age-Gate Demo (Local)

Local Midnight demo that showcases zero-knowledge age verification with separate roles:
- `Client` registers and stores age privately
- `Client` proves `age >= 18` without revealing exact age
- `Bartender` sells drinks only when on-chain permit is valid

Public chain state stores only:
- age commitment (`ageCommitment`)
- adult permit (`adultPermit`)
- drink counter (`drinksSold`)

Exact age is stored only in encrypted private state.

## Prerequisites

- Node.js `v22.16.0` (from `.nvmrc`)
- Yarn `1.22.x`
- Docker + Docker Compose
- Compact version manager `compact` and compiler `0.28.0`
- Chrome browser (for Lace Midnight Preview extension)

Compact setup:

```bash
compact --version
compact update 0.28.0
compact list
```

## Install and Configure Lace Midnight Preview

Install the extension:
1. Open Chrome Web Store:
   - https://chromewebstore.google.com/detail/lace-beta/hgeekaiplokcnmakghbdfbgnlfheichg
2. Click **Add to Chrome** and pin the extension.
3. Open Lace and complete onboarding:
   - create a new wallet or restore existing wallet
   - save recovery phrase offline

Configure it for local Docker network:
1. Open Lace settings and switch to Midnight Preview mode.
2. Select or add the `Undeployed` local network profile.
3. Set local endpoints:
   - Node WS: `ws://127.0.0.1:9944`
   - Indexer WS: `ws://127.0.0.1:8088/api/v3/graphql/ws`
   - Proof server: `http://127.0.0.1:6300`
4. Save settings and reconnect the wallet.

Mnemonic options for this demo:
- Use an existing Lace mnemonic (create/restore inside Lace).
- Or leave CLI mnemonic prompt empty and let CLI generate one-time mnemonic.
- Or generate one from terminal: `yarn mnemonic`.
- `yarn fund` and `yarn dust` always require an argument (mnemonic or address). Running them without args will fail.

Compatibility reference:
- https://forum.midnight.network/t/release-announcement-compatibility-v1-0/1020

## Install Dependencies

```bash
yarn install
```

## Start Local Network

```bash
docker compose up -d
docker compose ps
```

Services:
- `node` on `9944`
- `indexer` on `8088`
- `proof-server` on `6300`

## Compile + Build

```bash
yarn compile
yarn build
```

This generates artifacts under:
- `contracts/managed/bar-age-gate`

## Fund and Prepare Wallets

Use two wallets (client and bartender). You can use mnemonics from Lace Midnight Preview.

Generate a new mnemonic from terminal (optional):

```bash
yarn mnemonic
```

Fund each wallet:

```bash
MIDNIGHT_HOST=127.0.0.1 yarn fund "<client mnemonic>"
MIDNIGHT_HOST=127.0.0.1 yarn fund "<bartender mnemonic>"
```

If CLI generated mnemonics for you, use them directly:

```bash
MIDNIGHT_HOST=127.0.0.1 yarn fund "<generated client mnemonic>"
MIDNIGHT_HOST=127.0.0.1 yarn fund "<generated bartender mnemonic>"
```

You can also fund by address:

```bash
MIDNIGHT_HOST=127.0.0.1 yarn fund mn_shield-addr_undeployed...
MIDNIGHT_HOST=127.0.0.1 yarn fund mn_addr_undeployed...
```

Register NIGHT UTXOs for dust generation:

```bash
MIDNIGHT_HOST=127.0.0.1 yarn dust "<client mnemonic>"
MIDNIGHT_HOST=127.0.0.1 yarn dust "<bartender mnemonic>"
```

## Deploy Contract

Use one wallet mnemonic that already has:
- NIGHT balance (funded)
- DUST balance (registered and non-zero)

You can use either role wallet, but typically use the **client wallet mnemonic**.

```bash
MIDNIGHT_HOST=127.0.0.1 yarn deploy "<mnemonic>"
MIDNIGHT_HOST=127.0.0.1 yarn deploy "<client mnemonic>"
```

Run deploy from this repo root (`/Users/dawidurbas/Main/mf2`).

Deploy writes `deployment.json` with:
- `contractAddress`
- `txHash`
- `deployedAt`

Quick check:

```bash
cat deployment.json
```

## Run CLI

```bash
MIDNIGHT_HOST=127.0.0.1 yarn cli
```

Startup behavior:
- CLI asks for client mnemonic and bartender mnemonic.
- If input is empty, CLI generates a mnemonic and prints it once.
- Generated mnemonics are not stored in files.

Menu:
1. `Register client (client wallet)`
2. `Prove adult (client wallet)`
3. `Sell drink (bartender wallet)`
4. `Exit`

Important:
- `Sell drink` succeeds only after `Prove adult` has succeeded for that client.
- Registering an adult client does not automatically mark them as verified.

## End-to-End Demo Flow

1. Register under-18 client (for example age `17`) -> registration succeeds.
2. Try `Prove adult` for that client -> rejected.
3. Bartender `Sell drink` for that client -> `SALE_REJECTED`.
4. Register adult client (for example age `22`) -> registration succeeds.
5. If bartender tries `Sell drink` now -> still `SALE_REJECTED` (not verified yet).
6. Run `Prove adult` for that adult client -> succeeds.
7. Bartender `Sell drink` again -> `SALE_APPROVED` and `drinksSold` increments.

## Privacy Model

- Real age is stored in encrypted private state maintained by the client wallet flow.
- Contract stores only commitment/permit/counter on chain.
- Bartender never sees exact age.
- Sale path always enforces adult permit on-chain.

## Stop Local Network

```bash
docker compose down
```

## Troubleshooting

- `Not enough Dust generated to pay the fee`:
  - run `yarn dust` again and wait for non-zero dust balance.
- `No deployment.json found`:
  - run `yarn deploy` first.
- CLI shows a different contract address than your latest deploy:
  - you are likely in a different directory or using stale `deployment.json`.
  - run `cat deployment.json` in `/Users/dawidurbas/Main/mf2` and confirm it matches latest deploy output.
- `Contract bindings not found`:
  - run `yarn compile`.
- Wallet sync timeout:
  - verify Docker services are healthy and `MIDNIGHT_HOST=127.0.0.1` is set.
- Adult client still gets `SALE_REJECTED`:
  - run menu option `2` (`Prove adult`) for that client before menu option `3` (`Sell drink`).
