import type { Database } from 'bun:sqlite';
import { HannesError, messageSchema, selectionSchema, type ConversationStore, type Message, type Selection } from '@hannes/contracts';

export class SqliteConversations implements ConversationStore {
  constructor(private readonly db: Database) {}
  create(selection: Selection): string {
    try { const id = crypto.randomUUID(); this.db.query('INSERT INTO conversations(id,selection) VALUES(?,?)').run(id, JSON.stringify(selectionSchema.parse(selection))); return id; }
    catch { throw new HannesError('STORAGE'); }
  }
  append(id: string, message: Message, state: 'pending' | 'committed'): number {
    try {
      return this.db.transaction(() => {
        messageSchema.parse(message);
        const row = this.db.query('UPDATE conversations SET revision=revision+1 WHERE id=? RETURNING revision').get(id) as { revision: number } | null;
        if (!row) throw new HannesError('STORAGE');
        this.db.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(id, row.revision, message.role, message.content, state);
        return row.revision;
      }).immediate();
    } catch { throw new HannesError('STORAGE'); }
  }
  complete(id: string, revision: number, message: Message): void {
    try {
      this.db.transaction(() => {
        const row = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as { revision: number } | null;
        if (row?.revision !== revision) throw new HannesError('STORAGE');
        const result = this.db.query("UPDATE messages SET state='committed' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision);
        if (result.changes !== 1) throw new HannesError('STORAGE');
        this.append(id, messageSchema.parse(message), 'committed');
      }).immediate();
    } catch { throw new HannesError('STORAGE'); }
  }
  interrupt(id: string, revision: number): void {
    try { this.db.query("UPDATE messages SET state='interrupted' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision); }
    catch { throw new HannesError('STORAGE'); }
  }
}
