import {SecureVault} from '@cosmew/security';

// Opt-in OS backend probe. Uses only a new Futryn-owned entry and always deletes it.
if (process.env.HANNES_VERIFY_KEYRING !== '1') {
  console.error('Set HANNES_VERIFY_KEYRING=1 to create/read/delete one disposable Futryn keyring entry.');
  process.exit(1);
}
const vault = new SecureVault();
const key = crypto.randomUUID();
const secret = crypto.randomUUID();
let created = false;
try {
  await vault.set(key, secret);
  created = true;
  const read = await vault.get({kind: 'keyring', key});
  if (read !== secret) throw new Error('Keyring roundtrip failed');
  await vault.delete({kind: 'keyring', key});
  created = false;
  const removed = await vault.get({kind: 'keyring', key});
  console.log(
    JSON.stringify({
      platform: process.platform,
      backend: 'OS keyring',
      roundtrip: true,
      deleted: removed === undefined,
    }),
  );
} finally {
  if (created) await vault.delete({kind: 'keyring', key});
}
