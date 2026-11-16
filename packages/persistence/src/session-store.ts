import type { Database } from 'bun:sqlite';
import {
  FutrynError,
  turnReceiptSchema, type TurnReceipt,
  messageSchema,
  selectionSchema,
  type ConversationStore,
  type Message,
  type Selection,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
} from '@futryn/contracts';

import { ExecutionJournal } from './event-store';

type StoredRow = { revision: number; role: Message['role']; content: string; state: StoredMessage['state']; parts: string | null };

/** Tool fields live in the `parts` JSON column; plain text messages store NULL. */
function encodeParts(message: Message): string | null {
  const parts = { toolCalls: message.toolCalls, toolCallId: message.toolCallId, toolName: message.toolName };
  return message.toolCalls || message.toolCallId ? JSON.stringify(parts) : null;
}

function decodeRow(row: StoredRow): StoredMessage {
  if(!Number.isSafeInteger(row.revision)||row.revision<1||!['pending','committed','interrupted'].includes(row.state))throw new FutrynError('STORAGE');
  const parts = row.parts ? JSON.parse(row.parts) as Pick<Message, 'toolCalls' | 'toolCallId' | 'toolName'> : {};
  if(Object.keys(parts).some(key=>!['toolCalls','toolCallId','toolName'].includes(key)))throw new FutrynError('STORAGE');
  const message = messageSchema.parse({ role: row.role, content: row.content, ...parts });
  return { ...message, revision: row.revision, state: row.state };
}

function toMessage(stored: StoredMessage): Message {
  const { revision: _revision, state: _state, ...message } = stored;
  return message;
}

export class SqliteConversations implements ConversationStore {
  private readonly journal: ExecutionJournal;
  constructor(private readonly db: Database, private readonly redact:(value:string)=>string = value=>value) { this.journal=new ExecutionJournal(db,redact); }
  private clean(value:unknown):unknown {
    if(typeof value==='string')return this.redact(value);
    if(Array.isArray(value))return value.map(v=>this.clean(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,this.clean(v)]));
    return value;
  }
  beginExecution(id:string,user:Message,receipt:TurnReceipt):number {
    try{if(user.role!=='user'||user.toolCalls||user.toolCallId)throw new FutrynError('INVALID_INPUT');return this.db.transaction(()=>{const current=this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as {revision:number}|null;if(!current)throw new FutrynError('STORAGE');this.journal.claim(id,receipt.requestId,current.revision+1,{...user,content:this.redact(user.content)});return this.append(id,{...user,content:this.redact(user.content)},'pending',receipt);}).immediate();}
    catch(e){if(e instanceof FutrynError)throw e;throw new FutrynError('STORAGE');}
  }
  recordExecution(id:string,turnId:string,event:import('@futryn/contracts').ExecutionEventData):number{return this.journal.record(id,turnId,event);}
  recover(id:string):import('@futryn/contracts').RecoveredConversation {
    const messages=(this.db.query('SELECT revision,role,content,state,parts FROM messages WHERE conversation=? ORDER BY revision').all(id) as StoredRow[]).map(decodeRow);
    return this.journal.recover(id,messages);
  }
  saveTask(id:string,task:import('@futryn/contracts').ActiveTaskCheckpoint):void{this.journal.task(id,task);}
  saveContextSnapshot(id:string,snapshot:import('@futryn/contracts').ContextSnapshot):void{this.journal.snapshot(id,snapshot);}
  create(selection: Selection): string {
    try {
      const id = crypto.randomUUID();
      this.db.query('INSERT INTO conversations(id,selection) VALUES(?,?)').run(id, JSON.stringify(selectionSchema.parse(selection)));
      return id;
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  fork(id: string, selection: Selection): SessionRecord {
    return this.db.transaction(() => {
      const source = this.get(id); if (!source) throw new FutrynError('NOT_FOUND');
      const next = this.create(selection);
      for (const message of source.recovery?.messages ?? source.messages.map(toMessage)) this.append(next, message, 'committed');
      if(source.recovery?.task)this.saveTask(next,{...source.recovery.task,verifiedActions:source.recovery.task.verifiedActions.filter(a=>!a.status.startsWith('verified:')),state:'unfinished',pending:['Revalidate prior artifact evidence in this workspace before making changes.']});
      return this.get(next)!;
    }).immediate();
  }
  append(id: string, message: Message, state: 'pending' | 'committed', receipt?: TurnReceipt): number {
    try {
      return this.db.transaction(() => {
        message=messageSchema.parse(this.clean(message));
        const row = this.db.query('UPDATE conversations SET revision=revision+1 WHERE id=? RETURNING revision').get(id) as { revision: number } | null;
        if (!row) throw new FutrynError('STORAGE');
        this.db.query('INSERT INTO messages (conversation, revision, role, content, state, parts) VALUES(?,?,?,?,?,?)').run(id, row.revision, message.role, message.content, state, encodeParts(message));
        if (receipt) this.db.query('INSERT INTO turn_receipts VALUES(?,?,?)').run(id, row.revision, JSON.stringify(turnReceiptSchema.parse(this.clean(receipt))));
        return row.revision;
      }).immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  complete(id: string, revision: number, message: Message, receipt?: TurnReceipt, intermediate: Message[] = []): void {
    try {
      this.db.transaction(() => {
        const row = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as { revision: number } | null;
        if (row?.revision !== revision) throw new FutrynError('STORAGE');
        const result = this.db.query("UPDATE messages SET state='committed' WHERE conversation=? AND revision=? AND state='pending'").run(id, revision);
        if (result.changes !== 1) throw new FutrynError('STORAGE');
        // Tool rounds of this turn are committed together with the final answer, never on their own.
        for (const step of intermediate) this.append(id, messageSchema.parse(step), 'committed');
        this.append(id, messageSchema.parse(message), 'committed');
        if (receipt) this.writeReceipt(id, revision, receipt);
        this.journal.finish(id,revision,'completed');
      }).immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  private writeReceipt(id: string, revision: number, receipt: TurnReceipt): void {
    const result = this.db.query('UPDATE turn_receipts SET data=? WHERE conversation=? AND revision=?').run(JSON.stringify(turnReceiptSchema.parse(this.clean(receipt))), id, revision);
    if (result.changes !== 1) throw new FutrynError('STORAGE');
  }
  observeTurn(id: string, revision: number, receipt: TurnReceipt): void {
    try { this.writeReceipt(id, revision, receipt); } catch { throw new FutrynError('STORAGE'); }
  }
  interrupt(id: string, revision: number, receipt?: TurnReceipt, appliedSteps: Message[] = []): void {
    try {
      this.db.transaction(() => {
        const state=appliedSteps.length?'committed':'interrupted';
        const updated=this.db.query("UPDATE messages SET state=? WHERE conversation=? AND revision=? AND state='pending'").run(state,id,revision);
        if(appliedSteps.length&&updated.changes!==1)throw new FutrynError('STORAGE');
        // Mutating receipts survive interrupted continuations; they are evidence, never replay jobs.
        for(const step of appliedSteps)this.append(id,messageSchema.parse(step),'committed');
        if (receipt) this.writeReceipt(id, revision, receipt);
        this.journal.finish(id,revision,receipt?.outcome==='cancelled'?'cancelled':receipt?.outcome==='interrupted'?'interrupted':'failed');
      }).immediate();
    } catch { throw new FutrynError('STORAGE'); }
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
      throw new FutrynError('STORAGE');
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
      const recovery=this.recover(id);
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
        recovery,
        turns: (this.db.query('SELECT data FROM turn_receipts WHERE conversation=? ORDER BY revision').all(id) as {data: string}[]).map(row => {
          return turnReceiptSchema.parse(JSON.parse(row.data));
        }),
      };
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  delete(id: string): boolean {
    try {
      return this.db.transaction(() => {
        if(this.db.query("SELECT 1 FROM execution_turns WHERE conversation=? AND state IN ('pending','running')").get(id))throw new FutrynError('POLICY');
        this.db.query('DELETE FROM conversation_events WHERE conversation=?').run(id);
        this.db.query('DELETE FROM execution_turns WHERE conversation=?').run(id);
        this.db.query('DELETE FROM conversation_checkpoints WHERE conversation=?').run(id);
        this.db.query('DELETE FROM turn_receipts WHERE conversation=?').run(id);
        this.db.query('DELETE FROM messages WHERE conversation=?').run(id);
        const res = this.db.query('DELETE FROM conversations WHERE id=?').run(id);
        return res.changes > 0;
      }).immediate();
    } catch(e) {
      if(e instanceof FutrynError)throw e;
      throw new FutrynError('STORAGE');
    }
  }
}
