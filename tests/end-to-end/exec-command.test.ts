import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import type {CommandRuntime, CommandOutcome} from '@futryn/contracts';
import {FutrynTuiApp, commandSummary, messagesToTranscript} from '@futryn/tui';
import {SeatbeltRuntime} from '@futryn/tools';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function make(codex = false, enabled = true, real = false) {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-exec-home-')),
    ws = mkdtempSync(join(tmpdir(), 'futryn-exec-project-'));
  cleanup.push(
    () => rmSync(dir, {recursive: true, force: true}),
    () => rmSync(ws, {recursive: true, force: true}),
  );
  writeFileSync(join(ws, 'source.ts'), 'export const marker = 1;\n');
  let runs = 0,
    factories = 0,
    shutdowns = 0;
  const runtime: CommandRuntime = {
    id: 'fixture-policy',
    label: 'deterministic test only',
    availability: () => ({ok: true}),
    shutdown: async () => {
      shutdowns++;
    },
    run: async () => {
      runs++;
      return {
        kind: 'exited',
        exitCode: 0,
        signal: null,
        output: '\x1b[31msource.ts:1:marker\x1b[0m\n',
        omittedBytes: 0,
        durationMs: 2,
      };
    },
  };
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  const app = startup(dir, {
    vault: memoryVault(),
    ...(enabled
      ? {
          commands: (root: string, state: string) => {
            factories++;
            if (!real) return runtime;
            // Explicit research-only injection; production's mandatory cleanup gate stays closed.
            const candidate = new SeatbeltRuntime({
              workspaceRoot: root,
              stateDirectory: state,
              extraExecutables: ['rg'],
            });
            expect(candidate.probeIsolation()).toEqual({ok: true});
            return {
              id: candidate.id,
              label: 'OS isolation acceptance only',
              availability: () => ({ok: true as const}),
              shutdown: () => candidate.shutdown(),
              run: async (request, signal) => {
                runs++;
                return candidate.run(request, signal);
              },
            } satisfies CommandRuntime;
          },
        }
      : {}),
    subscriptions: {
      nativeRuntimeTools: false,
      openURL: async () => {},
      resolveCommand: r => ({
        command: process.execPath,
        prefix: [resolve('tests/subscription-fixtures/runtime.ts'), r, 'exec-command'],
      }),
    },
  });
  cleanup.push(async () => {
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
  });
  const client = app.createFutrynClient(ws);
  if (codex) {
    const challenge = await client.beginProviderAuth('chatgpt', 'subscription-device');
    await client.connectAccount({
      providerId: 'chatgpt',
      alias: 'fixture',
      credential: {kind: 'keyring', key: crypto.randomUUID()},
      authChallengeId: challenge.id,
    });
  } else {
    server.set({toolCall: {name: 'exec_command', args: JSON.stringify({cmd: 'rg -n marker source.ts'})}});
    app.registry.add(server.provider('chat', {id: 'commands', auth: 'none'}));
    await app.accounts.add('commands', 'fixture', {kind: 'none'});
    await client.discoverModels();
    client.selectModel('fixture-model');
  }
  client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({client, cols: 100, rows: 30});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  return {
    app,
    client,
    tui,
    server,
    ws,
    runtime,
    runs: () => runs,
    factories: () => factories,
    shutdowns: () => shutdowns,
  };
}
async function pending(c: Awaited<ReturnType<typeof make>>) {
  const end = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < end) await Bun.sleep(5);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  c.tui.advanceStartupGate();
}
for (const codex of [false, true])
  test(`${codex ? 'Codex dynamic bridge' : 'direct API'} fixture: exact approval, command pairing, sanitized output and persisted resume`, async () => {
    const c = await make(codex);
    const turn = c.tui.submitPrompt('Locate marker with rg');
    await pending(c);
    expect(c.runs()).toBe(0);
    const prompt = c.client.listPendingPermissions()[0]!;
    expect(prompt.capability).toBe('process.execute');
    expect(prompt.target).toBe('rg -n marker source.ts');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('Command: rg -n marker source.ts');
    await c.tui.handleKey('1');
    await turn;
    expect(c.runs()).toBe(1);
    const answer = c.tui.getTranscript().at(-1)!;
    expect(answer.toolResults?.[0]).toMatchObject({name: 'exec_command', status: 'ok', exitCode: 0});
    expect(answer.toolResults?.[0]?.callId).toBe(answer.toolCalls?.[0]?.id);
    expect(answer.toolResults?.[0]?.content).not.toContain('\x1b');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('⏺ Bash(rg -n marker source.ts)');
    const id = c.client.activeSession()!.id;
    const saved = c.app.conversations.get(id)!;
    expect(saved.messages.find(m => m.role === 'tool')?.content).toStartWith('Exit code: 0\nWall time:');
    const resumed = c.app.createFutrynClient(c.ws);
    resumed.resumeSession(id);
    const transcript = messagesToTranscript(resumed.activeSession()!.messages, {idPrefix: 'resume'});
    const item = transcript.at(-1)!;
    expect(commandSummary(item.toolCalls![0]!, item.toolResults![0], {live: false}).state).toBe('ran');
    if (!codex) {
      const resultRequest = c.server.requests.find(r => r.body?.messages?.some((m: any) => m.role === 'tool'));
      expect(resultRequest?.body.messages.find((m: any) => m.role === 'tool')?.tool_call_id).toBe(
        answer.toolCalls![0]!.id,
      );
    }
  });

test('production FUTRYN keeps exec unadvertised and never executes an unsolicited command', async () => {
  const c = await make(false, false);
  await c.tui.submitPrompt('Run a command');
  expect(c.runs()).toBe(0);
  expect(c.client.listPendingPermissions()).toHaveLength(0);
  for (const r of c.server.requests) expect(JSON.stringify(r.body?.tools ?? [])).not.toContain('exec_command');
  expect(c.tui.getTranscript().at(-1)?.toolResults ?? []).toHaveLength(0);
});

test.skipIf(process.platform !== 'darwin')(
  'research-only FUTRYN TUI acceptance: approved rg executes in actual Seatbelt without project mutation',
  async () => {
    const c = await make(false, true, true);
    const before = readFileSync(join(c.ws, 'source.ts'), 'utf8');
    const turn = c.tui.submitPrompt('Locate marker with rg');
    await pending(c);
    expect(c.runs()).toBe(0);
    await c.tui.handleKey('1');
    await turn;
    expect(c.runs()).toBe(1);
    expect(c.tui.getTranscript().at(-1)?.toolResults?.[0]).toMatchObject({exitCode: 0, status: 'ok'});
    expect(c.tui.getTranscript().at(-1)?.toolResults?.[0]?.content).toContain('1:export const marker = 1;');
    expect(readFileSync(join(c.ws, 'source.ts'), 'utf8')).toBe(before);
    expect(readdirSync(c.ws)).toEqual(['source.ts']);
  },
);

test('Escape at execution approval creates no process', async () => {
  const c = await make();
  const turn = c.tui.submitPrompt('Run rg');
  await pending(c);
  await c.tui.handleKey('Escape');
  await turn;
  expect(c.runs()).toBe(0);
  expect(c.tui.getTranscript().at(-1)?.toolResults?.[0]?.status).toBe('denied');
});

test('execution approval cache includes policy identity and revocation clears both grant stores', async () => {
  const c = await make();
  const input = {
    capability: 'process.execute' as const,
    action: 'Run here',
    target: 'printf ok',
    reason: 'fixture',
    scopeKey: 'policy-one',
  };
  const first = c.client.requestPermission(input);
  const req = c.client.listPendingPermissions()[0]!;
  c.client.resolvePermission(req.approvalId, req.scopeHash, 'session');
  expect(await first).toBe('session');
  expect(await c.client.requestPermission(input)).toBe('session');
  const controller = new AbortController();
  const changed = c.client.requestPermission({...input, scopeKey: 'policy-two'}, controller.signal);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  controller.abort();
  expect(await changed).toBe('deny');
  c.client.revokeToolGrants();
  const again = c.client.requestPermission(input, controller.signal);
  expect(await again).toBe('deny');
  const last = c.client.enqueuePermissionRequest(input);
  expect(last.status).toBe('pending');
  const expired = c.client.enqueuePermissionRequest({...input, scopeKey: 'expired', ttlMs: -1});
  expect(() => c.client.resolvePermission(expired.approvalId, expired.scopeHash, 'once')).toThrow();
  expect(c.runs()).toBe(0);
});

test('command status never calls an unstarted proposal running or invents success on resume', () => {
  const call = {id: 'c', name: 'exec_command', input: {cmd: 'printf ok'}};
  expect(commandSummary(call, undefined, {live: true, awaiting: true}).state).toBe('awaiting');
  expect(commandSummary(call, undefined, {live: true}).state).toBe('pending');
  expect(commandSummary(call, undefined, {live: false}).state).toBe('stopped');
  const outcome: Partial<CommandOutcome> = {exitCode: 7};
  expect(
    commandSummary(
      call,
      {
        callId: 'c',
        name: 'exec_command',
        status: 'ok',
        content: 'Exit code: 7\nWall time: 0.01 s\nOutput:\nerr',
        exitCode: outcome.exitCode,
      },
      {live: false},
    ),
  ).toMatchObject({state: 'failed', note: 'exit 7'});
  const item = messagesToTranscript(
    [
      {role: 'assistant', content: '', toolCalls: [call]},
      {
        role: 'tool',
        toolName: 'exec_command',
        toolCallId: 'c',
        content: 'Process ended by signal SIGKILL.\nWall time: 0.01 s\nOutput:\nExit code: 0',
      },
      {role: 'assistant', content: 'done'},
    ],
    {idPrefix: 'signal'},
  ).at(-1)!;
  expect(commandSummary(call, item.toolResults![0], {live: false}).state).toBe('failed');
});

test('CLI reuses its client runtime and shuts down owned runtimes once', async () => {
  const c = await make();
  for (let i = 0; i < 2; i++) {
    if (i) c.client.createSession();
    const turn = c.tui.submitPrompt('Locate marker');
    await pending(c);
    await c.tui.handleKey('1');
    await turn;
  }
  expect(c.factories()).toBe(1);
  expect(c.runs()).toBe(2);
  await Promise.all([c.app.shutdownCommands(), c.app.shutdownCommands()]);
  expect(c.shutdowns()).toBe(1);
});

test('!command shell mode uses the same dispatcher approval and sandbox; denial runs nothing and nothing reaches the model', async () => {
  const c = await make();
  const before = c.server.requests.length;
  const denied = c.tui.submitPrompt('!rg -n marker source.ts');
  await pending(c);
  expect(c.client.listPendingPermissions()[0]!.target).toBe('rg -n marker source.ts');
  await c.tui.handleKey('Escape');
  await denied;
  expect(c.runs()).toBe(0);
  const ran = c.tui.submitPrompt('!rg -n marker source.ts');
  await pending(c);
  await c.tui.handleKey('1');
  await ran;
  expect(c.runs()).toBe(1);
  const item = c.tui.getTranscript().at(-1)!;
  expect(item.toolResults?.[0]).toMatchObject({name: 'exec_command', status: 'ok', exitCode: 0});
  expect(c.tui.computeFrameSnapshot().plainText).toContain('⏺ Bash(rg -n marker source.ts)');
  expect(c.tui.getStatusBanner()).toContain('exit 0');
  expect(c.server.requests.length).toBe(before);
});
