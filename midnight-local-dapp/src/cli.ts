// Copyright 2025 Shagun Prasad
// SPDX-License-Identifier: Apache-2.0
// CLI for interacting with Hello World contract using same wallet as deploy/Lace

import * as readline from "readline/promises";
import { pathToFileURL } from "node:url";
import * as path from "path";
import * as fs from "fs";
import * as rx from "rxjs";
import * as bip39 from "bip39";
import * as ledger from "@midnight-ntwrk/ledger-v6";
import { MidnightBech32m } from "@midnight-ntwrk/wallet-sdk-address-format";
import { initWalletWithSeed } from "./utils.js";

const SHIELDED_NATIVE_RAW = ledger.shieldedToken().raw;
const NETWORK_ID = "undeployed";
const INDEXER_URL = "http://localhost:8088/api/v3/graphql";

// Query contract state from indexer
async function queryContractState(contractAddress: string): Promise<any> {
  const query = `
    query ContractState($address: HexEncoded!) {
      contractState(address: $address) {
        data
      }
    }
  `;

  const response = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { address: contractAddress },
    }),
  });

  const result = await response.json();
  return result.data?.contractState;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Hello World Contract CLI (Lace-compatible wallet)\n");

  try {
    // Check for deployment file
    if (!fs.existsSync("deployment.json")) {
      console.error(
        'No deployment.json found! Run deploy from repo root: yarn deploy "your mnemonic"'
      );
      process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync("deployment.json", "utf-8"));
    console.log(`Contract: ${deployment.contractAddress}\n`);

    // Accept mnemonic (same as Lace / yarn fund / yarn deploy)
    const input = (
      await rl.question("Enter your mnemonic (or 64-char hex seed): ")
    ).trim();

    let seed: Buffer;
    if (bip39.validateMnemonic(input)) {
      seed = bip39.mnemonicToSeedSync(input).subarray(0, 32) as Buffer;
    } else if (input.length === 64 && /^[0-9a-fA-F]+$/.test(input)) {
      seed = Buffer.from(input, "hex");
    } else {
      console.error(
        "Enter a valid BIP-39 mnemonic (12 or 24 words) or 64 hexadecimal characters."
      );
      rl.close();
      process.exit(1);
    }

    console.log("\nBuilding wallet (same derivation as Lace)...");
    const { wallet, shieldedSecretKeys, dustSecretKey } =
      await initWalletWithSeed(seed);
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    // Wait for wallet to sync
    await rx.firstValueFrom(wallet.state().pipe(rx.filter((s) => s.isSynced)));
    const state = await rx.firstValueFrom(wallet.state());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shieldedAddress = (MidnightBech32m as any).encode(
      NETWORK_ID,
      state.shielded.address
    ).toString();
    console.log(`Your wallet address (Lace match): ${shieldedAddress}`);

    const balance = state.shielded.balances[SHIELDED_NATIVE_RAW] ?? 0n;
    if (balance === 0n) {
      console.log(
        'Balance is 0. Fund from repo root: yarn fund "<mnemonic>"'
      );
    } else {
      console.log(`Balance: ${balance}`);
    }
    console.log();

    // Load compiled contract for state decoding
    console.log("Loading contract...");
    const contractPath = path.join(process.cwd(), "contracts");
    const contractModulePath = path.join(
      contractPath,
      "managed",
      "hello-world",
      "contract",
      "index.js"
    );

    if (!fs.existsSync(contractModulePath)) {
      console.error("Contract not found! Run: yarn compile");
      rl.close();
      await wallet.stop();
      process.exit(1);
    }

    const HelloWorldModule = await import(
      pathToFileURL(contractModulePath).href
    );

    console.log("Ready\n");

    // Main menu loop
    let running = true;
    while (running) {
      console.log("--- Menu ---");
      console.log("1. Read current message");
      console.log("2. Show wallet info");
      console.log("3. Exit");

      const choice = await rl.question("\nYour choice: ");

      switch (choice) {
        case "1": {
          console.log("\nReading message from blockchain...");
          try {
            const contractState = await queryContractState(
              deployment.contractAddress
            );
            if (contractState && contractState.data) {
              // Decode the state using the contract module
              const ledgerState = HelloWorldModule.ledger(contractState.data);
              const message = Buffer.from(ledgerState.message).toString();
              console.log(`Current message: "${message}"\n`);
            } else {
              console.log("No message found (contract state empty)\n");
            }
          } catch (error) {
            console.error("Failed to read message:", error);
          }
          break;
        }

        case "2": {
          // Refresh wallet state
          const currentState = await rx.firstValueFrom(wallet.state());
          const currentBalance =
            currentState.shielded.balances[SHIELDED_NATIVE_RAW] ?? 0n;
          console.log(`\nWallet address: ${shieldedAddress}`);
          console.log(`Balance: ${currentBalance}\n`);
          break;
        }

        case "3":
          running = false;
          console.log("\nGoodbye!");
          break;

        default:
          console.log("Invalid choice. Please enter 1, 2, or 3.\n");
      }
    }

    await wallet.stop();
  } catch (error) {
    console.error("\nError:", error);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
