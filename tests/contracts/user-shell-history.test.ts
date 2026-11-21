import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import type {ToolResult} from '@cosmew/contracts';
import {runUserShellCommand} from '../../apps/cli/src/bootstrap/user-shell';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'futryn-shell-history-'));
  const db = openPrivateDatabase(join(directory, 'state.sqlite'));
  const store = new SqliteConversations(db, text => text.replaceAll('secret-shell-value', '[REDACTED]'));
  const selection = {accountId: crypto.randomUUID(), modelId: 'fixture-model'};
  const id = store.create(selection);
  return {
    directory,
    db,
    store,
    selection,
    id,
    close: () => {
      db.close();
      rmSync(directory, {recursive: true, force: true});
    },
  };
}

test('shell invocation journals one paired call and confirmed outcome before resume, never a model request', async () => {
  const c = fixture();
  try {
    let dispatched = 0;
    const result: ToolResult = {
      callId: 'shell-stable-id',
      name: 'exec_command',
      status: 'ok',
      content: 'Exit code: 0\nOutput:\nsecret-shell-value',
      exitCode: 0,
    };
    await runUserShellCommand({
      store: c.store,
      sessionId: c.id,
      selection: c.selection,
      callId: result.callId,
      command: 'printf secret-shell-value',
      invoke: async call => {
        dispatched++;
        expect(call.id).toBe(result.callId);
        const pending = c.store.recover(c.id).turns.at(-1)!;
        expect(pending.events.map(event => event.data.type)).toEqual(['user.accepted', 'tool.call', 'tool.intent']);
        return result;
      },
    });
    const recovered = c.store.recover(c.id);
    expect(dispatched).toBe(1);
    expect(recovered.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(recovered.messages[1]!.toolCalls![0]!.id).toBe(result.callId);
    expect(recovered.messages[2]!.toolCallId).toBe(result.callId);
    expect(JSON.stringify(recovered)).not.toContain('secret-shell-value');
    expect(recovered.turns[0]!.state).toBe('completed');
    expect(recovered.turns[0]!.events.some(event => event.data.type === 'model.requested')).toBe(false);
    expect(c.store.get(c.id)!.turns![0]!.kind).toBe('user-shell');
  } finally {
    c.close();
  }
});

test('unconfirmed shell invocation recovers as unknown and never dispatches itself again', async () => {
  const c = fixture();
  try {
    let dispatched = 0;
    await expect(
      runUserShellCommand({
        store: c.store,
        sessionId: c.id,
        selection: c.selection,
        callId: 'shell-unknown-id',
        command: 'failure',
        invoke: async () => {
          dispatched++;
          throw new Error('injected invocation transport loss');
        },
      }),
    ).rejects.toThrow();
    const first = c.store.recover(c.id);
    const second = c.store.recover(c.id);
    expect(first.messages.at(-1)!.content).toContain('[unknown: interrupted execution]');
    expect(second.messages).toEqual(first.messages);
    expect(dispatched).toBe(1);
    expect(first.turns[0]!.state).toBe('failed');
  } finally {
    c.close();
  }
});

test('shell execution claim prevents another client dispatching into the same session', async () => {
  const c = fixture();
  try {
    let finish!: (result: ToolResult) => void;
    const pending = new Promise<ToolResult>(resolve => {
      finish = resolve;
    });
    const first = runUserShellCommand({
      store: c.store,
      sessionId: c.id,
      selection: c.selection,
      callId: 'shell-first',
      command: 'first',
      invoke: async () => pending,
    });
    let secondDispatched = false;
    await expect(
      runUserShellCommand({
        store: c.store,
        sessionId: c.id,
        selection: c.selection,
        callId: 'shell-second',
        command: 'second',
        invoke: async () => {
          secondDispatched = true;
          throw new Error('must not dispatch');
        },
      }),
    ).rejects.toThrow();
    expect(secondDispatched).toBe(false);
    finish({callId: 'shell-first', name: 'exec_command', status: 'ok', content: 'Exit code: 0', exitCode: 0});
    await first;
    expect(c.store.recover(c.id).turns).toHaveLength(1);
  } finally {
    c.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'native shell command keeps its real nonzero result through restart without invoking a model or replaying execution',
  async () => {
    const {existsSync} = await import('node:fs');
    expect(existsSync('/usr/bin/sandbox-exec')).toBe(true);
    const {startup} = await import('../../apps/cli/src/bootstrap/startup');
    const {NativeCommandRuntime} = await import('@cosmew/tools');
    const {fixtureServer, memoryVault} = await import('../fixtures');
    const directory = mkdtempSync(join(tmpdir(), 'futryn-shell-native-'));
    const server = fixtureServer();
    let app = startup(join(directory, 'state'), {
      vault: memoryVault(),
      commands: (workspaceRoot, stateDirectory) => new NativeCommandRuntime({workspaceRoot, stateDirectory}),
    });
    // Keep the approval path under test: with autoAllowBashIfSandboxed off a sandboxed command still asks.
    writeFileSync(
      join(directory, 'state', 'settings.json'),
      JSON.stringify({sandbox: {autoAllowBashIfSandboxed: false}}),
      {mode: 0o600},
    );
    try {
      app.registry.add(server.provider('chat', {id: 'shell-native', auth: 'none'}));
      await app.accounts.add('shell-native', 'shell-native', {kind: 'none'});
      let client = app.createFutrynClient(directory);
      await client.discoverModels();
      client.selectModel('fixture-model');
      client.setToolsEnabled(true);
      let finished = false;
      const task = client
        .runShellCommand("printf 'SHELL_RESTART\\n'; exit 7", {callId: 'shell-native-stable'})
        .finally(() => {
          finished = true;
        });
      let approvals = 0;
      const deadline = Date.now() + 15000;
      while (!finished && Date.now() < deadline) {
        for (const request of client.listPendingPermissions()) {
          expect(request.capability).toBe('process.execute');
          approvals++;
          client.resolvePermission(request.approvalId, request.scopeHash, 'once');
        }
        await Bun.sleep(10);
      }
      expect(finished).toBe(true);
      const result = await task;
      expect(approvals).toBe(1);
      expect(result.exitCode).toBe(7);
      expect(result.content).toContain('SHELL_RESTART');
      const session = client.activeSession()!;
      expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1);
      expect(session.messages.find(message => message.role === 'tool')!.toolCallId).toBe('shell-native-stable');
      expect(server.requests.filter(request => request.body?.stream)).toHaveLength(0);
      await app.shutdownCommands();
      app.db.close();
      app = startup(join(directory, 'state'), {vault: memoryVault()});
      client = app.createFutrynClient(directory);
      client.resumeSession(session.id);
      expect(client.activeSession()!.messages).toEqual(session.messages);
      expect(client.activeSession()!.messages.at(-1)!.content).toContain('Exit code: 7');
      expect(app.conversations.recover(session.id).turns[0]!.state).toBe('failed');
      expect(server.requests.filter(request => request.body?.stream)).toHaveLength(0);
    } finally {
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(directory, {recursive: true, force: true});
    }
  },
);
