import { HannesError, accountSchema, type Account, type CredentialRef, type CredentialVault, type SettingsStore } from '@hannes/contracts';

export class AccountManager {
  constructor(private readonly store: SettingsStore, private readonly vault: CredentialVault) {}
  list() { return this.store.read().accounts; }
  get(id: string): Account { const accounts = this.list(); const a = accounts.find(a => a.id === id) ?? accounts.find(a => a.alias === id); if (!a) throw new HannesError('NOT_FOUND'); return a; }
  async add(providerId: string, alias: string, credential: CredentialRef, secret?: string): Promise<Account> {
    await this.rejectDuplicate(providerId, credential, secret);
    const account = accountSchema.parse({ id: crypto.randomUUID(), providerId, alias, credential, status: 'unvalidated', validatedAt: null, authGeneration: 1 });
    const state = this.store.read();
    if (!state.providers.some(p => p.id === providerId) || state.accounts.some(a => a.alias === alias || ((credential.kind === 'keyring' || credential.kind === 'runtime') && (a.credential.kind === 'keyring' || a.credential.kind === 'runtime') && a.credential.key === credential.key))) throw new HannesError('INVALID_INPUT');
    if (credential.kind === 'keyring') { if (!secret) throw new HannesError('AUTH'); await this.vault.set(credential.key, secret); }
    try {
      this.store.update(s => {
        const provider = s.providers.find(p => p.id === providerId);
        if (!provider || s.accounts.some(a => a.alias === alias)) throw new HannesError('INVALID_INPUT');
        if ((credential.kind === 'runtime' ? provider.runtime !== credential.runtime : !!provider.runtime) || (provider.auth === 'api-key') === (credential.kind === 'none')) throw new HannesError('AUTH');
        s.accounts.push(account); if (!s.activeAccountId) s.activeAccountId = account.id;
      });
    } catch (e) { if (credential.kind === 'keyring') await this.vault.delete(credential); throw e; }
    return account;
  }
  use(id: string): Account {
    const a = this.get(id); if (a.status === 'logged-out') throw new HannesError('AUTH');
    if (this.store.read().activeAccountId === a.id) return a;
    this.store.update(s => { s.activeAccountId = a.id; s.selection = a.defaultModel ? { accountId: a.id, modelId: a.defaultModel } : null; }); return a;
  }
  async reauthenticate(id: string, credential: CredentialRef, secret?: string): Promise<Account> {
    const current = this.get(id); const provider = this.store.read().providers.find(p => p.id === current.providerId)!;
    accountSchema.parse({ ...current, credential });
    if ((credential.kind === 'runtime' ? provider.runtime !== credential.runtime : !!provider.runtime) || (provider.auth === 'api-key') === (credential.kind === 'none')) throw new HannesError('AUTH');
    if ((credential.kind === 'keyring' || credential.kind === 'runtime') && this.list().some(a => (a.credential.kind === 'keyring' || a.credential.kind === 'runtime') && a.credential.key === credential.key)) throw new HannesError('INVALID_INPUT');
    await this.rejectDuplicate(current.providerId, credential, secret, current.id);
    await this.logout(current.id);
    if (credential.kind === 'keyring') { if (!secret) throw new HannesError('AUTH'); await this.vault.set(credential.key, secret); }
    try {
      this.store.update(s => { const a = s.accounts.find(a => a.id === current.id)!; a.credential = credential; a.authGeneration = (a.authGeneration ?? 1) + 1; a.status = 'unvalidated'; a.validatedAt = null; if (!s.activeAccountId) s.activeAccountId = a.id; });
    } catch (e) { if (credential.kind === 'keyring') await this.vault.delete(credential); throw e; }
    return this.get(current.id);
  }
  /** Compare locally saved identity without persisting or logging identity/token data. */
  private async rejectDuplicate(providerId: string, credential: CredentialRef, secret?: string, exceptId?: string): Promise<void> {
    const identity = async (ref: CredentialRef, supplied?: string): Promise<string | undefined> => {
      if (ref.kind === 'none') return undefined;
      if (ref.kind !== 'runtime') return supplied ?? await this.vault.get(ref);
      const record = await this.vault.getRuntime?.(ref);
      if (!record) return undefined;
      try {
        const files = JSON.parse(record).files;
        if (ref.runtime === 'codex') {
          const auth = JSON.parse(files['auth.json']);
          if (typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id) return 'codex:' + auth.tokens.account_id;
        }
        // Exact snapshots also catch reused credentials when no stable identity is supplied.
        return record;
      } catch { throw new HannesError('AUTH'); }
    };
    const incoming = await identity(credential, secret);
    if (!incoming) return;
    for (const account of this.list()) {
      if (account.id === exceptId || account.providerId !== providerId || account.status === 'logged-out') continue;
      if (await identity(account.credential) === incoming) throw new HannesError('INVALID_INPUT');
    }
  }
  rename(id: string, alias: string): void {
    const a = this.get(id); accountSchema.parse({ ...a, alias });
    this.store.update(s => { if (s.accounts.some(x => x.alias === alias && x.id !== a.id)) throw new HannesError('INVALID_INPUT'); s.accounts.find(x => x.id === a.id)!.alias = alias; });
  }
  validation(id: string, valid: boolean, expected?: Account): void {
    const a = this.get(id); this.store.update(s => {
      const row = s.accounts.find(x => x.id === a.id)!;
      if (row.status === 'logged-out' || (expected && ((row.authGeneration ?? 1) !== (expected.authGeneration ?? 1) || JSON.stringify(row.credential) !== JSON.stringify(expected.credential)))) throw new HannesError('POLICY');
      row.status = valid ? 'valid' : 'invalid'; row.validatedAt = new Date().toISOString();
    });
  }
  async logout(id: string, remove = false): Promise<void> {
    const a = this.get(id);
    // Fence routing first, even if OS vault deletion fails. A retry can complete deletion.
    this.store.update(s => {
      s.accounts.find(x => x.id === a.id)!.status = 'logged-out';
      s.accounts.find(x => x.id === a.id)!.authGeneration = (a.authGeneration ?? 1) + 1;
      if (s.activeAccountId === a.id) s.activeAccountId = null;
      if (s.selection?.accountId === a.id) s.selection = null;
      s.catalogs = s.catalogs.filter(c => c.accountId !== a.id);
      for (const [path, selected] of Object.entries(s.projects)) if (selected.accountId === a.id) delete s.projects[path];
    });
    await this.vault.delete(a.credential);
    if (remove) this.store.update(s => {
      s.accounts = s.accounts.filter(x => x.id !== a.id);
      for (const key of Object.keys(s.reasoningPreferences ?? {})) if (key.startsWith(a.id + ':')) delete s.reasoningPreferences![key];
    });
  }
}
