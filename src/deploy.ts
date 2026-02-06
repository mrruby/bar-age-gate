// Copyright 2025 Shagun Prasad
// SPDX-License-Identifier: Apache-2.0
// Deploy Hello World contract using the same wallet as Lace (mnemonic → same address).
// Run from repo root: yarn deploy "your mnemonic words"

import * as bip39 from 'bip39';
import * as rx from 'rxjs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import * as fs from 'fs';
import * as ledger from '@midnight-ntwrk/ledger-v6';
import { initWalletWithSeed } from './utils';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';

const SHIELDED_NATIVE_RAW = ledger.shieldedToken().raw;
const NETWORK_ID = 'undeployed';
const TTL_MS = 30 * 60 * 1000;
const WAIT_FOR_FUNDS_MS = 90_000;
const WAIT_POLL_MS = 3_000;

async function main(): Promise<void> {
    const mnemonic = process.argv.slice(2).join(' ').trim();
    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        console.error('Usage: yarn deploy "your twelve or twenty four mnemonic words"');
        process.exit(2);
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic).subarray(0, 32);
    console.log('Building wallet (same derivation as Lace)...');
    const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = await initWalletWithSeed(seed);
    await wallet.start(shieldedSecretKeys, dustSecretKey);

    await rx.firstValueFrom(wallet.state().pipe(rx.filter((s) => s.isSynced)));
    let state = await rx.firstValueFrom(wallet.state());
    const shieldedAddress = MidnightBech32m.encode('undeployed', state.shielded.address).toString();
    console.log('Your wallet address (Lace match):', shieldedAddress);

    let balance = state.shielded.balances[SHIELDED_NATIVE_RAW] ?? 0n;
    if (balance === 0n) {
        console.log('Balance is 0. Waiting for funds (e.g. after yarn fund)…');
        const deadline = Date.now() + WAIT_FOR_FUNDS_MS;
        while (balance === 0n && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
            state = await rx.firstValueFrom(wallet.state());
            balance = state.shielded.balances[SHIELDED_NATIVE_RAW] ?? 0n;
        }
    }
    if (balance === 0n) {
        console.error('Balance is still 0. Fund this address from repo root: yarn fund "' + mnemonic + '"');
        await wallet.stop();
        process.exit(1);
    }
    console.log('Balance:', balance.toString());

    const dappDir = path.join(process.cwd(), 'midnight-local-dapp');
    const contractPath = path.join(dappDir, 'contracts', 'managed', 'hello-world', 'contract', 'index.js');
    const verifierKeyPath = path.join(dappDir, 'contracts', 'managed', 'hello-world', 'keys', 'storeMessage.verifier');
    if (!fs.existsSync(contractPath)) {
        console.error('Contract not found at', contractPath);
        await wallet.stop();
        process.exit(1);
    }
    if (!fs.existsSync(verifierKeyPath)) {
        console.error('Verifier key not found at', verifierKeyPath);
        await wallet.stop();
        process.exit(1);
    }
    // ledger-v6 WASM expects verifier key with header 'midnight:verifier-key[v4]:';
    // the contract build may emit v6. Rewrite v6 -> v4 so the setter accepts it.
    const V6_HEADER = new TextEncoder().encode('midnight:verifier-key[v6]:');
    const V4_HEADER = new TextEncoder().encode('midnight:verifier-key[v4]:');
    let verifierKeyBytes = new Uint8Array(fs.readFileSync(verifierKeyPath));
    if (
        verifierKeyBytes.length >= V6_HEADER.length &&
        V6_HEADER.every((b, i) => verifierKeyBytes[i] === b)
    ) {
        verifierKeyBytes = verifierKeyBytes.slice(0);
        verifierKeyBytes.set(V4_HEADER.subarray(0, V4_HEADER.length), 0);
    }

    console.log('Loading contract...');
    const ContractModule = await import(pathToFileURL(contractPath).href);
    const ContractClass = ContractModule.Contract;
    const contractInstance = new ContractClass({});

    const coinPublicKeyHex = state.shielded.coinPublicKey.toHexString();
    const constructorContext = createConstructorContext({}, coinPublicKeyHex);
    const constructorResult = contractInstance.initialState(constructorContext);

    // ledger-v6 expects its own ContractState instance. Use the contract's state value
    // via encode/decode (EncodedStateValue may be shared) and copy the operation.
    const cs = constructorResult.currentContractState as {
        data: { state: { encode: () => ledger.EncodedStateValue } };
        operation: (name: string) => { serialize: () => Uint8Array } | undefined;
    };
    const ledgerState = new ledger.ContractState();
    try {
        const encoded = cs.data.state.encode();
        ledgerState.data = new ledger.ChargedState(ledger.StateValue.decode(encoded));
    } catch {
        // Fallback: minimal state (array with null only)
        ledgerState.data = new ledger.ChargedState(
            ledger.StateValue.newArray().arrayPush(ledger.StateValue.newNull())
        );
    }
    const contractOp = cs.operation('storeMessage');
    let storeMessageOp: ledger.ContractOperation;
    if (contractOp) {
        try {
            storeMessageOp = ledger.ContractOperation.deserialize(contractOp.serialize());
        } catch {
            storeMessageOp = new ledger.ContractOperation();
        }
    } else {
        storeMessageOp = new ledger.ContractOperation();
    }
    storeMessageOp.verifierKey = verifierKeyBytes;
    ledgerState.setOperation('storeMessage', storeMessageOp);
    ledgerState.balance = new Map();
    const deploy = new ledger.ContractDeploy(ledgerState);
    const ttl = new Date(Date.now() + TTL_MS);
    const intent = ledger.Intent.new(ttl).addDeploy(deploy);
    const tx = ledger.Transaction.fromParts(NETWORK_ID, undefined, undefined, intent);

    console.log('Balancing and proving deploy transaction...');
    const recipe = await wallet.balanceTransaction(shieldedSecretKeys, dustSecretKey, tx, ttl);

    const unprovenTx =
        recipe.type === 'TransactionToProve'
            ? recipe.transaction
            : recipe.type === 'BalanceTransactionToProve'
              ? recipe.transactionToProve
              : recipe.transaction;

    const signSegment = (payload: Uint8Array): ledger.Signature => unshieldedKeystore.signData(payload);
    const signedTx = await wallet.signTransaction(unprovenTx, signSegment);

    const recipeToFinalize =
        recipe.type === 'TransactionToProve'
            ? { type: 'TransactionToProve' as const, transaction: signedTx }
            : recipe.type === 'BalanceTransactionToProve'
              ? { ...recipe, transactionToProve: signedTx }
              : { ...recipe, transaction: signedTx };

    const finalizedTx = await wallet.finalizeTransaction(recipeToFinalize);
    let txHash: string;
    try {
        txHash = await wallet.submitTransaction(finalizedTx);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Custom error: 110') || msg.includes('Invalid Transaction')) {
            console.error(
                'The node rejected the deploy transaction (runtime error 110).\n' +
                'This can mean invalid proof, initial state mismatch, or node/SDK version mismatch.\n' +
                'Check: node (compose) version vs ledger-v6/proof-server versions; node logs: docker compose logs node'
            );
        }
        throw err;
    }
    console.log('Deploy transaction submitted:', txHash);

    const contractAddress = deploy.address.toString();
    const deploymentJson = path.join(dappDir, 'deployment.json');
    fs.writeFileSync(
        deploymentJson,
        JSON.stringify({ contractAddress, deployedAt: new Date().toISOString(), txHash }, null, 2)
    );
    console.log('Contract address:', contractAddress);
    console.log('Saved to', deploymentJson);

    await wallet.stop();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
