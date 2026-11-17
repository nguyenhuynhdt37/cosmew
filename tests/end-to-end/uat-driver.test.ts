import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runAgent, splitPrompts} from '../../scripts/uat/agent-run';
import {collectTurnEvidence} from '../../scripts/uat/evidence';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('splitPrompts separates turns on a lone --- line', () => {
  expect(splitPrompts('a\nb\n---\nc\n')).toEqual(['a\nb', 'c']);
});

for (const approve of ['all', 'none'] as const) {
  test(`headless driver correlates durable dispatcher evidence with approval=${approve}`, async () => {
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
    const privateMarker = 'private-uat-report-marker';
    app.redactor.register(privateMarker);
    cleanup.push(async () => {
      await app.shutdownCommands();
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
      prompts: [`Copy it ${privateMarker}`],
      approve,
      app,
      pollMs: 10,
      log: l => lines.push(l),
    });
    expect(exitCode).toBe(0);
    expect(JSON.stringify(report)).not.toContain(privateMarker);
    if (approve === 'all') expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('written\n');
    else expect(existsSync(join(root, 'out.txt'))).toBe(false);
    const turn = report.turns[0]!;
    expect(turn.finalText).toContain('ALL DONE');
    expect(turn.toolCalls.map(c => [c.name, c.status])).toEqual([
      ['read', 'ok'],
      ['write', approve === 'all' ? 'ok' : 'denied'],
    ]);
    expect(turn.permissions).toHaveLength(1);
    expect(turn.permissions[0]).toMatchObject({
      capability: 'fs.write',
      target: 'out.txt',
      decision: approve === 'all' ? 'approved_once' : 'denied',
    });
    expect(lines.join('\n')).toContain(`permission ${approve === 'all' ? 'approved_once' : 'denied'}`);
    expect(turn.evidence).toMatchObject({
      source: 'sqlite-journal-and-tool-audit',
      journalVerified: true,
      dispatcherVerified: true,
    });
    expect(turn.evidence!.modelRequests).toBeGreaterThanOrEqual(3);
    expect(turn.evidence!.calls.map(call => [call.tool, call.verified])).toEqual([
      ['read', true],
      ['write', true],
    ]);
    expect(turn.evidence!.calls[1]!.authorizationScopeMatched).toBe(true);
    expect(turn.evidence!.calls[1]!.decision).toBe(approve === 'all' ? 'once' : 'deny');
    // Independent durable records, not model prose, determine whether dispatcher evidence is complete.
    app.db.query("DELETE FROM tool_audit WHERE call_id=? AND phase='requested'").run(turn.toolCalls[0]!.callId);
    const incomplete = collectTurnEvidence(app, turn.evidence!.sessionId, turn.evidence!.turnId, turn.toolCalls, 0);
    expect(incomplete.dispatcherVerified).toBe(false);
    expect(incomplete.calls[0]!.verified).toBe(false);
    expect(incomplete.journalVerified).toBe(true);
  });
}
