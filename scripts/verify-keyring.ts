// Canonical opt-in: COSMEW_VERIFY_KEYRING=1.
import {scriptEnvironment} from './environment';
import {SecureVault} from '@cosmew/security';

// Opt-in OS backend probe. Uses only a new Cosmew-owned entry and always deletes it.
if (scriptEnvironment('VERIFY_KEYRING') !== '1') {
  console.error('Set COSMEW_VERIFY_KEYRING=1 to create/read/delete one disposable Cosmew keyring entry.');
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
