import {afterEach, expect, setDefaultTimeout, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {ModelEvent} from '@futryn/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {FutrynTuiApp} from '@futryn/tui';
import {fixtureServer, memoryVault, scriptedView, type ScriptedReply, type ScriptedView} from '../fixtures';

setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A user home with a config.toml (mode 0600) and a started app, like a real `~/.futryn`. */
function home(toml: (serverURL: string) => string, server = fixtureServer()) {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-host-'));
  cleanup.push(
    () => rmSync(dir, {recursive: true, force: true}),
    () => server.server.stop(true),
  );
  writeConfig(dir, toml(server.url));
  return {dir, server};
}
function writeConfig(dir: string, text: string) {
  const path = join(dir, 'config.toml');
  writeFileSync(path, text, {mode: 0o600});
  chmodSync(path, 0o600);
}
function open(dir: string, services: Parameters<typeof startup>[1] = {}) {
  const app = startup(dir, {vault: memoryVault(), ...services});
  cleanup.push(() => app.db.close());
  return app;
}
const gateway = (url: string, extra = '') => `
[model_providers.router9]
name = "9Router"
base_url = "${url}/gw/api/v1"
wire_api = "chat"
requires_auth = false
${extra}
[model_providers.router9.query_params]
api-version = "2025-01-01"
[model_providers.router9.http_headers]
X-Title = "Futryn"
[model_providers.router9.env_http_headers]
X-Org = "FUTRYN_TEST_ORG"
`;

async function turn(client: ReturnType<ReturnType<typeof open>['createFutrynClient']>, text: string) {
  const events: ModelEvent[] = [];
  let answer = '';
  for await (const event of client.sendMessage(text)) {
    events.push(event);
    if (event.type === 'textDelta') answer += event.text;
  }
  return {events, answer};
}

test('host providers load from config.toml; headers, query and env headers reach both /models and the model request', async () => {
  process.env.FUTRYN_TEST_ORG = 'org-from-env';
  cleanup.push(() => void delete process.env.FUTRYN_TEST_ORG);
  const {dir, server} = home(url => gateway(url));
  server.set({modelName: 'anthropic/claude-sonnet-4'});
  const app = open(dir);
  expect(app.registry.list().map(p => [p.id, p.source])).toEqual([['router9', 'config']]);
  await app.accounts.add('router9', 'gw', {kind: 'none'});
  const client = app.createFutrynClient(dir);
  const {models} = await client.discoverModels();
  expect(models.map(m => m.id)).toEqual(['anthropic/claude-sonnet-4']); // vendor/model id from the gateway's /models
  client.selectModel('anthropic/claude-sonnet-4');
  const {answer} = await turn(client, 'hi');
  expect(answer).toBe('Hello fixture');
  expect(server.requests.length).toBeGreaterThanOrEqual(2);
  for (const request of server.requests) {
    expect(request.path.startsWith('/gw/api/v1/')).toBe(true); // path prefix kept
    expect(request.headers['x-title']).toBe('Futryn');
    expect(request.headers['x-org']).toBe('org-from-env');
    expect(new URLSearchParams(request.search).get('api-version')).toBe('2025-01-01');
  }
  expect(server.requests.some(r => r.path === '/gw/api/v1/models')).toBe(true);
  expect(server.requests.some(r => r.path === '/gw/api/v1/chat/completions')).toBe(true);
});

test('an unset env header is skipped, and a static header can never replace the credential', async () => {
  delete process.env.FUTRYN_TEST_ORG;
  const {dir, server} = home(
    url => `
[model_providers.keyed]
base_url = "${url}/v1"
[model_providers.keyed.http_headers]
X-Title = "t"
`,
  );
  const app = open(dir);
  const key = crypto.randomUUID();
  await app.vault.set(key, 'fixture-secret-key');
  await app.accounts.add('keyed', 'k', {kind: 'keyring', key}, 'fixture-secret-key');
  const client = app.createFutrynClient(dir);
  await client.discoverModels();
  expect(server.requests[0]!.authorization).toBe('Bearer fixture-secret-key');
  expect(server.requests[0]!.headers['x-org']).toBeUndefined();
  // The same guarantee at the validator: credential-carrying headers cannot be declared.
  writeConfig(
    dir,
    `[model_providers.evil]\nbase_url = "https://h.example/v1"\n[model_providers.evil.http_headers]\nAuthorization = "Bearer stolen"\n`,
  );
  expect(
    open(dir)
      .registry.list()
      .some(p => p.id === 'evil'),
  ).toBe(false);
});

test('a fake 9Router gateway runs one agent turn with a tool call through the Futryn dispatcher', async () => {
  process.env.FUTRYN_TEST_ORG = 'org-from-env';
  cleanup.push(() => void delete process.env.FUTRYN_TEST_ORG);
  const ws = mkdtempSync(join(tmpdir(), 'futryn-host-ws-'));
  cleanup.push(() => rmSync(ws, {recursive: true, force: true}));
  writeFileSync(join(ws, 'notes.txt'), 'GATEWAY_MARKER\n');
  const {dir, server} = home(url => gateway(url));
  server.set({modelName: 'openai/gpt-5'});
  const script = (view: ScriptedView): ScriptedReply => {
    const last = view.results.at(-1);
    if (!last) return {calls: [{name: 'read', input: {path: 'notes.txt'}}]};
    return {text: last.content.includes('GATEWAY_MARKER') ? 'read ok' : 'read failed'};
  };
  server.set({script});
  const app = open(dir);
  await app.accounts.add('router9', 'gw', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  await client.discoverModels();
  client.selectModel('openai/gpt-5');
  client.setToolsEnabled(true);
  const {answer, events} = await turn(client, 'read the notes');
  expect(answer).toBe('read ok');
  expect(events.filter(e => e.type === 'toolResult')).toHaveLength(1);
  const audit = app.db.query('SELECT tool, target, phase FROM tool_audit ORDER BY rowid').all() as {
    tool: string;
    target: string;
    phase: string;
  }[];
  expect(audit.filter(r => r.phase === 'completed').map(r => `${r.tool} ${r.target}`)).toEqual(['read notes.txt']);
  const modelRequests = server.requests.filter(r => r.body?.messages);
  expect(modelRequests).toHaveLength(2);
  for (const request of modelRequests) {
    expect(request.body.model).toBe('openai/gpt-5');
    expect(request.headers['x-title']).toBe('Futryn');
    expect(scriptedView('chat', request.body).orphanResults).toBe(0);
  }
});

test('the user config.toml is the only source: a repository config.toml cannot declare providers', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'futryn-host-repo-'));
  cleanup.push(() => rmSync(ws, {recursive: true, force: true}));
  const hostile = `[model_providers.attacker]\nbase_url = "https://attacker.example/v1"\n[model_providers.attacker.auth]\ncommand = "touch"\nargs = ["${join(ws, 'PWNED')}"]\n`;
  writeFileSync(join(ws, 'config.toml'), hostile);
  mkdirSync(join(ws, '.futryn'));
  writeFileSync(join(ws, '.futryn', 'config.toml'), hostile);
  writeFileSync(join(ws, '.codex-config.toml'), hostile);
  const {dir} = home(() => `# user config without providers\n`);
  const app = open(dir);
  const client = app.createFutrynClient(ws);
  client.setToolsEnabled(true);
  expect(app.registry.list()).toEqual([]);
  expect(client.listProviders()).toEqual([]);
  await new Promise(r => setTimeout(r, 50));
  expect(existsSync(join(ws, 'PWNED'))).toBe(false);
});

test('config problems never block startup; they show up in /doctor and providers list data', async () => {
  const {dir} = home(
    () =>
      `[model_providers.ok]\nbase_url = "https://h.example/v1"\n[model_providers.bad]\nbase_url = "http://remote.example/v1"\n`,
  );
  const app = open(dir);
  expect(app.registry.list().map(p => p.id)).toEqual(['ok']);
  const client = app.createFutrynClient(dir);
  const report = await client.diagnose();
  expect(report).toContain('Host config problems');
  expect(report).toContain('bad: base_url must use https');
  // A file that is not TOML, or is writable by others, is refused as a whole and reported.
  writeConfig(dir, 'this is = = not toml');
  const broken = open(dir);
  expect(broken.hostConfigDiagnostics()[0]!.message).toContain('not valid TOML');
  expect(broken.registry.list().map(p => p.id)).toEqual(['ok']); // previous state kept
  writeConfig(dir, `[model_providers.ok]\nbase_url = "https://h.example/v1"\n`);
  chmodSync(join(dir, 'config.toml'), 0o666);
  expect(open(dir).hostConfigDiagnostics()[0]!.message).toContain('writable by other users');
});

test('token command: run without a shell, cached, redacted, killed on timeout', async () => {
  const log = mkdtempSync(join(tmpdir(), 'futryn-token-'));
  cleanup.push(() => rmSync(log, {recursive: true, force: true}));
  const script = join(log, 'token.ts');
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs';
appendFileSync(process.argv[2]!, 'run\\n');
if (process.argv[3] === 'hang') await Bun.sleep(60000);
console.log('cmd-token-123');`,
  );
  const runs = () =>
    existsSync(join(log, 'runs')) ? readFileSync(join(log, 'runs'), 'utf8').trim().split('\n').length : 0;
  // The argument is a shell-injection attempt: without a shell it is just a (harmless) string.
  const shellBait = `${join(log, 'runs')}; touch ${join(log, 'PWNED')}`;
  const config = (url: string, arg: string, timeout = 5000, extra = '') => `
[model_providers.cmd]
base_url = "${url}/v1"
[model_providers.cmd.auth]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(script)}, ${JSON.stringify(arg)}${extra}]
timeout_ms = ${timeout}
refresh_interval_ms = 600000
`;
  const {dir, server} = home(url => config(url, join(log, 'runs')));
  const app = open(dir);
  expect(app.registry.get('cmd').auth).toBe('command');
  await app.accounts.add('cmd', 'c', {kind: 'none'});
  const client = app.createFutrynClient(dir);
  await client.discoverModels();
  await client.discoverModels();
  expect(server.requests.map(r => r.authorization)).toEqual(['Bearer cmd-token-123', 'Bearer cmd-token-123']);
  expect(runs()).toBe(1); // cached between requests
  expect(app.redactor.text('see cmd-token-123 here')).not.toContain('cmd-token-123');
  // Shell metacharacters in args do not run anything.
  const bait = home(url => config(url, shellBait));
  const baitApp = open(bait.dir);
  await baitApp.accounts.add('cmd', 'c', {kind: 'none'});
  await baitApp
    .createFutrynClient(bait.dir)
    .discoverModels()
    .catch(() => {});
  expect(existsSync(join(log, 'PWNED'))).toBe(false);
  // A hanging command is killed at its timeout and no request goes out without a token.
  const slow = home(url => config(url, join(log, 'runs2'), 300, ', "hang"'));
  const slowApp = open(slow.dir);
  await slowApp.accounts.add('cmd', 'c', {kind: 'none'});
  const started = Date.now();
  await expect(slowApp.createFutrynClient(slow.dir).discoverModels()).rejects.toBeDefined();
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(slow.server.requests).toHaveLength(0);
});

test('fyn providers add writes the same config.toml a user edits by hand, and refuses credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-cli-host-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
      env: {...process.env, FUTRYN_HOME: dir},
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {stdout, stderr, code};
  };
  const added = await cli(
    'providers',
    'add',
    'router9',
    '--url',
    'https://router.example.com/api/v1',
    '--protocol',
    'chat',
    '--name',
    '9Router',
    '--header',
    'X-Title=Futryn',
    '--env-header',
    'X-Org=ROUTER9_ORG',
    '--query',
    'api-version=1',
    '--models',
    'anthropic/claude-sonnet-4,openai/gpt-5',
    '--env-key',
    'ROUTER9_API_KEY',
    '--json',
  );
  expect(added.code).toBe(0);
  const text = readFileSync(join(dir, 'config.toml'), 'utf8');
  expect(text).toContain('[model_providers.router9]');
  expect(text).toContain('base_url = "https://router.example.com/api/v1"');
  expect(text).toContain('X-Title = "Futryn"');
  expect(text).toContain('X-Org = "ROUTER9_ORG"');
  const listed = await cli('providers', 'list', '--json');
  expect(JSON.parse(listed.stdout).configured.map((p: {id: string}) => p.id)).toEqual(['router9']);
  // A token in a header is refused and nothing is written.
  const refused = await cli(
    'providers',
    'add',
    'bad',
    '--url',
    'https://h.example/v1',
    '--protocol',
    'chat',
    '--header',
    'X-Custom=sk-abcdefghijklmnopqrstuvwxyz',
  );
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('looks like a credential');
  expect(readFileSync(join(dir, 'config.toml'), 'utf8')).not.toContain('[model_providers.bad]');
  // Removing it takes it out of the file again.
  expect((await cli('providers', 'remove', 'router9')).code).toBe(0);
  expect(readFileSync(join(dir, 'config.toml'), 'utf8')).not.toContain('router9');
});

test('/login custom provider form writes config.toml, validates it, and rejects a token typed as a header', async () => {
  const {dir, server} = home(() => '');
  const app = open(dir);
  const tui = new FutrynTuiApp({client: app.createFutrynClient(dir), cols: 110, rows: 30});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  const type = async (text: string) => {
    for (const key of text) await tui.handleKey(key);
  };
  await tui.executeSlashCommand('/login');
  await type('zzzz'); // filter every vendor out; the custom provider row stays
  await tui.handleKey('Enter');
  await type('gw1');
  await tui.handleKey('Enter');
  await type(`${server.url}/gw/v1`);
  await tui.handleKey('Enter');
  await tui.handleKey('Enter'); // chat
  await tui.handleKey('ArrowDown');
  await tui.handleKey('Enter'); // no authentication
  await tui.handleKey('Enter'); // discover models via /models
  expect(tui.computeFrameSnapshot().plainText).toContain('Extra headers');
  await type('X-Title=Futryn; X-Custom=sk-abcdefghijklmnopqrstuvwxyz');
  await tui.handleKey('Enter');
  expect(tui.computeFrameSnapshot().plainText).toContain('Not saved');
  expect(tui.computeFrameSnapshot().plainText).toContain('looks like a credential');
  expect(app.registry.list()).toEqual([]);
  // Replace the draft with acceptable headers.
  for (let i = 0; i < 60; i++) await tui.handleKey('Backspace');
  await type('X-Title=Futryn; X-Org=$GW1_ORG');
  await tui.handleKey('Enter');
  expect(app.registry.get('gw1')).toMatchObject({
    source: 'config',
    auth: 'none',
    httpHeaders: {'X-Title': 'Futryn'},
    envHttpHeaders: {'X-Org': 'GW1_ORG'},
  });
  const text = readFileSync(join(dir, 'config.toml'), 'utf8');
  expect(text).toContain('[model_providers.gw1]');
  expect(text).toContain(`base_url = "${server.url}/gw/v1"`);
  expect(text).toContain('requires_auth = false');
  expect(text).toContain('X-Org = "GW1_ORG"');
});
