import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

test('project read deny governs reads, listing, suggestions, grep and automatic instructions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-project-read-')));
  roots.push(root);
  writeFileSync(join(root, 'blocked.txt'), 'BLOCKED_MARKER');
  writeFileSync(join(root, 'visible.txt'), 'VISIBLE_MARKER');
  mkdirSync(join(root, 'blocked'));
  writeFileSync(join(root, 'blocked', 'AGENTS.md'), 'BLOCKED_INSTRUCTION');
  for (const ripgrep of [undefined, null]) {
    const tools = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants: new SessionGrants(),
      approve: async () => 'deny',
      redact: t => t,
      ripgrep,
      readPolicy: (path: string) =>
        path === 'blocked.txt' || path === 'blocked' || path.startsWith('blocked/') ? 'deny' : undefined,
    });
    const call = (name: string, input: unknown) => tools.invoke({id: crypto.randomUUID(), name, input});
    expect((await call('read', {path: 'blocked.txt'})).status).toBe('denied');
    expect((await call('read', {path: '.'})).content).not.toContain('blocked');
    expect((await call('glob', {pattern: '**/*'})).content).not.toContain('blocked');
    expect((await call('read', {path: 'blocke.txt'})).content).not.toContain('Did you mean');
    for (const output_mode of ['content', 'files_with_matches', 'count']) {
      const grep = await call('grep', {pattern: 'MARKER', output_mode});
      expect(grep.content).not.toContain('BLOCKED_MARKER');
      expect(grep.content).not.toContain('blocked.txt');
      expect(grep.content).toContain('visible.txt');
    }
    expect((await tools.readInstruction('blocked/AGENTS.md', 1000)).status).toBe('denied');
  }
});
