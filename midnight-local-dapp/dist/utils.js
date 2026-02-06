// Copyright 2025 Shagun Prasad
// SPDX-License-Identifier: Apache-2.0
import * as ledger from '@midnight-ntwrk/ledger-v6';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey as UnshieldedPublicKey, UnshieldedWallet, } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
const INDEXER_PORT = Number.parseInt(process.env['INDEXER_PORT'] ?? '8088', 10);
const NODE_PORT = Number.parseInt(process.env['NODE_PORT'] ?? '9944', 10);
const PROOF_SERVER_PORT = Number.parseInt(process.env['PROOF_SERVER_PORT'] ?? '6300', 10);
const INDEXER_HTTP_URL = `http://localhost:${INDEXER_PORT}/api/v3/graphql`;
const INDEXER_WS_URL = `ws://localhost:${INDEXER_PORT}/api/v3/graphql/ws`;
const configuration = {
    networkId: 'undeployed',
    costParameters: {
        additionalFeeOverhead: 300000000000000000n,
        feeBlocksMargin: 5,
    },
    relayURL: new URL(`ws://localhost:${NODE_PORT}`),
    provingServerUrl: new URL(`http://localhost:${PROOF_SERVER_PORT}`),
    indexerClientConnection: {
        indexerHttpUrl: INDEXER_HTTP_URL,
        indexerWsUrl: INDEXER_WS_URL,
    },
    indexerUrl: INDEXER_WS_URL,
};
export const initWalletWithSeed = async (seed) => {
    const hdWallet = HDWallet.fromSeed(Uint8Array.from(seed));
    if (hdWallet.type !== 'seedOk') {
        throw new Error('Failed to initialize HDWallet');
    }
    const derivationResult = hdWallet.hdWallet
        .selectAccount(0)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
        .deriveKeysAt(0);
    if (derivationResult.type !== 'keysDerived') {
        throw new Error('Failed to derive keys');
    }
    hdWallet.hdWallet.clear();
    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
    const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
    const unshieldedKeystore = createKeystore(derivationResult.keys[Roles.NightExternal], configuration.networkId);
    const shieldedWallet = ShieldedWallet(configuration).startWithSecretKeys(shieldedSecretKeys);
    const dustWallet = DustWallet(configuration).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    const unshieldedWallet = UnshieldedWallet({
        ...configuration,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    }).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore));
    const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
    await facade.start(shieldedSecretKeys, dustSecretKey);
    return { wallet: facade, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};
