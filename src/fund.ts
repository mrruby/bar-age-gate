import * as bip39 from 'bip39';
import * as rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { MidnightBech32m } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CombinedTokenTransfer } from '@midnight-ntwrk/wallet-sdk-facade';
import { initWalletWithSeed } from './utils';

const AMOUNT = 31_337_000_000n;
const TTL_MS = 30 * 60 * 1000;

type Receiver = { shielded?: string; unshielded?: string };

const parseReceiver = (arg: string): Receiver => {
  if (bip39.validateMnemonic(arg)) {
    return { shielded: '', unshielded: '' };
  }
  if (arg.startsWith('mn_shield-addr_undeployed')) {
    return { shielded: arg };
  }
  if (arg.startsWith('mn_addr_undeployed')) {
    return { unshielded: arg };
  }
  throw new Error(
    'Usage: yarn fund "<mnemonic>" | yarn fund mn_shield-addr_undeployed... | yarn fund mn_addr_undeployed...'
  );
};

const waitSynced = async (
  obs: ReturnType<Awaited<ReturnType<typeof initWalletWithSeed>>['wallet']['state']>
)=> rx.firstValueFrom(obs.pipe(rx.filter((s) => s.isSynced)));

async function main(): Promise<void> {
  const arg = process.argv.slice(2).join(' ').trim();
  if (!arg) {
    throw new Error(
      'Missing receiver argument.\n' +
      'Generate mnemonic: yarn mnemonic\n' +
      'Usage: yarn fund "<mnemonic>" | yarn fund mn_shield-addr_undeployed... | yarn fund mn_addr_undeployed...'
    );
  }

  const parsed = parseReceiver(arg);
  const receiver: Receiver = { ...parsed };

  let receiverWallet:
    | Awaited<ReturnType<typeof initWalletWithSeed>>
    | undefined;

  if (bip39.validateMnemonic(arg)) {
    receiverWallet = await initWalletWithSeed(
      bip39.mnemonicToSeedSync(arg).subarray(0, 32)
    );
    await receiverWallet.wallet.start(
      receiverWallet.shieldedSecretKeys,
      receiverWallet.dustSecretKey
    );
    const receiverState = await waitSynced(receiverWallet.wallet.state());
    receiver.shielded = MidnightBech32m.encode(
      'undeployed',
      receiverState.shielded.address
    ).toString();
    receiver.unshielded = receiverWallet.unshieldedKeystore
      .getBech32Address()
      .toString();
  }

  const sender = await initWalletWithSeed(
    Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000001',
      'hex'
    )
  );
  await sender.wallet.start(sender.shieldedSecretKeys, sender.dustSecretKey);
  await waitSynced(sender.wallet.state());

  const outputs: CombinedTokenTransfer[] = [];
  if (receiver.unshielded) {
    outputs.push({
      type: 'unshielded',
      outputs: [
        {
          amount: AMOUNT,
          receiverAddress: receiver.unshielded,
          type: ledger.unshieldedToken().raw,
        },
      ],
    });
  }
  if (receiver.shielded) {
    outputs.push({
      type: 'shielded',
      outputs: [
        {
          amount: AMOUNT,
          receiverAddress: receiver.shielded,
          type: ledger.shieldedToken().raw,
        },
      ],
    });
  }
  if (!outputs.length) throw new Error('No receiver resolved.');

  const recipe = await sender.wallet.transferTransaction(
    outputs,
    {
      shieldedSecretKeys: sender.shieldedSecretKeys,
      dustSecretKey: sender.dustSecretKey,
    },
    { ttl: new Date(Date.now() + TTL_MS), payFees: true }
  );
  const signed = await sender.wallet.signUnprovenTransaction(
    recipe.transaction,
    (payload) => sender.unshieldedKeystore.signData(payload)
  );
  const finalized = await sender.wallet.finalizeTransaction(signed);
  const txHash = await sender.wallet.submitTransaction(finalized);

  console.log('Submitted:', txHash);
  if (receiver.unshielded) console.log('Unshielded:', receiver.unshielded);
  if (receiver.shielded) console.log('Shielded:', receiver.shielded);

  await sender.wallet.stop();
  if (receiverWallet) await receiverWallet.wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
