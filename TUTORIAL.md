# Tutorial: Your First Midnight Smart Contract with Midnight Playground

If you are new to Midnight, you might be used to public blockchains where every transaction is visible. Midnight is different. It uses **Zero-Knowledge (ZK)** technology to allow for "selective disclosure."

This tutorial guides you through writing, compiling, and deploying your first Compact contract locally using the **midnight-playground**.

---

## 1. Understanding the Midnight Stack

Before we code, you need to understand the three pillars of a Midnight application:

- **The Node:** Maintains the ledger (the "Undeployed" network).
- **The Indexer:** A GraphQL service that allows you to query the state of the blockchain.
- **The Proof Server:** This is where the magic happens. It generates the ZK proofs on your machine before they are sent to the node. This ensures your private data never leaves your computer.

---

## 2. Setting Up the Playground

First, clone the environment and install dependencies. You'll need **Node.js v22** and **Docker**.

```bash
git clone https://github.com/0xshae/midnight-playground
cd midnight-playground
nvm use 22
yarn install
```

Start your local infrastructure:

```bash
docker compose up -d
```

> **Note:** Wait about 30 seconds for the indexer to sync.

---

## 3. Writing the Compact Contract

**Compact** is Midnight's language. It feels like a mix of TypeScript and C++, but it handles state in two ways: **Public** and **Private**.

Navigate to `midnight-local-dapp/contracts/hello-world.compact`. You'll see a structure like this:

```compact
pragma language_version 0.20.0;

export ledger message: Opaque<"string">;

export circuit storeMessage(customMessage: Opaque<"string">): [] {
  message = disclose(customMessage);
}
```

- **`ledger message`** — The ledger is what is stored on-chain. Here, a single private string (`Opaque<"string">`).
- **`export circuit storeMessage(...)`** — Transitions (how state changes) are defined as **circuits**. This one takes a private message and **discloses** it into the ledger.

### Key Concept: The "Circuit"

In Midnight, functions are called **circuits**. When you run `storeMessage`, your Proof Server executes the logic locally and generates a proof that the state transition is valid without necessarily revealing the inputs used.

---

## 4. Compiling and Funding

Midnight doesn't use standard `.js` or `.rs` files for contracts; it compiles them into a **contract pack**.

```bash
cd midnight-local-dapp
yarn compile
cd ..
```

### Funding your Wallet

The local "Undeployed" network doesn't have a public faucet. You must fund your Lace wallet using the playground's CLI:

```bash
yarn fund "your twelve word mnemonic phrase here"
```

This script derives your public/private addresses from your mnemonic and provides them with local DUST and tokens.

---

## 5. Deployment

In the root directory, run:

```bash
yarn deploy "your twelve word mnemonic phrase"
```

**What happens during deployment?**

1. Your mnemonic is used to sign the transaction.
2. The compiled contract bytecode is sent to the local Midnight node.
3. A `deployment.json` file is created in `midnight-local-dapp/`, containing your `contractAddress`.

---

## 6. Interaction

### Reading Contract State (CLI)

The playground includes a CLI that uses the **same wallet derivation as Lace**, so your address and balance match.

```bash
cd midnight-local-dapp
yarn install
yarn build
yarn cli
```

Enter your mnemonic when prompted. You'll see:

```
Hello World Contract CLI (Lace-compatible wallet)

Contract: aa6ce704ee3f482b...

Enter your mnemonic: <your mnemonic>

Building wallet (same derivation as Lace)...
Your wallet address (Lace match): mn_shield-addr_undeployed1r6d...
Balance: 94011000000

--- Menu ---
1. Read current message
2. Show wallet info
3. Exit
```

The CLI can:
- **Read** the current message stored in the contract
- **Show** your wallet address and balance (matches Lace)

### Storing Messages (dApp + Lace)

The contract starts with an **empty** message. To store a message, you need to call the `storeMessage` circuit.

**Why can't the CLI store messages?**

Storing requires:
1. Building a contract call transaction
2. Generating a ZK proof for the circuit inputs
3. Signing and submitting the transaction

This flow is handled by **Lace + a dApp frontend**:
- The dApp calls the contract via the **dapp-connector-api**
- Lace manages proof generation and transaction signing
- The proof server (`http://localhost:6300`) generates the ZK proofs

To store a message:
1. Build or use a dApp frontend configured for the **Undeployed** network
2. Point it at your local endpoints (indexer: `http://localhost:8088`, node: `http://localhost:9944`)
3. Connect Lace (set to Undeployed)
4. Call the `storeMessage` circuit through the dApp UI

After storing, run the CLI again and select "Read current message" to see your stored message.

---

## Troubleshooting Tips

- **"No message found (contract state empty)":** The contract deploys with an empty message. You need to call `storeMessage` via a dApp + Lace to store a message first.
- **Insufficient DUST:** Even on a local network, Midnight uses DUST for fees. Ensure you "Generate DUST" inside the Lace wallet (Undeployed network) after funding.
- **Docker Logs:** If deployment hangs, run `docker compose logs -f` to see if the Node or Indexer is throwing errors.
- **CLI shows different address than deploy:** Make sure you're using the **same mnemonic** for both. The CLI uses the same HD wallet derivation as `yarn deploy` and Lace.
