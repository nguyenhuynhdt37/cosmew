import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
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
    app.db.close();
  });
  app.registry.add(server.provider('chat', {id: 'edit-model', auth: 'none'}));
  await app.accounts.add('edit-model', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = await openInk(client, {width: 120});
  cleanup.push(() => tui.close());
  return {app, client, tui, root};
}

async function approveNext(c: Awaited<ReturnType<typeof make>>) {
  const permission = await c.tui.nextPermission();
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  await c.tui.press('1');
  return permission;
}

test('/init explores the project and writes AGENTS.md through a real file approval', async () => {
  const c = await make(view => {
    if (view.results.length === 0) return {calls: [{name: 'read', input: {path: 'README.md'}}]};
    expect(view.results[0]!.content).toContain('bun test');
    if (view.results.length === 1) return {calls: [{name: 'read', input: {path: 'AGENTS.md'}}]};
    if (view.results[1]!.content.includes('bun test'))
      return {text: 'Suggested improvement: document single-test runs.'};
    if (view.results.length === 2)
      return {calls: [{name: 'write', input: {path: 'AGENTS.md', content: '# Build and test\n\nRun bun test.\n'}}]};
    return {text: 'Project instructions initialized.'};
  });
  writeFileSync(join(c.root, 'README.md'), 'Run bun test.\n');
  await c.tui.type('/init');
  await c.tui.press('\r');
  expect(await approveNext(c)).toMatchObject({capability: 'fs.write', target: 'AGENTS.md'});
  await c.tui.waitFor('Project instructions initialized.');
  expect(c.client.activeSession()?.messages[0]?.content).toContain('initialize a concise AGENTS.md');
  expect(readFileSync(join(c.root, 'AGENTS.md'), 'utf8')).toBe('# Build and test\n\nRun bun test.\n');
  await c.tui.submit('/clear');
  await c.tui.submit('/init');
  await c.tui.waitFor('Suggested improvement');
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(readFileSync(join(c.root, 'AGENTS.md'), 'utf8')).toBe('# Build and test\n\nRun bun test.\n');
});

test('/export offers clipboard and file options; direct export and session titles use the real ports', async () => {
  const c = await make(view => ({
    text: view.system.includes('Generate a short descriptive title')
      ? 'Generated session title'
      : 'Sample export reply.',
  }));
  await c.tui.submit('Export this exchange');
  await c.tui.waitFor('Sample export reply.');
  await c.tui.submit('/rename Export fixture');
  await c.tui.waitFor('Session renamed to Export fixture.');
  await c.tui.submit('/rename');
  await c.tui.waitFor('Session renamed to Generated session title.');
  expect(c.client.status().sessionTitle).toBe('Generated session title');
  expect(c.app.createFutrynClient(c.root).listSessions()[0]?.title).toBe('Generated session title');
  expect(c.client.activeSession()?.messages.some(message => message.content.includes('Generated session title'))).toBe(
    false,
  );

  await c.tui.type('/export');
  await c.tui.press('\r');
  await c.tui.waitFor('Copy to clipboard');
  await c.tui.waitFor('Save to a file');
  await c.tui.press('\x1b[B');
  await c.tui.press('\r');
  expect(await approveNext(c)).toMatchObject({
    capability: 'fs.write',
    target: expect.stringMatching(/^cosmew-transcript-\d+\.txt$/),
  });
  await c.tui.waitFor('Created cosmew-transcript-');

  await c.tui.type('/export notes.txt');
  await c.tui.press('\r');
  expect(await approveNext(c)).toMatchObject({capability: 'fs.write', target: 'notes.txt'});
  await c.tui.waitFor('Created notes.txt.');
  const exported = readFileSync(join(c.root, 'notes.txt'), 'utf8');
  expect(exported).toContain('> Export this exchange');
  expect(exported).toContain('Sample export reply.');
  await c.tui.submit('/export notes.txt');
  await c.tui.waitFor('A destination already exists.');
  expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe(exported);
});

test('/copy 2 lets the user save only the selected code block through file approval', async () => {
  let response = 0;
  const c = await make(() => ({
    text: ++response === 1 ? 'First reply\n\n```ts\nconst earlier = 1;\n```' : 'Second reply',
  }));
  await c.tui.submit('First question');
  await c.tui.waitFor('First reply');
  await c.tui.submit('Second question');
  await c.tui.waitFor('Second reply');
  await c.tui.type('/copy 2');
  await c.tui.press('\r');
  await c.tui.waitFor('Code block 1');
  await c.tui.press('\x1b[B');
  await c.tui.press('w');
  expect(await approveNext(c)).toMatchObject({
    capability: 'fs.write',
    target: expect.stringMatching(/^cosmew-response-\d+\.txt$/),
  });
  await c.tui.waitFor('Created cosmew-response-');
  const filename = readdirSync(c.root).find(name => name.startsWith('cosmew-response-'))!;
  expect(readFileSync(join(c.root, filename), 'utf8')).toBe('const earlier = 1;\n');
});

test('/undo opens the rewind picker without modifying the current conversation', async () => {
  const c = await make(() => ({text: 'Original response.'}));
  await c.tui.submit('Original question');
  await c.tui.waitFor('Original response.');
  const source = c.client.activeSession()!.id;
  await c.tui.submit('/undo');
  await c.tui.waitFor('Rewind');
  expect(c.client.activeSession()?.id).toBe(source);
});

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
  await c.tui.submit('Fix the answer and add notes');
  const edit = await approveNext(c);
  expect(edit).toMatchObject({capability: 'fs.write', target: 'app.ts'});
  expect(edit.diffPreview).toContain('+export const answer = 42;');
  const write = await approveNext(c);
  expect(write).toMatchObject({capability: 'fs.write', target: 'docs/notes.md'});
  await c.tui.idle();
  expect(readFileSync(join(c.root, 'app.ts'), 'utf8')).toBe('export const answer = 42;\n');
  expect(readFileSync(join(c.root, 'docs/notes.md'), 'utf8')).toBe('# Notes\n');
  const frame = c.tui.frames();
  expect(frame).toContain('DONE edit,write');
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
  await c.tui.submit('Change it');
  await c.tui.waitFor('Read app.ts before changing it');
  await c.tui.idle();
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(c.tui.frames()).toContain('Read app.ts before changing it');
  expect(readFileSync(join(c.root, 'app.ts'), 'utf8')).toBe('x = 1\n');
});
