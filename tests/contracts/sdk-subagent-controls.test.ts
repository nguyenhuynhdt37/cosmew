import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {dialogFixture, child, selection} from '../../apps/tui/src/ink/features/picker/test-fixture';

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error('Expected pending permission');
}

test('SDK child sends validate input/ownership and abort when the parent or tools change', async () => {
  let calls = 0;
  let aborted = false;
  const {client} = dialogFixture({
    startSession: () => ({id: crypto.randomUUID(), selection, messages: []}),
    subagents: owner => [{...child, parentConversationId: owner!}],
    sendSubagentMessage: async (_owner, _id, _text, signal) => {
      calls++;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }),
      );
    },
  });
  client.createSession();
  await expect(client.sendSubagentMessage(child.id, ' ')).rejects.toMatchObject({code: 'INVALID_INPUT'});
  await expect(client.sendSubagentMessage(child.id, 'x'.repeat(100001))).rejects.toMatchObject({code: 'INVALID_INPUT'});
  await expect(client.sendSubagentMessage('foreign-child', 'follow up')).rejects.toMatchObject({code: 'NOT_FOUND'});
  expect(calls).toBe(0);
  const first = client.sendSubagentMessage(child.id, 'follow up');
  client.createSession();
  await expect(first).rejects.toMatchObject({name: 'AbortError'});
  expect(aborted).toBe(true);
  aborted = false;
  const second = client.sendSubagentMessage(child.id, 'follow up');
  client.setToolsEnabled(false);
  await expect(second).rejects.toMatchObject({name: 'AbortError'});
  expect(aborted).toBe(true);
});

test('production SDK agent_message obeys consent, default approval, deny, revoked approval, plan, cancellation and ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-agent-controls-'));
  const project = join(root, 'project');
  mkdirSync(project);
  const app = startup(join(root, 'state'), {vault: memoryVault()});
  const client = app.createFutrynClient(project);
  // An unavailable recorded account intentionally proves controls do not need a provider request.
  const owner = app.conversations.create(selection);
  const other = app.conversations.create(selection);
  app.conversations.bindWorkspace(owner, realpathSync(project));
  app.conversations.bindWorkspace(other, realpathSync(project));
  const id = app.conversations.create(selection);
  app.conversations.saveSubagentSession({
    id,
    parentConversationId: owner,
    parentTurnId: null,
    callId: 'call-1',
    agentType: 'explore',
    description: 'Inspect',
    selection,
    forkContext: false,
    background: true,
    prompt: 'inspect',
    depth: 1,
    status: 'closed',
    createdAt: new Date().toISOString(),
    finishedAt: null,
  });
  try {
    // Select only a durable parent without constructing a model turn.
    (client as unknown as {currentSession: unknown}).currentSession = {id: owner, selection, messages: []};
    await expect(client.sendSubagentMessage(id, 'instruction')).rejects.toMatchObject({code: 'UNSUPPORTED'});
    client.setToolsEnabled(true);
    client.setPromptsAvailable(true);
    const denied = client.sendSubagentMessage(id, 'instruction');
    await until(() => client.listPendingPermissions().length > 0);
    let prompt = client.listPendingPermissions()[0]!;
    client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'deny');
    expect((await denied).status).toBe('denied');
    const controller = new AbortController();
    const cancelled = client.sendSubagentMessage(id, 'cancel instruction', controller.signal);
    await until(() => client.listPendingPermissions().length > 0);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({code: 'CANCELLED'});
    expect(client.listPendingPermissions()).toEqual([]);
    const approved = client.sendSubagentMessage(id, 'exact instruction');
    await until(() => client.listPendingPermissions().length > 0);
    prompt = client.listPendingPermissions()[0]!;
    const firstScope = prompt.scopeHash;
    client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'session');
    expect((await approved).code).toBe('AGENT_CLOSED');
    expect((await client.sendSubagentMessage(id, 'exact instruction')).code).toBe('AGENT_CLOSED');
    const different = client.sendSubagentMessage(id, 'different instruction');
    await until(() => client.listPendingPermissions().length > 0);
    prompt = client.listPendingPermissions()[0]!;
    expect(prompt.scopeHash).not.toBe(firstScope);
    client.clearSessionView();
    await expect(different).rejects.toMatchObject({code: 'CANCELLED'});
    expect(client.listPendingPermissions()).toEqual([]);
    (client as unknown as {currentSession: unknown}).currentSession = {id: owner, selection, messages: []};
    client.addPermissionRule('allow', 'Tool(agent_message)');
    const actual = await client.sendSubagentMessage(id, 'instruction');
    expect(actual).toMatchObject({name: 'agent_message', status: 'error', code: 'AGENT_CLOSED'});
    client.setPermissionMode('plan');
    expect((await client.sendSubagentMessage(id, 'instruction')).status).toBe('denied');
    client.setPermissionMode('default');
    client.addPermissionRule('ask', 'Tool(agent_message)');
    const approvalRace = client.sendSubagentMessage(id, 'approved then revoked');
    await until(() => client.listPendingPermissions().length > 0);
    prompt = client.listPendingPermissions()[0]!;
    client.resolvePermission(prompt.approvalId, prompt.scopeHash, 'once');
    client.revokeToolGrants();
    await expect(approvalRace).rejects.toMatchObject({code: 'CANCELLED'});
    const revoked = client.sendSubagentMessage(id, 'instruction');
    await until(() => client.listPendingPermissions().length > 0);
    client.addPermissionRule('deny', 'Tool(agent_message)');
    await expect(revoked).rejects.toMatchObject({code: 'CANCELLED'});
    (client as unknown as {currentSession: unknown}).currentSession = {id: other, selection, messages: []};
    await expect(client.sendSubagentMessage(id, 'instruction')).rejects.toMatchObject({code: 'NOT_FOUND'});
  } finally {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
