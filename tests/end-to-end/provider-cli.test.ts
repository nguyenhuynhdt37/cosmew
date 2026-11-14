import { afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureServer } from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
function context() {
  const server = fixtureServer(); const dir = mkdtempSync(join(tmpdir(), 'hannes-cli-'));
  cleanup.push(() => server.server.stop(true), () => rmSync(dir, { recursive: true, force: true }));
  async function cli(args: string[], input = '') {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
      env: { ...process.env, HANNES_HOME: dir, HANNES_TEST_KEY: 'fixture-e2e-sensitive-value', HANNES_WORK_KEY: 'fixture-e2e-work-value' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    child.stdin.write(input); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stdout + stderr).not.toContain('fixture-e2e-sensitive-value'); expect(stdout + stderr).not.toContain('RAW-SENSITIVE');
    return { stdout, stderr, code };
  }
  return { server, dir, cli };
}
async function configure(x: ReturnType<typeof context>, id = 'gateway', protocol = 'chat', alias = 'personal', env = 'HANNES_TEST_KEY') {
  expect((await x.cli(['providers', 'add', id, '--url', x.server.url + (protocol === 'gemini' ? '/gemini' : '/v1'), '--protocol', protocol, '--catalog', protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai'])).code).toBe(0);
  const login = await x.cli(['auth', 'login', '--provider', id, '--alias', alias, '--env', env, '--json']); expect(login.code).toBe(0); expect(login.stdout).toContain('validated');
  expect((await x.cli(['models', 'select', 'fixture-model', '--account', alias, '--json'])).code).toBe(0);
}
test('actual CLI: provider/account/auth/discovery/selection/streamed chat/doctor/logout lifecycle', async () => {
  const x = context(); await configure(x);
  expect((await x.cli(['providers', 'show', 'gateway'])).stdout).toContain(x.server.url);
  expect((await x.cli(['models', 'search', 'fixture', '--json'])).stdout).toContain('fixture-model');
  expect((await x.cli(['models', 'info', 'fixture-model', '--json'])).stdout).toContain('unknown');
  const run = await x.cli(['run', '--json'], 'Say hello'); expect(run.code).toBe(0); expect(JSON.parse(run.stdout).text).toBe('Hello fixture');
  const plain = await x.cli(['run'], 'Say hello'); expect(plain.stdout).toBe('Hello fixture\n'); expect(plain.code).toBe(0);
  expect((await x.cli(['model', 'doctor', '--generate', '--json'])).code).toBe(0);
  expect((await x.cli(['auth', 'status', '--json'])).stdout).toContain('"credentialAvailable":true');
  expect(readFileSync(join(x.dir, 'provider-auth.sqlite')).includes(Buffer.from('fixture-e2e-sensitive-value'))).toBe(false);
  expect((await x.cli(['auth', 'logout'])).code).toBe(0);
  const before = x.server.requests.length; expect((await x.cli(['run'], 'No request')).code).toBe(1); expect(x.server.requests.length).toBe(before);
  expect((await x.cli(['accounts', 'remove', 'personal'])).code).toBe(0); expect((await x.cli(['providers', 'remove', 'gateway'])).code).toBe(0);
});
test('actual CLI: two native protocols and account/provider switching never transfers old context', async () => {
  const x = context(); await configure(x, 'openai-custom', 'responses');
  await configure(x, 'anthropic-custom', 'anthropic', 'work', 'HANNES_WORK_KEY');
  const chat = await x.cli(['chat'], 'First work prompt\n/accounts personal\nSecond personal prompt\n/exit\n');
  expect(chat.code).toBe(0); expect(chat.stdout).toContain('Hello fixture');
  const posts = x.server.requests.filter(r => r.body);
  expect(JSON.stringify(posts.at(-1)?.body)).toContain('Second personal prompt');
  expect(JSON.stringify(posts.at(-1)?.body)).not.toContain('First work prompt');
  expect((await x.cli(['accounts', 'rename', 'work', '--alias', 'work-new'])).code).toBe(0);
  expect((await x.cli(['accounts', 'list'])).stdout).toContain('work-new');
});
test('actual CLI: multi-turn context reaches provider and failure returns safe nonzero diagnostics', async () => {
  const x = context(); await configure(x);
  const chat = await x.cli(['chat'], 'First turn\nSecond turn\n/exit\n'); expect(chat.code).toBe(0);
  const posts = x.server.requests.filter(r => r.body); expect(posts.at(-1)?.body.messages).toEqual([{ role: 'user', content: 'First turn' }, { role: 'assistant', content: 'Hello fixture' }, { role: 'user', content: 'Second turn' }]);
  x.server.set({ status: 401 }); const failed = await x.cli(['run'], 'fail'); expect(failed.code).toBe(1); expect(failed.stderr).toContain('AUTH');
  const unsupported = await x.cli(['auth', 'login', '--provider', 'gateway', '--alias', 'subscription', '--method', 'oauth']); expect(unsupported.code).toBe(1); expect(unsupported.stderr).toContain('UNSUPPORTED');
});
test('actual CLI: custom URL + manual model supports gateways with no model-list API', async () => {
  const x = context();
  expect((await x.cli(['providers', 'add', 'my-9router', '--url', x.server.url + '/v1', '--protocol', 'responses', '--catalog', 'manual'])).code).toBe(0);
  const login = await x.cli(['auth', 'login', '--provider', 'my-9router', '--alias', 'gateway-main', '--env', 'HANNES_TEST_KEY', '--model', 'fixture-model', '--json']);
  expect(login.code).toBe(0); expect(login.stdout).toContain('generation');
  expect((await x.cli(['run', '--json'], 'Gateway request')).code).toBe(0);
  expect(x.server.requests.every(r => r.path.endsWith('/responses'))).toBe(true);
});
test('actual CLI: Gemini and Ollama discovery use real respective HTTP routes', async () => {
  const x = context(); await configure(x, 'gemini-custom', 'gemini');
  expect((await x.cli(['run', '--json'], 'Gemini request')).code).toBe(0);
  expect((await x.cli(['providers', 'add', 'ollama-fixture', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'ollama', '--auth', 'none'])).code).toBe(0);
  expect((await x.cli(['auth', 'login', '--provider', 'ollama-fixture', '--alias', 'local', '--method', 'none'])).code).toBe(0);
  expect((await x.cli(['models', 'select', 'fixture-model', '--account', 'local'])).code).toBe(0);
  expect((await x.cli(['run'], 'Local request')).code).toBe(0);
  expect(x.server.requests.some(r => r.path === '/api/tags' && r.authorization === null)).toBe(true);
});
test('actual CLI: missing credentials cannot report login success; no secret argv flags accepted', async () => {
  const x = context();
  expect((await x.cli(['providers', 'add', 'gateway', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'openai'])).code).toBe(0);
  const missing = await x.cli(['auth', 'login', '--provider', 'gateway', '--alias', 'missing', '--env', 'HANNES_UNSET_FIXTURE']); expect(missing.code).toBe(1); expect(missing.stderr).toContain('AUTH');
  const argv = await x.cli(['auth', 'login', '--api-key', 'do-not-echo-argv']); expect(argv.code).toBe(1); expect(argv.stderr).not.toContain('do-not-echo-argv');
});
test('actual CLI estimated-cost guard refuses unpriced requests without sending prompts', async () => {
  const x = context(); await configure(x); const before = x.server.requests.length;
  const result = await x.cli(['run', '--max-estimated-cost-usd', '0.01'], 'Do not send without a price');
  expect(result.code).toBe(1); expect(result.stderr).toContain('BUDGET'); expect(x.server.requests.length).toBe(before);
});
test('actual CLI emits streaming text before completion and SIGINT cancels without retry', async () => {
  const x = context(); await configure(x); x.server.set({ streamDelay: 1000 });
  const before = x.server.requests.length;
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'run'], { env: { ...process.env, HANNES_HOME: x.dir, HANNES_TEST_KEY: 'fixture-e2e-sensitive-value' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write('stream now'); child.stdin.end();
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toBe('Hello ');
    child.kill('SIGINT'); const status = await child.exited; expect(status).toBe(130);
    expect(await new Response(child.stderr).text()).toContain('CANCELLED');
    expect(x.server.requests.length - before).toBe(1);
  } finally { child.kill(); await reader.cancel(); }
}, 7000);
test('actual CLI reauthenticates existing identity and can connect via interactive commands', async () => {
  const x = context(); await configure(x);
  const before = JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)[0].id;
  expect((await x.cli(['auth', 'logout'])).code).toBe(0);
  expect((await x.cli(['auth', 'login', '--account', 'personal', '--env', 'HANNES_TEST_KEY'])).code).toBe(0);
  const after = JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)[0].id; expect(after).toBe(before);
  expect((await x.cli(['models', 'select', 'fixture-model'])).code).toBe(0);
  const connected = await x.cli(['chat'], '/connect gateway backup HANNES_WORK_KEY\n/model fixture-model\nNew account prompt\n/exit\n');
  expect(connected.code).toBe(0); expect(connected.stdout).toContain('Account connected'); expect(connected.stdout).toContain('Hello fixture');
});
test.skipIf(process.env.HANNES_TEST_KEYRING !== '1')('actual CLI key-stdin uses native OS vault and deletes credentials on logout', async () => {
  const x = context();
  expect((await x.cli(['providers', 'add', 'gateway', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'openai'])).code).toBe(0);
  try {
    const login = await x.cli(['auth', 'login', '--provider', 'gateway', '--alias', 'native-keyring', '--key-stdin'], 'fixture-e2e-sensitive-value\n');
    expect(login.code).toBe(0); expect((await x.cli(['auth', 'status', '--account', 'native-keyring', '--json'])).stdout).toContain('"credentialAvailable":true');
    expect(readFileSync(join(x.dir, 'provider-auth.sqlite')).includes(Buffer.from('fixture-e2e-sensitive-value'))).toBe(false);
  } finally { expect((await x.cli(['accounts', 'remove', 'native-keyring'])).code).toBe(0); }
});
