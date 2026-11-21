import {
  FutrynError,
  accountSchema,
  type Account,
  type CredentialRef,
  type CredentialVault,
  type SettingsStore,
} from '@cosmew/contracts';

/** API-key and OAuth providers keep a credential; `none` and `command` providers have none to store. */
const holdsCredential = (provider: {auth: string}) => provider.auth === 'api-key' || provider.auth === 'oauth';

export class AccountManager {
  constructor(
    private readonly store: SettingsStore,
    private readonly vault: CredentialVault,
  ) {}
  list() {
    return this.store.read().accounts;
  }
  get(id: string): Account {
    const accounts = this.list();
    const a = accounts.find(a => a.id === id) ?? accounts.find(a => a.alias === id);
    if (!a) throw new FutrynError('NOT_FOUND');
    return a;
  }
  async add(providerId: string, alias: string, credential: CredentialRef, secret?: string): Promise<Account> {
    await this.rejectDuplicate(providerId, credential, secret);
    const account = accountSchema.parse({
      id: crypto.randomUUID(),
      providerId,
      alias,
      credential,
      status: 'unvalidated',
      validatedAt: null,
      authGeneration: 1,
    });
    const state = this.store.read();
    if (
      !state.providers.some(p => p.id === providerId) ||
      state.accounts.some(
        a =>
          a.alias === alias ||
          (credential.kind === 'keyring' && a.credential.kind === 'keyring' && a.credential.key === credential.key),
      )
    )
      throw new FutrynError('INVALID_INPUT');
    if (credential.kind === 'keyring') {
      if (!secret) throw new FutrynError('AUTH');
      await this.vault.set(credential.key, secret);
    }
    try {
      this.store.update(s => {
        const provider = s.providers.find(p => p.id === providerId);
        if (!provider || s.accounts.some(a => a.alias === alias)) throw new FutrynError('INVALID_INPUT');
        if (holdsCredential(provider) === (credential.kind === 'none')) throw new FutrynError('AUTH');
        s.accounts.push(account);
        if (!s.activeAccountId) s.activeAccountId = account.id;
      });
    } catch (e) {
      if (credential.kind === 'keyring') await this.vault.delete(credential);
      throw e;
    }
    return account;
  }
  use(id: string): Account {
    const a = this.get(id);
    if (a.status === 'logged-out') throw new FutrynError('AUTH');
    if (this.store.read().activeAccountId === a.id) return a;
    this.store.update(s => {
      s.activeAccountId = a.id;
      s.selection = a.defaultModel ? {accountId: a.id, modelId: a.defaultModel} : null;
    });
    return a;
  }
  async reauthenticate(id: string, credential: CredentialRef, secret?: string): Promise<Account> {
    const current = this.get(id);
    const provider = this.store.read().providers.find(p => p.id === current.providerId)!;
    accountSchema.parse({...current, credential});
    if (holdsCredential(provider) === (credential.kind === 'none')) throw new FutrynError('AUTH');
    // Stage all user input before fencing the existing identity. A missing key or a keyring
    // failure must leave the current account usable so a retry does not require a second login.
    if (
      credential.kind === 'keyring' &&
      current.credential.kind === 'keyring' &&
      credential.key === current.credential.key
    )
      throw new FutrynError('INVALID_INPUT');
    if (credential.kind === 'keyring' && !secret) throw new FutrynError('AUTH');
    if (
      credential.kind === 'keyring' &&
      this.list().some(a => a.credential.kind === 'keyring' && a.credential.key === credential.key)
    )
      throw new FutrynError('INVALID_INPUT');
    await this.rejectDuplicate(current.providerId, credential, secret, current.id);
    if (credential.kind === 'keyring') {
      if (!secret) throw new FutrynError('AUTH');
      await this.vault.set(credential.key, secret);
    }
    try {
      // Logout fences routing and removes the old secret. It is intentionally after staging the
      // replacement so invalid input or an unavailable keyring cannot strand the account.
      await this.logout(current.id);
      this.store.update(s => {
        const a = s.accounts.find(a => a.id === current.id)!;
        a.credential = credential;
        a.authGeneration = (a.authGeneration ?? 1) + 1;
        a.status = 'unvalidated';
        a.validatedAt = null;
        if (!s.activeAccountId) s.activeAccountId = a.id;
      });
    } catch (e) {
      if (credential.kind === 'keyring') await this.vault.delete(credential);
      throw e;
    }
    return this.get(current.id);
  }
  /** Compare locally saved identity without persisting or logging identity/token data. */
  private async rejectDuplicate(
    providerId: string,
    credential: CredentialRef,
    secret?: string,
    exceptId?: string,
  ): Promise<void> {
    const identity = async (ref: CredentialRef, supplied?: string): Promise<string | undefined> => {
      if (ref.kind === 'none') return undefined;
      return supplied ?? (await this.vault.get(ref));
    };
    const incoming = await identity(credential, secret);
    if (!incoming) return;
    for (const account of this.list()) {
      if (account.id === exceptId || account.providerId !== providerId || account.status === 'logged-out') continue;
      if ((await identity(account.credential)) === incoming) throw new FutrynError('INVALID_INPUT');
    }
  }
  rename(id: string, alias: string): void {
    const a = this.get(id);
    accountSchema.parse({...a, alias});
    this.store.update(s => {
      if (s.accounts.some(x => x.alias === alias && x.id !== a.id)) throw new FutrynError('INVALID_INPUT');
      s.accounts.find(x => x.id === a.id)!.alias = alias;
    });
  }
  validation(id: string, valid: boolean, expected?: Account): void {
    const a = this.get(id);
    this.store.update(s => {
      const row = s.accounts.find(x => x.id === a.id)!;
      if (
        row.status === 'logged-out' ||
        (expected &&
          ((row.authGeneration ?? 1) !== (expected.authGeneration ?? 1) ||
            JSON.stringify(row.credential) !== JSON.stringify(expected.credential)))
      )
        throw new FutrynError('POLICY');
      row.status = valid ? 'valid' : 'invalid';
      row.validatedAt = new Date().toISOString();
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
      for (const [path, selected] of Object.entries(s.projects))
        if (selected.accountId === a.id) delete s.projects[path];
    });
    await this.vault.delete(a.credential);
    if (remove)
      this.store.update(s => {
        s.accounts = s.accounts.filter(x => x.id !== a.id);
        for (const key of Object.keys(s.reasoningPreferences ?? {}))
          if (key.startsWith(a.id + ':')) delete s.reasoningPreferences![key];
      });
  }
}
