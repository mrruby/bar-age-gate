# midnight-local-dapp

Hello World dApp for the **local Midnight network** (Undeployed). Configured to work with `midnight-playground` (Docker: node, indexer, proof server).

## Prerequisites

1. **Local network running** — from repo root:
   ```bash
   docker compose up -d
   ```
2. **Wallet funded** — use the same Lace wallet (Undeployed network) and fund it from repo root:
   ```bash
   yarn fund "your mnemonic from Lace"
   ```

## Deploy the contract (from repo root)

To deploy using **the same wallet as Lace** (same address from your mnemonic), run from the **repo root**:

```bash
yarn deploy "your twelve or twenty four mnemonic words"
```

- Uses the same wallet derivation as Lace and `yarn fund`, so the deployed contract is owned by your Lace-funded address.
- Writes `midnight-local-dapp/deployment.json` with the contract address.

After a successful deploy you get:

- `deployment.json` — contract address and timestamp
- Contract is live on your local chain

## Using the CLI

The CLI uses the **same wallet derivation as Lace/deploy**, so your address and balance will match.

```bash
cd midnight-local-dapp
yarn install
yarn build
yarn cli
```

Enter your mnemonic when prompted. The CLI can:
- **Read** the current message stored in the contract
- **Show** your wallet address and balance

## Storing messages

The contract starts with an empty message. To store a message, you need to call the `storeMessage` circuit, which requires:
- A dApp frontend connected to Lace via the dapp-connector-api
- The frontend configured for Undeployed network with local endpoints
- Proof generation through the proof server

The CLI currently supports **reading** contract state. For **writing**, use a dApp frontend connected to Lace.

## Scripts

| Script    | Description                             |
|-----------|-----------------------------------------|
| `compile` | Compile `contracts/hello-world.compact` |
| `build`   | Compile TypeScript (`src/` → `dist/`)   |
| `cli`     | Run the interactive CLI                 |

## Config (local / undeployed)

- **Network:** `NetworkId.Undeployed`
- **Indexer:** `http://localhost:8088/api/v3/graphql` (and WS at `/api/v3/graphql/ws`)
- **Node:** `http://localhost:9944`
- **Proof server:** `http://127.0.0.1:6300`

These match the defaults used by `midnight-playground`.
