import {afterEach, expect, test} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ToolDispatcher, DEFAULT_SANDBOX_CONFIG, NativeCommandRuntime} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {WorkspaceRoot} from '@cosmew/workspace';
import type {ApprovalRequest, ToolDispatcherOptions} from '../../packages/tools/src/context';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(extra: Partial<ToolDispatcherOptions> = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cosmew-outside-approval-')));
  cleanup.push(() => rmSync(base, {recursive: true, force: true}));
  const project = join(base, 'project'),
    outside = join(base, 'outside'),
    state = join(base, 'state');
  for (const path of [project, outside, state]) mkdirSync(path);
  writeFileSync(join(outside, 'a.txt'), 'OUTSIDE_CONTENT\n');
  const approvals: ApprovalRequest[] = [];
  const grants = new SessionGrants();
  const options: ToolDispatcherOptions = {
    workspace: new WorkspaceRoot(project),
    stateDirectory: state,
    grants,
    redact: text => text,
    sandbox: () => ({
      ...DEFAULT_SANDBOX_CONFIG,
      enabled: false,
      readOnly: false,
      autoAllowBash: false,
      allowUnsandboxed: true,
    }),
    approve: async request => {
      approvals.push(request);
      return 'once';
    },
    ...extra,
  };
  const dispatcher = new ToolDispatcher(options);
  const invoke = (name: string, input: unknown) => dispatcher.invoke({id: crypto.randomUUID(), name, input});
  return {base, project, outside, state, approvals, grants, invoke, options, dispatcher};
}

test('external reads ask instead of hard denial, then edit/write/apply_patch use the same approval path', async () => {
  const f = fixture();
  const path = join(f.outside, 'a.txt');
  expect((await f.invoke('read', {path})).content).toContain('OUTSIDE_CONTENT');
  expect(f.approvals.at(-1)?.reason).toBe('outside-working-directories');
  expect((await f.invoke('edit', {path, old_string: 'OUTSIDE_CONTENT', new_string: 'EDITED'})).status).toBe('ok');
  expect(f.approvals.at(-1)?.reason).toBe('outside-writable-roots');
  expect(readFileSync(path, 'utf8')).toBe('EDITED\n');
  const created = join(f.outside, 'nested', 'new.txt');
  expect((await f.invoke('write', {path: created, content: 'NEW'})).status).toBe('ok');
  expect(readFileSync(created, 'utf8')).toBe('NEW');
  const patchPath = join(f.outside, 'patch.txt');
  expect(
    (await f.invoke('apply_patch', {patch: `*** Begin Patch\n*** Add File: ${patchPath}\n+PATCHED\n*** End Patch`}))
      .status,
  ).toBe('ok');
  expect(readFileSync(patchPath, 'utf8')).toContain('PATCHED');
});

for (const ripgrep of [null, undefined])
  test(`external Glob/Grep ask once for the selected directory and filter protected hits (${ripgrep === null ? 'builtin' : 'rg'})`, async () => {
    const f = fixture({ripgrep});
    mkdirSync(join(f.outside, '.git'));
    writeFileSync(join(f.outside, '.git', 'secret'), 'HIDDEN_GIT');
    writeFileSync(join(f.outside, '.env'), 'HIDDEN_SECRET');
    const sibling = join(f.base, 'sibling');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'escaped.txt'), 'HIDDEN_SYMLINK_ESCAPE');
    symlinkSync(sibling, join(f.outside, 'sibling-link'));
    expect((await f.invoke('glob', {path: f.outside, pattern: '**/*'})).content).toContain('a.txt');
    const result = await f.invoke('grep', {path: f.outside, pattern: 'OUTSIDE|HIDDEN'});
    expect(result.status).toBe('ok');
    expect(result.content).toContain('OUTSIDE_CONTENT');
    expect(result.content).not.toContain('HIDDEN_GIT');
    expect(result.content).not.toContain('HIDDEN_SECRET');
    expect(result.content).not.toContain('HIDDEN_SYMLINK_ESCAPE');
    expect(f.approvals).toHaveLength(2);
  });

test('outside refusal is a user decision and makes no file changes', async () => {
  const f = fixture({approve: async () => 'deny'});
  expect((await f.invoke('read', {path: join(f.outside, 'a.txt')})).status).toBe('denied');
  const target = join(f.outside, 'refused.txt');
  expect((await f.invoke('write', {path: target, content: 'NO'})).status).toBe('denied');
  expect(existsSync(target)).toBe(false);
});

test('outside reads do not bypass deny rules, state or Git protections', async () => {
  const f = fixture({readPolicy: () => 'deny'});
  expect((await f.invoke('read', {path: join(f.outside, 'a.txt')})).status).toBe('denied');
  expect(f.approvals).toHaveLength(0);
  const g = fixture();
  mkdirSync(join(g.outside, '.git'));
  for (const target of [
    join(g.outside, '.git', 'config'),
    join(g.state, 'evil.json'),
    join(g.outside, '.cosmew', 'settings.json'),
  ]) {
    expect((await g.invoke('write', {path: target, content: 'NO'})).status).toBe('denied');
    expect(existsSync(target)).toBe(false);
  }
  expect(g.approvals).toHaveLength(0);
});

test('outside permission cannot turn a read-only profile into a writer', async () => {
  const f = fixture({sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, enabled: false, readOnly: true})});
  const target = join(f.outside, 'refused.txt');
  expect((await f.invoke('write', {path: target, content: 'NO'})).status).toBe('denied');
  expect(f.approvals).toHaveLength(0);
  expect(existsSync(target)).toBe(false);
});

test('symlink retarget and revocation after an outside approval cannot change the approved target', async () => {
  const f = fixture();
  const path = join(f.outside, 'a.txt');
  writeFileSync(join(f.outside, 'other.txt'), 'OTHER');
  const g = fixture({
    approve: async () => {
      rmSync(path);
      symlinkSync(join(f.outside, 'other.txt'), path);
      return 'once';
    },
  });
  expect((await g.invoke('read', {path})).status).toBe('denied');
  const h = fixture();
  h.options.approve = async () => {
    h.grants.clear();
    return 'once';
  };
  expect((await h.invoke('read', {path: join(h.outside, 'a.txt')})).status).toBe('denied');
});

test('an approved unsandboxed command can start in an external cwd and write there with the real runtime', async () => {
  const f = fixture();
  const runtime = new NativeCommandRuntime({workspaceRoot: f.project, stateDirectory: f.state});
  cleanup.push(() => runtime.shutdown());
  const dispatcher = new ToolDispatcher({...f.options, commands: runtime});
  const result = await dispatcher.invoke({
    id: crypto.randomUUID(),
    name: 'exec_command',
    input: {cmd: 'printf APPROVED > native.txt', workdir: f.outside, yield_time_ms: 1000},
  });
  expect(result.status).toBe('ok');
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(f.outside, 'native.txt'), 'utf8')).toBe('APPROVED');
  expect(f.approvals).toHaveLength(1);
});

test('external read session grants stay on the exact target; cancellation cannot grant access', async () => {
  const f = fixture();
  f.options.approve = async request => {
    f.approvals.push(request);
    return 'session';
  };
  const path = join(f.outside, 'a.txt');
  expect((await f.invoke('read', {path})).status).toBe('ok');
  expect((await f.invoke('read', {path})).status).toBe('ok');
  expect(f.approvals).toHaveLength(1);
  writeFileSync(join(f.outside, 'b.txt'), 'SECOND');
  expect((await f.invoke('read', {path: join(f.outside, 'b.txt')})).status).toBe('ok');
  expect(f.approvals).toHaveLength(2);
  const controller = new AbortController();
  f.options.approve = async () => {
    controller.abort();
    return 'session';
  };
  const target = join(f.outside, 'cancelled.txt');
  await expect(
    f.dispatcher.invoke(
      {id: crypto.randomUUID(), name: 'write', input: {path: target, content: 'NO'}},
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  expect(f.grants.list().filter(g => g.capability === 'fs.write')).toHaveLength(0);
});

test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
  'file approval does not enlarge the actual shell sandbox write roots',
  async () => {
    const f = fixture({
      sandbox: () => ({
        ...DEFAULT_SANDBOX_CONFIG,
        enabled: true,
        readOnly: false,
        autoAllowBash: false,
        allowUnsandboxed: false,
      }),
    });
    const file = join(f.outside, 'file-tool.txt');
    expect((await f.invoke('write', {path: file, content: 'APPROVED_FILE'})).status).toBe('ok');
    const runtime = new NativeCommandRuntime({workspaceRoot: f.project, stateDirectory: f.state});
    cleanup.push(() => runtime.shutdown());
    const dispatcher = new ToolDispatcher({...f.options, commands: runtime});
    const result = await dispatcher.invoke({
      id: crypto.randomUUID(),
      name: 'exec_command',
      input: {cmd: 'printf NO > shell.txt', workdir: f.outside, yield_time_ms: 1000},
    });
    expect(result).toMatchObject({status: 'error', exitCode: 1});
    expect(result.content).toContain('Operation not permitted');
    expect(existsSync(join(f.outside, 'shell.txt'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('APPROVED_FILE');
  },
);
