import {afterEach, expect, test} from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
  linkSync,
  mkdirSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ToolDispatcher, DEFAULT_SANDBOX_CONFIG, type ApprovalRequest, type ApprovalDecision} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {SessionGrants} from '@cosmew/security';
import {parsePatch, updateFile} from '../../packages/tools/src/patch/parser';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
const patch = (...lines: string[]) => '*** Begin Patch\n' + lines.join('\n') + '\n*** End Patch';
function fixture(approve: (r: ApprovalRequest) => Promise<ApprovalDecision> = async () => 'once') {
  const root = mkdtempSync(join(tmpdir(), 'hannes-patch-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const grants = new SessionGrants(),
    requests: ApprovalRequest[] = [];
  const tools = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    stateDirectory: join(realpathSync.native(root), 'state'),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: s => s,
    approve: async r => {
      requests.push(r);
      return approve(r);
    },
  });
  return {
    root,
    tools,
    grants,
    requests,
    run: (text: string, signal?: AbortSignal) =>
      tools.invoke({id: crypto.randomUUID(), name: 'apply_patch', input: {patch: text}}, signal),
  };
}
test('parser handles contextual multi-hunks, EOF, whitespace matching and rejects malformed patches', () => {
  const parsed = parsePatch(
    patch('*** Update File: a', '@@ function f()', '-old', '+new', '@@', ' tail', '+last', '*** End of File'),
  );
  expect(parsed).toHaveLength(1);
  const update = parsed[0]!;
  if (update.kind !== 'update') throw new Error();
  expect(updateFile('function f()\r\nold\r\ntail\r\n', update.chunks)).toBe('function f()\r\nnew\r\ntail\r\nlast\r\n');
  expect(() => parsePatch('bad')).toThrow();
  expect(() => parsePatch(patch('*** Update File: a'))).toThrow();
});
test('Add Update Delete Move and multi-file patches apply only after showing the verified diff', async () => {
  const f = fixture(async request => {
    expect(request.capability).toBe('fs.write');
    expect(request.diffPreview).toContain('---');
    expect(existsSync(join(f.root, 'nested/new'))).toBe(false);
    return 'once';
  });
  writeFileSync(join(f.root, 'old'), 'old\n');
  writeFileSync(join(f.root, 'remove'), 'remove\n');
  const result = await f.run(
    patch(
      '*** Add File: nested/new',
      '+added',
      '*** Update File: old',
      '*** Move to: moved',
      '@@',
      '-old',
      '+new',
      '*** Delete File: remove',
    ),
  );
  expect(result.status).toBe('ok');
  expect(readFileSync(join(f.root, 'nested/new'), 'utf8')).toBe('added\n');
  expect(readFileSync(join(f.root, 'moved'), 'utf8')).toBe('new\n');
  expect(existsSync(join(f.root, 'old'))).toBe(false);
  expect(existsSync(join(f.root, 'remove'))).toBe(false);
  expect(f.requests).toHaveLength(1);
  expect(result.content).toContain('moved');
});
test('denial, invalid hunks and stale content make no patch writes', async () => {
  const f = fixture(async () => 'deny');
  writeFileSync(join(f.root, 'file'), 'old\n');
  expect(await f.run(patch('*** Update File: file', '@@', '-old', '+new'))).toMatchObject({status: 'denied'});
  expect(readFileSync(join(f.root, 'file'), 'utf8')).toBe('old\n');
  expect((await f.run(patch('*** Update File: file', '@@', '-missing', '+new'))).status).toBe('error');
  expect(f.requests).toHaveLength(1);
  const g = fixture(async () => {
    writeFileSync(join(g.root, 'file'), 'external\n');
    return 'once';
  });
  writeFileSync(join(g.root, 'file'), 'old\n');
  expect(await g.run(patch('*** Update File: file', '@@', '-old', '+new'))).toMatchObject({
    status: 'error',
    code: 'STALE_CONTENT',
  });
  expect(readFileSync(join(g.root, 'file'), 'utf8')).toBe('external\n');
});
test('protected paths, symlink parents and hardlinks are denied without prompting', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'state'));
  mkdirSync(join(f.root, '.git'));
  writeFileSync(join(f.root, 'source'), 'original');
  const outside = mkdtempSync(join(tmpdir(), 'hannes-patch-out-'));
  cleanup.push(() => rmSync(outside, {recursive: true, force: true}));
  writeFileSync(join(outside, 'target'), 'outside');
  symlinkSync(outside, join(f.root, 'link'));
  linkSync(join(outside, 'target'), join(f.root, 'hard'));
  for (const path of ['.git/config', 'state/file', '.env', 'link/new', 'hard']) {
    const cmd = path === 'hard' ? patch('*** Delete File: hard') : patch('*** Add File: ' + path, '+changed');
    const result = await f.run(cmd);
    expect(result.status).toBe('denied');
  }
  expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('outside');
  expect(f.requests).toHaveLength(0);
});

test('parent symlink swaps, occupied destinations and revoked grants fail closed', async () => {
  const f = fixture(async () => {
    rmSync(join(f.root, 'dir'), {recursive: true});
    symlinkSync(outside, join(f.root, 'dir'));
    return 'once';
  });
  const outside = mkdtempSync(join(tmpdir(), 'hannes-patch-race-'));
  cleanup.push(() => rmSync(outside, {recursive: true, force: true}));
  mkdirSync(join(f.root, 'dir'));
  expect((await f.run(patch('*** Add File: dir/new', '+unsafe'))).status).toBe('error');
  expect(existsSync(join(outside, 'new'))).toBe(false);
  const g = fixture(async () => {
    writeFileSync(join(g.root, 'new'), 'external');
    return 'once';
  });
  expect(await g.run(patch('*** Add File: new', '+new'))).toMatchObject({code: 'STALE_CONTENT'});
  expect(readFileSync(join(g.root, 'new'), 'utf8')).toBe('external');
});
test('cancellation while awaiting approval creates nothing and caches no grants', async () => {
  let resolve!: (value: ApprovalDecision) => void;
  const f = fixture(
      () =>
        new Promise(r => {
          resolve = r;
        }),
    ),
    controller = new AbortController();
  const pending = f.run(patch('*** Add File: new', '+new'), controller.signal);
  controller.abort();
  resolve('session');
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  expect(existsSync(join(f.root, 'new'))).toBe(false);
  expect(f.grants.list()).toEqual([]);
});
test('session approval binds exact patch, original content and targets; changed patches ask again', async () => {
  const f = fixture(async () => 'session');
  writeFileSync(join(f.root, 'file'), 'old\n');
  const text = patch('*** Update File: file', '@@', '-old', '+new');
  expect((await f.run(text)).status).toBe('ok');
  const scope = f.requests[0]!.scopeKey;
  expect(scope).toStartWith('patch:');
  expect((await f.run(patch('*** Update File: file', '@@', '-new', '+other'))).status).toBe('ok');
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.scopeKey).not.toBe(scope);
});
test('partial failure reports completed OS changes, remaining files and failure cause', async () => {
  const {ApplyPatchRuntime} = await import('../../packages/tools/src/runtimes/apply-patch');
  const f = fixture();
  writeFileSync(join(f.root, 'a'), 'old\n');
  writeFileSync(join(f.root, 'b'), 'old\n');
  const runtime = new ApplyPatchRuntime({
    workspace: new WorkspaceRoot(f.root),
    grants: f.grants,
    approve: async () => 'once',
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: s => s,
  });
  const plan = runtime.verify(
    parsePatch(patch('*** Update File: a', '@@', '-old', '+new', '*** Update File: b', '@@', '-old', '+new')),
  );
  const apply = plan.files.apply.bind(plan.files);
  plan.files.apply = (file, content) => {
    apply(file, content);
    if (file.path === 'a') writeFileSync(join(f.root, 'b'), 'external\n');
  };
  const result = runtime.apply(plan);
  expect(result).toMatchObject({status: 'error', code: 'PARTIAL_APPLY'});
  const receipt = JSON.parse(result.content);
  expect(receipt.changes.map((c: any) => c.path)).toEqual(['a']);
  expect(receipt.remaining).toEqual(['b']);
  expect(receipt.failureCode).toBe('STALE_CONTENT');
  expect(readFileSync(join(f.root, 'a'), 'utf8')).toBe('new\n');
  expect(readFileSync(join(f.root, 'b'), 'utf8')).toBe('external\n');
});
test('parser preserves untouched context, rejects overlapping paths and supports pure insertion at EOF', async () => {
  const parsed = parsePatch(patch('*** Update File: a', '@@', ' context', '-old', '+new'))[0]!;
  if (parsed.kind !== 'update') throw new Error();
  expect(updateFile(' context  \nold', parsed.chunks)).toBe(' context  \nnew');
  const f = fixture();
  expect((await f.run(patch('*** Add File: x', '+one', '*** Add File: x', '+two'))).status).toBe('error');
  expect(f.requests).toHaveLength(0);
});

test('BOM and mixed line endings retain truthful hashes and preserved context bytes', async () => {
  const f = fixture();
  const before = '\uFEFFfirst\r\nold\ncontext\r\n';
  writeFileSync(join(f.root, 'bom'), before);
  const result = await f.run(patch('*** Update File: bom', '@@', '-old', '+new', ' context'));
  expect(result.status).toBe('ok');
  expect(readFileSync(join(f.root, 'bom'), 'utf8')).toBe('\uFEFFfirst\r\nnew\r\ncontext\r\n');
  const {createHash} = await import('node:crypto');
  expect(JSON.parse(result.content).changes[0].beforeHash).toBe(
    createHash('sha256').update(Buffer.from(before)).digest('hex'),
  );
});

test('Move retains executable permissions without granting overwrite of an existing destination', async () => {
  const {chmodSync, statSync} = await import('node:fs');
  const f = fixture();
  writeFileSync(join(f.root, 'run'), 'old\n');
  chmodSync(join(f.root, 'run'), 0o755);
  expect((await f.run(patch('*** Update File: run', '*** Move to: renamed', '@@', '-old', '+new'))).status).toBe('ok');
  expect(statSync(join(f.root, 'renamed')).mode & 0o777).toBe(0o755);
  writeFileSync(join(f.root, 'occupied'), 'external');
  expect(
    (await f.run(patch('*** Update File: renamed', '*** Move to: occupied', '@@', '-new', '+changed'))).status,
  ).toBe('error');
  expect(readFileSync(join(f.root, 'occupied'), 'utf8')).toBe('external');
});

test('read grants do not authorize writes, and revoking an exact patch grant before launch wins', async () => {
  const f = fixture(async () => 'session');
  f.grants.grant('fs.read', new WorkspaceRoot(f.root).root);
  const grant = f.grants.grant.bind(f.grants);
  f.grants.grant = (capability, target) => {
    grant(capability, target);
    if (capability === 'fs.write') queueMicrotask(() => f.grants.clear());
  };
  expect(await f.run(patch('*** Add File: new', '+new'))).toMatchObject({status: 'denied'});
  expect(f.requests).toHaveLength(1);
  expect(existsSync(join(f.root, 'new'))).toBe(false);
});
test('a failed Move source deletion reports the created destination without claiming the source was removed', async () => {
  const {ApplyPatchRuntime} = await import('../../packages/tools/src/runtimes/apply-patch');
  const f = fixture();
  writeFileSync(join(f.root, 'source'), 'old\n');
  const runtime = new ApplyPatchRuntime({
    workspace: new WorkspaceRoot(f.root),
    grants: f.grants,
    approve: async () => 'once',
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: s => s,
  });
  const plan = runtime.verify(
    parsePatch(patch('*** Update File: source', '*** Move to: destination', '@@', '-old', '+new')),
  );
  const apply = plan.files.apply.bind(plan.files);
  plan.files.apply = (file, content, mode) => {
    apply(file, content, mode);
    if (file.path === 'destination') writeFileSync(join(f.root, 'source'), 'external\n');
  };
  const result = runtime.apply(plan),
    receipt = JSON.parse(result.content);
  expect(result.code).toBe('PARTIAL_APPLY');
  expect(receipt.changes.map((c: any) => [c.path, c.action])).toEqual([['destination', 'add']]);
  expect(receipt.remaining).toEqual(['source']);
  expect(readFileSync(join(f.root, 'destination'), 'utf8')).toBe('new\n');
  expect(readFileSync(join(f.root, 'source'), 'utf8')).toBe('external\n');
});

test('approval renders literal control bytes and refuses misleading bidi paths', async () => {
  const f = fixture(async request => {
    expect(request.diffPreview).toContain('\\u001b[31m');
    return 'once';
  });
  expect((await f.run(patch('*** Add File: controls', '+\x1b[31mtext'))).status).toBe('ok');
  expect(readFileSync(join(f.root, 'controls'), 'utf8')).toBe('\x1b[31mtext\n');
  expect((await f.run(patch('*** Add File: evil\u202Etxt', '+bad'))).status).toBe('denied');
  expect(f.requests).toHaveLength(1);
});
test('partial receipts do not label completed no-op operations as remaining', async () => {
  const {ApplyPatchRuntime} = await import('../../packages/tools/src/runtimes/apply-patch');
  const f = fixture();
  for (const name of ['a', 'b', 'c']) writeFileSync(join(f.root, name), 'old\n');
  const runtime = new ApplyPatchRuntime({
    workspace: new WorkspaceRoot(f.root),
    grants: f.grants,
    approve: async () => 'once',
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    redact: s => s,
  });
  const plan = runtime.verify(
    parsePatch(
      patch(
        '*** Update File: a',
        '@@',
        '-old',
        '+old',
        '*** Update File: b',
        '@@',
        '-old',
        '+new',
        '*** Update File: c',
        '@@',
        '-old',
        '+new',
      ),
    ),
  );
  const apply = plan.files.apply.bind(plan.files);
  plan.files.apply = (file, content, mode) => {
    apply(file, content, mode);
    if (file.path === 'b') writeFileSync(join(f.root, 'c'), 'external\n');
  };
  expect(JSON.parse(runtime.apply(plan).content).remaining).toEqual(['c']);
});

test('a patch that writes a whole large file is accepted with no size ceiling, as on Codex (was 64 KiB)', () => {
  const body = Array.from({length: 6000}, (_, i) => `+<div class="row-${i}">line ${i} of a generated page</div>`);
  const large = patch('*** Add File: page.html', ...body);
  expect(Buffer.byteLength(large)).toBeGreaterThan(256 * 1024);
  expect(parsePatch(large)).toHaveLength(1);
});
