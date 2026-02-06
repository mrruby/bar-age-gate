import { WalletBuilder } from "@midnight-ntwrk/wallet";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NetworkId, setNetworkId, getZswapNetworkId, getLedgerNetworkId, } from "@midnight-ntwrk/midnight-js-network-id";
import { createBalancedTx } from "@midnight-ntwrk/midnight-js-types";
import { nativeToken, Transaction } from "@midnight-ntwrk/ledger";
import { Transaction as ZswapTransaction } from "@midnight-ntwrk/zswap";
import { WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";
import * as readline from "readline/promises";
import * as Rx from "rxjs";
// Fix WebSocket for Node.js environment
// @ts-ignore
globalThis.WebSocket = WebSocket;
// Configure for local network (Undeployed) — matches midnight-local-network
setNetworkId(NetworkId.Undeployed);
// Local connection endpoints (indexer api/v3, node, proof server)
const LOCAL_CONFIG = {
    indexer: "http://localhost:8088/api/v3/graphql",
    indexerWS: "ws://localhost:8088/api/v3/graphql/ws",
    node: "http://localhost:9944",
    proofServer: "http://127.0.0.1:6300",
};
const waitForFunds = (wallet) => Rx.firstValueFrom(wallet.state().pipe(Rx.tap((state) => {
    if (state.syncProgress) {
        console.log(`Sync progress: synced=${state.syncProgress.synced}, sourceGap=${state.syncProgress.lag.sourceGap}, applyGap=${state.syncProgress.lag.applyGap}`);
    }
}), Rx.filter((state) => state.syncProgress?.synced === true), Rx.map((s) => s.balances[nativeToken()] ?? 0n), Rx.filter((balance) => balance > 0n), Rx.tap((balance) => console.log(`Wallet funded with balance: ${balance}`))));
async function main() {
    console.log("Midnight Hello World Deployment (local / undeployed)\n");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const choice = await rl.question("Do you have a wallet seed? (y/n): ");
        let walletSeed;
        if (choice.toLowerCase() === "y" || choice.toLowerCase() === "yes") {
            walletSeed = await rl.question("Enter your 64-character seed: ");
        }
        else {
            const bytes = new Uint8Array(32);
            // @ts-ignore
            crypto.getRandomValues(bytes);
            walletSeed = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
            console.log(`\nSAVE THIS SEED: ${walletSeed}\n`);
        }
        // Build wallet from seed
        console.log("Building wallet...");
        const wallet = await WalletBuilder.buildFromSeed(LOCAL_CONFIG.indexer, LOCAL_CONFIG.indexerWS, LOCAL_CONFIG.proofServer, LOCAL_CONFIG.node, walletSeed, getZswapNetworkId(), "info");
        wallet.start();
        const state = await Rx.firstValueFrom(wallet.state());
        console.log(`Your wallet address is: ${state.address}`);
        let balance = state.balances[nativeToken()] || 0n;
        if (balance === 0n) {
            console.log(`Your wallet balance is: 0`);
            console.log("Fund your wallet: from the repo root run 'yarn fund \"<your-mnemonic>\"' or 'yarn fund <mn_addr_undeployed...>'.");
            console.log(`Waiting to receive tokens...`);
            balance = await waitForFunds(wallet);
        }
        console.log(`Balance: ${balance}`);
        // Load compiled contract (index.js — ESM output)
        console.log("Loading contract...");
        const contractPath = path.join(process.cwd(), "contracts");
        const contractModulePath = path.join(contractPath, "managed", "hello-world", "contract", "index.js");
        if (!fs.existsSync(contractModulePath)) {
            console.error("Contract not found! Run: npm run compile");
            process.exit(1);
        }
        const HelloWorldModule = await import(pathToFileURL(contractModulePath).href);
        const contractInstance = new HelloWorldModule.Contract({});
        // Create wallet provider for transactions
        const walletState = await Rx.firstValueFrom(wallet.state());
        const walletProvider = {
            coinPublicKey: walletState.coinPublicKey,
            encryptionPublicKey: walletState.encryptionPublicKey,
            balanceTx(tx, newCoins) {
                return wallet
                    .balanceTransaction(ZswapTransaction.deserialize(tx.serialize(getLedgerNetworkId()), getZswapNetworkId()), newCoins)
                    .then((tx) => wallet.proveTransaction(tx))
                    .then((zswapTx) => Transaction.deserialize(zswapTx.serialize(getLedgerNetworkId()), getZswapNetworkId()))
                    .then(createBalancedTx);
            },
            submitTx(tx) {
                return wallet.submitTransaction(tx);
            },
        };
        // Configure all required providers
        console.log("Setting up providers...");
        const zkConfigPath = path.join(contractPath, "managed", "hello-world");
        const providers = {
            privateStateProvider: levelPrivateStateProvider({
                privateStateStoreName: "hello-world-state",
            }),
            publicDataProvider: indexerPublicDataProvider(LOCAL_CONFIG.indexer, LOCAL_CONFIG.indexerWS),
            zkConfigProvider: new NodeZkConfigProvider(zkConfigPath),
            proofProvider: httpClientProofProvider(LOCAL_CONFIG.proofServer),
            walletProvider: walletProvider,
            midnightProvider: walletProvider,
        };
        // Deploy contract to the blockchain
        console.log("Deploying contract (30-60 seconds)...");
        const deployed = await deployContract(providers, {
            contract: contractInstance,
            privateStateId: "helloWorldState",
            initialPrivateState: {},
        });
        const contractAddress = deployed.deployTxData.public.contractAddress;
        console.log("\nDEPLOYED!");
        console.log(`Contract: ${contractAddress}\n`);
        const info = {
            contractAddress,
            deployedAt: new Date().toISOString(),
        };
        fs.writeFileSync("deployment.json", JSON.stringify(info, null, 2));
        console.log("Saved to deployment.json");
        await wallet.close();
    }
    catch (error) {
        console.error("Failed:", error);
    }
    finally {
        rl.close();
    }
}
main().catch(console.error);
