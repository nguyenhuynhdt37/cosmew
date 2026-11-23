import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {dialogFixture, model, selection} from '../../apps/tui/src/ink/features/picker/test-fixture';

test('history is bounded, newest first, redacted, persistent and isolated by canonical workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3-history-'));
  const db = openPrivateDatabase(root);
  try {
    const s = new SqliteConversations(db, v => v.replaceAll('private-value', '[redacted]'));
    const a = s.create(selection),
      b = s.create(selection),
      unknown = s.create(selection);
    s.bindWorkspace(a, '/canonical/a');
    s.bindWorkspace(b, '/canonical/b');
    s.bindWorkspace(a, '/canonical/b'); // resume cannot relabel the source
    s.append(a, {role: 'user', content: 'project private-value'}, 'committed');
    s.append(a, {role: 'assistant', content: 'answer'}, 'committed');
    s.append(b, {role: 'user', content: 'other workspace'}, 'committed');
    s.append(unknown, {role: 'user', content: 'unknown legacy workspace'}, 'committed');
    const query = {scope: 'project' as const, workspace: '/canonical/a'};
    expect(s.promptHistory(query).map(p => p.content)).toEqual(['project [redacted]']);
    const reopened = new SqliteConversations(db);
    const all = reopened.promptHistory({scope: 'everywhere', workspace: '/canonical/a'});
    expect(all).toHaveLength(3);
    expect(all[0]?.content).toBe('unknown legacy workspace');
    expect(all.every(p => Number.isFinite(Date.parse(p.timestamp)))).toBe(true);
    expect(s.promptHistory({scope: 'session', sessionId: b, workspace: '/canonical/a'}).map(p => p.content)).toEqual([
      'other workspace',
    ]);
    expect(s.promptHistory({...query, limit: 1})).toHaveLength(1);
    expect(s.promptHistory({...query, workspace: '/missing'})).toEqual([]);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('composition scopes history by canonical workspace and never leaks another project', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3-history-host-'));
  const state = join(root, 'state');
  mkdirSync(state, {mode: 0o700});
  const a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  symlinkSync(a, join(root, 'alias'));
  const app = startup(state, {vault: memoryVault()});
  try {
    const first = app.conversations.create(selection),
      second = app.conversations.create(selection);
    app.conversations.bindWorkspace(first, realpathSync(a));
    app.conversations.bindWorkspace(second, realpathSync(b));
    app.conversations.append(first, {role: 'user', content: 'first project'}, 'committed');
    app.conversations.append(second, {role: 'user', content: 'second project'}, 'committed');
    expect(
      app
        .createFutrynClient(join(root, 'alias'))
        .promptHistory({scope: 'project'})
        .map(p => p.content),
    ).toEqual(['first project']);
    expect(
      app
        .createFutrynClient(b)
        .promptHistory({scope: 'project'})
        .map(p => p.content),
    ).toEqual(['second project']);
    expect(app.createFutrynClient(a).promptHistory({scope: 'everywhere'})).toHaveLength(2);
  } finally {
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('session model choice bypasses user settings and forks history before changing pinned adapters', () => {
  let persisted = 0;
  const m2 = {...model, id: 'other-model'};
  const fixture = dialogFixture({
    cachedModels: () => [model, m2],
    selectModel: () => {
      persisted++;
      throw new Error('must not persist');
    },
    startSession: (_project, pick) => ({
      id: 'original',
      selection: pick ?? selection,
      messages: [{role: 'user', content: 'keep history'}],
    }),
    forkSession: (id, pick) => {
      expect(id).toBe('original');
      return {id: 'fork', selection: pick, messages: [{role: 'user', content: 'keep history'}]};
    },
  });
  fixture.client.createSession();
  const before = JSON.stringify(fixture.settings);
  fixture.client.selectModel(m2.id, {scope: 'session'});
  expect(fixture.client.status().selection?.modelId).toBe(m2.id);
  expect(fixture.client.activeSession()?.messages[0]?.content).toBe('keep history');
  expect(fixture.client.activeSession()?.id).toBe('fork');
  expect(persisted).toBe(0);
  expect(JSON.stringify(fixture.settings)).toBe(before);
  fixture.client.createSession();
  expect(fixture.client.status().selection?.modelId).toBe(selection.modelId);
});

test('session effort reaches sendTurn and clears with a new session without persisting preferences', async () => {
  let effort: string | undefined;
  let serial = 0;
  const fixture = dialogFixture({
    startSession: (_project, pick) => ({id: `session-${++serial}`, selection: pick ?? selection, messages: []}),
    async *sendTurn(_id, _text, _signal, _max, _cost, value) {
      effort = value;
      yield {type: 'textDelta', text: 'ok'};
    },
  });
  fixture.client.createSession();
  const before = JSON.stringify(fixture.settings);
  fixture.client.setReasoningEffort('high', {scope: 'session'});
  expect(fixture.client.status().reasoningEffort).toBe('high');
  expect(JSON.stringify(fixture.settings)).toBe(before);
  for await (const _event of fixture.client.sendMessage('request')) {
    /* consume */
  }
  expect(effort).toBe('high');
  fixture.client.createSession();
  expect(fixture.client.status().reasoningEffort).not.toBe('high');
  expect(() => fixture.client.setReasoningEffort('invented', {scope: 'session'})).toThrow();
});

test('schema 9 migration preserves known times and leaves unknown workspace prompts out of project history', async () => {
  const {Database} = await import('bun:sqlite');
  const root = mkdtempSync(join(tmpdir(), 'p3-history-migrate-'));
  let db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const id = store.create(selection);
    store.append(id, {role: 'user', content: 'legacy unknown'}, 'committed');
    db.exec(
      'DROP TABLE prompt_history; ALTER TABLE messages DROP COLUMN created_at; ALTER TABLE conversations DROP COLUMN workspace; PRAGMA user_version=9;',
    );
    db.close();
    db = openPrivateDatabase(root);
    expect((db.query('PRAGMA user_version').get() as {user_version: number}).user_version).toBe(13);
    expect(new SqliteConversations(db).promptHistory({scope: 'project', workspace: '/arbitrary'})).toEqual([]);
    expect(new SqliteConversations(db).promptHistory({scope: 'everywhere', workspace: '/arbitrary'})).toEqual([]);
    db.close();
    const raw = new Database(join(root, 'provider-auth.sqlite'));
    raw.exec('PRAGMA user_version=14');
    raw.close();
    expect(() => openPrivateDatabase(root)).toThrow();
    db = new Database(':memory:');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('failed session model fork leaves selection, settings and permission state intact', () => {
  const next = {...model, id: 'next'};
  const fixture = dialogFixture({
    cachedModels: () => [model, next],
    startSession: () => ({id: 'session', selection, messages: []}),
    forkSession: () => {
      throw new Error('storage failed');
    },
  });
  fixture.client.createSession();
  fixture.client.setPermissionMode('plan');
  const before = JSON.stringify(fixture.settings);
  expect(() => fixture.client.selectModel('next', {scope: 'session'})).toThrow();
  expect(fixture.client.status().selection).toEqual(selection);
  expect(fixture.client.permissionMode()).toBe('plan');
  expect(JSON.stringify(fixture.settings)).toBe(before);
});

test('session-only account choice drives default catalog and manual model without changing saved preferences', async () => {
  const {account} = await import('../../apps/tui/src/ink/features/picker/test-fixture');
  const other = {...account, id: crypto.randomUUID(), alias: 'Other'};
  const otherModel = {...model, id: 'other-account-model'};
  let manualAccount: string | undefined;
  const f = dialogFixture({
    getAccount: id => (id === other.id ? other : account),
    cachedModels: a => (a.id === other.id ? [otherModel] : [model]),
    addManualModel: (a, id) => {
      manualAccount = a.id;
      return {...otherModel, id};
    },
  });
  f.settings.accounts.push(other);
  const before = JSON.stringify(f.settings);
  f.client.selectModel(otherModel.id, {accountId: other.id, scope: 'session'});
  expect(f.client.cachedModels().map(m => m.id)).toEqual([otherModel.id]);
  f.client.addManualModel('manual');
  expect(manualAccount).toBe(other.id);
  expect(f.settings.activeAccountId).toBe(account.id);
  expect(JSON.stringify(f.settings)).toBe(before);
});

test('session-only model fork preserves plan and review workflow on in-process resume without saving settings', () => {
  const next = {...model, id: 'next'};
  const forkSelection = {...selection, modelId: next.id};
  for (const mode of ['plan', 'review'] as const) {
    const f = dialogFixture({
      cachedModels: () => [model, next],
      startSession: () => ({id: 'source', selection, messages: []}),
      forkSession: () => ({id: 'fork', selection: forkSelection, messages: []}),
      resumeSession: id => ({id, selection: id === 'fork' ? forkSelection : selection, messages: []}),
    });
    f.client.createSession();
    f.client.setMode(mode);
    const before = JSON.stringify(f.settings);
    f.client.selectModel(next.id, {scope: 'session'});
    expect(f.client.mode()).toBe(mode);
    f.client.resumeSession('source');
    f.client.resumeSession('fork');
    expect(f.client.mode()).toBe(mode);
    expect(JSON.stringify(f.settings)).toBe(before);
  }
});

test('forked context is not counted as new prompt history and future real submissions remain visible', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3-history-fork-'));
  const db = openPrivateDatabase(root);
  try {
    const store = new SqliteConversations(db);
    const source = store.create(selection);
    store.bindWorkspace(source, '/project');
    store.append(source, {role: 'user', content: 'actual original prompt'}, 'committed');
    const original = store.promptHistory({scope: 'everywhere', workspace: '/project'});
    const fork = store.fork(source, selection);
    store.bindWorkspace(fork.id, '/project');
    expect(fork.recovery?.messages.map(m => m.content)).toEqual(['actual original prompt']);
    expect(store.promptHistory({scope: 'everywhere', workspace: '/project'})).toEqual(original);
    expect(store.promptHistory({scope: 'project', workspace: '/project'})).toEqual(original);
    expect(store.promptHistory({scope: 'session', sessionId: fork.id, workspace: '/project'})).toEqual([]);
    store.append(fork.id, {role: 'user', content: 'actual post-fork prompt'}, 'committed');
    expect(
      store.promptHistory({scope: 'session', sessionId: fork.id, workspace: '/project'}).map(p => p.content),
    ).toEqual(['actual post-fork prompt']);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('prompt workspace follows each actual submission across a cross-project resume; steering is searchable and retract removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3-history-steer-'));
  const db = openPrivateDatabase(root);
  try {
    const a = new SqliteConversations(db, v => v.replaceAll('private-value', '[redacted]'), '/project-a');
    const b = new SqliteConversations(db, v => v.replaceAll('private-value', '[redacted]'), '/project-b');
    const id = a.create(selection);
    a.append(id, {role: 'user', content: 'submitted in a'}, 'committed');
    b.append(id, {role: 'user', content: 'submitted after resume in b'}, 'committed');
    const receipt = {
      requestId: crypto.randomUUID(),
      ...selection,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outcome: 'pending' as const,
      usage: null,
      context: null,
    };
    b.beginExecution(id, {role: 'user', content: 'running in b'}, receipt);
    b.recordExecution(id, receipt.requestId, {type: 'model.requested', stepId: crypto.randomUUID()});
    const steerId = crypto.randomUUID();
    b.recordExecution(id, receipt.requestId, {
      type: 'user.steered',
      steerId,
      message: {role: 'user', content: 'steering private-value'},
    });
    expect(a.promptHistory({scope: 'project', workspace: '/project-a'}).map(p => p.content)).toEqual([
      'submitted in a',
    ]);
    expect(b.promptHistory({scope: 'project', workspace: '/project-b'}).map(p => p.content)).toEqual([
      'steering [redacted]',
      'running in b',
      'submitted after resume in b',
    ]);
    b.retractQueuedInput(id, [{steerId, content: 'steering private-value'}], {includeShell: false});
    expect(b.promptHistory({scope: 'project', workspace: '/project-b'}).some(p => p.content.includes('steering'))).toBe(
      false,
    );
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('Auto clears an effort even without declared levels; session reset never persists', () => {
  const fixture = dialogFixture({cachedModels: () => [{...model, reasoningEfforts: undefined}]});
  const key = selection.accountId + ':' + model.id;
  fixture.settings.reasoningPreferences = {[key]: 'high'};
  const before = JSON.stringify(fixture.settings);
  fixture.client.setReasoningEffort('default', {scope: 'session'});
  expect(fixture.client.status().reasoningEffort).toBeNull();
  expect(JSON.stringify(fixture.settings)).toBe(before);
  fixture.client.setReasoningEffort('default');
  expect(fixture.settings.reasoningPreferences?.[key]).toBeUndefined();
  try {
    fixture.client.setReasoningEffort('high');
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toMatchObject({code: 'UNSUPPORTED'});
    expect((error as Error).message).toContain('No effort levels known');
  }
});

test('SDK uses the catalog’s selectable efforts and still permits Auto without a mapping', () => {
  for (const protocol of ['anthropic', 'gemini'] as const) {
    let current = {...model, reasoningEfforts: undefined as string[] | undefined};
    const fixture = dialogFixture({cachedModels: () => [current]});
    fixture.settings.providers = fixture.settings.providers.map(provider => ({...provider, protocol}));
    try {
      fixture.client.setReasoningEffort('high');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({code: 'UNSUPPORTED', message: expect.stringContaining(`${protocol} protocol`)});
    }
    expect(() => fixture.client.setReasoningEffort('default')).not.toThrow();
    current = {...model, reasoningEfforts: ['high']};
    fixture.client.setReasoningEffort('high');
    expect(fixture.client.status().reasoningEffort).toBe('high');
  }
});
