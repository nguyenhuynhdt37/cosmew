import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, chmodSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptySettings, providerSchema, requestSchema, modelIdSchema, FutrynError} from '@futryn/contracts';
import {
  ConfiguredNetworkPolicy,
  Redactor,
  SecureVault,
  fetchModelsDev,
  terminalText,
  validateEndpoint,
} from '@futryn/security';
import {openPrivateDatabase, SqliteSettings, SqliteConversations} from '@futryn/persistence';

test('strict contract rejects executable fields, unknown versions and invalid requests', () => {
  expect(() => providerSchema.parse({...provider, execute: 'shell'})).toThrow();
  expect(() => requestSchema.parse({requestId: crypto.randomUUID(), modelId: '../bad model', messages: []})).toThrow();
  expect(emptySettings().schemaVersion).toBe(1);
  expect(modelIdSchema.parse('~openai/provider-alias-latest')).toBe('~openai/provider-alias-latest');
});
const provider = providerSchema.parse({
  id: 'local',
  name: 'Local',
  protocol: 'chat',
  baseURL: 'http://127.0.0.1:1234/v1',
  auth: 'none',
  catalog: 'openai',
  metadataVersion: 1,
});
test('network policy binds account, requires auth and rejects URL credential/query/remote HTTP', () => {
  for (const url of [
    'http://example.com/v1',
    'https://key@host/v1',
    'https://host/v1?key=secret',
    'https://host/#x',
    'file:///tmp/a',
  ])
    expect(() => validateEndpoint(url)).toThrow();
  expect(validateEndpoint(provider.baseURL)).toBe(provider.baseURL);
  const policy = new ConfiguredNetworkPolicy();
  expect(() =>
    policy.authorize(provider, {
      id: crypto.randomUUID(),
      providerId: 'wrong',
      alias: 'a',
      credential: {kind: 'none'},
      status: 'valid',
      validatedAt: null,
    }),
  ).toThrow();
});
test('environment references remain isolated; redaction and diagnostics exclude raw secrets', async () => {
  const redactor = new Redactor();
  const vault = new SecureVault(redactor, {KEY_A: 'private-value', KEY_B: 'other-value'});
  expect(await vault.get({kind: 'env', name: 'KEY_A'})).toBe('private-value');
  expect(await vault.get({kind: 'env', name: 'MISSING'})).toBeUndefined();
  await vault.delete({kind: 'env', name: 'KEY_A'});
  expect(redactor.text('Bearer secret private-value sk-testkey')).toBe('Bearer [REDACTED] [REDACTED] [REDACTED]');
  expect(JSON.stringify(new FutrynError('AUTH'))).not.toContain('private-value');
  expect(terminalText('\x1b]52;attack\x07hello')).not.toContain('\x1b');
});
test('private SQLite settings survive restart, reject malformed updates and fence conversation outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hannes-foundation-'));
  chmodSync(dir, 0o700);
  try {
    let db = openPrivateDatabase(dir);
    const settings = new SqliteSettings(db);
    settings.update(s => s.providers.push(provider));
    expect(() =>
      settings.update(s => {
        (s as any).schemaVersion = 2;
      }),
    ).toThrow();
    expect(() => settings.update(s => s.providers.push(provider))).toThrow();
    expect(settings.read().providers).toHaveLength(1);
    const sessions = new SqliteConversations(db);
    const id = sessions.create({accountId: crypto.randomUUID(), modelId: 'test'});
    const rev = sessions.append(id, {role: 'user', content: 'hi'}, 'pending');
    expect(() => sessions.complete(id, rev + 1, {role: 'assistant', content: 'wrong'})).toThrow();
    sessions.complete(id, rev, {role: 'assistant', content: 'hello'});
    expect(() => sessions.complete(id, rev, {role: 'assistant', content: 'duplicate'})).toThrow();
    db.close();
    db = openPrivateDatabase(dir);
    expect(new SqliteSettings(db).read().providers[0]?.id).toBe('local');
    db.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
test('symlink store and insecure root are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hannes-insecure-'));
  try {
    chmodSync(dir, 0o755);
    expect(() => openPrivateDatabase(dir)).toThrow();
    chmodSync(dir, 0o700);
    symlinkSync('/tmp/should-not-be-opened', join(dir, 'provider-auth.sqlite'));
    expect(() => openPrivateDatabase(dir)).toThrow();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
test('advisory catalog capability fixes the destination and omits credentials', async () => {
  const data = await fetchModelsDev(undefined, (async (url, init) => {
    expect(String(url)).toBe('https://models.dev/api.json');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toBeUndefined();
    return Response.json({fixture: {models: {}}});
  }) as typeof fetch);
  expect(data).toEqual({fixture: {models: {}}});
});
