import {afterEach, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {CommandRuntime, PermissionMode} from '@cosmew/contracts';
import {SeatbeltRuntime} from '@cosmew/tools';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

/** ADR 0081: ordinary commands and edits ask; containment tests explicitly enable the sandbox. */
import {writeSandboxSettings} from '../sandbox-config';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function make(
  script: (view: ScriptedView) => ScriptedReply,
  runtime: (root: string, state: string) => CommandRuntime,
  mode?: PermissionMode,
  prepare?: (root: string) => void,
  sandbox = false,
) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-policy-home-')),
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-policy-project-')));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  if (sandbox) writeSandboxSettings(home);
  prepare?.(root);
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(home, {vault: memoryVault(), commands: runtime, ...(mode ? {permissions: {mode}} : {})});
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add(server.provider('chat', {id: 'policy-model', auth: 'none'}));
  await app.accounts.add('policy-model', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = await openInk(client, {width: 120});
  cleanup.push(() => tui.shutdown());
  return {client, tui, root};
}

function fixtureRuntime(ran: string[]): (root: string, state: string) => CommandRuntime {
  return () => ({
    id: 'policy-e2e',
    label: 'fixture',
    availability: () => ({ok: true}),
    capabilities: () => ({
      modes: ['read-only', 'workspace-write', 'danger-full-access'],
      network: false,
      tty: false,
      unsandboxed: true,
      shells: ['bash'],
      tools: [],
    }),
    run: async request => {
      ran.push(request.command);
      return {kind: 'exited', exitCode: 0, signal: null, output: '1 pass\n', omittedBytes: 0, durationMs: 1};
    },
  });
}

for (const sandbox of [false, true])
  test(
    sandbox
      ? 'default mode with explicit sandbox auto-allow: `bun test` and `rm -rf` run without a prompt; a workspace edit asks'
      : 'default mode: `bun test`, `rm -rf` and a workspace edit ask under regular permissions',
    async () => {
      const ran: string[] = [];
      const c = await make(
        view => {
          const done = view.results.map(r => (r.name === 'exec_command' ? r.input.cmd : r.name));
          if (!done.includes('bun test')) return {calls: [{name: 'exec_command', input: {cmd: 'bun test'}}]};
          if (!done.includes('rm -rf build')) return {calls: [{name: 'exec_command', input: {cmd: 'rm -rf build'}}]};
          if (!done.includes('write')) return {calls: [{name: 'write', input: {path: 'notes.md', content: 'ok\n'}}]};
          return {text: 'DONE ' + view.results.map(r => r.content.slice(0, 40)).join(' | ')};
        },
        fixtureRuntime(ran),
        undefined,
        undefined,
        sandbox,
      );
      expect(c.client.permissionMode()).toBe('default');
      await c.tui.submitPrompt('Run the tests, clean up, note it');
      // ADR 0081: sandbox is off and ordinary Bash permissions ask before each command.
      expect(c.client.status().sandbox.enabled).toBe(sandbox);
      if (!sandbox)
        for (const [index, command] of ['bun test', 'rm -rf build'].entries()) {
          await c.tui.nextPermission();
          expect(ran).toEqual(['bun test', 'rm -rf build'].slice(0, index));
          expect(c.client.listPendingPermissions()).toHaveLength(1);
          expect(c.client.listPendingPermissions()[0]).toMatchObject({capability: 'process.execute', target: command});
          await c.tui.handleKey('1');
        }
      await c.tui.nextPermission();
      expect(ran).toEqual(['bun test', 'rm -rf build']);
      expect(c.client.listPendingPermissions()).toHaveLength(1);
      expect(c.client.listPendingPermissions()[0]).toMatchObject({capability: 'fs.write'});
      await c.tui.handleKey('Escape');
      await c.tui.idle();
      expect(() => readFileSync(join(c.root, 'notes.md'), 'utf8')).toThrow();
    },
    20000,
  );

test('acceptEdits approves the workspace edit without a prompt', async () => {
  const ran: string[] = [];
  const c = await make(
    view => {
      if (!view.results.length) return {calls: [{name: 'write', input: {path: 'notes.md', content: 'ok\n'}}]};
      return {text: 'DONE'};
    },
    fixtureRuntime(ran),
    'acceptEdits',
  );
  await c.tui.submitPrompt('note it');
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  expect(readFileSync(join(c.root, 'notes.md'), 'utf8')).toBe('ok\n');
}, 20000);

test.skipIf(process.platform !== 'darwin')(
  'default mode in the real Seatbelt sandbox: rg runs without a prompt and cannot write outside the workspace',
  async () => {
    let runs = 0;
    const outside = join(tmpdir(), `fyn-policy-outside-${crypto.randomUUID()}`);
    cleanup.push(() => rmSync(outside, {force: true}));
    const c = await make(
      view => {
        if (!view.results.length) return {calls: [{name: 'exec_command', input: {cmd: 'rg -n marker source.ts'}}]};
        if (view.results.length === 1) return {calls: [{name: 'exec_command', input: {cmd: `touch ${outside}`}}]};
        return {text: 'DONE'};
      },
      (root, state) => {
        const candidate = new SeatbeltRuntime({workspaceRoot: root, stateDirectory: state, extraExecutables: ['rg']});
        expect(candidate.probeIsolation()).toEqual({ok: true});
        return {
          id: candidate.id,
          label: 'Seatbelt acceptance',
          availability: () => ({ok: true as const}),
          capabilities: () => ({
            modes: ['read-only', 'workspace-write'],
            network: false,
            tty: false,
            shells: ['bash'],
            tools: [],
          }),
          shutdown: () => candidate.shutdown(),
          run: async (request, signal) => {
            runs++;
            return candidate.run(request, signal);
          },
        } satisfies CommandRuntime;
      },
      undefined,
      undefined,
      true, // Explicit sandbox + auto-approved Bash; these are not the ADR 0081 defaults.
    );
    writeFileSync(join(c.root, 'source.ts'), 'export const marker = 1;\n');
    await c.tui.submitPrompt('find marker');
    expect(c.client.listPendingPermissions()).toHaveLength(0);
    expect(runs).toBe(2);
    const result = c.tui.getTranscript().at(-1)?.toolResults?.[0];
    expect(result).toMatchObject({status: 'ok', exitCode: 0});
    expect(result?.content).toContain('1:export const marker = 1;');
    // The research SeatbeltRuntime reports the real exit/output, without NativeCommandRuntime's denial tag.
    const denied = c.tui.getTranscript().at(-1)?.toolResults?.[1];
    expect(denied?.exitCode).toBe(1);
    expect(denied?.content).toMatch(/Operation not permitted|Permission denied/);
    expect(existsSync(outside)).toBe(false);
    expect(readdirSync(c.root)).toEqual(['source.ts']);
  },
);

test('a repository settings file that loosens something is offered in the TUI; approving it by content applies its rules', async () => {
  const ran: string[] = [];
  const c = await make(
    () => ({text: 'ready'}),
    fixtureRuntime(ran),
    undefined,
    root => {
      mkdirSync(join(root, '.futryn'));
      writeFileSync(
        join(root, '.futryn', 'settings.json'),
        JSON.stringify({permissions: {allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)']}}),
      );
    },
  );
  expect(c.client.permissionRules()).toEqual({allow: [], ask: [], deny: ['Bash(rm:*)']});
  await c.tui.nextPermission();
  expect(c.tui.frame()).toContain('Trust settings');
  expect(c.tui.frame()).toMatch(/allow rule: Bash\(npm\s+test:\*\)/);
  // Trust offers session/always/deny; only offered scopes receive numbers.
  expect(c.tui.frame()).toContain('2. Yes, always trust this content (by hash)');
  await c.tui.handleKey('2');
  expect(c.client.permissionRules().allow).toEqual(['Bash(npm test:*)']);
  expect(c.client.listPendingPermissions()).toHaveLength(0);
}, 20000);
