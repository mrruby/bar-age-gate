# Midnight Local Playground

A **playground** for writing [Compact](https://docs.midnight.network) contracts and deploying them **locally** on your machine. Use the **Midnight Lace Preview Wallet** on the **“Undeployed”** network to fund your wallet, deploy contracts, and interact with them—without depending on public testnets or faucets.

---

## What this repo is for

- **Write** Compact smart contracts (edit the example in `midnight-local-dapp` or add your own).
- **Run** a full local Midnight network (node, indexer, proof server) via Docker.
- **Fund** your Lace-derived wallet using a CLI script (no built-in faucet on Undeployed).
- **Deploy** contracts from the repo root using the **same wallet as Lace** (mnemonic-based).
- **Interact** with deployed contracts via the Lace wallet UI or a CLI adapted for the local setup.

Ideal for development, workshops, and learning the Compact toolchain and Midnight stack locally.

---

## Prerequisites

- **Git**
- **Docker** and **Docker Compose v2**
- **Node.js ≥ 22.16.0** ([nvm](https://github.com/nvm-sh/nvm) recommended)
- **Yarn** (classic)
- **Midnight Lace Preview** (v2.36.0 or later) browser extension

---

## Quick reference: ports

| Service       | Port | Purpose        |
|---------------|------|----------------|
| Proof Server  | 6300 | ZK proof generation |
| Node          | 9944 | RPC / chain   |
| Indexer       | 8088 | GraphQL API   |

---

## Step-by-step setup

All commands below are from the **repository root** unless stated otherwise.

### 1. Clone and install

```bash
git clone https://github.com/0xshae/midnight-playground.git midnight-playground
cd midnight-playground
nvm use 22   # or: nvm install 22 && nvm use 22
yarn install
```

### 2. Start the local network

```bash
docker compose up -d
```

Give it a short time to start (e.g. 30 seconds). The node, indexer, and proof server will be available on the ports above.

### 3. Connect Lace to “Undeployed”

- In **Lace** → **Settings** → **Midnight**
- Set network to **“Undeployed”**
- Save and switch the wallet to that network

Use the same wallet (and mnemonic) for funding and deployment so addresses match.

### 4. Fund your wallet

The Undeployed network has no faucet. Use the included fund script with your **BIP-39 mnemonic** (the one from Lace):

```bash
yarn fund "your twelve or twenty four mnemonic words"
```

This funds both the shielded and unshielded addresses derived from that mnemonic (same derivation as Lace). You can also fund a single address:

```bash
yarn fund mn_shield-addr_undeployed1...
yarn fund mn_addr_undeployed1...
```

### 5. Generate DUST in Lace (required before deploy)

Deploying a contract uses **DUST** for fees. You must have DUST in your Lace wallet on the Undeployed network:

1. Open **Lace** → **Midnight** (Undeployed).
2. Use the wallet UI to **generate DUST** (follow Lace’s in-app steps).
3. **Wait for DUST to refill** to the required level.

If you skip this step, `yarn deploy` can fail due to insufficient DUST.

### 6. Deploy the Hello World contract

From the repo root, using the **same mnemonic** as Lace:

```bash
yarn deploy "your twelve or twenty four mnemonic words"
```

- Requires a **funded** wallet (`yarn fund` first) and **DUST** (generated in Lace).
- Deploys the contract from `midnight-local-dapp` (Hello World example).
- Writes **`midnight-local-dapp/deployment.json`** with `contractAddress` and `txHash`.

You can re-run this after changing the contract (see below).

---

## Changing the contract and redeploying

1. **Edit** the Compact source, e.g.  
   `midnight-local-dapp/contracts/hello-world.compact`
2. **Recompile** from the dApp directory:
   ```bash
   cd midnight-local-dapp
   yarn compile
   cd ..
   ```
3. **Redeploy** from the repo root:
   ```bash
   yarn deploy "your mnemonic"
   ```

The deploy script is currently wired to the **Hello World** contract and its `storeMessage` entrypoint/verifier. To deploy a different contract or entrypoint, you’d need to point the deploy script at that contract’s path and verifier key (see `src/deploy.ts`).

---

## Interacting with the deployed contract

### Option A: CLI (read contract state)

The `midnight-local-dapp` folder includes a CLI that uses the **same wallet derivation as Lace/deploy**, so your address and balance match.

```bash
cd midnight-local-dapp
yarn install
yarn build
yarn cli
```

Enter your mnemonic when prompted. The CLI can:
- **Read** the current message stored in the contract
- **Show** your wallet address and balance (matches Lace)

Example session:
```
Hello World Contract CLI (Lace-compatible wallet)

Contract: aa6ce704ee3f482b8675ba1b0f95f9e0dfa8fbcf693800e32f3b5593dbd41688

Enter your mnemonic: <your mnemonic>

Building wallet (same derivation as Lace)...
Your wallet address (Lace match): mn_shield-addr_undeployed1r6d...
Balance: 94011000000

--- Menu ---
1. Read current message
2. Show wallet info
3. Exit
```

### Option B: Lace wallet UI (store messages)

To **store a message** in the contract, use a dApp frontend connected to Lace:

1. Build or use a dApp that connects to Lace via the **dapp-connector-api**
2. Configure it for the **Undeployed** network with local endpoints:
   - Indexer: `http://127.0.0.1:8088/api/v3/graphql`
   - Node: `http://127.0.0.1:9944`
   - Proof server: `http://127.0.0.1:6300`
3. Point it at the contract address from `midnight-local-dapp/deployment.json`
4. Call the `storeMessage` circuit through the dApp UI

Lace will use your local node/indexer when connected to Undeployed.

### Why can't the CLI store messages?

Storing a message requires calling the `storeMessage` circuit, which involves:
- Building a contract call transaction with ZK proofs
- The proof server generating proofs for the circuit inputs

This is typically handled by a dApp frontend + Lace, which manages the proof generation and transaction signing through the wallet connector. The CLI currently focuses on reading state, which doesn't require proofs.

---

## Repo layout (relevant parts)

```
midnight-playground/
├── compose.yml          # Docker: node, indexer, proof-server
├── package.json         # Root scripts: fund, deploy
├── src/
│   ├── fund.ts          # Fund shielded/unshielded from mnemonic or address
│   ├── deploy.ts        # Deploy Hello World using Lace-compatible wallet
│   └── utils.ts         # Wallet initialization (HD wallet, same derivation as Lace)
└── midnight-local-dapp/
    ├── contracts/
    │   ├── hello-world.compact   # Edit this (or add new contracts)
    │   └── managed/hello-world/  # Compiled output, keys, contract module
    ├── deployment.json           # Written by yarn deploy
    ├── src/
    │   ├── cli.ts                # CLI for reading contract state
    │   └── utils.ts              # Wallet utils (same as root)
    └── package.json              # compile, build, cli scripts
```

---

## Scripts

### Repo root

| Script                   | Description |
|--------------------------|-------------|
| `yarn fund "mnemonic"`   | Fund Lace-derived addresses on Undeployed (or pass a single address). |
| `yarn deploy "mnemonic"` | Deploy the Hello World contract; requires funded wallet + DUST in Lace. |

### midnight-local-dapp

| Script        | Description                                |
|---------------|--------------------------------------------|
| `yarn compile`| Compile `contracts/hello-world.compact`    |
| `yarn build`  | Compile TypeScript (`src/` → `dist/`)      |
| `yarn cli`    | Run the interactive CLI (read contract state, show wallet info) |

---

## Troubleshooting

- **“Balance is still 0”**  
  Run `yarn fund "your mnemonic"` and ensure the local network is up (`docker compose up -d`).

- **Deploy fails (e.g. insufficient DUST)**  
  In Lace (Undeployed), generate DUST and wait for it to refill, then run `yarn deploy` again.

- **“Invalid Transaction: Custom error: 110”**  
  The node rejected the deploy (e.g. verifier key or proof issue). Check `docker compose logs node` and ensure node/image versions in `compose.yml` match the ledger-v6 and proof-server versions used by this repo.

- **“Command 'fund' not found”**  
  Run `yarn install` from the repo root so the `fund` script is available.

---

## References

- [Midnight Docs – Interact with an MN app](https://docs.midnight.network/getting-started/interact-with-mn-app) (Testnet CLI flow; adapt endpoints and network for local Undeployed).
- [Compact](https://docs.midnight.network) – Midnight’s smart contract language and toolchain.
