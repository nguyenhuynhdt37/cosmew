import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import type {Database} from 'bun:sqlite';
import {
  FutrynError,
  attachmentSchema,
  combineUsage,
  planStateSchema,
  planProposalSchema,
  type PlanProposal,
  type RetractQueuedOptions,
  type PromptHistoryScope,
  type PromptHistoryEntry,
  type Attachment,
  type PlanState,
  turnReceiptSchema,
  type TurnReceipt,
  messageSchema,
  selectionSchema,
  subagentSessionRecordSchema,
  type ConversationStore,
  type Message,
  type Selection,
  type SessionRecord,
  type SessionSummary,
  type StoredMessage,
  type SubagentSessionRecord,
  type SubagentStatus,
} from '@cosmew/contracts';

import {ExecutionJournal} from './event-store';

/** Media kept per conversation (ADR 0041); older results lose their media first. */
export const MAX_SESSION_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** Nested AGENTS.md directories remembered per session (matches the workspace loader bound). */
export const MAX_SESSION_INSTRUCTION_DIRECTORIES = 64;

type StoredRow = {
  revision: number;
  role: Message['role'];
  content: string;
  state: StoredMessage['state'];
  parts: string | null;
};

/** Tool fields live in the `parts` JSON column; plain text messages store NULL. */
function encodeParts(message: Message): string | null {
  const parts = {
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    reasoning: message.reasoning,
    providerReplay: message.providerReplay,
  };
  return message.toolCalls || message.toolCallId || message.reasoning || message.providerReplay
    ? JSON.stringify(parts)
    : null;
}

function decodeRow(row: StoredRow): StoredMessage {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !['pending', 'committed', 'interrupted'].includes(row.state)
  )
    throw new FutrynError('STORAGE');
  const parts = row.parts
    ? (JSON.parse(row.parts) as Pick<Message, 'toolCalls' | 'toolCallId' | 'toolName' | 'reasoning' | 'providerReplay'>)
    : {};
  if (
    Object.keys(parts).some(
      key => !['toolCalls', 'toolCallId', 'toolName', 'reasoning', 'providerReplay'].includes(key),
    )
  )
    throw new FutrynError('STORAGE');
  const message = messageSchema.parse({role: row.role, content: row.content, ...parts});
  return {...message, revision: row.revision, state: row.state};
}

function toMessage(stored: StoredMessage): Message {
  const {revision: _revision, state: _state, ...message} = stored;
  return message;
}

export class SqliteConversations implements ConversationStore {
  private readonly journal: ExecutionJournal;
  constructor(
    private readonly db: Database,
    private readonly redact: (value: string) => string = value => value,
    private readonly historyWorkspace?: string,
  ) {
    this.journal = new ExecutionJournal(db, redact);
  }
  private clean(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.clean(v));
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, this.clean(v)]));
    return value;
  }
  /** A durable inbox, consumed only by beginExecution's user-acceptance transaction. */
  enqueueNextTurn(id: string, content: string): {id: string; content: string} {
    try {
      const message = messageSchema.parse({role: 'user', content: this.redact(content.trim())});
      if (!message.content.trim()) throw new FutrynError('INVALID_INPUT');
      const input = {id: crypto.randomUUID(), content: message.content};
      this.db
        .query('INSERT INTO next_turn_input(conversation,id,content) VALUES(?,?,?)')
        .run(id, input.id, input.content);
      return input;
    } catch (error) {
      if (error instanceof FutrynError) throw error;
      throw new FutrynError('STORAGE');
    }
  }
  listNextTurn(id: string): readonly {id: string; content: string}[] {
    try {
      return this.db.query('SELECT id,content FROM next_turn_input WHERE conversation=? ORDER BY position').all(id) as {
        id: string;
        content: string;
      }[];
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  /** Atomic transfer for send-now: a crash sees either the old steering or its inbox replacement. */
  moveQueuedInputToInbox(id: string, live: readonly {steerId: string; content: string}[]): void {
    this.db
      .transaction(() => {
        const items = this.retractQueuedInput(id, live);
        for (const item of items) this.enqueueNextTurn(id, item.content);
      })
      .immediate();
  }

  /** Linearizes with beginExecution; live ids are exclusively owned by Conversation. */
  retractQueuedInput(
    id: string,
    live: readonly {steerId: string; content: string}[] = [],
    options: RetractQueuedOptions & {claimedIds?: readonly string[]} = {},
  ): {steerId: string; content: string}[] {
    return this.db
      .transaction(() => {
        const recovered = this.recover(id);
        const pending = (recovered.pendingInput ?? []).map(p => ({steerId: p.steerId, content: p.message.content}));
        const eligible = new Set<string>();
        for (const turn of recovered.turns) {
          const waiting = new Set<string>();
          let requests = 0;
          for (const {data} of turn.events) {
            if (data.type === 'user.steered') waiting.add(data.steerId);
            if (data.type === 'model.requested' && requests++ > 0) waiting.clear();
          }
          if (turn.state === 'running' || turn.state === 'pending') for (const key of waiting) eligible.add(key);
        }
        const items = [
          ...pending,
          ...live.filter(p => eligible.has(p.steerId)),
          ...this.listNextTurn(id).map(p => ({steerId: p.id, content: p.content})),
        ];
        const retracted = new Set(
          (this.db.query('SELECT id FROM input_retractions WHERE conversation=?').all(id) as {id: string}[]).map(
            p => p.id,
          ),
        );
        const all = [...new Map(items.map(p => [p.steerId, p])).values()].filter(p => !retracted.has(p.steerId));
        const claimed = new Set(options.claimedIds ?? []);
        const unique = all.filter(
          p =>
            !claimed.has(p.steerId) &&
            (!p.content.startsWith('!') ||
              (options.includeShell !== false && (!options.shellOnlyWhenAlone || all.length === 1))),
        );
        for (const item of unique)
          this.db
            .query('INSERT OR IGNORE INTO input_retractions VALUES(?,?,?)')
            .run(id, item.steerId, new Date().toISOString());
        for (const item of unique)
          this.db.query('DELETE FROM next_turn_input WHERE conversation=? AND id=?').run(id, item.steerId);
        return unique.map(p => ({...p, content: this.redact(p.content)}));
      })
      .immediate();
  }
  beginExecution(
    id: string,
    user: Message,
    receipt: TurnReceipt,
    carried: string[] = [],
    queuedInputId?: string,
  ): number {
    try {
      if (user.role !== 'user' || user.toolCalls || user.toolCallId) throw new FutrynError('INVALID_INPUT');
      return this.db
        .transaction(() => {
          const current = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as {
            revision: number;
          } | null;
          if (!current) throw new FutrynError('STORAGE');
          if (queuedInputId) {
            // Validate session, FIFO ordering and exact redacted content before acknowledging anything.
            const pending = this.listNextTurn(id)[0];
            if (!pending || pending.id !== queuedInputId || pending.content !== this.redact(user.content))
              throw new FutrynError('POLICY');
          }
          this.journal.claim(
            id,
            receipt.requestId,
            current.revision + 1,
            {...user, content: this.redact(user.content)},
            carried,
          );
          const revision = this.append(id, {...user, content: this.redact(user.content)}, 'pending', receipt);
          if (queuedInputId)
            this.db.query('DELETE FROM next_turn_input WHERE conversation=? AND id=?').run(id, queuedInputId);
          return revision;
        })
        .immediate();
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
  recordExecution(id: string, turnId: string, event: import('@cosmew/contracts').ExecutionEventData): number {
    return this.db
      .transaction(() => {
        const seq = this.journal.record(id, turnId, event);
        if (event.type === 'user.steered') this.recordPrompt(id, event.steerId, event.message.content);
        return seq;
      })
      .immediate();
  }
  recover(id: string): import('@cosmew/contracts').RecoveredConversation {
    const messages = (
      this.db
        .query('SELECT revision,role,content,state,parts FROM messages WHERE conversation=? ORDER BY revision')
        .all(id) as StoredRow[]
    ).map(decodeRow);
    const recovered = this.journal.recover(id, messages);
    return recovered.messages ? {...recovered, messages: this.withAttachments(id, recovered.messages)} : recovered;
  }
  /**
   * Media of one tool result (ADR 0041). Bounded per conversation: when the total passes
   * `MAX_SESSION_ATTACHMENT_BYTES` the oldest results lose their media (their text stays).
   */
  saveAttachments(id: string, callId: string, attachments: Attachment[]): void {
    try {
      const data = JSON.stringify(attachmentSchema.array().max(8).parse(attachments));
      const bytes = attachments.reduce((sum, a) => sum + Math.floor((a.data.length * 3) / 4), 0);
      this.db
        .transaction(() => {
          this.db
            .query('INSERT OR REPLACE INTO tool_attachments(conversation,call_id,bytes,data) VALUES(?,?,?,?)')
            .run(id, callId, bytes, data);
          const rows = this.db
            .query('SELECT position, bytes FROM tool_attachments WHERE conversation=? ORDER BY position DESC')
            .all(id) as {position: number; bytes: number}[];
          let total = 0;
          for (const row of rows) {
            total += row.bytes;
            if (total > MAX_SESSION_ATTACHMENT_BYTES)
              this.db.query('DELETE FROM tool_attachments WHERE position=?').run(row.position);
          }
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  savePlanProposal(id: string, proposal: PlanProposal): PlanProposal {
    let createdPath: string | undefined;
    try {
      const parsed = planProposalSchema.parse(this.clean(proposal));
      if (parsed.sessionId !== id) throw new FutrynError('STORAGE');
      // The durable store chooses the path: callers can never target arbitrary files.
      const database = this.db.query('PRAGMA database_list').get() as {file: string};
      if (database.file) {
        const directory = join(dirname(database.file), 'plans');
        mkdirSync(directory, {recursive: true, mode: 0o700});
        const stat = lstatSync(directory);
        if (
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          stat.mode & 0o077 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new FutrynError('STORAGE');
        parsed.revision ??= 1;
        const path = join(directory, `${parsed.id}-${parsed.revision}.md`);
        let fd: number;
        let created = false;
        try {
          fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          created = true;
          createdPath = path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // Open first, then inspect and read that same inode; never follow a swapped symlink.
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        }
        try {
          if (created) {
            writeFileSync(fd, parsed.plan);
            fsyncSync(fd);
          } else {
            const existing = fstatSync(fd);
            const expected = Buffer.from(parsed.plan, 'utf8');
            if (
              !existing.isFile() ||
              existing.mode & 0o077 ||
              (process.getuid && existing.uid !== process.getuid()) ||
              existing.size !== expected.length
            )
              throw new FutrynError('STORAGE');
            // One extra byte detects growth after fstat, without allocating from an untrusted file size.
            const bytes = Buffer.alloc(expected.length + 1);
            const count = readSync(fd, bytes, 0, bytes.length, 0);
            if (count !== expected.length || !bytes.subarray(0, count).equals(expected))
              throw new FutrynError('STORAGE');
          }
        } finally {
          closeSync(fd);
        }
        // Make the newly created directory entry durable before SQLite publishes its path.
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
        parsed.path = this.redact(path);
      }
      this.db
        .query(
          'INSERT INTO session_plan_approval(conversation,data) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET data=excluded.data',
        )
        .run(id, JSON.stringify(parsed));
      return parsed;
    } catch {
      if (createdPath) {
        try {
          unlinkSync(createdPath);
        } catch {
          /* no authority from an orphan */
        }
      }
      throw new FutrynError('STORAGE');
    }
  }
  loadPlanProposal(id: string): PlanProposal | null {
    try {
      const row = this.db.query('SELECT data FROM session_plan_approval WHERE conversation=?').get(id) as {
        data: string;
      } | null;
      return row ? planProposalSchema.parse(JSON.parse(row.data)) : null;
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  savePlan(id: string, plan: PlanState): void {
    try {
      this.db
        .query(
          'INSERT INTO session_plan(conversation,data) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET data=excluded.data',
        )
        .run(id, JSON.stringify(planStateSchema.parse(plan)));
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  loadPlan(id: string): PlanState | null {
    try {
      const row = this.db.query('SELECT data FROM session_plan WHERE conversation=?').get(id) as {data: string} | null;
      return row ? planStateSchema.parse(JSON.parse(row.data)) : null;
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  saveSubagentSession(record: SubagentSessionRecord): void {
    try {
      const parsed = subagentSessionRecordSchema.parse(this.clean(record));
      this.db
        .query(
          `INSERT INTO subagent_sessions(
            id, parent_conversation, parent_turn_id, call_id, depth,
            agent_type, description, prompt, fork_context, background,
            status, created_at, finished_at, error_code, isolation
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            status=excluded.status,
            finished_at=excluded.finished_at,
            error_code=excluded.error_code`,
        )
        .run(
          parsed.id,
          parsed.parentConversationId,
          parsed.parentTurnId,
          parsed.callId,
          parsed.depth,
          parsed.agentType,
          parsed.description,
          parsed.prompt,
          parsed.forkContext ? 1 : 0,
          parsed.background ? 1 : 0,
          parsed.status,
          parsed.createdAt,
          parsed.finishedAt,
          parsed.errorCode ?? null,
          parsed.isolation ?? null,
        );
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  updateSubagentSession(
    id: string,
    patch: {status: SubagentStatus; finishedAt?: string | null; errorCode?: string},
  ): void {
    try {
      const cleanCode = patch.errorCode ? this.redact(patch.errorCode).slice(0, 64) : null;
      this.db
        .query(
          'UPDATE subagent_sessions SET status=?, finished_at=COALESCE(?, finished_at), error_code=COALESCE(?, error_code) WHERE id=?',
        )
        .run(patch.status, patch.finishedAt ?? null, cleanCode, id);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  getSubagentSession(id: string): SubagentSessionRecord | undefined {
    try {
      const row = this.db
        .query(
          `SELECT s.*, c.selection FROM subagent_sessions s
           JOIN conversations c ON c.id = s.id
           WHERE s.id = ?`,
        )
        .get(id) as {
        id: string;
        parent_conversation: string;
        parent_turn_id: string | null;
        call_id: string;
        depth: number;
        agent_type: string;
        description: string;
        prompt: string;
        fork_context: number;
        background: number;
        status: string;
        created_at: string;
        finished_at: string | null;
        error_code: string | null;
        isolation: string | null;
        selection: string;
      } | null;
      if (!row) return undefined;
      let status = row.status as SubagentStatus;
      let finishedAt = row.finished_at;
      let errorCode = row.error_code ?? undefined;
      if (status === 'running') {
        const recovered = this.recover(id);
        const lastTurn = recovered.turns.at(-1);
        if (lastTurn && !['pending', 'running'].includes(lastTurn.state)) {
          status =
            lastTurn.state === 'completed'
              ? 'completed'
              : lastTurn.state === 'cancelled'
                ? 'cancelled'
                : lastTurn.state === 'interrupted'
                  ? 'interrupted'
                  : 'failed';
          finishedAt ??= new Date().toISOString();
          if (status === 'interrupted' && !errorCode) errorCode = 'PROCESS_EXIT';
          this.updateSubagentSession(id, {status, finishedAt, ...(errorCode ? {errorCode} : {})});
        }
      }
      return subagentSessionRecordSchema.parse({
        id: row.id,
        parentConversationId: row.parent_conversation,
        parentTurnId: row.parent_turn_id,
        callId: row.call_id,
        depth: row.depth,
        agentType: row.agent_type,
        description: row.description,
        prompt: row.prompt,
        selection: selectionSchema.parse(JSON.parse(row.selection)),
        forkContext: row.fork_context !== 0,
        background: row.background !== 0,
        ...(row.isolation === 'worktree' ? {isolation: 'worktree' as const} : {}),
        status,
        createdAt: row.created_at,
        finishedAt,
        ...(errorCode ? {errorCode} : {}),
      });
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  listSubagentSessions(parentConversationId: string): SubagentSessionRecord[] {
    try {
      const rows = this.db
        .query('SELECT id FROM subagent_sessions WHERE parent_conversation=? ORDER BY rowid ASC')
        .all(parentConversationId) as {id: string}[];
      return rows
        .map(row => this.getSubagentSession(row.id))
        .filter((item): item is SubagentSessionRecord => item !== undefined);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  /** Remember a nested AGENTS.md directory for this session (ADR 0041); at most 64 per session. */
  addInstructionDirectory(id: string, directory: string): void {
    try {
      this.db
        .transaction(() => {
          const count = (
            this.db.query('SELECT COUNT(*) AS n FROM session_instructions WHERE conversation=?').get(id) as {n: number}
          ).n;
          if (count >= MAX_SESSION_INSTRUCTION_DIRECTORIES) return;
          this.db
            .query('INSERT OR IGNORE INTO session_instructions(conversation,directory) VALUES(?,?)')
            .run(id, directory);
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  listInstructionDirectories(id: string): string[] {
    try {
      return (
        this.db.query('SELECT directory FROM session_instructions WHERE conversation=? ORDER BY directory').all(id) as {
          directory: string;
        }[]
      ).map(row => row.directory);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  /** Tool messages regain their stored media by call id; nothing else changes. */
  private withAttachments<T extends Message>(id: string, messages: T[]): T[] {
    const rows = this.db.query('SELECT call_id, data FROM tool_attachments WHERE conversation=?').all(id) as {
      call_id: string;
      data: string;
    }[];
    if (!rows.length) return messages;
    const byCall = new Map(rows.map(row => [row.call_id, attachmentSchema.array().parse(JSON.parse(row.data))]));
    return messages.map(m =>
      m.role === 'tool' && m.toolCallId && byCall.has(m.toolCallId) ? {...m, attachments: byCall.get(m.toolCallId)} : m,
    );
  }
  saveTask(id: string, task: import('@cosmew/contracts').ActiveTaskCheckpoint): void {
    this.journal.task(id, task);
  }
  saveContextSnapshot(id: string, snapshot: import('@cosmew/contracts').ContextSnapshot): void {
    this.journal.snapshot(id, snapshot);
  }
  create(selection: Selection): string {
    try {
      const id = crypto.randomUUID();
      this.db
        .query('INSERT INTO conversations(id,selection) VALUES(?,?)')
        .run(id, JSON.stringify(selectionSchema.parse(selection)));
      if (this.historyWorkspace) this.bindWorkspace(id, this.historyWorkspace);
      return id;
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  fork(id: string, selection: Selection): SessionRecord {
    return this.db
      .transaction(() => {
        const source = this.get(id);
        if (!source) throw new FutrynError('NOT_FOUND');
        const next = this.create(selection);
        for (const message of source.recovery?.messages ?? source.messages.map(toMessage)) {
          this.appendContext(next, message);
          if (message.attachments?.length && message.toolCallId)
            this.saveAttachments(next, message.toolCallId, message.attachments);
        }
        if (source.recovery?.task)
          this.saveTask(next, {
            ...source.recovery.task,
            verifiedActions: source.recovery.task.verifiedActions.filter(a => !a.status.startsWith('verified:')),
            state: 'unfinished',
            pending: ['Revalidate prior artifact evidence in this workspace before making changes.'],
          });
        return this.get(next)!;
      })
      .immediate();
  }
  /** Copied/synthetic context is not a new prompt submission and must not enter prompt history. */
  appendContext(id: string, message: Message): number {
    return this.db
      .transaction(() => {
        const revision = this.append(id, message, 'committed', undefined, false);
        this.db.query('UPDATE messages SET created_at=NULL WHERE conversation=? AND revision=?').run(id, revision);
        this.db.query('DELETE FROM prompt_history WHERE conversation=? AND id=?').run(id, `message:${revision}`);
        return revision;
      })
      .immediate();
  }
  append(
    id: string,
    message: Message,
    state: 'pending' | 'committed',
    receipt?: TurnReceipt,
    includeHistory = true,
  ): number {
    try {
      return this.db
        .transaction(() => {
          const original = messageSchema.parse(message);
          const {providerReplay, ...visible} = original;
          const clean = this.clean(visible) as Omit<Message, 'providerReplay'>;
          // Opaque signatures/encrypted bytes must stay exact. Plaintext and canonical tool inputs
          // still obey normal redaction; altering signed plaintext invalidates the whole envelope.
          const safe =
            providerReplay &&
            JSON.stringify(clean) === JSON.stringify(visible) &&
            providerReplay.parts.every(part => part.type === 'tool-call' || this.redact(part.text) === part.text);
          message = messageSchema.parse({...clean, ...(safe ? {providerReplay} : {})});
          const row = this.db
            .query('UPDATE conversations SET revision=revision+1 WHERE id=? RETURNING revision')
            .get(id) as {revision: number} | null;
          if (!row) throw new FutrynError('STORAGE');
          this.db
            .query(
              'INSERT INTO messages (conversation, revision, role, content, state, parts, created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              id,
              row.revision,
              message.role,
              message.content,
              state,
              encodeParts(message),
              new Date().toISOString(),
            );
          if (includeHistory && message.role === 'user')
            this.recordPrompt(id, `message:${row.revision}`, message.content);
          if (receipt)
            this.db
              .query('INSERT INTO turn_receipts VALUES(?,?,?)')
              .run(id, row.revision, JSON.stringify(turnReceiptSchema.parse(this.clean(receipt))));
          return row.revision;
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  complete(id: string, revision: number, message: Message, receipt?: TurnReceipt, intermediate: Message[] = []): void {
    try {
      this.db
        .transaction(() => {
          const row = this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as {
            revision: number;
          } | null;
          if (row?.revision !== revision) throw new FutrynError('STORAGE');
          const result = this.db
            .query("UPDATE messages SET state='committed' WHERE conversation=? AND revision=? AND state='pending'")
            .run(id, revision);
          if (result.changes !== 1) throw new FutrynError('STORAGE');
          // Tool rounds of this turn are committed together with the final answer, never on their own.
          for (const step of intermediate) this.appendContext(id, messageSchema.parse(step));
          this.append(id, messageSchema.parse(message), 'committed');
          if (receipt) this.writeReceipt(id, revision, receipt);
          this.journal.finish(id, revision, 'completed');
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  private writeReceipt(id: string, revision: number, receipt: TurnReceipt): void {
    const result = this.db
      .query('UPDATE turn_receipts SET data=? WHERE conversation=? AND revision=?')
      .run(JSON.stringify(turnReceiptSchema.parse(this.clean(receipt))), id, revision);
    if (result.changes !== 1) throw new FutrynError('STORAGE');
  }
  /** Fold a compaction call's usage into the latest agent turn so session usage counts it (ADR 0054). */
  addUsage(id: string, usage: import('@cosmew/contracts').Usage): void {
    try {
      const rows = this.db
        .query('SELECT revision,data FROM turn_receipts WHERE conversation=? ORDER BY revision DESC')
        .all(id) as {revision: number; data: string}[];
      for (const row of rows) {
        const receipt = turnReceiptSchema.parse(JSON.parse(row.data));
        if (receipt.kind === 'user-shell') continue;
        receipt.usage = combineUsage(receipt.usage, usage);
        this.writeReceipt(id, row.revision, receipt);
        return;
      }
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  observeTurn(id: string, revision: number, receipt: TurnReceipt): void {
    try {
      this.writeReceipt(id, revision, receipt);
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  interrupt(id: string, revision: number, receipt?: TurnReceipt, appliedSteps: Message[] = []): void {
    try {
      this.db
        .transaction(() => {
          const state = appliedSteps.length ? 'committed' : 'interrupted';
          const updated = this.db
            .query("UPDATE messages SET state=? WHERE conversation=? AND revision=? AND state='pending'")
            .run(state, id, revision);
          if (appliedSteps.length && updated.changes !== 1) throw new FutrynError('STORAGE');
          // Mutating receipts survive interrupted continuations; they are evidence, never replay jobs.
          for (const step of appliedSteps) this.appendContext(id, messageSchema.parse(step));
          if (receipt) this.writeReceipt(id, revision, receipt);
          this.journal.finish(
            id,
            revision,
            receipt?.outcome === 'cancelled'
              ? 'cancelled'
              : receipt?.outcome === 'interrupted'
                ? 'interrupted'
                : 'failed',
            receipt?.errorCode,
          );
        })
        .immediate();
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  /** Immutable workspace identity; resuming elsewhere never relabels old prompts. */
  bindWorkspace(id: string, workspace: string): void {
    this.db.query('UPDATE conversations SET workspace=? WHERE id=? AND workspace IS NULL').run(workspace, id);
  }
  private recordPrompt(sessionId: string, id: string, content: string): void {
    const owner = this.db.query('SELECT workspace FROM conversations WHERE id=?').get(sessionId) as {
      workspace: string | null;
    } | null;
    this.db
      .query('INSERT OR IGNORE INTO prompt_history(conversation,id,workspace,at,content) VALUES(?,?,?,?,?)')
      .run(
        sessionId,
        id,
        this.historyWorkspace ?? owner?.workspace ?? null,
        new Date().toISOString(),
        this.redact(content).slice(0, 16000),
      );
    this.db
      .query(
        'DELETE FROM prompt_history WHERE rowid IN (SELECT rowid FROM prompt_history ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 5000)',
      )
      .run();
  }
  promptHistory(input: {
    scope: PromptHistoryScope;
    sessionId?: string;
    workspace: string;
    limit?: number;
  }): PromptHistoryEntry[] {
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 100)));
    const predicate =
      input.scope === 'session' ? 'h.conversation=?' : input.scope === 'project' ? 'h.workspace=?' : '1=1';
    const args =
      input.scope === 'session' ? [input.sessionId ?? ''] : input.scope === 'project' ? [input.workspace] : [];
    const rows = this.db
      .query(
        `SELECT h.conversation AS sessionId,h.id,h.content,h.at AS timestamp
      FROM prompt_history h WHERE h.conversation NOT IN (SELECT id FROM subagent_sessions)
      AND NOT EXISTS (SELECT 1 FROM input_retractions r WHERE r.conversation=h.conversation AND r.id=h.id)
      AND ${predicate} ORDER BY h.at DESC,h.rowid DESC LIMIT ?`,
      )
      .all(...args, limit) as PromptHistoryEntry[];
    return rows.map(r => ({...r, id: `${r.sessionId}:${r.id}`, content: this.redact(r.content).slice(0, 16000)}));
  }
  list(): SessionSummary[] {
    try {
      const rows = this.db
        .query(
          'SELECT id, selection, revision, rowid FROM conversations WHERE id NOT IN (SELECT id FROM subagent_sessions) ORDER BY rowid DESC LIMIT 200',
        )
        .all() as {
        id: string;
        selection: string;
        revision: number;
        rowid: number;
      }[];
      return rows.map(row => {
        const selection = selectionSchema.parse(JSON.parse(row.selection));
        const msgs = (
          this.db
            .query(
              'SELECT revision, role, content, state, parts FROM messages WHERE conversation=? ORDER BY revision ASC',
            )
            .all(row.id) as StoredRow[]
        ).map(decodeRow);
        const firstUser = msgs.find(m => m.role === 'user')?.content ?? '';
        const lastMsg = msgs.at(-1);
        const title = firstUser ? firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) : `Session ${row.id.slice(0, 8)}`;
        const preview = lastMsg ? lastMsg.content.replace(/\s+/g, ' ').trim().slice(0, 80) : 'No messages yet';
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
      const recovery = this.recover(id);
      const messages = (
        this.db
          .query(
            'SELECT revision, role, content, state, parts FROM messages WHERE conversation=? ORDER BY revision ASC',
          )
          .all(row.id) as StoredRow[]
      ).map(decodeRow);
      const withMedia = this.withAttachments(id, messages);
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
        messages: withMedia,
        recovery,
        turns: (
          this.db.query('SELECT data FROM turn_receipts WHERE conversation=? ORDER BY revision').all(id) as {
            data: string;
          }[]
        ).map(row => {
          return turnReceiptSchema.parse(JSON.parse(row.data));
        }),
      };
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  delete(id: string): boolean {
    try {
      return this.db
        .transaction(() => {
          const removeConversation = (targetId: string): boolean => {
            if (
              this.db
                .query("SELECT 1 FROM execution_turns WHERE conversation=? AND state IN ('pending','running')")
                .get(targetId)
            )
              throw new FutrynError('POLICY');
            const children = this.db
              .query('SELECT id FROM subagent_sessions WHERE parent_conversation=?')
              .all(targetId) as {id: string}[];
            for (const child of children) removeConversation(child.id);
            this.db.query('DELETE FROM subagent_sessions WHERE id=? OR parent_conversation=?').run(targetId, targetId);
            this.db.query('DELETE FROM next_turn_input WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM prompt_history WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM background_task_history WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM turn_checkpoints WHERE session_id=?').run(targetId);
            this.db.query('DELETE FROM input_retractions WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM tool_attachments WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM session_instructions WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM session_plan WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM session_plan_approval WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM conversation_events WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM execution_turns WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM conversation_checkpoints WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM turn_receipts WHERE conversation=?').run(targetId);
            this.db.query('DELETE FROM messages WHERE conversation=?').run(targetId);
            const res = this.db.query('DELETE FROM conversations WHERE id=?').run(targetId);
            return res.changes > 0;
          };
          return removeConversation(id);
        })
        .immediate();
    } catch (e) {
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('STORAGE');
    }
  }
}
