import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolDispatcher, DEFAULT_SANDBOX_CONFIG, type ApprovalDecision, type ApprovalRequest} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {SessionGrants} from '@cosmew/security';
import {replaceText} from '../../packages/tools/src/handlers/file-edit';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});

function fixture(approve: (r: ApprovalRequest) => Promise<ApprovalDecision> = async () => 'once') {
  const root = mkdtempSync(join(tmpdir(), 'futryn-edit-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const requests: ApprovalRequest[] = [];
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    stateDirectory: join(realpathSync.native(root), 'state'),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: s => s,
    approve: async r => {
      requests.push(r);
      return approve(r);
    },
  });
  const call = (name: string, input: Record<string, unknown>) => tools.invoke({id: crypto.randomUUID(), name, input});
  return {root, tools, requests, call, file: (p: string) => readFileSync(join(root, p), 'utf8')};
}

test('edit and write are offered as write tools beside apply_patch', () => {
  const {tools} = fixture();
  const byName = new Map(tools.descriptors().map(d => [d.name, d]));
  expect(byName.get('edit')?.capability).toBe('fs.write');
  expect(byName.get('write')?.capability).toBe('fs.write');
  expect(byName.get('edit')?.parallel).toBeUndefined();
});

test('edit replaces one exact match after approval showing the diff, and keeps $ literal', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  await f.call('read', {path: 'a.ts'});
  const result = await f.call('edit', {path: 'a.ts', old_string: 'const b = 2;', new_string: "const b = '$&$1';"});
  expect(result.status).toBe('ok');
  expect(f.file('a.ts')).toBe("const a = 1;\nconst b = '$&$1';\n");
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.tool).toBe('edit');
  expect(f.requests[0]!.capability).toBe('fs.write');
  expect(f.requests[0]!.diffPreview).toContain("+const b = '$&$1';");
  expect(JSON.parse(result.content).changes[0]).toMatchObject({path: 'a.ts', action: 'update'});
});

test('edit refuses blind, stale, ambiguous, missing and no-op edits without asking or writing', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'a.ts'), 'x\nx\n');
  expect((await f.call('edit', {path: 'a.ts', old_string: 'x', new_string: 'y'})).code).toBe('READ_REQUIRED');
  await f.call('read', {path: 'a.ts'});
  expect((await f.call('edit', {path: 'a.ts', old_string: 'x', new_string: 'y'})).code).toBe('EDIT_AMBIGUOUS');
  expect((await f.call('edit', {path: 'a.ts', old_string: 'zz', new_string: 'y'})).code).toBe('EDIT_NO_MATCH');
  expect((await f.call('edit', {path: 'a.ts', old_string: 'x', new_string: 'x'})).code).toBe('EDIT_NO_CHANGE');
  expect((await f.call('edit', {path: 'new.ts', old_string: 'x', new_string: 'y'})).code).toBe('NOT_FOUND');
  writeFileSync(join(f.root, 'a.ts'), 'x\nchanged elsewhere\n');
  expect((await f.call('edit', {path: 'a.ts', old_string: 'changed', new_string: 'y'})).code).toBe(
    'FILE_CHANGED_SINCE_READ',
  );
  expect(f.requests).toHaveLength(0);
  expect(f.file('a.ts')).toBe('x\nchanged elsewhere\n');
});

test('replace_all, consecutive edits without rereading, and CRLF files keep their line endings', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'a.txt'), 'one\r\ntwo\r\none\r\n');
  await f.call('read', {path: 'a.txt'});
  expect((await f.call('edit', {path: 'a.txt', old_string: 'one', new_string: '1', replace_all: true})).status).toBe(
    'ok',
  );
  // The written version counts as seen, so a follow-up edit needs no reread.
  expect((await f.call('edit', {path: 'a.txt', old_string: '1\ntwo', new_string: '1\n2'})).status).toBe('ok');
  expect(f.file('a.txt')).toBe('1\r\n2\r\n1\r\n');
});

test('write creates files and directories, but overwrites only the version the model read', async () => {
  const f = fixture();
  expect((await f.call('write', {path: 'src/new/file.ts', content: 'export {};\n'})).status).toBe('ok');
  expect(f.file('src/new/file.ts')).toBe('export {};\n');
  writeFileSync(join(f.root, 'old.ts'), 'before\n');
  expect((await f.call('write', {path: 'old.ts', content: 'after\n'})).code).toBe('READ_REQUIRED');
  await f.call('read', {path: 'old.ts'});
  expect((await f.call('write', {path: 'old.ts', content: 'after\n'})).status).toBe('ok');
  expect(f.file('old.ts')).toBe('after\n');
});

test('protected paths are denied and a user denial changes nothing', async () => {
  const f = fixture(async () => 'deny');
  writeFileSync(join(f.root, '.env'), 'TOKEN=1\n');
  const env = await f.call('write', {path: '.env', content: 'TOKEN=2\n'});
  expect(env.status).toBe('denied');
  const git = await f.call('write', {path: '.git/config', content: '[core]\n'});
  expect(git.status).toBe('denied');
  const state = await f.call('write', {path: 'state/x.json', content: '{}'});
  expect(state.status).toBe('denied');
  const outside = await f.call('write', {path: '../escape.txt', content: 'x'});
  expect(outside.status).not.toBe('ok');
  expect(f.requests).toHaveLength(1);
  const denied = await f.call('write', {path: 'ok.ts', content: 'x'});
  expect(denied.status).toBe('denied');
  expect(f.requests).toHaveLength(2);
  expect(existsSync(join(f.root, 'ok.ts'))).toBe(false);
  expect(readFileSync(join(f.root, '.env'), 'utf8')).toBe('TOKEN=1\n');
});

test('a file changed between approval and apply is not overwritten', async () => {
  let root = '';
  const f = fixture(async () => {
    writeFileSync(join(root, 'a.ts'), 'raced\n');
    return 'once';
  });
  root = f.root;
  writeFileSync(join(f.root, 'a.ts'), 'original\n');
  await f.call('read', {path: 'a.ts'});
  const result = await f.call('edit', {path: 'a.ts', old_string: 'original', new_string: 'edited'});
  expect(result.status).toBe('error');
  expect(f.file('a.ts')).toBe('raced\n');
});

test('replaceText is pure string replacement', () => {
  expect(replaceText('a.b.a', {old_string: '.', new_string: '$', replace_all: true})).toBe('a$b$a');
  expect(() => replaceText('abc', {old_string: 'x', new_string: 'y'})).toThrow();
});
