import {test, expect, afterEach} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerCommandRuntime} from '@futryn/tools';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, type ScriptedReply, type ScriptedView} from '../fixtures';
const containerTest = test.skipIf(process.env.FUTRYN_TEST_CONTAINER !== '1');
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
async function setup(protocol: 'chat' | 'anthropic', script: (v: ScriptedView) => ScriptedReply) {
  const home = mkdtempSync(join(tmpdir(), 'fyn-exec-home-')),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-exec-agent-')));
  clean.push(() => {
    rmSync(home, {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      scripts: {test: 'bun test', build: 'bun build entry.ts --outfile=/tmp/bundle.js', lint: 'bun lint.ts'},
    }),
  );
  writeFileSync(join(root, 'entry.ts'), 'export const answer = 42;\n');
  writeFileSync(
    join(root, 'entry.test.ts'),
    "import {test,expect} from 'bun:test'; import {answer} from './entry';test('answer',()=>expect(answer).toBe(42));\n",
  );
  writeFileSync(
    join(root, 'lint.ts'),
    "import {readFileSync} from 'node:fs';if(!readFileSync('entry.ts','utf8').trimEnd().endsWith(';'))process.exit(1);console.log('LINT_PASS');",
  );
  const server = fixtureServer();
  server.set({script});
  clean.push(() => server.server.stop(true));
  const app = startup(home, {
    vault: memoryVault(),
    commands: (workspaceRoot, stateDirectory) => new DockerCommandRuntime({workspaceRoot, stateDirectory}),
  });
  clean.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add(server.provider(protocol, {id: 'exec-fixture', auth: 'none'}));
  await app.accounts.add('exec-fixture', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  return {home, root, app, client, server};
}
async function sendApproved(c: Awaited<ReturnType<typeof setup>>) {
  const seen: string[] = [],
    events: any[] = [];
  let finished = false;
  const sending = (async () => {
    try {
      for await (const event of c.client.sendMessage('Run the requested checks through the sandbox.'))
        events.push(event);
    } finally {
      finished = true;
    }
  })();
  const deadline = Date.now() + 25000;
  while (!finished && Date.now() < deadline) {
    for (const p of c.client.listPendingPermissions())
      if (!seen.includes(p.approvalId)) {
        expect(p.capability).toBe('process.execute');
        seen.push(p.approvalId);
        c.client.resolvePermission(p.approvalId, p.scopeHash, 'once');
      }
    await Bun.sleep(10);
  }
  expect(finished).toBe(true);
  await sending;
  return {events, approvals: seen.length};
}
for (const protocol of ['chat', 'anthropic'] as const)
  containerTest(
    `${protocol}: model → current approval → actual test/build/lint → streamed results → model`,
    async () => {
      const c = await setup(protocol, v =>
        v.results.length
          ? {text: 'MODEL VERIFIED TEST_BUILD_LINT'}
          : {
              calls: [
                {
                  name: 'exec_command',
                  input: {
                    cmd: 'printf FIRST; sleep 0.2; printf SECOND >&2; bun run test && bun run build && bun run lint',
                    timeout_ms: 10000,
                    max_output_tokens: 2000,
                  },
                },
              ],
            },
      );
      const {events, approvals} = await sendApproved(c);
      expect(approvals).toBe(1);
      const final = events.find(e => e.type === 'toolResult')!.result;
      expect(final.exitCode).toBe(0);
      expect(final.content).toContain('LINT_PASS');
      expect(final.content).toContain('1 pass');
      expect(final.content).toContain('Descendant termination: terminated.');
      expect(events.some(e => e.type === 'toolOutputDelta' && e.stream === 'stdout')).toBe(true);
      expect(events.some(e => e.type === 'toolOutputDelta' && e.stream === 'stderr')).toBe(true);
      expect(events.findIndex(e => e.type === 'toolOutputDelta')).toBeLessThan(
        events.findIndex(e => e.type === 'toolResult'),
      );
      expect(
        events
          .filter(e => e.type === 'textDelta')
          .map(e => e.text)
          .join(''),
      ).toBe('MODEL VERIFIED TEST_BUILD_LINT');
      expect(existsSync(join(c.root, 'bundle.js'))).toBe(false);
      const stored = c.app.conversations.recover(c.client.activeSession()!.id);
      expect(stored.messages.filter(m => m.toolName === 'exec_command')).toHaveLength(1);
      expect(stored.turns.at(-1)!.state).toBe('completed');
    },
    35000,
  );
containerTest(
  'a model gets a real pipe session, separately approves input and receives the actual response',
  async () => {
    const c = await setup('chat', v => {
      const last = v.results.at(-1);
      if (!last)
        return {
          calls: [
            {
              name: 'exec_command',
              input: {cmd: 'echo READY; read value; echo "INPUT:$value"', timeout_ms: 8000, yield_time_ms: 100},
            },
          ],
        };
      if (last.name === 'exec_command') {
        const id = /Running session: ([a-f0-9-]{36})/.exec(last.content)?.[1];
        expect(id).toBeDefined();
        return {calls: [{name: 'write_stdin', input: {session_id: id, chars: 'hello\n', yield_time_ms: 1500}}]};
      }
      expect(last.content).toContain('INPUT:hello');
      return {text: 'INPUT_VERIFIED'};
    });
    // ADR 0034: stricter than Codex, non-empty input is approved separately (polls are not).
    const {events, approvals} = await sendApproved(c);
    expect(approvals).toBe(2);
    expect(events.filter(e => e.type === 'toolResult').map(e => e.result.name)).toEqual([
      'exec_command',
      'write_stdin',
    ]);
    expect(
      events
        .filter(e => e.type === 'textDelta')
        .map(e => e.text)
        .join(''),
    ).toBe('INPUT_VERIFIED');
  },
  35000,
);
containerTest(
  'closing a live command iterator cancels its namespace and persists the actual partial output/result',
  async () => {
    const c = await setup('chat', () => ({
      calls: [{name: 'exec_command', input: {cmd: 'printf OWNED_RUNNING; sleep 20', timeout_ms: 10000}}],
    }));
    let closed = false;
    const start = Date.now();
    const work = (async () => {
      for await (const event of c.client.sendMessage('Run until I cancel.'))
        if (event.type === 'toolOutputDelta' && event.text.includes('OWNED_RUNNING')) {
          closed = true;
          break;
        }
    })();
    const deadline = Date.now() + 12000;
    while (!c.client.listPendingPermissions().length && Date.now() < deadline) await Bun.sleep(10);
    const prompt = c.client.listPendingPermissions()[0]!;
    c.client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
    await work;
    expect(closed).toBe(true);
    expect(Date.now() - start).toBeLessThan(7000);
    const recovery = c.app.conversations.recover(c.client.activeSession()!.id);
    expect(recovery.turns.at(-1)!.state).toBe('cancelled');
    const result = recovery.turns.at(-1)!.events.find(e => e.data.type === 'tool.result')!.data;
    expect(result.type).toBe('tool.result');
    if (result.type === 'tool.result') {
      expect(result.result.code).toBe('CANCELLED');
      expect(result.result.content).toContain('OWNED_RUNNING');
      expect(result.result.content).toContain('Descendant termination: terminated.');
    }
  },
  30000,
);
containerTest(
  'ADR 0033 Q: a real failing test, an approved fix and a passing rerun, with steering accepted while the command runs',
  async () => {
    const c = await setup('chat', v => {
      const last = v.results.at(-1);
      if (!last) return {calls: [{name: 'exec_command', input: {cmd: 'bun test', timeout_ms: 20000}}]};
      if (last.name === 'exec_command' && !/Exit code: 0/.test(last.content))
        return {
          calls: [
            {
              name: 'apply_patch',
              input: {
                patch:
                  '*** Begin Patch\n*** Update File: entry.ts\n@@\n-export const answer = 41;\n+export const answer = 42;\n*** End Patch',
              },
            },
          ],
        };
      if (last.name === 'apply_patch')
        return {calls: [{name: 'exec_command', input: {cmd: 'bun test', timeout_ms: 20000}}]};
      return {text: 'FIXED_AND_VERIFIED'};
    });
    writeFileSync(join(c.root, 'entry.ts'), 'export const answer = 41;\n');
    const events: any[] = [];
    let finished = false;
    let steer: unknown;
    const approved: string[] = [];
    const sending = (async () => {
      try {
        for await (const event of c.client.sendMessage('Make the tests pass.')) {
          events.push(event);
          if (event.type === 'toolOutputDelta' && steer === undefined)
            steer = c.client.submitWhileBusy('Keep the export name answer.');
        }
      } finally {
        finished = true;
      }
    })();
    const deadline = Date.now() + 60000;
    while (!finished && Date.now() < deadline) {
      for (const p of c.client.listPendingPermissions())
        if (!approved.includes(p.approvalId)) {
          approved.push(p.approvalId);
          c.client.resolvePermission(p.approvalId, p.scopeHash, 'once');
        }
      await Bun.sleep(10);
    }
    await sending;
    const results = events.filter(e => e.type === 'toolResult').map(e => e.result);
    expect(results.map(r => r.name)).toEqual(['exec_command', 'apply_patch', 'exec_command']);
    expect(results[0].exitCode).not.toBe(0);
    expect(results[2].exitCode).toBe(0);
    expect(
      events
        .filter(e => e.type === 'textDelta')
        .map(e => e.text)
        .join(''),
    ).toBe('FIXED_AND_VERIFIED');
    expect(steer).toMatchObject({disposition: 'steered'});
    expect(events.some(e => e.type === 'steered')).toBe(true);
    expect(JSON.stringify(c.server.requests.filter(r => r.body).at(-1)!.body)).toContain(
      'Keep the export name answer.',
    );
    const stored = c.app.conversations.recover(c.client.activeSession()!.id);
    expect(stored.turns.at(-1)!.state).toBe('completed');
    expect(stored.pendingInput).toBeUndefined();
  },
  90000,
);
containerTest(
  'Task 02 F 40-46: the model writes source with Bash, sees the real failing test, fixes it with Bash, reruns and reports verified results',
  async () => {
    // Fixture model only: this proves Futryn's loop/runtime wiring, not real-model capability.
    const c = await setup('chat', v => {
      const last = v.results.at(-1);
      if (!last)
        return {
          calls: [
            {
              name: 'exec_command',
              input: {
                cmd: "mkdir -p src && printf 'export const add = (a: number, b: number) => a - b;\\n' > src/math.ts && printf \"import {test,expect} from 'bun:test'; import {add} from './math'; test('add',()=>expect(add(2,3)).toBe(5));\\n\" > src/math.test.ts && git --version >/dev/null 2>&1; echo CREATED",
              },
            },
          ],
        };
      if (last.name === 'exec_command' && last.content.includes('CREATED'))
        return {calls: [{name: 'exec_command', input: {cmd: 'bun test src'}}]};
      if (last.name === 'exec_command' && /Exit code: [1-9]/.test(last.content))
        return {
          calls: [{name: 'exec_command', input: {cmd: "sed -i 's/a - b/a + b/' src/math.ts && cat src/math.ts"}}],
        };
      if (last.name === 'exec_command' && last.content.includes('a + b'))
        return {calls: [{name: 'exec_command', input: {cmd: 'bun test src'}}]};
      return {
        text:
          /Exit code: 0/.test(last.content) && last.content.includes('1 pass')
            ? 'VERIFIED: bun test src passes (1 pass).'
            : 'NOT VERIFIED',
      };
    });
    const {events, approvals} = await sendApproved(c);
    const results = events.filter(e => e.type === 'toolResult').map(e => e.result);
    expect(results.map(r => r.exitCode)).toEqual([0, 1, 0, 0]);
    expect(results[1].content).toContain('fail');
    expect(approvals).toBe(4);
    expect(
      events
        .filter(e => e.type === 'textDelta')
        .map(e => e.text)
        .join(''),
    ).toBe('VERIFIED: bun test src passes (1 pass).');
    // The fix is in the real project, visible to the host.
    expect(readFileSync(join(c.root, 'src/math.ts'), 'utf8')).toContain('a + b');
    const stored = c.app.conversations.recover(c.client.activeSession()!.id);
    expect(stored.turns.at(-1)!.state).toBe('completed');
    expect(stored.messages.filter(m => m.toolName === 'exec_command')).toHaveLength(4);
  },
  120000,
);
