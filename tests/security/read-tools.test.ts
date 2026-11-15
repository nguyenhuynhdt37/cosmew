import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionGrants, evaluateRead } from '@hannes/security';
import { ToolDispatcher, type ApprovalDecision, type ApprovalRequest, type ToolAuditRecord } from '@hannes/tools';
import { WorkspaceRoot } from '@hannes/workspace';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function setup(answer: ApprovalDecision = 'deny') {
  const base = mkdtempSync(join(tmpdir(), 'futryn-tools-')); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'ws'); const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, 'src', 'app.ts'), 'export const answer = 42;\nconst token = "sk-ant-api03-' + 'A'.repeat(90) + '";\n');
  writeFileSync(join(root, '.env'), 'DATABASE_PASSWORD=hunter2\n');
  writeFileSync(join(root, '.env.example'), 'DATABASE_PASSWORD=\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n');
  const asked: ApprovalRequest[] = []; const audit: ToolAuditRecord[] = [];
  const grants = new SessionGrants();
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root), grants, stateDirectory: join(root, '.hannes-state'),
    approve: async request => { asked.push(request); return answer; },
    redact: text => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]'),
    audit: record => audit.push(record), searchDeadlineMs: 1500,
  });
  const call = (name: string, input: unknown) => dispatcher.invoke({ id: crypto.randomUUID(), name, input });
  return { root, outside, asked, audit, grants, call };
}

test('read returns numbered lines and redacts secrets in file contents', async () => {
  const s = setup();
  const result = await s.call('read', { path: 'src/app.ts' });
  expect(result.status).toBe('ok');
  expect(result.content).toContain('1\texport const answer = 42;');
  expect(result.content).toContain('[REDACTED]'); expect(result.content).not.toContain('sk-ant-api03');
  expect(s.asked).toHaveLength(0); // ordinary files need no prompt
});

test('traversal, absolute paths and symlinks never leave the workspace or echo the outside path', async () => {
  const s = setup('session');
  symlinkSync(join(s.outside, 'secret.txt'), join(s.root, 'link.txt'));
  symlinkSync(s.outside, join(s.root, 'linkdir'));
  for (const path of ['../outside/secret.txt', join(s.outside, 'secret.txt'), 'link.txt', 'linkdir/secret.txt']) {
    const result = await s.call('read', { path });
    expect(result.status).toBe('denied');
    expect(result.content).not.toContain('outside secret');
    expect(result.content).not.toContain(s.outside);
  }
  expect(s.asked).toHaveLength(0); // outside is denied, never prompted (user decision)
});

test('secret files ask; deny and Esc never grant; session grants are remembered per file', async () => {
  const denied = setup('deny');
  const first = await denied.call('read', { path: '.env' });
  expect(first.status).toBe('denied'); expect(first.content).not.toContain('hunter2');
  expect(denied.asked).toEqual([{ tool: 'read', capability: 'fs.read', target: '.env', reason: 'secret-file' }]);
  expect((await denied.call('read', { path: '.env.example' })).status).toBe('ok'); // templates are allowed

  const session = setup('session');
  expect((await session.call('read', { path: '.env' })).content).toContain('hunter2');
  expect((await session.call('read', { path: '.env' })).status).toBe('ok');
  expect(session.asked).toHaveLength(1); // second read uses the session grant

  const once = setup('once');
  await once.call('read', { path: '.env' }); await once.call('read', { path: '.env' });
  expect(once.asked).toHaveLength(2); // "once" is not remembered
});

test('case variants cannot dodge secret or git rules on case-insensitive file systems', async () => {
  expect(evaluateRead('.ENV', '/w/.ENV').effect).toBe('ask');
  expect(evaluateRead('Keys/ID_RSA', '/w/Keys/ID_RSA').effect).toBe('ask');
  expect(evaluateRead('.Git/config', '/w/.Git/config').effect).toBe('deny');
  expect(evaluateRead('x', '/State/x', { stateDirectory: '/state' }).effect).toBe('deny');
  const s = setup('deny');
  const upper = await s.call('read', { path: '.ENV' });
  if (upper.code !== 'NOT_FOUND') { // case-insensitive volume: the same file must still need approval
    expect(upper.status).toBe('denied'); expect(upper.content).not.toContain('hunter2');
    expect(s.asked.at(-1)).toMatchObject({ target: '.env', reason: 'secret-file' }); // on-disk casing
  }
});

test('policy order: deny beats everything, including a session grant', () => {
  expect(evaluateRead('.git/config', '/w/.git/config').effect).toBe('deny');
  expect(evaluateRead('a/.env', '/w/a/.env').effect).toBe('ask');
  expect(evaluateRead('keys/server.pem', '/w/keys/server.pem').effect).toBe('ask');
  expect(evaluateRead('README.md', '/w/README.md').effect).toBe('allow');
  expect(evaluateRead('x', '/state/x', { stateDirectory: '/state' })).toEqual({ effect: 'deny', reason: 'hannes-state' });
});

test('audit records the request before any decision, then the decision and the outcome', async () => {
  const s = setup('deny');
  await s.call('read', { path: '.env' });
  expect(s.audit.map(r => r.phase)).toEqual(['requested', 'decided', 'decided', 'completed']);
  expect(s.audit.at(-1)).toMatchObject({ outcome: 'denied', target: '.env' });
});

test('glob lists files, hides git internals; grep skips secret files and reports it', async () => {
  const s = setup();
  const listed = await s.call('glob', { pattern: '**/*' });
  expect(listed.content).toContain('src/app.ts'); expect(listed.content).not.toContain('.git/');
  const found = await s.call('grep', { pattern: 'PASSWORD' });
  expect(found.content).toContain('.env.example:1');
  expect(found.content).not.toContain('hunter2');
  expect(found.content).toContain('secret-looking file(s) skipped');
  expect(s.asked).toHaveLength(0);
});

test('invalid input, unknown tools, binary and directories fail safely', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'blob.bin'), new Uint8Array([1, 0, 2, 3]));
  expect((await s.call('read', { path: 'src' })).code).toBe('IS_DIRECTORY');
  expect((await s.call('read', { path: 'blob.bin' })).code).toBe('BINARY_FILE');
  expect((await s.call('read', { nope: 1 })).code).toBe('INVALID_INPUT');
  expect((await s.call('grep', { pattern: '(' })).code).toBe('INVALID_PATTERN');
  expect((await s.call('shell', { cmd: 'rm -rf /' })).code).toBe('UNKNOWN_TOOL');
  expect((await s.call('read', { path: 'missing.txt' })).code).toBe('NOT_FOUND');
});

test('read pages long files within the line and byte limits', async () => {
  const s = setup();
  writeFileSync(join(s.root, 'long.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const first = await s.call('read', { path: 'long.txt' });
  expect(first.truncated).toBe(true); expect(first.content).toContain('continue with offset 2001');
  const page = await s.call('read', { path: 'long.txt', offset: 4999, limit: 5 });
  expect(page.content).toContain('4999\tline 4999'); expect(page.content).toContain('5000\tline 5000');
});

test('a catastrophic regex is stopped by the deadline instead of hanging the app', async () => {
  const s = setup();
  // JavaScriptCore caps one backtracking match at ~0.5 s, but 20 such lines add up to ~10 s.
  writeFileSync(join(s.root, 'evil.txt'), Array.from({ length: 20 }, () => 'x'.repeat(30)).join('\n'));
  const started = Date.now();
  const result = await s.call('grep', { pattern: '(x+x+)+y' });
  expect(result.code).toBe('TIMEOUT');
  expect(Date.now() - started).toBeLessThan(5000);
}, 10000);
