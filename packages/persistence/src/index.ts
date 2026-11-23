import type {Database} from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {
  FutrynError,
  emptySettings,
  settingsSchema,
  themeIdSchema,
  themeManifestSchema,
  type Settings,
  type SettingsStore,
  type ThemeManifest,
} from '@cosmew/contracts';
export {openPrivateDatabase} from './database';
export {
  MigrationOutbox,
  REMOVED_RUNTIMES,
  REMOVED_RUNTIME_PROVIDER_IDS,
  REMOVED_CODEX_RUNTIMES,
  REMOVED_CODEX_PROVIDER_IDS,
  removeRuntimeProfiles,
} from './runtime-removal';
export {SqliteConversations} from './session-store';
export {ToolAuditStore, type ToolAuditEntry} from './tool-audit';

export class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Database) {}
  read(): Settings {
    try {
      const row = this.db.query('SELECT data FROM settings WHERE id=1').get() as {data: string} | null;
      return settingsSchema.parse(row ? JSON.parse(row.data) : emptySettings());
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  update(change: (settings: Settings) => void): void {
    try {
      this.db
        .transaction(() => {
          const settings = this.read();
          change(settings);
          const validated = settingsSchema.parse(settings);
          this.db
            .query('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
            .run(JSON.stringify(validated));
        })
        .immediate();
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
}

/** Read-only compatibility import. SQLite appearance/project rows are left in place. */
export function importLegacyAppearance(store: SettingsStore): import('@cosmew/contracts').PartialAppearanceConfig {
  return structuredClone(store.read().appearance ?? {});
}

export interface CustomThemeStoreResult {
  themes: ThemeManifest[];
  errors: {file: string; message: string}[];
}

export class FileCustomThemeStore {
  private readonly themesDir: string;
  constructor(rootDirectory: string) {
    const root = resolve(rootDirectory);
    this.themesDir = join(root, 'themes');
  }
  private ensureSafeDirectory(): void {
    mkdirSync(this.themesDir, {recursive: true, mode: 0o700});
    const stat = lstatSync(this.themesDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FutrynError('STORAGE');
    if (process.platform !== 'win32' && stat.mode & 0o077) chmodSync(this.themesDir, 0o700);
  }
  loadAll(): CustomThemeStoreResult {
    try {
      this.ensureSafeDirectory();
      const entries = readdirSync(this.themesDir);
      const themes: ThemeManifest[] = [];
      const errors: {file: string; message: string}[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith('.json')) continue;
        const fullPath = join(this.themesDir, entry);
        try {
          const stat = lstatSync(fullPath);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 262144) {
            errors.push({file: entry, message: 'Unsafe or oversized theme file refused'});
            continue;
          }
          const raw = JSON.parse(readFileSync(fullPath, 'utf8'));
          const parsed = themeManifestSchema.safeParse({...raw, builtIn: false, category: 'custom'});
          if (!parsed.success) {
            errors.push({file: entry, message: parsed.error.issues[0]?.message ?? 'Invalid theme manifest schema'});
            continue;
          }
          themes.push(parsed.data);
        } catch (err) {
          errors.push({file: entry, message: err instanceof Error ? err.message : 'Corrupted JSON file'});
        }
      }
      return {themes, errors};
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
  save(manifest: ThemeManifest): ThemeManifest {
    let validated: ThemeManifest;
    try {
      validated = themeManifestSchema.parse({...manifest, builtIn: false, category: 'custom'});
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
    try {
      this.ensureSafeDirectory();
      const targetPath = join(this.themesDir, `${validated.id}.json`);
      if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) throw new FutrynError('STORAGE');
      const tempPath = join(this.themesDir, `.${validated.id}.${crypto.randomUUID()}.tmp`);
      const serialized = JSON.stringify(validated, null, 2) + '\n';
      writeFileSync(tempPath, serialized, {encoding: 'utf8', mode: 0o600});
      const fd = openSync(tempPath, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tempPath, targetPath);
      if (process.platform !== 'win32') chmodSync(targetPath, 0o600);
      return validated;
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
  remove(id: string): boolean {
    let validId: string;
    try {
      validId = themeIdSchema.parse(id);
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
    try {
      this.ensureSafeDirectory();
      const targetPath = join(this.themesDir, `${validId}.json`);
      if (!existsSync(targetPath)) return false;
      if (lstatSync(targetPath).isSymbolicLink()) {
        unlinkSync(targetPath);
        return true;
      }
      rmSync(targetPath, {force: true});
      return true;
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
}

export {FileMemories} from './memories';

export {SqliteToolOutputArchive} from './output-archive';

export {CheckpointStore} from './checkpoint-store';

export {SqliteBackgroundTaskHistory, type BackgroundTaskHistory} from './background-task-history';

export {FileMcpAuthStore} from './mcp-auth';
export {FileMcpInstallStore, type ManagedMcpInstallRecord} from './mcp-install';

export {FileMcpSettings, type McpSettingsDocument, type McpSettingsRead} from './mcp-settings';
