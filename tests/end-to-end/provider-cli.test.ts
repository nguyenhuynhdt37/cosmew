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
  expect(JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)).toEqual([]); expect((await x.cli(['providers', 'remove', 'gateway'])).code).toBe(0);
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
  expect((await x.cli(['auth', 'login', '--account', 'personal', '--env', 'HANNES_TEST_KEY'])).code).toBe(0);
  const after = JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)[0].id; expect(after).toBe(before);
  expect((await x.cli(['models', 'select', 'fixture-model'])).code).toBe(0);
  const connected = await x.cli(['chat'], '/connect gateway backup HANNES_WORK_KEY\n/model fixture-model\nNew account prompt\n/exit\n');
  expect(connected.code).toBe(0); expect(connected.stdout).toContain('Account connected'); expect(connected.stdout).toContain('Hello fixture');
});
test('slash login configures a fresh gateway, selects its model, logs out and reauthenticates in the same chat', async () => {
  const x = context();
  const result = await x.cli(['chat'], [
    '/status', '/login', 'custom', 'wizard-router', x.server.url + '/v1', 'responses', 'api-key', 'n',
    'env', 'fixture-model', 'HANNES_TEST_KEY', 'First private conversation',
    '/logout', '/status', 'Must never be sent while logged out', '/logout',
    '/login', 'wizard-router', 'env', 'fixture-model', 'HANNES_TEST_KEY', 'Fresh conversation after login', '/exit', '',
  ].join('\n'));
  expect(result.code).toBe(0); expect(result.stdout).toContain('Đã đăng nhập wizard-router');
  expect(result.stdout).toContain('Đã đăng xuất wizard-router'); expect(result.stdout).toContain('"selection": null');
  expect(result.stdout).toContain('Bạn đã đăng xuất'); expect(result.stdout).toContain('Hello fixture');
  const posts = x.server.requests.filter(r => r.body);
  expect(posts).toHaveLength(4); expect(JSON.stringify(posts)).not.toContain('Must never be sent');
  expect(JSON.stringify(posts.at(-1)?.body)).toContain('Fresh conversation after login');
  expect(JSON.stringify(posts.at(-1)?.body)).not.toContain('First private conversation');
  expect(JSON.stringify(posts)).not.toContain('HANNES_TEST_KEY');
  const accounts = JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout);
  expect(accounts).toHaveLength(1); expect(accounts[0].alias).toBe('wizard-router');
});
test('slash login can be cancelled or fail validation without sending wizard answers or old chat context', async () => {
  const x = context();
  const cancelled = await x.cli(['chat'], '/login\n/cancel\n/status\n/logout\n/exit\n');
  expect(cancelled.code).toBe(0); expect(cancelled.stdout).toContain('Đã hủy'); expect(x.server.requests).toHaveLength(0);
  await configure(x); const before = x.server.requests.length;
  await x.cli(['auth', 'logout', '--account', 'personal']);
  const failed = await x.cli(['chat'], '/login\ngateway\nenv\nHANNES_UNSET_FIXTURE\nDo not reuse old conversation\n/status\n/exit\n');
  expect(failed.code).toBe(0); expect(failed.stderr).toContain('AUTH'); expect(failed.stdout).not.toContain('Đã đăng nhập');
  expect(failed.stdout).toContain('"selection": null'); expect(x.server.requests.length).toBe(before);
});
test('slash login chooses saved credentials and model without shell commands; logout can target another account', async () => {
  const x = context(); await configure(x);
  expect((await x.cli(['auth', 'login', '--provider', 'gateway', '--alias', 'backup', '--env', 'HANNES_WORK_KEY'])).code).toBe(0);
  const result = await x.cli(['chat'], '/login personal\nfixture\n1\nReady to chat\n/logout backup\nStill on personal\n/logout\n/exit\n');
  expect(result.code).toBe(0); expect(result.stdout).toContain('Đã đăng nhập personal');
  expect(result.stdout).toContain('Đã đăng xuất backup'); expect(result.stdout).toContain('Đã đăng xuất personal');
  const posts = x.server.requests.filter(r => r.body);
  expect(posts.at(-1)?.body.messages).toEqual([{ role: 'user', content: 'Ready to chat' }, { role: 'assistant', content: 'Hello fixture' }, { role: 'user', content: 'Still on personal' }]);
});
test('slash login replaces a retired default model using fresh discovery', async () => {
  const x = context(); await configure(x); x.server.set({ modelName: 'replacement-model' });
  const result = await x.cli(['chat'], '/login personal\n\nUse available model\n/exit\n');
  expect(result.code).toBe(0); expect(result.stdout).toContain('Đã đăng nhập personal');
  expect(result.stdout).toContain('replacement-model');
  expect(x.server.requests.filter(r => r.body).at(-1)?.body.model).toBe('replacement-model');
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
test.skipIf(process.env.HANNES_TEST_KEYRING !== '1' || process.platform === 'win32')('real terminal slash login hides key input/history and logout stays in the same CLI', async () => {
  const x = context();
  expect((await x.cli(['providers', 'add', 'gateway', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'openai'])).code).toBe(0);
  let transcript = ''; let cursor = 0; let notify = () => {}; const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 100, rows: 30, data(_terminal, data) { transcript += decoder.decode(data, { stream: true }); notify(); } });
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'chat'], { terminal, env: { ...process.env, HANNES_HOME: x.dir } });
  const waitFor = (needle: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { notify = () => {}; reject(new Error('Terminal did not reach expected prompt: ' + needle)); }, 4000);
    notify = () => { const index = transcript.indexOf(needle, cursor); if (index >= 0) { cursor = index + needle.length; clearTimeout(timer); notify = () => {}; resolve(); } };
    notify();
  });
  try {
    await waitFor('hannes> '); terminal.write('/login\r');
    await waitFor('Provider ['); terminal.write('gateway\r');
    await waitFor('Cách đăng nhập [keyring]: '); terminal.write('\r');
    await waitFor('API key (hidden): '); terminal.write('fixture-e2e-sensitive-value\r');
    await waitFor('Model [fixture-model]: '); terminal.write('\r');
    await waitFor('Đã đăng nhập gateway'); await waitFor('hannes> ');
    terminal.write('\x1b[AHello after hidden login\r'); await waitFor('Hello fixture'); await waitFor('hannes> ');
    terminal.write('/logout\r'); await waitFor('Sign out of gateway?'); terminal.write('y\r'); await waitFor('Đã đăng xuất gateway'); await waitFor('hannes> ');
    terminal.write('/status\r'); await waitFor('"selection": null'); await waitFor('hannes> ');
    terminal.write('/exit\r'); expect(await child.exited).toBe(0);
    expect(transcript).not.toContain('fixture-e2e-sensitive-value');
    expect(readFileSync(join(x.dir, 'provider-auth.sqlite')).includes(Buffer.from('fixture-e2e-sensitive-value'))).toBe(false);
    const posts = x.server.requests.filter(r => r.body); expect(posts).toHaveLength(1);
    expect(posts[0]?.body.messages).toEqual([{ role: 'user', content: 'Hello after hidden login' }]);
    expect(JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)).toEqual([]);
  } finally { child.kill(); await child.exited; terminal.close(); await x.cli(['accounts', 'remove', 'gateway']); }
}, 20000);
test.skipIf(process.platform === 'win32')('Ctrl-C at the hidden login prompt exits cleanly without creating credentials or sending a request', async () => {
  const x = context();
  expect((await x.cli(['providers', 'add', 'gateway', '--url', x.server.url + '/v1', '--protocol', 'chat', '--catalog', 'openai'])).code).toBe(0);
  const steps = [['hannes> ', '/login\r'], ['Provider [', 'gateway\r'], ['Cách đăng nhập [keyring]: ', '\r'], ['API key (hidden): ', '\x03']];
  let transcript = ''; let cursor = 0; let step = 0; const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ data(term, data) {
    transcript += decoder.decode(data, { stream: true }); const next = steps[step]; if (!next) return;
    const index = transcript.indexOf(next[0]!, cursor);
    if (index >= 0) { cursor = index + next[0]!.length; step++; term.write(next[1]!); }
  } });
  const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'chat'], { terminal, env: { ...process.env, HANNES_HOME: x.dir } });
  const timeout = setTimeout(() => child.kill(), 6000);
  try {
    expect(await child.exited).toBe(130); expect(step).toBe(steps.length); expect(transcript).toContain('CANCELLED');
    expect(x.server.requests).toHaveLength(0); expect(JSON.parse((await x.cli(['accounts', 'list', '--json'])).stdout)).toEqual([]);
  } finally { clearTimeout(timeout); child.kill(); await child.exited; terminal.close(); }
}, 8000);
