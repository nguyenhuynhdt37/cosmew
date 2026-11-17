import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runAgent, splitPrompts} from '../../scripts/uat/agent-run';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('splitPrompts separates turns on a lone --- line', () => {
  expect(splitPrompts('a\nb\n---\nc\n')).toEqual(['a\nb', 'c']);
});

test('headless driver runs read then write with auto-approval and reports both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-uat-home-')),
    root = mkdtempSync(join(tmpdir(), 'futryn-uat-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  writeFileSync(join(root, 'in.txt'), 'hello\n');
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  server.set({
    script: view => {
      const done = view.results.map(r => r.name);
      if (!done.includes('read')) return {calls: [{name: 'read', input: {path: 'in.txt'}}]};
      if (!done.includes('write')) return {calls: [{name: 'write', input: {path: 'out.txt', content: 'written\n'}}]};
      return {text: 'ALL DONE'};
    },
  });
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
  });
  app.registry.add(server.provider('chat', {id: 'uat-model', auth: 'none'}));
  await app.accounts.add('uat-model', 'fixture', {kind: 'none'});
  const setup = app.createFutrynClient(root);
  await setup.discoverModels();
  setup.selectModel('fixture-model');

  const lines: string[] = [];
  const {report, exitCode} = await runAgent({
    workspace: root,
    prompts: ['Copy it'],
    approve: 'all',
    app,
    pollMs: 10,
    log: l => lines.push(l),
  });
  expect(exitCode).toBe(0);
  expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('written\n');
  const turn = report.turns[0]!;
  expect(turn.finalText).toContain('ALL DONE');
  expect(turn.toolCalls.map(c => [c.name, c.status])).toEqual([
    ['read', 'ok'],
    ['write', 'ok'],
  ]);
  expect(turn.permissions).toHaveLength(1);
  expect(turn.permissions[0]).toMatchObject({capability: 'fs.write', target: 'out.txt', decision: 'approved_once'});
  expect(lines.join('\n')).toContain('permission approved_once');
});
