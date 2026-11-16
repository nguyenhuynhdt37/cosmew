import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FutrynTuiApp} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function make(script: (view: ScriptedView) => ScriptedReply) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-edit-home-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-edit-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
  });
  app.registry.add(server.provider('chat', {id: 'edit-model', auth: 'none'}));
  await app.accounts.add('edit-model', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({client, cols: 120, rows: 36});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  return {app, client, tui, root};
}

async function approveNext(c: Awaited<ReturnType<typeof make>>) {
  const end = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < end) await Bun.sleep(5);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  c.tui.advanceStartupGate();
  const permission = c.client.listPendingPermissions()[0]!;
  await c.tui.handleKey('1');
  return permission;
}

test('model reads, edits and writes through the agent loop; each write shows its diff and needs approval', async () => {
  const c = await make(view => {
    const done = view.results.map(r => r.name);
    if (!done.includes('read')) return {calls: [{name: 'read', input: {path: 'app.ts'}}]};
    if (!done.includes('edit'))
      return {calls: [{name: 'edit', input: {path: 'app.ts', old_string: 'answer = 41', new_string: 'answer = 42'}}]};
    if (!done.includes('write'))
      return {calls: [{name: 'write', input: {path: 'docs/notes.md', content: '# Notes\n'}}]};
    const applied = view.results.filter(r => r.content.includes('"status":"applied"')).map(r => r.name);
    return {text: 'DONE ' + applied.join(',')};
  });
  writeFileSync(join(c.root, 'app.ts'), 'export const answer = 41;\n');
  const turn = c.tui.submitPrompt('Fix the answer and add notes');
  const edit = await approveNext(c);
  expect(edit).toMatchObject({capability: 'fs.write', target: 'app.ts'});
  expect(edit.diffPreview).toContain('+export const answer = 42;');
  const write = await approveNext(c);
  expect(write).toMatchObject({capability: 'fs.write', target: 'docs/notes.md'});
  await turn;
  expect(readFileSync(join(c.root, 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  expect(readFileSync(join(c.root, 'docs/notes.md'), 'utf8')).toBe('# Notes\n');
  expect(c.tui.getTranscript().at(-1)!.content).toContain('DONE edit,write');
  const frame = c.tui.computeFrameSnapshot().plainText;
  expect(frame).toContain('Update(app.ts)');
  expect(frame).toContain('Write(docs/notes.md)');
});

test('an edit without a prior read is refused before any approval prompt', async () => {
  const c = await make(view =>
    view.results.length
      ? {text: 'GOT ' + view.results[0]!.content}
      : {calls: [{name: 'edit', input: {path: 'app.ts', old_string: '1', new_string: '2'}}]},
  );
  writeFileSync(join(c.root, 'app.ts'), 'x = 1\n');
  await c.tui.submitPrompt('Change it');
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(c.tui.getTranscript().at(-1)!.content).toContain('Read app.ts before changing it');
  expect(readFileSync(join(c.root, 'app.ts'), 'utf8')).toBe('x = 1\n');
});
