import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase} from '@futryn/persistence';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const provider = (id: string, runtime?: string) => ({
  id,
  name: id,
  protocol: 'chat',
  baseURL: 'https://example.test',
  auth: 'api-key',
  catalog: 'manual',
  metadataVersion: 1,
  timeoutMs: 60000,
  ...(runtime ? {runtime} : {}),
});
const account = (id: string, providerId: string, alias: string, credential: object, extra: object = {}) => ({
  id,
  providerId,
  alias,
  credential,
  status: 'valid',
  validatedAt: '2026-11-01T00:00:00.000Z',
  authGeneration: 1,
  ...extra,
});
const ID = {
  grok: '00000000-0000-4000-8000-000000000001',
  copilot: '00000000-0000-4000-8000-000000000002',
  codex: '00000000-0000-4000-8000-000000000003',
  openai: '00000000-0000-4000-8000-000000000004',
};
const KEY = {
  grok: '10000000-0000-4000-8000-000000000001',
  copilot: '10000000-0000-4000-8000-000000000002',
  codex: '10000000-0000-4000-8000-000000000003',
  openai: '10000000-0000-4000-8000-000000000004',
};

/** A database as the previous release left it: schema v6 with removed-runtime accounts selected. */
function legacyHome() {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-runtime-removal-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  const db = openPrivateDatabase(dir);
  const settings = {
    schemaVersion: 1,
    providers: [
      provider('grok-subscription', 'grok-build'),
      provider('github-copilot', 'copilot'),
      {...provider('chatgpt', 'codex'), baseURL: 'https://chatgpt.com'},
      provider('openai'),
    ],
    accounts: [
      account(ID.grok, 'grok-subscription', 'grok', {kind: 'runtime', key: KEY.grok, runtime: 'grok-build'}),
      account(ID.copilot, 'github-copilot', 'copilot', {kind: 'runtime', key: KEY.copilot, runtime: 'copilot'}),
      account(
        ID.codex,
        'chatgpt',
        'codex',
        {kind: 'runtime', key: KEY.codex, runtime: 'codex'},
        {defaultModel: 'gpt-5'},
      ),
      account(ID.openai, 'openai', 'openai', {kind: 'keyring', key: KEY.openai}),
    ],
    activeAccountId: ID.grok,
    selection: {accountId: ID.grok, modelId: 'grok-4'},
    projects: {
      '/work/a': {accountId: ID.grok, modelId: 'grok-4'},
      '/work/b': {accountId: ID.openai, modelId: 'gpt-5'},
    },
    catalogs: [],
    reasoningPreferences: {[`${ID.grok}:grok-4`]: 'high', [`${ID.openai}:gpt-5`]: 'low'},
  };
  db.query('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(
    JSON.stringify(settings),
  );
  db.exec("INSERT INTO conversations(id, selection) VALUES('keep-me', '{}')");
  db.exec('DROP TABLE IF EXISTS credential_cleanup; DROP TABLE IF EXISTS startup_notices; PRAGMA user_version=6;');
  db.close();
  return dir;
}

function seededVault() {
  const vault = memoryVault();
  for (const key of Object.values(KEY)) vault.values.set(key, 'secret-' + key);
  return vault;
}

test('migration deletes removed-runtime credentials, keeps other accounts and re-selects a valid account', async () => {
  const dir = legacyHome();
  const vault = seededVault();
  const app = startup(dir, {vault});
  try {
    await app.migrationCleanup;
    expect([...vault.values.keys()].sort()).toEqual([KEY.codex, KEY.openai].sort());
    const state = app.settings.read();
    expect(state.providers.map(p => p.id).sort()).toEqual(['chatgpt', 'openai']);
    expect(state.accounts.map(a => a.id).sort()).toEqual([ID.codex, ID.openai].sort());
    // Other accounts are unchanged.
    expect(state.accounts.find(a => a.id === ID.openai)).toMatchObject({alias: 'openai', status: 'valid'});
    expect(state.accounts.find(a => a.id === ID.codex)).toMatchObject({alias: 'codex', defaultModel: 'gpt-5'});
    // The active account moved to a valid account instead of dangling.
    expect(state.activeAccountId).toBe(ID.codex);
    expect(state.selection).toEqual({accountId: ID.codex, modelId: 'gpt-5'});
    expect(Object.keys(state.projects)).toEqual(['/work/b']);
    expect(state.reasoningPreferences).toEqual({[`${ID.openai}:gpt-5`]: 'low'});
    // User data beyond the removed providers is untouched.
    expect(app.db.query("SELECT id FROM conversations WHERE id='keep-me'").get()).toBeTruthy();
    // One-time notice, delivered exactly once.
    const notices = app.takeStartupNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('grok');
    expect(notices[0]).toContain('copilot');
    expect(app.takeStartupNotices()).toEqual([]);
  } finally {
    await app.subscriptions.shutdown();
    app.db.close();
  }
  // Second start is a no-op.
  const again = startup(dir, {vault});
  try {
    await again.migrationCleanup;
    expect(again.takeStartupNotices()).toEqual([]);
    expect(again.settings.read().accounts).toHaveLength(2);
  } finally {
    await again.subscriptions.shutdown();
    again.db.close();
  }
});

test('a failed credential deletion stays queued and is retried on the next start', async () => {
  const dir = legacyHome();
  const vault = seededVault();
  const originalDelete = vault.delete.bind(vault);
  let failing = true;
  vault.delete = async ref => {
    if (failing && ref.kind === 'runtime' && ref.key === KEY.grok) throw new Error('keyring locked');
    return originalDelete(ref);
  };
  const first = startup(dir, {vault});
  try {
    await first.migrationCleanup;
    expect(vault.values.has(KEY.grok)).toBe(true); // not deleted yet
    expect(vault.values.has(KEY.copilot)).toBe(false);
    expect(first.settings.read().accounts.some(a => a.id === ID.grok)).toBe(false); // account is already gone
  } finally {
    first.db.close();
  }
  failing = false;
  const second = startup(dir, {vault});
  try {
    await second.migrationCleanup;
    expect(vault.values.has(KEY.grok)).toBe(false);
    expect(vault.values.has(KEY.codex) && vault.values.has(KEY.openai)).toBe(true);
  } finally {
    second.db.close();
  }
});

test('without any usable account left the selection is cleared instead of dangling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-runtime-removal-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  const db = openPrivateDatabase(dir);
  const settings = {
    schemaVersion: 1,
    providers: [provider('qwen-subscription', 'qwen-code')],
    accounts: [account(ID.grok, 'qwen-subscription', 'qwen', {kind: 'runtime', key: KEY.grok, runtime: 'qwen-code'})],
    activeAccountId: ID.grok,
    selection: {accountId: ID.grok, modelId: 'qwen3'},
    projects: {},
    catalogs: [],
  };
  db.query('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(
    JSON.stringify(settings),
  );
  db.exec('DROP TABLE IF EXISTS credential_cleanup; DROP TABLE IF EXISTS startup_notices; PRAGMA user_version=6;');
  db.close();
  const vault = seededVault();
  const app = startup(dir, {vault});
  try {
    await app.migrationCleanup;
    const state = app.settings.read();
    expect(state.accounts).toEqual([]);
    expect(state.activeAccountId).toBeNull();
    expect(state.selection).toBeNull();
    expect(vault.values.has(KEY.grok)).toBe(false);
    expect(app.takeStartupNotices()[0]).toContain('/login');
  } finally {
    app.db.close();
  }
});
