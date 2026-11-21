import type {Database} from 'bun:sqlite';
import {
  FutrynError,
  activeTaskCheckpointSchema,
  contextSnapshotSchema,
  executionEventDataSchema,
  type ActiveTaskCheckpoint,
  type ContextSnapshot,
  type ExecutionEventData,
  type Message,
  type RecoveredConversation,
  type StoredMessage,
  type TurnState,
} from '@cosmew/contracts';
import {groupEvents, reconstructConversation, type EventRow, type TurnRow} from './journal-reconstruction';
const owner = crypto.randomUUID();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as {code?: string}).code !== 'ESRCH';
  }
};

/** SQLite owns ordered execution evidence. Reading it never invokes a tool or restores a grant. */
export class ExecutionJournal {
  constructor(
    private readonly db: Database,
    private readonly redact: (value: string) => string,
  ) {}
  private clean(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.clean(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.clean(v)]));
    return value;
  }
  private append(id: string, turnId: string, event: ExecutionEventData): number {
    const data = executionEventDataSchema.parse(this.clean(event));
    const seq = (
      this.db.query('SELECT COALESCE(MAX(seq),0)+1 AS n FROM conversation_events WHERE conversation=?').get(id) as {
        n: number;
      }
    ).n;
    this.db
      .query('INSERT INTO conversation_events VALUES(?,?,?,?,?)')
      .run(id, seq, turnId, new Date().toISOString(), JSON.stringify(data));
    return seq;
  }
  /** A live owner cannot be stolen, even by another client in the same process. */
  claim(id: string, turnId: string, revision: number, user: Message, carried: string[] = []): void {
    this.abandonDead(id);
    if (this.db.query("SELECT 1 FROM execution_turns WHERE conversation=? AND state IN ('pending','running')").get(id))
      throw new FutrynError('POLICY');
    // Carried input must still be pending; a stale or duplicate id would deliver an instruction twice.
    if (carried.length) {
      const pending = new Set((this.recover(id, []).pendingInput ?? []).map(p => p.steerId));
      if (new Set(carried).size !== carried.length || carried.some(c => !pending.has(c)))
        throw new FutrynError('POLICY');
    }
    this.db
      .query("INSERT INTO execution_turns VALUES(?,?,?,NULL,'pending',?,?)")
      .run(id, turnId, revision, process.pid, owner);
    this.append(id, turnId, {type: 'user.accepted', message: user, ...(carried.length ? {carried} : {})});
  }
  record(id: string, turnId: string, event: ExecutionEventData): number {
    try {
      return this.db
        .transaction(() => {
          if (event.type === 'user.accepted' || event.type === 'turn.finished') throw new FutrynError('STORAGE');
          if (
            event.type === 'user.steered' &&
            (event.message.role !== 'user' || event.message.toolCalls?.length || event.message.toolCallId)
          )
            throw new FutrynError('STORAGE');
          const row = this.db
            .query('SELECT * FROM execution_turns WHERE conversation=? AND id=?')
            .get(id, turnId) as TurnRow | null;
          if (!row || row.owner !== owner || !['pending', 'running'].includes(row.state))
            throw new FutrynError('STORAGE');
          if (event.type === 'model.requested')
            this.db.query("UPDATE execution_turns SET state='running' WHERE conversation=? AND id=?").run(id, turnId);
          return this.append(id, turnId, event);
        })
        .immediate();
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
  finish(id: string, revision: number, state: TurnState, errorCode?: string): void {
    const row = this.db
      .query('SELECT * FROM execution_turns WHERE conversation=? AND user_revision=?')
      .get(id, revision) as TurnRow | null;
    if (!row) return; // v1-v3 and custom legacy stores remain readable.
    if (
      !['pending', 'running'].includes(row.state) ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
    )
      throw new FutrynError('STORAGE');
    const current = (this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as {revision: number})
      .revision;
    this.db
      .query('UPDATE execution_turns SET state=?,end_revision=? WHERE conversation=? AND id=?')
      .run(state, current, id, row.id);
    this.append(id, row.id, {type: 'turn.finished', state, ...(errorCode ? {errorCode} : {})});
  }
  private abandonDead(id: string): void {
    const rows = this.db
      .query("SELECT * FROM execution_turns WHERE conversation=? AND state IN ('pending','running')")
      .all(id) as TurnRow[];
    for (const row of rows)
      if (row.owner !== owner && !alive(row.owner_pid)) {
        this.finish(id, row.user_revision, 'interrupted', 'PROCESS_EXIT');
        this.db
          .query("UPDATE messages SET state='interrupted' WHERE conversation=? AND revision=? AND state='pending'")
          .run(id, row.user_revision);
        const receipt = this.db
          .query('SELECT data FROM turn_receipts WHERE conversation=? AND revision=?')
          .get(id, row.user_revision) as {data: string} | null;
        if (receipt) {
          const data = JSON.parse(receipt.data);
          data.outcome = 'interrupted';
          data.finishedAt = new Date().toISOString();
          data.stopReason = 'failed';
          this.db
            .query('UPDATE turn_receipts SET data=? WHERE conversation=? AND revision=?')
            .run(JSON.stringify(data), id, row.user_revision);
        }
      }
  }
  task(id: string, task: ActiveTaskCheckpoint): void {
    const data = activeTaskCheckpointSchema.parse(this.clean(task));
    this.db
      .query(
        'INSERT INTO conversation_checkpoints(conversation,task) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET task=excluded.task',
      )
      .run(id, JSON.stringify(data));
  }
  snapshot(id: string, snapshot: ContextSnapshot): void {
    const data = contextSnapshotSchema.parse(this.clean(snapshot));
    this.db
      .query(
        'INSERT INTO conversation_checkpoints(conversation,context) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET context=excluded.context',
      )
      .run(id, JSON.stringify(data));
  }
  /**
   * Rebuild the conversation from durable evidence: legacy messages plus every journaled turn,
   * validated and reconstructed (see journal-reconstruction.ts). A corrupt journal fails with
   * STORAGE instead of guessing. Reading never invokes a tool or restores a grant.
   */
  recover(id: string, legacy: StoredMessage[]): RecoveredConversation {
    try {
      return this.db
        .transaction(() => {
          this.abandonDead(id);
          const rows = this.db
            .query('SELECT * FROM execution_turns WHERE conversation=? ORDER BY user_revision')
            .all(id) as TurnRow[];
          const records = this.db
            .query('SELECT seq,turn_id,at,data FROM conversation_events WHERE conversation=? ORDER BY seq')
            .all(id) as EventRow[];

          const turns = groupEvents(rows, records);
          const {messages, pendingInput} = reconstructConversation(
            rows,
            turns,
            legacy,
            new Set(
              (this.db.query('SELECT id FROM input_retractions WHERE conversation=?').all(id) as {id: string}[]).map(
                row => row.id,
              ),
            ),
          );
          const saved = this.db
            .query('SELECT task,context FROM conversation_checkpoints WHERE conversation=?')
            .get(id) as {task: string | null; context: string | null} | null;

          return {
            messages,
            turns,
            ...(pendingInput.size
              ? {pendingInput: [...pendingInput].map(([steerId, message]) => ({steerId, message}))}
              : {}),
            ...(saved?.task ? {task: activeTaskCheckpointSchema.parse(JSON.parse(saved.task))} : {}),
            ...(saved?.context ? {compaction: contextSnapshotSchema.parse(JSON.parse(saved.context))} : {}),
          };
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
}
