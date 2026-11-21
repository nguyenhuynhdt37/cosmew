import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolDispatcher, DEFAULT_SANDBOX_CONFIG} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {WorkspaceRoot} from '@cosmew/workspace';
import type {CommandOutcome, CommandRuntime, CommandSandbox} from '@cosmew/contracts';
import {runRead} from '../../packages/tools/src/builtin/read';
import {runGlob} from '../../packages/tools/src/builtin/search';
import {execDescriptor} from '../../packages/tools/src/exec/command';
import {LIMITS} from '../../packages/tools/src/limits';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-coding-correctness-')));
  roots.push(base);
  const root = join(base, 'workspace');
  mkdirSync(root);
  return {base, root, workspace: new WorkspaceRoot(root)};
}

for (const character of ['x', '界']) {
  test(`Read byte pagination preserves complete ${character} lines and useful forward offsets`, () => {
    const {root, workspace} = fixture();
    const lines = Array.from({length: 100}, (_, i) => `${i + 1}:${character.repeat(1990)}`);
    writeFileSync(join(root, 'large.txt'), lines.join('\n'));
    const observed: string[] = [];
    let offset = 1;
    for (let page = 0; page < 20; page++) {
      const result = runRead(workspace, workspace.resolve('large.txt'), {path: 'large.txt', offset});
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      const body = result.content.split('\n\n[')[0]!;
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(LIMITS.readOutputBytes);
      expect(body).not.toContain('�');
      observed.push(...body.split('\n').map(line => line.slice(line.indexOf('\t') + 1)));
      if (!result.truncated) break;
      const next = Number(result.content.match(/continue with offset (\d+)/)?.[1]);
      expect(next).toBeGreaterThan(offset);
      offset = next;
    }
    expect(observed).toEqual(lines);
  });
}

test('Read preserves the long-line truncation marker at byte boundaries', () => {
  const {root, workspace} = fixture();
  writeFileSync(join(root, 'long.txt'), Array.from({length: 100}, () => '界'.repeat(3000)).join('\n'));
  const result = runRead(workspace, workspace.resolve('long.txt'), {path: 'long.txt'});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  for (const line of result.content.split('\n\n[')[0]!.split('\n'))
    expect(line.endsWith('… [line truncated]')).toBe(true);
});

test('Read does not split a surrogate pair at the explicit long-line cutoff', () => {
  const {root, workspace} = fixture();
  writeFileSync(join(root, 'emoji.txt'), 'x'.repeat(LIMITS.lineChars - 1) + '😀tail');
  const result = runRead(workspace, workspace.resolve('emoji.txt'), {path: 'emoji.txt'});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(result.content).toBe('1\t' + 'x'.repeat(LIMITS.lineChars - 1) + '… [line truncated]');
  expect(result.content).not.toMatch(/[\uD800-\uDFFF]/);
});

test('Glob stats granted absolute paths before newest-first top-100 selection', () => {
  const {base, workspace} = fixture();
  const additional = join(base, 'additional');
  mkdirSync(additional);
  for (let i = 0; i < 120; i++) {
    const path = join(additional, `${String(i).padStart(3, '0')}.ts`);
    writeFileSync(path, 'fixture');
    utimesSync(path, 1000, 1000 + i);
  }
  const newest = join(additional, 'zzz-newest.ts');
  writeFileSync(newest, 'newest');
  utimesSync(newest, 9999, 9999);
  const result = runGlob(workspace, workspace.resolve(additional, [additional]), {path: additional, pattern: '*.ts'});
  expect(result.truncated).toBe(true);
  const shown = result.content.split('\n\n')[0]!.split('\n');
  expect(shown).toHaveLength(100);
  expect(shown[0]).toBe(newest);
  expect(shown[1]).toBe(join(additional, '119.ts'));
});

test('unhealthy sandbox allows owned host-session transport, while new sandbox launches fail closed', async () => {
  const {workspace} = fixture();
  let enabled = false;
  let session: {cwd: string; command: string; tty: boolean; sandbox: CommandSandbox} | undefined;
  let launches = 0;
  let prompts = 0;
  const id = crypto.randomUUID();
  const sent: string[] = [];
  const exited: CommandOutcome = {
    kind: 'exited',
    exitCode: 0,
    signal: null,
    output: 'done',
    omittedBytes: 0,
    durationMs: 1,
  };
  const runtime: CommandRuntime = {
    id: 'unhealthy-fixture',
    label: 'test double, no OS containment claim',
    availability: () => ({ok: false, reason: 'sandbox self-test unavailable'}),
    capabilities: () => ({
      network: true,
      tty: true,
      unsandboxed: true,
      modes: ['read-only', 'workspace-write', 'danger-full-access'],
      tools: [],
      shells: ['bash'],
    }),
    run: async request => {
      launches++;
      session = {cwd: request.cwd, command: request.command, tty: false, sandbox: request.sandbox!};
      return {...exited, kind: 'running', sessionId: id};
    },
    session: key => (key === id ? session : undefined),
    writeStdin: async (_key, chars, _yield, _signal, interrupt) => {
      sent.push(interrupt ?? chars);
      if (interrupt) session = undefined;
      return exited;
    },
  };
  const dispatcher = new ToolDispatcher({
    workspace,
    grants: new SessionGrants(),
    commands: runtime,
    redact: text => text,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, enabled}),
    approve: async () => {
      prompts++;
      return 'once';
    },
  });
  const invoke = (name: string, input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name, input});
  expect((await invoke('exec_command', {cmd: 'cat'})).sessionId).toBe(id);
  expect(session?.sandbox.unsandboxed).toBe(true);
  expect((await invoke('write_stdin', {session_id: id})).status).toBe('ok');
  expect(prompts).toBe(1);
  expect((await invoke('write_stdin', {session_id: id, chars: 'hello\n'})).status).toBe('ok');
  expect(prompts).toBe(2);
  enabled = true;
  expect((await invoke('exec_command', {cmd: 'echo blocked'})).code).toBe('SANDBOX_UNAVAILABLE');
  expect(launches).toBe(1);
  expect((await invoke('write_stdin', {session_id: id, chars: 'blocked\n'})).status).toBe('denied');
  expect((await invoke('write_stdin', {session_id: id, signal: 'SIGTERM'})).status).toBe('ok');
  expect(sent).toEqual(['', 'hello\n', 'SIGTERM']);
  expect((await invoke('write_stdin', {session_id: id})).code).toBe('SESSION_NOT_FOUND');
  expect((await invoke('write_stdin', {session_id: crypto.randomUUID()})).code).toBe('SESSION_NOT_FOUND');
});

test('shell schema accurately describes conditional sandbox protections and escape hatch', () => {
  expect(execDescriptor.description).toContain('disabled by default');
  expect(execDescriptor.description).toContain('autoAllowBashIfSandboxed');
  expect(execDescriptor.description).toContain('defaults to false');
  expect(execDescriptor.inputSchema.properties.dangerouslyDisableSandbox.description).toContain(
    'When the sandbox is enabled',
  );
  expect(execDescriptor.inputSchema.properties.login.description).not.toContain('trusted image');
});
