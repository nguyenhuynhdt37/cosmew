import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import type {ArchivedToolOutput, OutputArchiveScope, ToolOutputArchive} from '@cosmew/contracts';

const ARTIFACT_BYTES = 1024 * 1024;
const SESSION_BYTES = 8 * ARTIFACT_BYTES;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Auxiliary, disposable evidence table: no conversation schema/recovery migration. */
export class SqliteToolOutputArchive implements ToolOutputArchive {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_output_archive (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, session TEXT NOT NULL,
      data TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS tool_output_archive_scope ON tool_output_archive(workspace,session,created)`);
  }
  put(scope: OutputArchiveScope, output: Omit<ArchivedToolOutput, 'outputId'>): string {
    const bytes = Buffer.from(output.content);
    const content =
      bytes.length > ARTIFACT_BYTES
        ? new TextDecoder().decode(bytes.subarray(0, ARTIFACT_BYTES)).replace(/�$/, '')
        : output.content;
    const id = randomUUID();
    this.db
      .transaction(() => {
        this.db.query('DELETE FROM tool_output_archive WHERE created < ?').run(this.now() - RETENTION_MS);
        this.db.query('INSERT INTO tool_output_archive VALUES (?,?,?,?,?,?)').run(
          id,
          scope.workspace,
          scope.session,
          JSON.stringify({
            ...output,
            content,
            sourceTruncated: output.sourceTruncated || bytes.length > ARTIFACT_BYTES,
          }),
          Buffer.byteLength(content),
          this.now(),
        );
        const rows = this.db
          .query(
            'SELECT id,bytes FROM tool_output_archive WHERE workspace=? AND session=? ORDER BY created DESC,rowid DESC',
          )
          .all(scope.workspace, scope.session) as {id: string; bytes: number}[];
        let used = 0;
        for (const row of rows) {
          used += row.bytes;
          if (used > SESSION_BYTES) this.db.query('DELETE FROM tool_output_archive WHERE id=?').run(row.id);
        }
        // A global cap prevents abandoned sessions growing this disposable cache without bound.
        this.db.exec(
          'DELETE FROM tool_output_archive WHERE id IN (SELECT id FROM tool_output_archive ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 1024)',
        );
      })
      .immediate();
    return id;
  }
  get(scope: OutputArchiveScope, outputId: string): ArchivedToolOutput | undefined {
    const row = this.db
      .query('SELECT data FROM tool_output_archive WHERE id=? AND workspace=? AND session=? AND created>=?')
      .get(outputId, scope.workspace, scope.session, this.now() - RETENTION_MS) as {data: string} | null;
    return row ? {...JSON.parse(row.data), outputId} : undefined;
  }
}
