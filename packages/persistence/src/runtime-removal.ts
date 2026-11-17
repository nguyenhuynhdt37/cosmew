import type {Database} from 'bun:sqlite';
import {FutrynError, type CredentialRef} from '@futryn/contracts';

/**
 * Subscription runtimes that were chat-only and are removed (ADR 0045): Copilot CLI, Gemini CLI,
 * Qwen Code and Grok Build. Their accounts are logged out and removed; only those accounts and
 * their own catalog/selection/preference rows are touched.
 */
export const REMOVED_RUNTIMES: readonly string[] = ['copilot', 'gemini-cli', 'qwen-code', 'grok-build'];
export const REMOVED_RUNTIME_PROVIDER_IDS: readonly string[] = [
  'github-copilot',
  'google-subscription',
  'qwen-subscription',
  'grok-subscription',
];

export function ensureMigrationTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS credential_cleanup (
      id INTEGER PRIMARY KEY AUTOINCREMENT, credential TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS startup_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);`);
}

/** Runs inside the schema transaction, on raw settings JSON before any schema parsing. */
export function migrateRemovedRuntimes(db: Database): void {
  ensureMigrationTables(db);
  const row = db.query('SELECT data FROM settings WHERE id=1').get() as {data: string} | null;
  if (!row) return;
  let settings: any;
  try {
    settings = JSON.parse(row.data);
  } catch {
    return;
  }
  const providers: any[] = Array.isArray(settings.providers) ? settings.providers : [];
  const accounts: any[] = Array.isArray(settings.accounts) ? settings.accounts : [];
  const removedProviderIds = new Set<string>(
    providers
      .filter(p => REMOVED_RUNTIMES.includes(p?.runtime) || REMOVED_RUNTIME_PROVIDER_IDS.includes(p?.id))
      .map(p => p.id),
  );
  for (const id of REMOVED_RUNTIME_PROVIDER_IDS) removedProviderIds.add(id);
  const removed = accounts.filter(
    a => removedProviderIds.has(a?.providerId) || REMOVED_RUNTIMES.includes(a?.credential?.runtime),
  );
  if (!removedProviderIds.size || (!removed.length && !providers.some(p => removedProviderIds.has(p?.id)))) return;

  const removedIds = new Set<string>(removed.map(a => a.id));
  const insert = db.query('INSERT INTO credential_cleanup(credential) VALUES(?)');
  for (const account of removed) {
    // Only the vault entry key matters for deletion; the removed runtime names no longer parse as references.
    const credential = account.credential;
    if (['keyring', 'runtime'].includes(credential?.kind) && typeof credential.key === 'string')
      insert.run(JSON.stringify({kind: credential.kind, key: credential.key}));
  }

  settings.providers = providers.filter(p => !removedProviderIds.has(p?.id));
  settings.accounts = accounts.filter(a => !removedIds.has(a?.id));
  if (Array.isArray(settings.catalogs))
    settings.catalogs = settings.catalogs.filter((c: any) => !removedIds.has(c?.accountId));
  if (settings.projects && typeof settings.projects === 'object')
    for (const [path, selected] of Object.entries<any>(settings.projects))
      if (removedIds.has(selected?.accountId)) delete settings.projects[path];
  if (settings.reasoningPreferences && typeof settings.reasoningPreferences === 'object')
    for (const key of Object.keys(settings.reasoningPreferences))
      if ([...removedIds].some(id => key.startsWith(id + ':'))) delete settings.reasoningPreferences[key];

  const usable = (settings.accounts as any[]).filter(a => a.status !== 'logged-out');
  const replacement = usable.find(a => a.status === 'valid') ?? usable[0];
  const activeRemoved = removedIds.has(settings.activeAccountId);
  const selectionRemoved = removedIds.has(settings.selection?.accountId);
  if (activeRemoved) settings.activeAccountId = replacement?.id ?? null;
  if (activeRemoved || selectionRemoved)
    settings.selection =
      replacement && replacement.defaultModel ? {accountId: replacement.id, modelId: replacement.defaultModel} : null;
  if (settings.selection && !settings.accounts.some((a: any) => a.id === settings.selection.accountId))
    settings.selection = null;

  db.query('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(settings));
  const names = removed.map(a => a.alias).filter(Boolean);
  db.query('INSERT INTO startup_notices(message) VALUES(?)').run(
    `Removed chat-only subscription runtimes (Copilot CLI, Gemini CLI, Qwen Code, Grok Build)${
      names.length ? `; signed out and deleted account(s): ${names.join(', ')}` : ''
    }. ${
      replacement
        ? `Active account is now ${replacement.alias}.`
        : 'No usable account is left; use /login to connect one.'
    }`,
  );
}

/** Credentials and notices the migration left for the composition root, which owns the vault. */
export class MigrationOutbox {
  constructor(private readonly db: Database) {
    ensureMigrationTables(db);
  }
  pendingCredentials(): {id: number; credential: CredentialRef}[] {
    const rows = this.db.query('SELECT id, credential FROM credential_cleanup ORDER BY id').all() as {
      id: number;
      credential: string;
    }[];
    return rows.flatMap(row => {
      try {
        const {kind, key} = JSON.parse(row.credential);
        if (typeof key !== 'string' || !['keyring', 'runtime'].includes(kind)) throw new Error('not a reference');
        // The vault addresses entries by key alone; the runtime tag only satisfies the reference type.
        const credential: CredentialRef = kind === 'keyring' ? {kind, key} : {kind: 'runtime', key, runtime: 'codex'};
        return [{id: row.id, credential}];
      } catch {
        // A row that is not a vault reference has nothing to delete.
        this.done(row.id);
        return [];
      }
    });
  }
  done(id: number): void {
    this.db.query('DELETE FROM credential_cleanup WHERE id=?').run(id);
  }
  /** One-time notices: returned once, then forgotten. */
  takeNotices(): string[] {
    try {
      return this.db
        .transaction(() => {
          const rows = this.db.query('SELECT id, message FROM startup_notices ORDER BY id').all() as {
            id: number;
            message: string;
          }[];
          this.db.exec('DELETE FROM startup_notices');
          return rows.map(r => r.message);
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
}
