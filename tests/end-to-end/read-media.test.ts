import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FutrynTuiApp} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

/** ADR 0041: images reach the model on both adapters; nested AGENTS.md is durable across restart. */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function project() {
  const home = mkdtempSync(join(tmpdir(), 'futryn-media-home-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-media-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  writeFileSync(join(root, 'logo.png'), Buffer.from(PNG, 'base64'));
  mkdirSync(join(root, 'pkg', 'sub'), {recursive: true});
  writeFileSync(join(root, 'pkg', 'AGENTS.md'), 'NESTED-PKG-RULE: use tabs in pkg.\n');
  writeFileSync(join(root, 'pkg', 'sub', 'x.ts'), 'export const x = 1;\n');
  return {home, root};
}

async function open(
  dirs: {home: string; root: string},
  protocol: 'chat' | 'anthropic',
  script: (view: ScriptedView) => ScriptedReply,
  reuse?: ReturnType<typeof fixtureServer>,
) {
  const server = reuse ?? fixtureServer();
  if (!reuse) cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(dirs.home, {vault: memoryVault()});
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.shutdownCommands();
    app.db.close();
  };
  cleanup.push(close);
  if (!reuse) {
    app.registry.add(server.provider(protocol, {id: 'media-model', auth: 'none'}));
    await app.accounts.add('media-model', 'fixture', {kind: 'none'});
  }
  const client = app.createFutrynClient(dirs.root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({client, cols: 120, rows: 36});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  return {app, client, tui, server, close};
}

const bodyText = (body: unknown) => JSON.stringify(body);

for (const protocol of ['chat', 'anthropic'] as const)
  test(`${protocol}: a read image reaches the model in the protocol's wire format; transcript has no base64`, async () => {
    const dirs = project();
    const c = await open(dirs, protocol, view =>
      view.results.length ? {text: 'SEEN'} : {calls: [{name: 'read', input: {path: 'logo.png'}}]},
    );
    await c.tui.submitPrompt('Look at the logo');
    const last = c.server.requests.at(-1)!.body;
    if (protocol === 'anthropic') {
      const results = last.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
      const toolResult = results.find((b: any) => b.type === 'tool_result');
      expect(toolResult.content).toContainEqual({
        type: 'image',
        source: {type: 'base64', media_type: 'image/png', data: PNG},
      });
    } else {
      const index = last.messages.findIndex((m: any) => m.role === 'tool');
      expect(index).toBeGreaterThan(0);
      const next = last.messages[index + 1];
      expect(next.role).toBe('user');
      expect(bodyText(next.content)).toContain(`data:image/png;base64,${PNG}`);
    }
    expect(c.tui.getTranscript().at(-1)!.content).toContain('SEEN');
    // The transcript and the stored tool message keep only the text summary.
    expect(bodyText(c.tui.getTranscript())).not.toContain(PNG);
    const stored = c.app.conversations.get(c.client.activeSession()!.id)!;
    expect(bodyText(stored.messages.map(({attachments: _a, ...m}) => m))).not.toContain(PNG);
  });

test('image media and nested AGENTS.md survive a restart; nested instructions load once', async () => {
  const dirs = project();
  const first = await open(dirs, 'chat', view => {
    const done = view.results.map(r => r.input.path);
    if (!done.includes('logo.png')) return {calls: [{name: 'read', input: {path: 'logo.png'}}]};
    if (!done.includes('pkg/sub/x.ts')) return {calls: [{name: 'read', input: {path: 'pkg/sub/x.ts'}}]};
    return {text: 'DONE'};
  });
  await first.tui.submitPrompt('Read things');
  const readResult = first.tui
    .getTranscript()
    .at(-1)!
    .toolResults!.find(r => r.content.includes('export const x'))!;
  expect(readResult.content).toContain('NESTED-PKG-RULE');
  const id = first.client.activeSession()!.id;
  // A second read in the same directory does not repeat the nested instructions.
  first.server.set({
    script: view =>
      view.results.some(r => r.input.path === 'pkg/sub/x.ts' && r.content.includes('again'))
        ? {text: 'OK'}
        : {calls: [{name: 'read', input: {path: 'pkg/sub/x.ts', offset: 1}}]},
  });
  await first.tui.submitPrompt('again');
  const again = first.tui.getTranscript().at(-1)!.toolResults!.at(-1)!;
  expect(again.content).not.toContain('NESTED-PKG-RULE');
  // The next turn's project context carries the nested source.
  expect(bodyText(first.server.requests.at(-1)!.body)).toContain('NESTED-PKG-RULE');
  await first.close();

  const second = await open(dirs, 'chat', () => ({text: 'RESUMED'}), first.server);
  second.client.resumeSession(id);
  await second.tui.submitPrompt('continue');
  const body = bodyText(second.server.requests.at(-1)!.body);
  expect(body).toContain(`data:image/png;base64,${PNG}`);
  expect(body).toContain('NESTED-PKG-RULE');
});

test('nested AGENTS.md is never loaded from dependencies or ignored directories', async () => {
  const dirs = project();
  Bun.spawnSync(['git', 'init', '-q'], {cwd: dirs.root});
  writeFileSync(join(dirs.root, '.gitignore'), 'generated/\n');
  for (const [dir, marker] of [
    ['node_modules/pkg', 'DEPENDENCY-RULE'],
    ['generated/out', 'IGNORED-RULE'],
    ['packages/app', 'APP-RULE'],
  ] as const) {
    mkdirSync(join(dirs.root, dir), {recursive: true});
    writeFileSync(join(dirs.root, dir, 'AGENTS.md'), `${marker}: obey me\n`);
    writeFileSync(join(dirs.root, dir, 'index.js'), 'module.exports = 1;\n');
  }
  const c = await open(dirs, 'chat', view => {
    const done = view.results.map(r => r.input.path);
    for (const path of ['node_modules/pkg/index.js', 'generated/out/index.js', 'packages/app/index.js'])
      if (!done.includes(path)) return {calls: [{name: 'read', input: {path}}]};
    return {text: 'DONE'};
  });
  await c.tui.submitPrompt('read');
  const all = JSON.stringify(c.tui.getTranscript().at(-1)!.toolResults!);
  expect(all).not.toContain('DEPENDENCY-RULE');
  expect(all).not.toContain('IGNORED-RULE');
  expect(all).toContain('APP-RULE');
  expect(all).toContain('Nested project instructions from packages/app/AGENTS.md (repository content');
  c.server.set({script: () => ({text: 'NEXT'})});
  await c.tui.submitPrompt('next');
  const next = bodyText(c.server.requests.at(-1)!.body);
  expect(next).toContain('APP-RULE');
  expect(next).not.toContain('DEPENDENCY-RULE');
  expect(next).not.toContain('IGNORED-RULE');
});

test('nested UTF-8 instructions near the 60 KB tool output cap respect the byte budget cleanly', async () => {
  const dirs = project();
  mkdirSync(join(dirs.root, 'viet'), {recursive: true});
  writeFileSync(join(dirs.root, 'viet', 'AGENTS.md'), 'Quy tắc tiếng Việt 🚀 '.repeat(450));
  writeFileSync(
    join(dirs.root, 'viet', 'large.txt'),
    Array.from({length: 700}, (_, i) => `${i}: ${'x'.repeat(70)}`).join('\n'),
  );
  const c = await open(dirs, 'chat', view =>
    view.results.length ? {text: 'OK'} : {calls: [{name: 'read', input: {path: 'viet/large.txt'}}]},
  );
  await c.tui.submitPrompt('read large file');
  const readResult = c.tui.getTranscript().at(-1)!.toolResults![0]!;
  expect(Buffer.byteLength(readResult.content, 'utf8')).toBeLessThanOrEqual(60000);
  expect(readResult.content).toContain('Quy tắc tiếng Việt');
  expect(readResult.content).not.toContain('\uFFFD');
});
