import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultStateDirectory} from '../../apps/cli/src/bootstrap/paths';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {providerPresets} from '@cosmew/models';
import {defaultAppearance, type TurnReceipt} from '@cosmew/contracts';

for (const legacyName of ['.futryn', '.hannes']) {
  test(`${legacyName} state moves to .cosmew with accounts, selection, settings and journal intact`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cosmew-legacy-migration-'));
    const legacy = join(home, legacyName);
    const vault = memoryVault();
    let app = startup(legacy, {vault});
    try {
      app.registry.add(providerPresets.find(provider => provider.id === 'openai')!);
      const key = crypto.randomUUID();
      const account = await app.accounts.add('openai', 'legacy-account', {kind: 'keyring', key}, 'fixture-secret');
      const selection = {accountId: account.id, modelId: 'legacy-model'};
      app.settings.update(settings => {
        settings.selection = selection;
        settings.appearance = {...defaultAppearance(), theme: 'dark'};
      });
      const id = app.conversations.create(selection);
      const message = {role: 'user' as const, content: 'Durable message before the rename'};
      const receipt: TurnReceipt = {
        requestId: crypto.randomUUID(),
        ...selection,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        outcome: 'pending',
        usage: null,
        context: null,
      };
      const revision = app.conversations.beginExecution(id, message, receipt);
      app.conversations.recordExecution(id, receipt.requestId, {type: 'assistant.text', text: 'Journal evidence'});
      app.conversations.complete(id, revision, {role: 'assistant', content: 'Journal evidence'});
      const journal = app.conversations.recover(id);
      await app.shutdownCommands();
      app.db.close();
      const database = join(home, '.cosmew', 'provider-auth.sqlite');
      const before = databaseBytes(join(legacy, 'provider-auth.sqlite'));
      const inode = statSync(join(legacy, 'provider-auth.sqlite')).ino;
      expect(defaultStateDirectory({}, home)).toBe(join(home, '.cosmew'));
      app = startup(defaultStateDirectory({}, home), {vault});
      expect(app.accounts.get(account.id).alias).toBe('legacy-account');
      expect(app.accounts.get('legacy-account').id).toBe(account.id);
      expect(await vault.get(app.accounts.get(account.id).credential)).toBe('fixture-secret');
      expect(app.router.resolve()).toEqual(selection);
      expect(app.settings.read().appearance?.theme).toBe('dark');
      expect(app.conversations.list().some(session => session.id === id)).toBe(true);
      expect(app.conversations.get(id)?.messages).toContainEqual(expect.objectContaining(message));
      expect(app.conversations.recover(id).messages).toContainEqual(expect.objectContaining(message));
      expect(app.conversations.recover(id)).toEqual(journal);
      expect(existsSync(legacy)).toBe(false);
      expect(statSync(database).ino).toBe(inode);
      await app.shutdownCommands();
      app.db.close();
      expect(databaseBytes(database)).toEqual(before);
      const isolated = join(home, 'explicit-new-state');
      app = startup(defaultStateDirectory({COSMEW_HOME: isolated}, home), {vault});
      expect(app.settings.read().accounts).toEqual([]);
      expect(app.settings.read().selection).toBeNull();
      expect(app.conversations.list()).toEqual([]);
      expect(databaseBytes(database)).toEqual(before);
      expect(existsSync(join(home, '.cosmew'))).toBe(true);
    } finally {
      await app.shutdownCommands();
      app.db.close();
      rmSync(home, {recursive: true, force: true});
    }
  });
}

// SQLite increments these two header counters when startup opens a transaction, even with no data changes.
function databaseBytes(path: string) {
  const bytes = readFileSync(path);
  bytes.fill(0, 24, 28);
  bytes.fill(0, 92, 96);
  return bytes;
}
