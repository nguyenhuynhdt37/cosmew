import type { Database } from 'bun:sqlite';
import {
  HannesError,
  turnReceiptSchema, type TurnReceipt,
  messageSchema,
  selectionSchema,
  type ConversationStore,
  type Message,
  type Selection,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
} from '@hannes/contracts';

export class SqliteConversations implements ConversationStore {
  constructor(private readonly db: Database) {}
  create(selection: Selection): string {
    try {
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO conversations(id,selection) VALUES(?,?)').run(id, JSON.stringify(selectionSchema.parse(selection)));
      return id;
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  fork(id: string, selection: Selection): SessionRecord {
    return this.db.transaction(() => {
      const source = this.get(id); if (!source) throw new HannesError('NOT_FOUND');
      const next = this.create(selection);
      for (const message of source.messages.filter(m => m.state === 'committed')) this.append(next, { role: message.role, content: message.content }, 'committed');
      return this.get(next)!;
    }).immediate();
  }
  append(id: string, message: Message, state: 'pending' | 'committed', receipt?: TurnReceipt): number {
    try {
      return this.db.transaction(() => {
        messageSchema.parse(message);
        const row = this.db.query('UPDATE conversations SET revision=revision+1 WHERE id=? RETURNING revision').get(id) as { revision: number } | null;
        if (!row) throw new HannesError('STORAGE');
        this.db.query('INSERT INTO messages VALUES(?,?,?,?,?)').run(id, row.revision, message.role, message.content, state);
        if (receipt) this.db.query('INSERT INTO turn_receipts VALUES(?,?,?)').run(id, row.revision, JSON.stringify(turnReceiptSchema.parse(receipt)));
        return row.revision;
      }).immediate();
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  complete(id: string, revision: number, message: Message, receipt?: TurnReceipt): void {
    try {
      this.db.transaction(() => {
        const row = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as { revision: number } | null;
        if (row?.revision !== revision) throw new HannesError('STORAGE');
        const result = this.db.query("UPDATE messages SET state='committed' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision);
        if (result.changes !== 1) throw new HannesError('STORAGE');
        this.append(id, messageSchema.parse(message), 'committed');
        if (receipt) this.writeReceipt(id, revision, receipt);
      }).immediate();
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  private writeReceipt(id: string, revision: number, receipt: TurnReceipt): void {
    const result = this.db.query('UPDATE turn_receipts SET data=? WHERE conversation=? AND revision=?').run(JSON.stringify(turnReceiptSchema.parse(receipt)), id, revision);
    if (result.changes !== 1) throw new HannesError('STORAGE');
  }
  observeTurn(id: string, revision: number, receipt: TurnReceipt): void {
    try { this.writeReceipt(id, revision, receipt); } catch { throw new HannesError('STORAGE'); }
  }
  interrupt(id: string, revision: number, receipt?: TurnReceipt): void {
    try {
      this.db.transaction(() => {
        this.db.query("UPDATE messages SET state='interrupted' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision);
        if (receipt) this.writeReceipt(id, revision, receipt);
      }).immediate();
    } catch { throw new HannesError('STORAGE'); }
  }
  list(): SessionSummary[] {
    try {
      const rows = this.db.query('SELECT id, selection, revision, rowid FROM conversations ORDER BY rowid DESC LIMIT 200').all() as {
        id: string;
        selection: string;
        revision: number;
        rowid: number;
      }[];
      return rows.map(row => {
        const selection = selectionSchema.parse(JSON.parse(row.selection));
        const msgs = this.db
          .query('SELECT revision, role, content, state FROM messages WHERE conversation=? ORDER BY revision ASC')
          .all(row.id) as StoredMessage[];
        const firstUser = msgs.find(m => m.role === 'user')?.content ?? '';
        const lastMsg = msgs.at(-1);
        const title = firstUser
          ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 60)
          : `Session ${row.id.slice(0, 8)}`;
        const preview = lastMsg
          ? lastMsg.content.replace(/\s+/g, ' ').trim().slice(0, 80)
          : 'No messages yet';
        return {
          id: row.id,
          title,
          selection,
          revision: row.revision,
          messageCount: msgs.filter(m => m.state === 'committed').length,
          lastState: lastMsg?.state ?? 'idle',
          preview,
        };
      });
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  get(id: string): SessionRecord | undefined {
    try {
      const row = this.db.query('SELECT id, selection, revision FROM conversations WHERE id=?').get(id) as {
        id: string;
        selection: string;
        revision: number;
      } | null;
      if (!row) return undefined;
      const selection = selectionSchema.parse(JSON.parse(row.selection));
      const messages = this.db
        .query('SELECT revision, role, content, state FROM messages WHERE conversation=? ORDER BY revision ASC')
        .all(row.id) as StoredMessage[];
      const firstUser = messages.find(m => m.role === 'user')?.content ?? '';
      const lastMsg = messages.at(-1);
      return {
        id: row.id,
        title: firstUser ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) : `Session ${row.id.slice(0, 8)}`,
        selection,
        revision: row.revision,
        messageCount: messages.filter(m => m.state === 'committed').length,
        lastState: lastMsg?.state ?? 'idle',
        preview: lastMsg ? lastMsg.content.replace(/\s+/g, ' ').trim().slice(0, 80) : 'No messages yet',
        messages,
        turns: (this.db.query('SELECT data FROM turn_receipts WHERE conversation=? ORDER BY revision').all(id) as {data: string}[]).map(row => {
          return turnReceiptSchema.parse(JSON.parse(row.data));
        }),
      };
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  delete(id: string): boolean {
    try {
      return this.db.transaction(() => {
        this.db.query('DELETE FROM turn_receipts WHERE conversation=?').run(id);
        this.db.query('DELETE FROM messages WHERE conversation=?').run(id);
        const res = this.db.query('DELETE FROM conversations WHERE id=?').run(id);
        return res.changes > 0;
      }).immediate();
    } catch {
      throw new HannesError('STORAGE');
    }
  }
}
