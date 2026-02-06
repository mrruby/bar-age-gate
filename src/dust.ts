import * as bip39 from 'bip39';
import * as rx from 'rxjs';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { initWalletWithSeed } from './utils';

const WAIT_SYNC_MS = 90_000;
const WAIT_DUST_MS = 120_000;
const POLL_MS = 3_000;

const waitSynced = async (
  wallet: Awaited<ReturnType<typeof initWalletWithSeed>>['wallet']
) => {
  const end = Date.now() + WAIT_SYNC_MS;
  while (Date.now() < end) {
    const state = await rx.firstValueFrom(wallet.state());
    if (state.isSynced) return state;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error('Wallet sync timed out');
};

async function main(): Promise<void> {
  const mnemonic = process.argv.slice(2).join(' ').trim();
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Usage: yarn dust "<mnemonic>"');
  }

  const ctx = await initWalletWithSeed(bip39.mnemonicToSeedSync(mnemonic).subarray(0, 32));
  await ctx.wallet.start(ctx.shieldedSecretKeys, ctx.dustSecretKey);
  let state = await waitSynced(ctx.wallet);

  console.log(
    'Unshielded:',
    MidnightBech32m.encode('undeployed', state.unshielded.address).toString()
  );
  console.log('Dust:', state.dust.dustAddress);

  const utxos = state.unshielded.availableCoins;
  if (!utxos.length) throw new Error('No unshielded NIGHT UTXOs. Run yarn fund first.');

  const sign = (payload: Uint8Array) => ctx.unshieldedKeystore.signData(payload);
  let txHash = '';
  for (const utxo of [...utxos].sort((a, b) => Number(b.utxo.value - a.utxo.value))) {
    try {
      const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
        [utxo],
        ctx.unshieldedKeystore.getPublicKey(),
        sign
      );
      const finalized = await ctx.wallet.finalizeRecipe(recipe);
      txHash = await ctx.wallet.submitTransaction(finalized);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Custom error: 139')) throw err;
    }
  }
  if (!txHash) throw new Error('No UTXO accepted for dust registration.');
  console.log('Registered:', txHash);

  const end = Date.now() + WAIT_DUST_MS;
  let dust = state.dust.walletBalance(new Date());
  while (dust === 0n && Date.now() < end) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    state = await rx.firstValueFrom(ctx.wallet.state());
    dust = state.dust.walletBalance(new Date());
  }
  console.log('Dust balance:', dust.toString());

  await ctx.wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
