import type {Database} from 'bun:sqlite';
import {FutrynError, type BackgroundTask} from '@cosmew/contracts';

/** Snapshots only: this store has no execution, recovery or process control capability. */
export interface BackgroundTaskHistory {
  save(sessionId: string, task: BackgroundTask): void;
  list(sessionId: string): BackgroundTask[];
}

export class SqliteBackgroundTaskHistory implements BackgroundTaskHistory {
  constructor(
    private readonly db: Database,
    private readonly redact: (text: string) => string,
  ) {}

  save(sessionId: string, task: BackgroundTask): void {
    if (task.kind !== 'shell') return;
    // Redact the complete fields before truncation so a boundary cannot expose a partial secret.
    const snapshot: BackgroundTask = {
      id: task.id,
      kind: 'shell',
      description: this.redact(task.description).slice(0, 1024),
      status: task.status,
      startedAt: task.startedAt,
      outputTail: this.redact(task.outputTail).slice(-8192),
      ...(task.exitCode === undefined ? {} : {exitCode: task.exitCode}),
    };
    try {
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO background_task_history(conversation,id,updated_at,data) VALUES(?,?,?,?)
          ON CONFLICT(conversation,id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data`,
          )
          .run(sessionId, snapshot.id, new Date().toISOString(), JSON.stringify(snapshot));
        this.db
          .query(
            `DELETE FROM background_task_history WHERE conversation=? AND rowid IN (
          SELECT rowid FROM background_task_history WHERE conversation=? ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 200)`,
          )
          .run(sessionId, sessionId);
        this.db.exec(`DELETE FROM background_task_history WHERE rowid IN (
          SELECT rowid FROM background_task_history ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 5000)`);
      })();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }

  list(sessionId: string): BackgroundTask[] {
    try {
      const rows = this.db
        .query(
          `SELECT data FROM background_task_history WHERE conversation=?
        ORDER BY updated_at DESC,rowid DESC LIMIT 200`,
        )
        .all(sessionId) as {data: string}[];
      return rows.map(row => JSON.parse(row.data) as BackgroundTask);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
}
