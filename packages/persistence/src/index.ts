import type { Database } from 'bun:sqlite';
import { HannesError, emptySettings, settingsSchema, type Settings, type SettingsStore } from '@hannes/contracts';
export { openPrivateDatabase } from './database';
export { SqliteConversations } from './session-store';

export class SqliteSettings implements SettingsStore {
  constructor(private readonly db: Database) {}
  read(): Settings {
    try {
      const row = this.db.query('SELECT data FROM settings WHERE id=1').get() as { data: string } | null;
      return settingsSchema.parse(row ? JSON.parse(row.data) : emptySettings());
    } catch { throw new HannesError('STORAGE'); }
  }
  update(change: (settings: Settings) => void): void {
    try {
      this.db.transaction(() => {
        const settings = this.read(); change(settings); const validated = settingsSchema.parse(settings);
        this.db.query('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(validated));
      }).immediate();
    } catch (e) { if (e instanceof HannesError) throw e; throw new HannesError('STORAGE'); }
  }
}
