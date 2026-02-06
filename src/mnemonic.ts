import * as bip39 from 'bip39';

const DEFAULT_HOST = process.env['MIDNIGHT_HOST'] ?? '127.0.0.1';

async function main(): Promise<void> {
  const mnemonic = bip39.generateMnemonic(256);

  console.log('Generated mnemonic (save it securely):');
  console.log(mnemonic);
  console.log('');
  console.log('Next commands:');
  console.log(`MIDNIGHT_HOST=${DEFAULT_HOST} yarn fund "${mnemonic}"`);
  console.log(`MIDNIGHT_HOST=${DEFAULT_HOST} yarn dust "${mnemonic}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
