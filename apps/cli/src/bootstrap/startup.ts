import { homedir } from 'node:os';
import { join } from 'node:path';
import { HannesError, type Account } from '@hannes/contracts';
import { Conversation } from '@hannes/core';
import { AccountManager, ModelCatalog, ModelRouter, ProviderAdapter, ProviderRegistry, ProviderTransport } from '@hannes/models';
import { openPrivateDatabase, SqliteSettings, SqliteConversations } from '@hannes/persistence';
import { ConfiguredNetworkPolicy, Redactor, SecureVault, redactModel } from '@hannes/security';

export function startup(directory = process.env.HANNES_HOME ?? join(homedir(), '.hannes')) {
  process.umask(0o077);
  const db = openPrivateDatabase(directory); const settings = new SqliteSettings(db);
  const redactor = new Redactor(); const vault = new SecureVault(redactor);
  const registry = new ProviderRegistry(settings); const accounts = new AccountManager(settings, vault); const router = new ModelRouter(settings);
  const policy = new ConfiguredNetworkPolicy();
  const transport = (account: Account) => new ProviderTransport(registry.get(account.providerId), account, vault, {
    authorize(provider, a) {
      // Re-read durable grants before every network operation, so logout in another process fences new requests.
      const fresh = accounts.get(a.id);
      if ((fresh.authGeneration ?? 1) !== (a.authGeneration ?? 1) || JSON.stringify(fresh.credential) !== JSON.stringify(a.credential) || JSON.stringify(registry.get(provider.id)) !== JSON.stringify(provider)) throw new HannesError('POLICY');
      policy.authorize(provider, fresh);
    },
  });
  const catalog = (account: Account) => new ModelCatalog(settings, transport(account));
  const resolveAccount = (id?: string) => {
    const selected = id ?? settings.read().activeAccountId; if (!selected) throw new HannesError('AUTH'); return accounts.get(selected);
  };
  const conversation = (project?: string) => {
    const selection = router.resolve(project); const account = accounts.get(selection.accountId);
    const info = catalog(account).cached().find(m => m.id === selection.modelId); if (!info) throw new HannesError('NOT_FOUND');
    return new Conversation(selection, redactModel(new ProviderAdapter(transport(account), selection.modelId, info), redactor), new SqliteConversations(db));
  };
  return { db, settings, redactor, vault, registry, accounts, router, transport, catalog, resolveAccount, conversation };
}
export type Application = ReturnType<typeof startup>;
