import * as bip39 from 'bip39';
import * as rx from 'rxjs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import * as fs from 'fs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { initWalletWithSeed } from './utils';

const HOST = process.env['MIDNIGHT_HOST'] ?? '127.0.0.1';
const INDEXER_PORT = Number.parseInt(process.env['INDEXER_PORT'] ?? '8088', 10);
const INDEXER_HTTP_URL = `http://${HOST}:${INDEXER_PORT}/api/v3/graphql`;
const WAIT_FUNDS_MS = 90_000;
const WAIT_DUST_MS = 10 * 60_000;
const POLL_MS = 3_000;
const TTL_MS = 30 * 60 * 1000;
const CHAIN_SAFETY_MS = Number.parseInt(process.env['CHAIN_TIME_SAFETY_MS'] ?? '30000', 10);
const MANAGED_CONTRACT_DIR = path.join(
  process.cwd(),
  'contracts',
  'managed',
  'bar-age-gate'
);

const BLOCK_TIME_QUERY = `query BlockTime { block { timestamp } }`;

type ContractModule = {
  Contract: new (...args: unknown[]) => {
    initialState: (context: unknown) => {
      currentContractState: {
        data: { state: { encode: () => ledger.EncodedStateValue } };
        operation: (name: string) => { serialize: () => Uint8Array } | undefined;
      };
    };
  };
};

const fetchChainTime = async (): Promise<Date> => {
  const res = await fetch(INDEXER_HTTP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: BLOCK_TIME_QUERY }),
  });
  if (!res.ok) throw new Error(`Indexer request failed (${res.status})`);
  const json = (await res.json()) as {
    data?: { block?: { timestamp?: number } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  const ts = json.data?.block?.timestamp;
  if (!ts) throw new Error('Missing block timestamp');
  return new Date(Math.max(0, ts - CHAIN_SAFETY_MS));
};

const getTtl = async (): Promise<Date> => {
  try {
    const chainNow = await fetchChainTime();
    return new Date(chainNow.getTime() + TTL_MS);
  } catch {
    return new Date(Date.now() + TTL_MS);
  }
};

const deployWitnesses = {
  storeAge: (context: { privateState?: { agesByClientId?: Record<string, unknown> } }) => [
    context.privateState ?? { agesByClientId: {} },
    [],
  ],
  loadAge: () => {
    throw new Error('loadAge witness is not available during deployment');
  },
};

const waitSynced = async (
  wallet: Awaited<ReturnType<typeof initWalletWithSeed>>['wallet']
) => rx.firstValueFrom(wallet.state().pipe(rx.filter((s) => s.isSynced)));

const loadVerifierEntries = (): Array<{ circuitName: string; verifierKey: Uint8Array }> => {
  const keysDir = path.join(MANAGED_CONTRACT_DIR, 'keys');
  if (!fs.existsSync(keysDir)) {
    throw new Error('Missing contract keys directory. Run yarn compile.');
  }

  const verifierFiles = fs
    .readdirSync(keysDir)
    .filter((file) => file.endsWith('.verifier'))
    .sort();

  if (verifierFiles.length === 0) {
    throw new Error('No verifier keys found. Run yarn compile.');
  }

  return verifierFiles.map((file) => ({
    circuitName: file.replace(/\.verifier$/, ''),
    verifierKey: new Uint8Array(fs.readFileSync(path.join(keysDir, file))),
  }));
};

async function main(): Promise<void> {
  const mnemonic = process.argv.slice(2).join(' ').trim();
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Usage: yarn deploy "<mnemonic>"');
  }

  const ctx = await initWalletWithSeed(bip39.mnemonicToSeedSync(mnemonic).subarray(0, 32));
  await ctx.wallet.start(ctx.shieldedSecretKeys, ctx.dustSecretKey);
  let state = await waitSynced(ctx.wallet);

  const address = MidnightBech32m.encode('undeployed', state.shielded.address).toString();
  console.log('Wallet:', address);

  let balance = state.shielded.balances[ledger.shieldedToken().raw] ?? 0n;
  if (balance === 0n) {
    const end = Date.now() + WAIT_FUNDS_MS;
    while (balance === 0n && Date.now() < end) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      state = await rx.firstValueFrom(ctx.wallet.state());
      balance = state.shielded.balances[ledger.shieldedToken().raw] ?? 0n;
    }
  }
  if (balance === 0n) throw new Error('Balance is 0. Run yarn fund first.');
  console.log('Balance:', balance.toString());

  const contractModulePath = path.join(MANAGED_CONTRACT_DIR, 'contract', 'index.js');
  if (!fs.existsSync(contractModulePath)) {
    throw new Error('Missing contract bindings. Run yarn compile.');
  }

  const mod = (await import(pathToFileURL(contractModulePath).href)) as ContractModule;
  const contract = new mod.Contract(deployWitnesses);
  const ctor = contract.initialState(
    createConstructorContext(
      { agesByClientId: {} },
      state.shielded.coinPublicKey.toHexString()
    )
  );
  const currentState = ctor.currentContractState;

  const ledgerState = new ledger.ContractState();
  ledgerState.data = new ledger.ChargedState(
    ledger.StateValue.decode(currentState.data.state.encode())
  );
  ledgerState.balance = new Map();

  for (const { circuitName, verifierKey } of loadVerifierEntries()) {
    const existingOperation = currentState.operation(circuitName);
    const operation = existingOperation
      ? ledger.ContractOperation.deserialize(existingOperation.serialize())
      : new ledger.ContractOperation();
    operation.verifierKey = verifierKey;
    ledgerState.setOperation(circuitName, operation);
  }

  const deploy = new ledger.ContractDeploy(ledgerState);
  const tx = ledger.Transaction.fromParts(
    'undeployed',
    undefined,
    undefined,
    ledger.Intent.new(await getTtl()).addDeploy(deploy)
  );

  const endDust = Date.now() + WAIT_DUST_MS;
  let recipe: { type: 'UNPROVEN_TRANSACTION'; transaction: ledger.UnprovenTransaction };
  while (true) {
    try {
      recipe = await ctx.wallet.balanceUnprovenTransaction(
        tx,
        {
          shieldedSecretKeys: ctx.shieldedSecretKeys,
          dustSecretKey: ctx.dustSecretKey,
        },
        { ttl: await getTtl() }
      );
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Not enough Dust generated to pay the fee')) throw err;
      if (Date.now() > endDust) throw new Error('Timed out waiting for dust.');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  const signed = await ctx.wallet.signUnprovenTransaction(
    recipe.transaction,
    (payload) => ctx.unshieldedKeystore.signData(payload)
  );
  const finalized = await ctx.wallet.finalizeTransaction(signed);
  const txHash = await ctx.wallet.submitTransaction(finalized);

  fs.writeFileSync(
    path.join(process.cwd(), 'deployment.json'),
    JSON.stringify(
      {
        contractAddress: deploy.address.toString(),
        deployedAt: new Date().toISOString(),
        txHash,
      },
      null,
      2
    )
  );

  console.log('Contract:', deploy.address.toString());
  console.log('Tx:', txHash);

  await ctx.wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
