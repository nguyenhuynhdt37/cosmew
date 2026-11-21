// Canonical opt-in: COSMEW_LIVE_PUBLIC=1.
import {scriptEnvironment} from './environment';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

if (scriptEnvironment('LIVE_PUBLIC') !== '1') {
  console.error('Set COSMEW_LIVE_PUBLIC=1 to contact public OpenRouter and Models.dev catalogs (no generation).');
  process.exit(1);
}
const root = mkdtempSync(join(tmpdir(), 'cosmew-public-smoke-'));
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
    env: {...process.env, COSMEW_HOME: root},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(error);
  return out;
}
try {
  await run(['providers', 'add', 'openrouter', '--auth', 'none']);
  await run(['auth', 'login', '--provider', 'openrouter', '--alias', 'public-catalog-only', '--method', 'none']);
  const catalog = JSON.parse(await run(['models', 'list', '--json']));
  await run(['models', 'sync-metadata']);
  const cached = JSON.parse(await run(['models', 'list', '--offline', '--json']));
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      openrouterPublicCatalog: catalog.models.length > 0,
      modelsDevMetadata: cached.models.some(
        (m: {metadataSource: string | null}) => m.metadataSource === 'https://models.dev/api.json',
      ),
      authenticatedGeneration: 'not-tested',
      note: 'Public catalog access does not establish generation entitlement.',
    }),
  );
} finally {
  rmSync(root, {recursive: true, force: true});
}
