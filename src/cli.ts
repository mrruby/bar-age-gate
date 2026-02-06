import * as readline from 'readline/promises';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import * as fs from 'fs';
import * as rx from 'rxjs';
import * as bip39 from 'bip39';
import { createHash, randomBytes } from 'node:crypto';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { Buffer } from 'buffer';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { ContractState as RuntimeContractState, type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { initWalletWithSeed } from './utils';

const INDEXER_PORT = Number.parseInt(process.env['INDEXER_PORT'] ?? '8088', 10);
const PROOF_SERVER_PORT = Number.parseInt(process.env['PROOF_SERVER_PORT'] ?? '6300', 10);
const MIDNIGHT_HOST = process.env['MIDNIGHT_HOST'] ?? '127.0.0.1';

const INDEXER_HTTP_URL = `http://${MIDNIGHT_HOST}:${INDEXER_PORT}/api/v3/graphql`;
const INDEXER_WS_URL = `ws://${MIDNIGHT_HOST}:${INDEXER_PORT}/api/v3/graphql/ws`;
const PROOF_SERVER_HTTP_URL = `http://${MIDNIGHT_HOST}:${PROOF_SERVER_PORT}`;
const CLIENT_PRIVATE_STATE_ID = 'barPrivateStateClient';
const BARTENDER_PRIVATE_STATE_ID = 'barPrivateStateBartender';
const PRIVATE_STATE_STORE_PREFIX = 'bar-private';
const SIGNING_KEY_STORE_PREFIX = 'bar-signing-keys';
const WAIT_POLL_MS = 2_000;
const WAIT_FOR_SYNC_MS = 90_000;
const WAIT_FOR_STATE_UPDATE_MS = 60_000;
const TTL_MS = 30 * 60 * 1000;

type WalletContext = Awaited<ReturnType<typeof initWalletWithSeed>>;

type AgeRecord = {
  age: number;
  saltHex: string;
};

type BarPrivateState = {
  agesByClientId: Record<string, AgeRecord>;
};

type BarWitnesses = {
  storeAge: (
    context: WitnessContext<unknown, BarPrivateState>,
    clientKey: Uint8Array,
    age: bigint,
    salt: Uint8Array
  ) => [BarPrivateState, []];
  loadAge: (
    context: WitnessContext<unknown, BarPrivateState>,
    clientKey: Uint8Array
  ) => [BarPrivateState, [bigint, Uint8Array]];
};

type BarContractModule = {
  Contract: new (...args: unknown[]) => unknown;
  ledger: (stateOrChargedState: unknown) => {
    ageCommitment: {
      member: (key: Uint8Array) => boolean;
      lookup: (key: Uint8Array) => Uint8Array;
    };
    adultPermit: {
      member: (key: Uint8Array) => boolean;
      lookup: (key: Uint8Array) => boolean;
    };
    drinksSold: {
      member: (key: Uint8Array) => boolean;
      lookup: (key: Uint8Array) => bigint;
    };
  };
};

type Providers = {
  privateStateProvider: ReturnType<typeof levelPrivateStateProvider>;
  publicDataProvider: ReturnType<typeof indexerPublicDataProvider>;
  zkConfigProvider: NodeZkConfigProvider<any>;
  proofProvider: ReturnType<typeof httpClientProofProvider>;
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
};

type ClientStatus = {
  registered: boolean;
  adultVerified: boolean;
  drinksSold: bigint;
};

type RoleInput = {
  seedHex: string;
  generatedMnemonic?: string;
};

const emptyPrivateState = (): BarPrivateState => ({ agesByClientId: {} });

const keyHex = (key: Uint8Array): string => Buffer.from(key).toString('hex');

const privateStateStoreName = (
  role: 'client' | 'bartender',
  sessionId: string
): string => `${PRIVATE_STATE_STORE_PREFIX}-${role}-${sessionId}`;

const signingKeyStoreName = (
  role: 'client' | 'bartender',
  sessionId: string
): string => `${SIGNING_KEY_STORE_PREFIX}-${role}-${sessionId}`;

const parseSeedInput = (input: string): string => {
  if (bip39.validateMnemonic(input)) {
    const seed32 = bip39.mnemonicToSeedSync(input).subarray(0, 32);
    return Buffer.from(seed32).toString('hex');
  }
  if (input.length === 64 && /^[0-9a-fA-F]+$/.test(input)) {
    return input.toLowerCase();
  }
  throw new Error('Enter a valid BIP-39 mnemonic (12/24 words), 64-char hex seed, or leave blank to generate.');
};

const promptRoleInput = async (
  rl: readline.Interface,
  roleLabel: string
): Promise<RoleInput> => {
  const input = (
    await rl.question(`Enter ${roleLabel} mnemonic (or 64-char hex seed, leave empty to generate): `)
  ).trim();

  if (input.length > 0) {
    return { seedHex: parseSeedInput(input) };
  }

  const mnemonic = bip39.generateMnemonic(256);
  const seedHex = parseSeedInput(mnemonic);
  console.log(`\nGenerated ${roleLabel} mnemonic (save it now, it will not be stored):`);
  console.log(mnemonic);
  console.log('');
  return { seedHex, generatedMnemonic: mnemonic };
};

const clientKeyFromNickname = (nickname: string): Uint8Array =>
  createHash('sha256').update('bar:client:v1').update(nickname, 'utf8').digest();

const normalizePrivateState = (state: unknown): BarPrivateState => {
  if (!state || typeof state !== 'object') {
    return emptyPrivateState();
  }
  const entries = (state as { agesByClientId?: Record<string, AgeRecord> }).agesByClientId;
  return { agesByClientId: entries && typeof entries === 'object' ? entries : {} };
};

const createClientWitnesses = (): BarWitnesses => ({
  storeAge: (context, clientKey, age, salt) => {
    const privateState = normalizePrivateState(context.privateState);
    const next: BarPrivateState = {
      agesByClientId: {
        ...privateState.agesByClientId,
        [keyHex(clientKey)]: {
          age: Number(age),
          saltHex: keyHex(salt),
        },
      },
    };
    return [next, []];
  },
  loadAge: (context, clientKey) => {
    const privateState = normalizePrivateState(context.privateState);
    const record = privateState.agesByClientId[keyHex(clientKey)];
    if (!record) {
      throw new Error('Missing private age record. Register client first with this wallet.');
    }
    return [
      privateState,
      [BigInt(record.age), Uint8Array.from(Buffer.from(record.saltHex, 'hex'))],
    ];
  },
});

const createBartenderWitnesses = (): BarWitnesses => ({
  storeAge: (_context, _clientKey, _age, _salt) => {
    throw new Error('storeAge witness is client-only');
  },
  loadAge: (_context, _clientKey) => {
    throw new Error('loadAge witness is client-only');
  },
});

const waitUntilSynced = async (wallet: WalletContext['wallet']) => {
  const deadline = Date.now() + WAIT_FOR_SYNC_MS;
  while (Date.now() < deadline) {
    const state = await rx.firstValueFrom(wallet.state());
    if (state.isSynced) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(
    `Wallet did not sync within ${Math.floor(
      WAIT_FOR_SYNC_MS / 1000
    )}s. Check docker services and MIDNIGHT_HOST (current: ${MIDNIGHT_HOST}).`
  );
};

const signTransactionIntents = (
  tx: { intents?: Map<number, unknown> },
  signFn: (payload: Uint8Array) => ledger.Signature,
  proofMarker: 'proof' | 'pre-proof'
): void => {
  if (!tx.intents || tx.intents.size === 0) {
    return;
  }

  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent || typeof intent !== 'object') {
      continue;
    }
    const serialized = (intent as { serialize: () => Uint8Array }).serialize();
    const cloned = ledger.Intent.deserialize<
      ledger.SignatureEnabled,
      ledger.Proofish,
      ledger.PreBinding
    >('signature', proofMarker, 'pre-binding', serialized);

    const signature = signFn(cloned.signatureData(segment));

    if (cloned.fallibleUnshieldedOffer) {
      const signatures = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) =>
          cloned.fallibleUnshieldedOffer?.signatures.at(i) ?? signature
      );
      cloned.fallibleUnshieldedOffer =
        cloned.fallibleUnshieldedOffer.addSignatures(signatures);
    }

    if (cloned.guaranteedUnshieldedOffer) {
      const signatures = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: ledger.UtxoSpend, i: number) =>
          cloned.guaranteedUnshieldedOffer?.signatures.at(i) ?? signature
      );
      cloned.guaranteedUnshieldedOffer =
        cloned.guaranteedUnshieldedOffer.addSignatures(signatures);
    }

    tx.intents.set(segment, cloned);
  }
};

const createWalletAndMidnightProvider = async (
  ctx: WalletContext
): Promise<WalletProvider & MidnightProvider> => {
  const state = await rx.firstValueFrom(
    ctx.wallet.state().pipe(rx.filter((s) => s.isSynced))
  );
  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx, ttl) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: ctx.shieldedSecretKeys,
          dustSecretKey: ctx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + TTL_MS) }
      );

      const signFn = (payload: Uint8Array) =>
        ctx.unshieldedKeystore.signData(payload);
      signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
      if (recipe.balancingTransaction) {
        signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
      }

      return ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx(tx) {
      return ctx.wallet.submitTransaction(tx) as unknown as Promise<string>;
    },
  };
};

const loadDeploymentAddress = (): string => {
  const deploymentPath = path.join(process.cwd(), 'deployment.json');
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      'No deployment.json found. Run deploy from repo root: yarn deploy "<mnemonic>"'
    );
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8')) as {
    contractAddress?: string;
  };
  if (!deployment.contractAddress) {
    throw new Error('deployment.json does not contain contractAddress');
  }
  return deployment.contractAddress;
};

const loadContractModule = async (): Promise<{
  contractModule: BarContractModule;
  zkConfigPath: string;
}> => {
  const zkConfigPath = path.join(
    process.cwd(),
    'contracts',
    'managed',
    'bar-age-gate'
  );
  const contractModulePath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractModulePath)) {
    throw new Error('Contract bindings not found. Run: yarn compile');
  }

  const contractModule = (await import(
    pathToFileURL(contractModulePath).href
  )) as BarContractModule;

  return { contractModule, zkConfigPath };
};

const createProviders = async (
  walletContext: WalletContext,
  zkConfigPath: string,
  privateStateStoreName: string,
  signingKeyStoreNameValue: string
): Promise<Providers> => {
  const walletAndMidnightProvider = await createWalletAndMidnightProvider(
    walletContext
  );
  const zkConfigProvider = new NodeZkConfigProvider<any>(zkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName,
      signingKeyStoreName: signingKeyStoreNameValue,
      walletProvider: walletAndMidnightProvider,
    }),
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(
      PROOF_SERVER_HTTP_URL,
      zkConfigProvider
    ),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

const withWitnessesUnsafe = <TContract>(
  contract: TContract,
  witnesses: unknown
): TContract =>
  (CompiledContract.withWitnesses as unknown as (self: TContract, w: unknown) => TContract)(
    contract,
    witnesses
  );

const readClientStatus = async (
  providers: Providers,
  contractModule: BarContractModule,
  contractAddress: string,
  clientKey: Uint8Array
): Promise<ClientStatus> => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) {
    return { registered: false, adultVerified: false, drinksSold: 0n };
  }
  const runtimeContractState = RuntimeContractState.deserialize(state.serialize());
  const ledgerView = contractModule.ledger(runtimeContractState.data);

  if (!ledgerView.ageCommitment.member(clientKey)) {
    return { registered: false, adultVerified: false, drinksSold: 0n };
  }

  const adultVerified =
    ledgerView.adultPermit.member(clientKey) && ledgerView.adultPermit.lookup(clientKey);
  const drinksSold = ledgerView.drinksSold.member(clientKey)
    ? ledgerView.drinksSold.lookup(clientKey)
    : 0n;

  return {
    registered: true,
    adultVerified,
    drinksSold,
  };
};

const waitForStatus = async (
  providers: Providers,
  contractModule: BarContractModule,
  contractAddress: string,
  clientKey: Uint8Array,
  predicate: (status: ClientStatus) => boolean
): Promise<ClientStatus | null> => {
  const deadline = Date.now() + WAIT_FOR_STATE_UPDATE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    const status = await readClientStatus(
      providers,
      contractModule,
      contractAddress,
      clientKey
    );
    if (predicate(status)) {
      return status;
    }
  }
  return null;
};

const printWalletSummary = async (
  label: string,
  walletContext: WalletContext
): Promise<string> => {
  const state = await rx.firstValueFrom(walletContext.wallet.state());
  const address = MidnightBech32m.encode('undeployed', state.shielded.address).toString();
  const balance = state.shielded.balances[ledger.shieldedToken().raw] ?? 0n;
  const dustBalance = state.dust.walletBalance(new Date());

  console.log(`${label} address: ${address}`);
  console.log(`${label} balance: ${balance}`);
  console.log(`${label} dust: ${dustBalance}`);
  return address;
};

async function main() {
  setNetworkId('undeployed');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('Bar Age Gate CLI\n');

  let clientWalletContext: WalletContext | null = null;
  let bartenderWalletContext: WalletContext | null = null;

  try {
    const contractAddress = loadDeploymentAddress();
    console.log(`Contract: ${contractAddress}\n`);

    const clientInput = await promptRoleInput(rl, 'client');
    const bartenderInput = await promptRoleInput(rl, 'bartender');

    if (clientInput.generatedMnemonic || bartenderInput.generatedMnemonic) {
      console.log('Next commands to fund and generate dust:\n');
      if (clientInput.generatedMnemonic) {
        console.log(`MIDNIGHT_HOST=127.0.0.1 yarn fund "${clientInput.generatedMnemonic}"`);
        console.log(`MIDNIGHT_HOST=127.0.0.1 yarn dust "${clientInput.generatedMnemonic}"`);
      }
      if (bartenderInput.generatedMnemonic) {
        console.log(`MIDNIGHT_HOST=127.0.0.1 yarn fund "${bartenderInput.generatedMnemonic}"`);
        console.log(`MIDNIGHT_HOST=127.0.0.1 yarn dust "${bartenderInput.generatedMnemonic}"`);
      }
      console.log('');
    }

    console.log('Connecting wallets...');
    clientWalletContext = await initWalletWithSeed(
      Buffer.from(clientInput.seedHex, 'hex')
    );
    bartenderWalletContext = await initWalletWithSeed(
      Buffer.from(bartenderInput.seedHex, 'hex')
    );

    await waitUntilSynced(clientWalletContext.wallet);
    await waitUntilSynced(bartenderWalletContext.wallet);

    await printWalletSummary('Client', clientWalletContext);
    await printWalletSummary('Bartender', bartenderWalletContext);
    console.log('');

    const { contractModule, zkConfigPath } = await loadContractModule();
    const privateStateSessionId = randomBytes(6).toString('hex');

    const clientProviders = await createProviders(
      clientWalletContext,
      zkConfigPath,
      privateStateStoreName('client', privateStateSessionId),
      signingKeyStoreName('client', privateStateSessionId)
    );
    const bartenderProviders = await createProviders(
      bartenderWalletContext,
      zkConfigPath,
      privateStateStoreName('bartender', privateStateSessionId),
      signingKeyStoreName('bartender', privateStateSessionId)
    );

    const clientCompiledContract = CompiledContract.withCompiledFileAssets(
      withWitnessesUnsafe(
        CompiledContract.make('bar-age-gate-client', contractModule.Contract as any),
        createClientWitnesses()
      ),
      zkConfigPath as never
    );

    const bartenderCompiledContract = CompiledContract.withCompiledFileAssets(
      withWitnessesUnsafe(
        CompiledContract.make('bar-age-gate-bartender', contractModule.Contract as any),
        createBartenderWitnesses()
      ),
      zkConfigPath as never
    );

    const clientContract = await findDeployedContract(clientProviders as any, {
      contractAddress,
      compiledContract: clientCompiledContract as any,
      privateStateId: CLIENT_PRIVATE_STATE_ID,
      initialPrivateState: emptyPrivateState(),
    });

    const bartenderContract = await findDeployedContract(
      bartenderProviders as any,
      {
        contractAddress,
        compiledContract: bartenderCompiledContract as any,
        privateStateId: BARTENDER_PRIVATE_STATE_ID,
        initialPrivateState: emptyPrivateState(),
      }
    );

    let running = true;
    while (running) {
      console.log('--- Menu ---');
      console.log('1. Register client (client wallet)');
      console.log('2. Prove adult (client wallet)');
      console.log('3. Sell drink (bartender wallet)');
      console.log('4. Exit');

      const choice = (await rl.question('\nYour choice: ')).trim();
      switch (choice) {
        case '1': {
          const nickname = (await rl.question('Client nickname: ')).trim();
          if (nickname.length === 0) {
            console.log('Nickname cannot be empty.\n');
            break;
          }

          const ageInput = (await rl.question('Client age: ')).trim();
          const ageNumber = Number.parseInt(ageInput, 10);
          if (!Number.isFinite(ageNumber) || ageNumber < 0 || ageNumber > 255) {
            console.log('Age must be an integer in range 0..255.\n');
            break;
          }

          const clientKey = clientKeyFromNickname(nickname);
          const salt = randomBytes(32);

          try {
            const txData = await (clientContract as any).callTx.registerClient(
              clientKey,
              BigInt(ageNumber),
              salt
            );
            console.log(`Submitted transaction: ${txData.public.txId}`);

            const status = await waitForStatus(
              clientProviders,
              contractModule,
              contractAddress,
              clientKey,
              (s) => s.registered
            );
            if (status) {
              console.log(`Registered: ${nickname}`);
              console.log(
                `Adult permit: ${status.adultVerified ? 'VERIFIED' : 'NOT_VERIFIED'}`
              );
              console.log(`Drinks sold: ${status.drinksSold}\n`);
            } else {
              console.log('Timed out waiting for state update.\n');
            }
          } catch (error) {
            console.error('Failed to register client:', error);
          }
          break;
        }
        case '2': {
          const nickname = (await rl.question('Client nickname: ')).trim();
          if (nickname.length === 0) {
            console.log('Nickname cannot be empty.\n');
            break;
          }

          const clientKey = clientKeyFromNickname(nickname);
          try {
            const txData = await (clientContract as any).callTx.proveAdult(clientKey);
            console.log(`Submitted transaction: ${txData.public.txId}`);

            const status = await waitForStatus(
              clientProviders,
              contractModule,
              contractAddress,
              clientKey,
              (s) => s.adultVerified
            );
            if (status) {
              console.log('Adult proof accepted.\n');
            } else {
              console.log('Timed out waiting for permit update.\n');
            }
          } catch (error) {
            console.error('Failed to prove adult:', error);
          }
          break;
        }
        case '3': {
          const nickname = (await rl.question('Client nickname: ')).trim();
          if (nickname.length === 0) {
            console.log('Nickname cannot be empty.\n');
            break;
          }

          const clientKey = clientKeyFromNickname(nickname);
          const before = await readClientStatus(
            bartenderProviders,
            contractModule,
            contractAddress,
            clientKey
          );
          try {
            const txData = await (bartenderContract as any).callTx.sellDrink(clientKey);
            console.log(`Submitted transaction: ${txData.public.txId}`);

            const after = await waitForStatus(
              bartenderProviders,
              contractModule,
              contractAddress,
              clientKey,
              (status) => status.drinksSold > before.drinksSold
            );

            if (after) {
              console.log('SALE_APPROVED');
              console.log(`Drinks sold: ${after.drinksSold}\n`);
            } else {
              console.log('Sale submitted but no updated state was observed in time.\n');
            }
          } catch (error) {
            console.log('SALE_REJECTED');
            console.error(error);
          }
          break;
        }
        case '4':
          running = false;
          console.log('\nGoodbye!');
          break;
        default:
          console.log('Invalid choice. Please enter 1, 2, 3, or 4.\n');
      }
    }
  } catch (error) {
    console.error('\nError:', error);
  } finally {
    if (clientWalletContext) {
      await clientWalletContext.wallet.stop();
    }
    if (bartenderWalletContext) {
      await bartenderWalletContext.wallet.stop();
    }
    rl.close();
  }
}

main().catch(console.error);
