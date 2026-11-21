import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
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
  const tui = await openInk(client, {width: 100});
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
  expect(c.client.activeSession()!.messages.find(message => message.role === 'user')?.content).toContain(
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
  await c.tui.submit('/review focus on value.ts');
  for (let i = 0; i < 100 && c.client.mode() !== 'review'; i++) await Bun.sleep(50);
  await c.tui.idle();
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
  await c.tui.submit('/review');
  for (let i = 0; i < 100 && !c.client.activeSession(); i++) await Bun.sleep(50);
  await c.tui.idle();
  const request = c.client.activeSession()!.messages.find(message => message.role === 'user')!.content;
  expect(request).toContain('export const value = 2;');
  expect(request).toContain('"path":".env"');
  expect(request).toContain('contentWithheld');
  expect(request).not.toContain('fixture-secret-never-sent');
  expect(request).not.toContain('old-value');
});

test('review evidence judges paths at their canonical, real location', async () => {
  const c = await context();
  writeFileSync(join(c.dir, '.env'), 'API_TOKEN=fixture-secret\n');
  symlinkSync('.env', join(c.dir, 'innocent.txt'));
  writeFileSync(join(c.dir, 'plain.ts'), 'export {};\n');
  const file = (path: string) => ({path, status: 'untracked' as const, additions: 1, deletions: 0, lines: []});
  const evidence = c.client.reviewEvidence([
    file('state/provider-auth.sqlite'),
    file('innocent.txt'),
    file('deleted.ts'),
    file('plain.ts'),
  ]);
  expect(evidence.map(entry => entry.contentWithheld === true)).toEqual([true, true, false, false]);
});

test('review never inspects an unapproved workspace and session aliases use canonical handlers', async () => {
  const c = await context();
  c.server.set({script: () => ({text: 'A saved answer'})});
  await c.tui.submitPrompt('first conversation');
  const session = c.client.activeSession()!.id;
  c.client.setToolsEnabled(false); // the folder consent was withdrawn
  await c.tui.submitPrompt('/review');
  expect(c.client.mode()).toBe('chat');
  expect(c.tui.frame()).toContain('Review could not inspect');
  expect(c.server.requests.filter(request => request.body?.stream)).toHaveLength(1);
  await c.tui.submitPrompt('/new');
  expect(c.client.activeSession()?.id).not.toBe(session);
  await c.tui.executeSlashCommand('/sessions');
  expect(c.tui.frame()).toContain('Resume session');
  await c.tui.handleKey('Escape');
  await c.tui.executeSlashCommand('/?');
  expect(c.tui.frame()).toContain('General   Commands   Custom commands');
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
  expect(c.tui.frame()).toContain('PROTOCOL');
  expect(c.tui.getTranscript().at(-1)?.toolResults ?? []).toHaveLength(0);
  expect(c.client.mode()).toBe('plan');
});

test('running turns cannot change mode or session through slash commands or SDK setters', async () => {
  const c = await context();
  c.server.set({streamDelay: 150});
  await c.tui.submit('Keep this active turn in chat mode.');
  await Bun.sleep(100);
  expect(() => c.client.setMode('plan')).toThrow();
  await c.tui.submit('/plan');
  await Bun.sleep(100);
  expect(c.client.mode()).toBe('chat');
  await c.tui.handleKey('Escape');
  await c.tui.idle();
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
  c.client.setPermissionMode('acceptEdits');
  c.client.setMode('plan');
  await c.tui.submitPrompt('/fork');
  const fork = c.client.activeSession()!;
  expect(fork.id).not.toBe(source.id);
  expect(fork.messages).toEqual(source.messages);
  expect(c.server.requests).toHaveLength(requests);
  expect(c.client.listSessions().map(session => session.id)).toContain(source.id);
  expect(c.client.permissionMode()).toBe('default');
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
  await c.tui.submit('/review original review request');
  const requests = c.server.requests.length;
  // Ctrl+N is history navigation now; start the new conversation the way `/clear` does while the command is pending.
  c.client.clearSessionView();
  await Bun.sleep(100);
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
  await Bun.sleep(300);
  expect(c.client.mode()).toBe('chat');
  expect(c.server.requests).toHaveLength(requests);
  expect(c.client.activeSession()).toBeNull();
  expect(c.client.listSessions().map(session => session.id)).toContain(source);
  expect(c.tui.frame()).toContain('Review cancelled');
});

test('Shift+Tab and /permissions cycle the Claude Code modes, bypassPermissions is launch-only, and [3] saves an allowed domain', async () => {
  const c = await context();
  expect(c.client.permissionMode()).toBe('default');
  await c.tui.handleKey('Shift+Tab');
  expect(c.client.permissionMode()).toBe('acceptEdits');
  await c.tui.handleKey('Shift+Tab');
  expect(c.client.permissionMode()).toBe('plan');
  expect(c.tui.frames()).toContain('plan mode');
  // bypassPermissions is not part of the cycle unless the session started in it.
  await c.tui.handleKey('Shift+Tab');
  expect(c.client.permissionMode()).toBe('default');
  expect(() => c.client.setPermissionMode('bypassPermissions')).toThrow();

  // `/permissions` opens the dialog; slash arguments switch modes directly.
  await c.tui.executeSlashCommand('/permissions');
  await c.tui.waitFor('Permissions');
  await c.tui.handleKey('Escape');
  await c.tui.submitPrompt('/permissions acceptEdits');
  expect(c.client.permissionMode()).toBe('acceptEdits');
  await c.tui.submitPrompt('/permissions bypass');
  expect(c.client.permissionMode()).toBe('acceptEdits');
  await c.tui.submitPrompt('/permissions default');

  // A new network domain asks; `[3]` saves it to sandbox.network.allowedDomains of the local settings.
  const waiting = c.client.authorizeNetwork('registry.example.org', 443);
  await Bun.sleep(10);
  await c.tui.nextPermission();
  expect(c.tui.frame()).toContain('sandbox.network.allowedDomains: registry.example.org');
  await c.tui.handleKey('3');
  expect(await waiting).toBe(true);
  expect(c.client.permissionSettings().sandbox.allowedDomains).toContain('registry.example.org');
  expect(await c.client.authorizeNetwork('registry.example.org', 443)).toBe(true);
});

test('interactive CLI/TUI entry accepts the Claude Code launch flags, warns on bypass and rejects conflicts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-cli-launch-flags-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
      env: {...process.env, FUTRYN_HOME: home},
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {stdout, stderr, code};
  };

  const skipTui = await run(['tui', '--dangerously-skip-permissions']);
  expect(skipTui.code).toBe(0);
  expect(skipTui.stderr).toContain('WARNING: bypassPermissions');
  expect(skipTui.stdout).toContain('WARNING: bypassPermissions');

  const bypassStatus = await run(['status', '--dangerously-skip-permissions', '--json']);
  expect(bypassStatus.code).toBe(0);
  expect(bypassStatus.stderr).toContain('WARNING: bypassPermissions');
  expect(JSON.parse(bypassStatus.stdout)).toMatchObject({permissionMode: 'bypassPermissions'});

  const planStatus = await run(['status', '--permission-mode', 'plan', '--json']);
  expect(planStatus.code).toBe(0);
  expect(JSON.parse(planStatus.stdout)).toMatchObject({permissionMode: 'plan', sandbox: {enabled: true}});

  for (const bad of [
    ['tui', '--dangerously-skip-permissions', '--permission-mode', 'plan'],
    ['tui', '--permission-mode', 'auto'],
    ['tui', '--allowedTools', 'Nonsense(('],
    ['tui', '--yolo'],
    ['tui', '--sandbox', 'read-only'],
    ['tui', '--full-auto'],
  ]) {
    const conflict = await run(bad);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('INVALID_INPUT');
  }
}, 60000);
