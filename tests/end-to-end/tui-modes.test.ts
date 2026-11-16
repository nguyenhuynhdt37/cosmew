import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynTuiApp} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedView} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function context() {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-modes-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  const backend = startup(join(dir, 'state'), {vault: memoryVault()});
  cleanup.push(
    () => backend.db.close(),
    () => backend.shutdownCommands(),
  );
  backend.registry.add(server.provider('chat', {id: 'modes', auth: 'none'}));
  await backend.accounts.add('modes', 'main', {kind: 'none'});
  const client = backend.createFutrynClient(dir);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({client, cols: 100, rows: 30});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  return {dir, server, backend, client, tui};
}

test('plan command changes the actual offered tools, preserves the request and returns to implementation', async () => {
  const c = await context();
  writeFileSync(join(c.dir, 'notes.txt'), 'original\n');
  const views: ScriptedView[] = [];
  c.server.set({
    script: view => {
      views.push(view);
      return view.results.length
        ? {text: '1. Read notes.\n2. Update notes after implementation is authorized.'}
        : {calls: [{name: 'read', input: {path: 'notes.txt'}}]};
    },
  });
  await c.tui.submitPrompt('/plan update notes safely');
  expect(c.client.mode()).toBe('plan');
  expect(c.client.activeSession()!.messages.find(message => message.role === 'user')?.content).toBe(
    'update notes safely',
  );
  expect(views.length).toBeGreaterThan(1);
  expect(views.every(view => !view.tools.includes('apply_patch') && !view.tools.includes('exec_command'))).toBe(true);
  expect(views[0]!.tools).toContain('read');
  expect(c.tui.getTranscript().at(-1)?.content).toContain('1. Read notes.');
  expect(readFileSync(join(c.dir, 'notes.txt'), 'utf8')).toBe('original\n');
  const session = c.client.activeSession()!.id;
  await c.tui.submitPrompt('/implement');
  expect(c.client.mode()).toBe('chat');
  expect(c.client.activeSession()!.id).toBe(session);
});

test('review command inspects real Git changes, reads source and emits findings without edits', async () => {
  const c = await context();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {cwd: c.dir, stdout: 'pipe', stderr: 'pipe'});
    expect(result.exitCode).toBe(0);
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(c.dir, '.gitignore'), 'state/\n');
  writeFileSync(join(c.dir, 'value.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(c.dir, 'value.ts'), 'export const value = 0;\n');
  const views: ScriptedView[] = [];
  c.server.set({
    script: view => {
      views.push(view);
      return view.results.length
        ? {text: '[P1] value.ts:1 — zero causes callers to divide by zero.'}
        : {calls: [{name: 'read', input: {path: 'value.ts'}}]};
    },
  });
  await c.tui.submitPrompt('/review focus on value.ts');
  expect(c.client.mode()).toBe('review');
  const request = c.client.activeSession()!.messages.find(message => message.role === 'user')!.content;
  expect(request).toContain('focus on value.ts');
  expect(request).toContain('export const value = 0;');
  expect(views.every(view => !view.tools.includes('apply_patch') && !view.tools.includes('exec_command'))).toBe(true);
  expect(c.tui.getTranscript().at(-1)?.content).toContain('[P1] value.ts:1');
  expect(readFileSync(join(c.dir, 'value.ts'), 'utf8')).toBe('export const value = 0;\n');
});

test('review withholds diff content of files the read policy would ask about', async () => {
  const c = await context();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {cwd: c.dir, stdout: 'pipe', stderr: 'pipe'});
    expect(result.exitCode).toBe(0);
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(c.dir, '.gitignore'), 'state/\n');
  writeFileSync(join(c.dir, '.env'), 'API_TOKEN=old-value\n');
  writeFileSync(join(c.dir, 'value.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  writeFileSync(join(c.dir, '.env'), 'API_TOKEN=fixture-secret-never-sent\n');
  writeFileSync(join(c.dir, 'value.ts'), 'export const value = 2;\n');
  c.server.set({script: () => ({text: 'No findings.'})});
  await c.tui.submitPrompt('/review');
  const request = c.client.activeSession()!.messages.find(message => message.role === 'user')!.content;
  expect(request).toContain('export const value = 2;');
  expect(request).toContain('"path":".env"');
  expect(request).toContain('contentWithheld');
  expect(request).not.toContain('fixture-secret-never-sent');
  expect(request).not.toContain('old-value');
});

test('review never inspects an unapproved workspace and session aliases use canonical handlers', async () => {
  const c = await context();
  c.server.set({script: () => ({text: 'A saved answer'})});
  await c.tui.submitPrompt('first conversation');
  const session = c.client.activeSession()!.id;
  c.tui.denyWorkspaceAccess();
  await c.tui.submitPrompt('/review');
  expect(c.client.mode()).toBe('chat');
  expect(c.tui.getStatusBanner()).toContain('approval');
  expect(c.server.requests.filter(request => request.body?.stream)).toHaveLength(1);
  await c.tui.submitPrompt('/new');
  expect(c.client.activeSession()?.id).not.toBe(session);
  await c.tui.submitPrompt('/sessions');
  expect(c.tui.getActiveOverlay()).toBe('sessions');
  await c.tui.submitPrompt('/?');
  expect(c.tui.getActiveOverlay()).toBe('help');
});

test('analysis modes reject a mutation even when the model calls a hidden tool', async () => {
  const c = await context();
  writeFileSync(join(c.dir, 'notes.txt'), 'original\n');
  c.server.set({
    script: view =>
      view.results.length
        ? {text: 'The mutation was denied; no file was changed.'}
        : {
            calls: [
              {
                name: 'apply_patch',
                input: {patch: '*** Begin Patch\n*** Update File: notes.txt\n@@\n-original\n+changed\n*** End Patch'},
              },
            ],
          },
  });
  await c.tui.submitPrompt('/plan inspect notes without changing it');
  expect(readFileSync(join(c.dir, 'notes.txt'), 'utf8')).toBe('original\n');
  // The provider adapter refuses calls absent from its advertised schema before dispatch.
  expect(c.tui.getTranscript().at(-1)?.errorText).toContain('PROTOCOL');
  expect(c.tui.getTranscript().at(-1)?.toolResults ?? []).toHaveLength(0);
  expect(c.client.mode()).toBe('plan');
});

test('running turns cannot change mode or session through slash commands or SDK setters', async () => {
  const c = await context();
  c.server.set({streamDelay: 150});
  const turn = c.tui.submitPrompt('Keep this active turn in chat mode.');
  expect(() => c.client.setMode('plan')).toThrow();
  await c.tui.submitPrompt('/plan');
  expect(c.client.mode()).toBe('chat');
  expect(c.tui.getStatusBanner()).toContain('Cancel the active response');
  await c.tui.handleKey('Escape');
  await turn;
  expect(c.client.mode()).toBe('chat');
});

test('fork copies committed transcript without replay, preserves the source and resets session authority', async () => {
  const c = await context();
  writeFileSync(join(c.dir, 'notes.txt'), 'original\n');
  c.server.set({
    script: view =>
      view.results.length ? {text: 'The file says original.'} : {calls: [{name: 'read', input: {path: 'notes.txt'}}]},
  });
  await c.tui.submitPrompt('Read notes.');
  const source = c.client.activeSession()!;
  const requests = c.server.requests.length;
  c.client.setPermissionMode('auto');
  c.client.setMode('plan');
  await c.tui.submitPrompt('/fork');
  const fork = c.client.activeSession()!;
  expect(fork.id).not.toBe(source.id);
  expect(fork.messages).toEqual(source.messages);
  expect(c.server.requests).toHaveLength(requests);
  expect(c.client.listSessions().map(session => session.id)).toContain(source.id);
  expect(c.client.permissionMode()).toBe('default');
  expect(c.client.delegatedAgent()).toBe(false);
  expect(c.client.mode()).toBe('plan');
  expect(c.tui.getTranscript().flatMap(item => item.toolCalls ?? [])).toHaveLength(1);
  await c.tui.submitPrompt(`/resume ${source.id}`);
  expect(c.client.activeSession()!.messages).toEqual(source.messages);
  expect(c.tui.getTranscript().flatMap(item => item.toolCalls ?? [])).toHaveLength(1);
});

test('review refresh cannot send its old request into a newly selected session', async () => {
  const c = await context();
  c.server.set({script: () => ({text: 'Saved answer'})});
  await c.tui.submitPrompt('First conversation.');
  const source = c.client.activeSession()!.id;
  let complete!: (report: Awaited<ReturnType<typeof c.client.refreshWorkspaceDiff>>) => void;
  c.client.refreshWorkspaceDiff = () =>
    new Promise(resolve => {
      complete = resolve;
    });
  const review = c.tui.submitPrompt('/review original review request');
  const requests = c.server.requests.length;
  await c.tui.submitPrompt('/new');
  complete({
    workspace: c.dir,
    gitAvailable: true,
    files: [
      {
        path: 'notes.txt',
        status: 'modified',
        additions: 1,
        deletions: 0,
        lines: [{type: 'add', oldLine: null, newLine: 1, content: 'change'}],
      },
    ],
    totalAdditions: 1,
    totalDeletions: 0,
  });
  await review;
  expect(c.client.mode()).toBe('chat');
  expect(c.server.requests).toHaveLength(requests);
  expect(c.client.activeSession()).toBeNull();
  expect(c.client.listSessions().map(session => session.id)).toContain(source);
  expect(c.tui.getStatusBanner()).toContain('Review cancelled');
});
