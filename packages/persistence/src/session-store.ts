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

type StoredRow = { revision: number; role: Message['role']; content: string; state: StoredMessage['state']; parts: string | null };

/** Tool fields live in the `parts` JSON column; plain text messages store NULL. */
function encodeParts(message: Message): string | null {
  const parts = { toolCalls: message.toolCalls, toolCallId: message.toolCallId, toolName: message.toolName };
  return message.toolCalls || message.toolCallId ? JSON.stringify(parts) : null;
}

function decodeRow(row: StoredRow): StoredMessage {
  const parts = row.parts ? JSON.parse(row.parts) as Pick<Message, 'toolCalls' | 'toolCallId' | 'toolName'> : {};
  const message = messageSchema.parse({ role: row.role, content: row.content, ...parts });
  return { ...message, revision: row.revision, state: row.state };
}

function toMessage(stored: StoredMessage): Message {
  const { revision: _revision, state: _state, ...message } = stored;
  return message;
}

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
      for (const message of source.messages.filter(m => m.state === 'committed')) this.append(next, toMessage(message), 'committed');
      return this.get(next)!;
    }).immediate();
  }
  append(id: string, message: Message, state: 'pending' | 'committed', receipt?: TurnReceipt): number {
    try {
      return this.db.transaction(() => {
        messageSchema.parse(message);
        const row = this.db.query('UPDATE conversations SET revision=revision+1 WHERE id=? RETURNING revision').get(id) as { revision: number } | null;
        if (!row) throw new HannesError('STORAGE');
        this.db.query('INSERT INTO messages (conversation, revision, role, content, state, parts) VALUES(?,?,?,?,?,?)').run(id, row.revision, message.role, message.content, state, encodeParts(message));
        if (receipt) this.db.query('INSERT INTO turn_receipts VALUES(?,?,?)').run(id, row.revision, JSON.stringify(turnReceiptSchema.parse(receipt)));
        return row.revision;
      }).immediate();
    } catch {
      throw new HannesError('STORAGE');
    }
  }
  complete(id: string, revision: number, message: Message, receipt?: TurnReceipt, intermediate: Message[] = []): void {
    try {
      this.db.transaction(() => {
        const row = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as { revision: number } | null;
        if (row?.revision !== revision) throw new HannesError('STORAGE');
        const result = this.db.query("UPDATE messages SET state='committed' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision);
        if (result.changes !== 1) throw new HannesError('STORAGE');
        // Tool rounds of this turn are committed together with the final answer, never on their own.
        for (const step of intermediate) this.append(id, messageSchema.parse(step), 'committed');
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
  interrupt(id: string, revision: number, receipt?: TurnReceipt, appliedSteps: Message[] = []): void {
    try {
      this.db.transaction(() => {
        const state=appliedSteps.length?'committed':'interrupted';
        const updated=this.db.query("UPDATE messages SET state=? WHERE conversation=? AND revision=? AND state='pending'").run(state,id,revision);
        if(appliedSteps.length&&updated.changes!==1)throw new HannesError('STORAGE');
        // Mutating receipts survive interrupted continuations; they are evidence, never replay jobs.
        for(const step of appliedSteps)this.append(id,messageSchema.parse(step),'committed');
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
        const msgs = (this.db
          .query('SELECT revision, role, content, state, parts FROM messages WHERE conversation=? ORDER BY revision ASC')
          .all(row.id) as StoredRow[]).map(decodeRow);
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
      const messages = (this.db
        .query('SELECT revision, role, content, state, parts FROM messages WHERE conversation=? ORDER BY revision ASC')
        .all(row.id) as StoredRow[]).map(decodeRow);
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
