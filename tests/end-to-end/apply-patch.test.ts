import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FutrynTuiApp} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault, scriptedView} from '../fixtures';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const patch = '*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+PATCH_MARKER\n*** End Patch';
async function make(protocol: 'chat' | 'anthropic' = 'chat', repeat = false) {
  const home = mkdtempSync(join(tmpdir(), 'hannes-patch-home-')),
    root = mkdtempSync(join(tmpdir(), 'hannes-patch-project-'));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  writeFileSync(join(root, 'notes.txt'), 'old\n');
  const server = fixtureServer();
  cleanup.push(() => server.server.stop(true));
  server.set({
    script: view => {
      if (repeat)
        return view.results.length < 2
          ? {calls: [{name: 'apply_patch', input: {patch: patch.replace('+PATCH_MARKER', '+old')}}]}
          : {text: view.results.map(r => r.content).join('\n')};
      const last = view.results.at(-1);
      if (last && last.content.startsWith('[')) return {text: 'MODEL_CONTINUED ' + last.content};
      if (!last) return {calls: [{name: 'apply_patch', input: {patch}}]};
      if (last.name === 'apply_patch') return {calls: [{name: 'read', input: {path: 'notes.txt'}}]};
      return {text: 'MODEL_CONTINUED ' + last.content};
    },
  });
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add(server.provider(protocol, {id: 'patch-model', auth: 'none'}));
  await app.accounts.add('patch-model', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({client, cols: 120, rows: 36});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  return {app, client, tui, root, server, protocol};
}
async function pending(c: Awaited<ReturnType<typeof make>>) {
  const end = Date.now() + 4000;
  while (!c.client.listPendingPermissions().length && Date.now() < end) await Bun.sleep(5);
  expect(c.client.listPendingPermissions()).toHaveLength(1);
  c.tui.advanceStartupGate();
}
for (const protocol of ['chat', 'anthropic'] as const)
  test(`${protocol}: approved patch diff reaches TUI, real filesystem, paired storage and model continuation`, async () => {
    const c = await make(protocol);
    const turn = c.tui.submitPrompt('Update notes');
    await pending(c);
    const permission = c.client.listPendingPermissions()[0]!;
    expect(permission).toMatchObject({capability: 'fs.write', target: 'notes.txt'});
    expect(permission.diffPreview).toContain('-old\n+PATCH_MARKER');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('+ PATCH_MARKER');
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n');
    await c.tui.handleKey('1');
    await turn;
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('PATCH_MARKER\n');
    expect(c.tui.computeFrameSnapshot().plainText).toContain('notes.txt · applied diff');
    const answer = c.tui.getTranscript().at(-1)!;
    expect(answer.content).toContain('MODEL_CONTINUED');
    expect(answer.content).toContain('PATCH_MARKER');
    const receipt = JSON.parse(answer.toolResults![0]!.content);
    expect(receipt.changes).toHaveLength(1);
    expect(receipt.changes[0]).toMatchObject({path: 'notes.txt', action: 'update'});
    const saved = c.app.conversations.get(c.client.activeSession()!.id)!.messages;
    for (const result of answer.toolResults!)
      expect(saved.find(m => m.role === 'tool' && m.toolCallId === result.callId)?.toolName).toBe(result.name);
    for (const request of c.server.requests.filter(r => r.body?.messages)) {
      const view = scriptedView(protocol, request.body);
      expect(view.orphanResults).toBe(0);
      expect(view.unansweredCalls).toBe(0);
      expect(JSON.stringify(request.body.tools)).not.toContain('freeform');
    }
  });
test('denied patch returns refusal to the model without changing files', async () => {
  const c = await make();
  const turn = c.tui.submitPrompt('Update notes');
  await pending(c);
  await c.tui.handleKey('Escape');
  await turn;
  expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('old\n');
  expect(c.tui.getTranscript().at(-1)!.toolResults![0]).toMatchObject({status: 'denied'});
  expect(c.tui.getTranscript().at(-1)!.content).toContain('MODEL_CONTINUED [denied');
});
test('mutating calls with identical output are never replaced by the unchanged-read notice', async () => {
  const c = await make('chat', true);
  const turn = c.tui.submitPrompt('Verify two patches');
  for (let i = 0; i < 2; i++) {
    await pending(c);
    await c.tui.handleKey('1');
  }
  await turn;
  const results = c.tui.getTranscript().at(-1)!.toolResults!;
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.status).toBe('ok');
    expect(result.content).not.toContain('[unchanged]');
    expect(JSON.parse(result.content).changes).toEqual([]);
  }
});

for (const failure of ['cancel', 'provider'] as const)
  test(`write receipt survives ${failure} after filesystem mutation without replay`, async () => {
    const c = await make(),
      controller = new AbortController();
    let caught: unknown;
    const sending = (async () => {
      try {
        for await (const event of c.client.sendMessage('Update notes', {signal: controller.signal})) {
          if (event.type === 'toolResult' && event.result.name === 'apply_patch') {
            if (failure === 'cancel') controller.abort();
            else c.server.set({status: 400});
          }
        }
      } catch (error) {
        caught = error;
      }
    })();
    await pending(c);
    const permission = c.client.listPendingPermissions()[0]!;
    c.client.resolvePermission(permission.approvalId, permission.scopeHash, 'once');
    await sending;
    expect(caught).toBeDefined();
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('PATCH_MARKER\n');
    const record = c.app.conversations.get(c.client.activeSession()!.id)!;
    const result = record.messages.find(m => m.role === 'tool' && m.toolName === 'apply_patch')!;
    expect(result.state).toBe('committed');
    expect(JSON.parse(result.content).changes[0].path).toBe('notes.txt');
    const resumed = c.app.createFutrynClient(c.root);
    resumed.resumeSession(record.id);
    expect(resumed.activeSession()!.messages.some(m => m.role === 'tool' && m.toolCallId === result.toolCallId)).toBe(
      true,
    );
    expect(readFileSync(join(c.root, 'notes.txt'), 'utf8')).toBe('PATCH_MARKER\n');
  });
