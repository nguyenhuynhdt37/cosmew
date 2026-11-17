import type {Database} from 'bun:sqlite';
import {lstatSync, rmSync} from 'node:fs';
import {join} from 'node:path';
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

/**
 * The Codex app-server runtime is removed too (ADR 0049): Futryn only calls provider APIs and owns the
 * loop and every tool. Its `chatgpt` accounts (runtime credentials) are deleted; `chatgpt-api` stays.
 */
export const REMOVED_CODEX_RUNTIMES: readonly string[] = ['codex'];
export const REMOVED_CODEX_PROVIDER_IDS: readonly string[] = ['chatgpt'];

interface RemovalSpec {
  runtimes: readonly string[];
  providerIds: readonly string[];
  notice: string;
}

const CHAT_ONLY_REMOVAL: RemovalSpec = {
  runtimes: REMOVED_RUNTIMES,
  providerIds: REMOVED_RUNTIME_PROVIDER_IDS,
  notice: 'Removed chat-only subscription runtimes (Copilot CLI, Gemini CLI, Qwen Code, Grok Build)',
};
const CODEX_REMOVAL: RemovalSpec = {
  runtimes: REMOVED_CODEX_RUNTIMES,
  providerIds: REMOVED_CODEX_PROVIDER_IDS,
  notice:
    'Removed the Codex CLI runtime (ChatGPT subscription · Codex CLI); use "ChatGPT subscription · API" to sign in again',
};

/** v7 (ADR 0045). Runs inside the schema transaction, on raw settings JSON before any schema parsing. */
export function migrateRemovedRuntimes(db: Database): void {
  removeRuntimes(db, CHAT_ONLY_REMOVAL);
}

/** v8 (ADR 0049): the Codex runtime, its accounts and its process leases. */
export function migrateRemovedCodexRuntime(db: Database): void {
  db.exec('DROP TABLE IF EXISTS runtime_leases');
  removeRuntimes(db, CODEX_REMOVAL);
}

function removeRuntimes(db: Database, spec: RemovalSpec): void {
  const {runtimes, providerIds} = spec;
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
    providers.filter(p => runtimes.includes(p?.runtime) || providerIds.includes(p?.id)).map(p => p.id),
  );
  for (const id of providerIds) removedProviderIds.add(id);
  const removed = accounts.filter(
    a => removedProviderIds.has(a?.providerId) || runtimes.includes(a?.credential?.runtime),
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
    `${spec.notice}${names.length ? `; signed out and deleted account(s): ${names.join(', ')}` : ''}. ${
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
        // The vault addresses entries by key alone, so a removed runtime's entry deletes as a keyring key.
        const credential: CredentialRef = {kind: 'keyring', key};
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

/**
 * Codex runtime profiles (ADR 0049) lived in `<state>/runtime-tmp/profile-*` and could hold a copy of
 * the runtime's auth.json after a crash. Removed at startup; a symlink is unlinked, never followed.
 */
export function removeRuntimeProfiles(stateDirectory: string): void {
  const base = join(stateDirectory, 'runtime-tmp');
  try {
    if (lstatSync(base).isSymbolicLink()) {
      rmSync(base, {force: true});
      return;
    }
  } catch {
    return;
  }
  rmSync(base, {recursive: true, force: true});
}
