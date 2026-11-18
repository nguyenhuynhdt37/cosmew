import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {CommandRuntime} from '@futryn/contracts';
import {SeatbeltRuntime} from '@futryn/tools';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';

/**
 * ADR 0040 end to end: the product default is Codex `on-request` in the workspace-write sandbox.
 * The agent runs ordinary commands and workspace edits without a prompt; a dangerous command asks.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function make(
  script: (view: ScriptedView) => ScriptedReply,
  runtime: (root: string, state: string) => CommandRuntime,
) {
  const previous = process.env.FUTRYN_APPROVAL_POLICY;
  // The product default: no explicit policy (tests/preload.ts pins `untrusted` for fixture suites).
  delete process.env.FUTRYN_APPROVAL_POLICY;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.FUTRYN_APPROVAL_POLICY;
    else process.env.FUTRYN_APPROVAL_POLICY = previous;
  });
  const home = mkdtempSync(join(tmpdir(), 'futryn-policy-home-')),
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-policy-project-')));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  server.set({script});
  const app = startup(home, {vault: memoryVault(), commands: runtime});
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
      modes: ['read-only', 'workspace-write'],
      network: false,
      tty: false,
      shells: ['bash'],
      tools: [],
    }),
    run: async request => {
      ran.push(request.command);
      return {kind: 'exited', exitCode: 0, signal: null, output: '1 pass\n', omittedBytes: 0, durationMs: 1};
    },
  });
}

test('on-request default: `bun test` and a workspace edit run without a prompt; `rm -rf` asks', async () => {
  const ran: string[] = [];
  const c = await make(view => {
    const done = view.results.map(r => (r.name === 'exec_command' ? r.input.cmd : r.name));
    if (!done.includes('bun test')) return {calls: [{name: 'exec_command', input: {cmd: 'bun test'}}]};
    if (!done.includes('write')) return {calls: [{name: 'write', input: {path: 'notes.md', content: 'ok\n'}}]};
    if (!done.includes('rm -rf build')) return {calls: [{name: 'exec_command', input: {cmd: 'rm -rf build'}}]};
    return {text: 'DONE ' + view.results.map(r => r.content.slice(0, 40)).join(' | ')};
  }, fixtureRuntime(ran));
  expect(c.client.permissionMode()).toBe('auto');
  let prompts = 0;
  await c.tui.submitPrompt('Run the tests, note it, clean up');
  const end = Date.now() + 6000;
  while (Date.now() < end && !c.client.listPendingPermissions().length) await Bun.sleep(5);
  const pending = c.client.listPendingPermissions();
  expect(pending).toHaveLength(1);
  prompts++;
  // The only prompt is the dangerous command, after the test run and the edit already happened.
  expect(pending[0]).toMatchObject({capability: 'process.execute', target: 'rm -rf build'});
  expect(ran).toEqual(['bun test']);
  expect(readFileSync(join(c.root, 'notes.md'), 'utf8')).toBe('ok\n');
  await c.tui.nextPermission();
  await c.tui.handleKey('Escape');
  await c.tui.idle();
  expect(prompts).toBe(1);
  expect(ran).toEqual(['bun test']);
}, 20000);

test.skipIf(process.platform !== 'darwin')(
  'on-request in the real Seatbelt sandbox: rg runs without a prompt and cannot write outside the workspace',
  async () => {
    let runs = 0;
    const c = await make(
      view => {
        if (!view.results.length) return {calls: [{name: 'exec_command', input: {cmd: 'rg -n marker source.ts'}}]};
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
    );
    writeFileSync(join(c.root, 'source.ts'), 'export const marker = 1;\n');
    await c.tui.submitPrompt('find marker');
    expect(c.client.listPendingPermissions()).toHaveLength(0);
    expect(runs).toBe(1);
    const result = c.tui.getTranscript().at(-1)?.toolResults?.[0];
    expect(result).toMatchObject({status: 'ok', exitCode: 0});
    expect(result?.content).toContain('1:export const marker = 1;');
    expect(readdirSync(c.root)).toEqual(['source.ts']);
  },
);

test('request_permissions answered [2] "for this session" stays active across later turns without prompting again', async () => {
  const launches: {command: string; network?: boolean}[] = [];
  let turnNumber = 1;
  const c = await make(
    view => {
      const results = view.results;
      if (turnNumber === 1) {
        if (!results.some(r => r.name === 'request_permissions'))
          return {
            calls: [{name: 'request_permissions', input: {permissions: {network: {enabled: true}}, reason: 'deps'}}],
          };
        if (!results.some(r => r.name === 'exec_command' && r.input.cmd === 'npm install'))
          return {calls: [{name: 'exec_command', input: {cmd: 'npm install'}}]};
        return {text: 'TURN1_DONE'};
      }
      const turn2Execs = results.filter(r => r.name === 'exec_command' && String(r.input.cmd).startsWith('curl'));
      if (!turn2Execs.length)
        return {
          calls: [
            {
              name: 'exec_command',
              input: {
                cmd: 'curl -s https://example.com',
                sandbox_permissions: 'with_additional_permissions',
                additional_permissions: {network: {enabled: true}},
                justification: 'fetch metadata',
              },
            },
          ],
        };
      return {text: 'TURN2_DONE'};
    },
    () => ({
      id: 'net-session-e2e',
      label: 'fixture',
      availability: () => ({ok: true}),
      capabilities: () => ({
        modes: ['read-only', 'workspace-write', 'danger-full-access'],
        network: true,
        tty: false,
        unsandboxed: true,
        shells: ['bash'],
        tools: [],
      }),
      run: async request => {
        launches.push({command: request.command, network: request.sandbox?.network});
        return {kind: 'exited', exitCode: 0, signal: null, output: 'ok\n', omittedBytes: 0, durationMs: 1};
      },
    }),
  );

  await c.tui.submitPrompt('Install dependencies');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !c.client.listPendingPermissions().length) await Bun.sleep(5);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  c.tui.advanceStartupGate();
  // Press [2] Yes, for this session.
  await c.tui.handleKey('2');
  await c.tui.idle();
  expect(launches).toEqual([{command: 'npm install', network: true}]);

  // Turn 2: network grant survives into the new turn with zero prompts.
  turnNumber = 2;
  let extraPrompts = 0;
  c.client.onInteractionEvent(e => {
    if (e.type === 'permission.requested') extraPrompts++;
  });
  await c.tui.submitPrompt('Fetch metadata in turn 2');
  expect(extraPrompts).toBe(0);
  expect(launches).toEqual([
    {command: 'npm install', network: true},
    {command: 'curl -s https://example.com', network: true},
  ]);

  // `/new` clears the session and revokes the session grant.
  await c.tui.submitPrompt('/new');
  expect(c.client.listToolGrants()).toEqual([]);
});
