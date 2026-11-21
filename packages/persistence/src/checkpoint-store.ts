import type {Database} from 'bun:sqlite';
import {
  FutrynError,
  type CheckpointFile,
  type CheckpointRecord,
  type CheckpointView,
  type Message,
} from '@cosmew/contracts';

const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
/** Turn checkpoint metadata and preimages; durable writes belong exclusively to persistence. */
export class CheckpointStore {
  constructor(
    private readonly db: Database,
    private readonly redact: (text: string) => string = text => text,
  ) {}
  begin(sessionId: string, workspace: string, prompt: string, messages: Message[]): string {
    const id = crypto.randomUUID();
    const record: CheckpointRecord & {sessionDiffBaselineVersion: 1} = {
      sessionDiffBaselineVersion: 1,
      id,
      sessionId,
      workspace,
      createdAt: new Date().toISOString(),
      conversationIndex: messages.length,
      prompt: this.redact(prompt).slice(0, 2000),
      promptId: id,
      text: this.redact(prompt).slice(0, 2000),
      fileChanges: [],
      messages: messages.map(({role, content, toolCalls, toolCallId, toolName, reasoning}) => ({
        role,
        content,
        ...(toolCalls ? {toolCalls} : {}),
        ...(toolCallId ? {toolCallId, toolName} : {}),
        ...(reasoning ? {reasoning} : {}),
      })),
      changes: [],
      files: 0,
      restorable: true,
    };
    const data = JSON.stringify(record);
    // Never keep secret-bearing checkpoint contents. Large histories are not copied unboundedly.
    if (
      this.hasSecret(record.messages) ||
      this.redact(data) !== data ||
      Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES
    ) {
      record.messages = [];
      record.restorable = false;
    }
    this.db
      .query('INSERT INTO turn_checkpoints(id,session_id,workspace,data) VALUES(?,?,?,?)')
      .run(id, sessionId, workspace, JSON.stringify(record));
    this.prune(sessionId);
    return id;
  }
  recordRewind(checkpointId: string, sessionId: string, targetSessionId: string, scope: string): void {
    this.db
      .query('INSERT INTO rewind_events(checkpoint_id,session_id,target_session_id,scope,at) VALUES(?,?,?,?,?)')
      .run(checkpointId, sessionId, targetSessionId, scope, new Date().toISOString());
  }
  private hasSecret(value: unknown): boolean {
    if (typeof value === 'string') return this.redact(value) !== value;
    if (Array.isArray(value)) return value.some(item => this.hasSecret(item));
    return !!value && typeof value === 'object' && Object.values(value).some(item => this.hasSecret(item));
  }
  private prune(sessionId: string): void {
    const rows = this.db
      .query(
        'SELECT id,length(CAST(data AS BLOB)) AS bytes FROM turn_checkpoints WHERE session_id=? ORDER BY rowid DESC',
      )
      .all(sessionId) as {id: string; bytes: number}[];
    let bytes = 0;
    let pruned = false;
    rows.forEach((row, index) => {
      bytes += row.bytes;
      if (index >= 100 || bytes > 64 * 1024 * 1024) {
        this.db.query('DELETE FROM turn_checkpoints WHERE id=?').run(row.id);
        pruned = true;
      }
    });
    if (pruned) {
      const first = this.db
        .query('SELECT id,data FROM turn_checkpoints WHERE session_id=? ORDER BY rowid LIMIT 1')
        .get(sessionId) as {id: string; data: string} | null;
      if (first)
        this.db
          .query('UPDATE turn_checkpoints SET data=? WHERE id=?')
          .run(JSON.stringify({...JSON.parse(first.data), sessionDiffIncomplete: true}), first.id);
    }
  }
  get(id: string): CheckpointRecord | undefined {
    const row = this.db.query('SELECT data FROM turn_checkpoints WHERE id=?').get(id) as {data: string} | null;
    return row ? (JSON.parse(row.data) as CheckpointRecord) : undefined;
  }
  list(sessionId: string, workspace: string): CheckpointView[] {
    return this.records(sessionId, workspace).map(
      ({id, sessionId, createdAt, conversationIndex, prompt, promptId, text, fileChanges, files, restorable}) => ({
        id,
        sessionId,
        createdAt,
        conversationIndex,
        prompt,
        promptId,
        text,
        fileChanges,
        files,
        restorable,
      }),
    );
  }
  private records(sessionId: string, workspace: string): CheckpointRecord[] {
    return (
      this.db
        .query('SELECT data FROM turn_checkpoints WHERE session_id=? AND workspace=? ORDER BY rowid')
        .all(sessionId, workspace) as {data: string}[]
    ).map(row => JSON.parse(row.data) as CheckpointRecord);
  }
  /** Earliest retained preimages; omitted checkpoints fail closed rather than silently changing the base. */
  sessionDiffBaseline(
    sessionId: string,
    workspace: string,
  ): {files: {path: string; before: string | null}[]; reason?: string} {
    const records = this.records(sessionId, workspace);
    if (
      records.some(
        record => (record as CheckpointRecord & {sessionDiffBaselineVersion?: number}).sessionDiffBaselineVersion !== 1,
      )
    )
      return {files: [], reason: 'Legacy session checkpoint baseline completeness is unknown.'};
    if (records.some(record => (record as CheckpointRecord & {sessionDiffIncomplete?: boolean}).sessionDiffIncomplete))
      return {files: [], reason: 'Session diff baseline exceeded checkpoint retention.'};
    if (records.some(record => !record.restorable))
      return {files: [], reason: 'Session checkpoint baseline is unavailable or redacted.'};
    const files = new Map<string, {path: string; before: string | null}>();
    for (const record of records)
      for (const change of record.changes)
        if (!files.has(change.path)) files.set(change.path, {path: change.path, before: change.before});
    return {files: [...files.values()]};
  }
  workspaceDiffSnapshot(
    sessionId: string,
    workspace: string,
  ): {files: {path: string; before: string | null}[]; reason?: string} | undefined {
    const records = this.records(sessionId, workspace) as (CheckpointRecord & {
      workspaceDiffSnapshot?: {files: {path: string; before: string | null}[]; reason?: string};
    })[];
    const snapshot = records.find(record => record.workspaceDiffSnapshot)?.workspaceDiffSnapshot;
    return snapshot && this.hasSecret(snapshot)
      ? {files: [], reason: 'Workspace baseline is unavailable or redacted.'}
      : snapshot;
  }
  saveWorkspaceDiffSnapshot(
    id: string,
    snapshot: {files: {path: string; before: string | null}[]; reason?: string},
  ): void {
    const record = this.get(id);
    if (!record) throw new FutrynError('STORAGE');
    const data = JSON.stringify({...record, workspaceDiffSnapshot: snapshot});
    const safe =
      this.hasSecret(snapshot) || Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES
        ? {files: [], reason: 'Workspace baseline is unavailable or redacted.'}
        : snapshot;
    this.db
      .query('UPDATE turn_checkpoints SET data=? WHERE id=?')
      .run(JSON.stringify({...record, workspaceDiffSnapshot: safe}), id);
    this.prune(record.sessionId);
  }
  /** Persist the expected post-state before the patch writes anything. A crash never loses the preimage. */
  capture(id: string, changes: CheckpointFile[]): void {
    const record = this.get(id);
    if (!record) throw new FutrynError('STORAGE');
    for (const change of changes) {
      const previous = record.changes.find(c => c.path === change.path);
      if (previous) {
        previous.afterHash = change.afterHash;
        previous.afterMode = change.afterMode;
        previous.additions += change.additions;
        previous.deletions += change.deletions;
      } else record.changes.push(change);
    }
    record.files = record.changes.length;
    record.fileChanges = record.changes.map(({path, additions, deletions}) => ({
      path: this.redact(path),
      additions,
      deletions,
    }));
    const saved = record as CheckpointRecord & {
      workspaceDiffSnapshot?: {files: {path: string; before: string | null}[]; reason?: string};
    };
    if (saved.workspaceDiffSnapshot && this.hasSecret(saved.workspaceDiffSnapshot))
      saved.workspaceDiffSnapshot = {files: [], reason: 'Workspace baseline is unavailable or redacted.'};
    const data = JSON.stringify(record);
    if (
      record.changes.some(
        c => this.redact(c.path) !== c.path || (c.before !== null && this.redact(c.before) !== c.before),
      ) ||
      this.redact(data) !== data ||
      Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES
    ) {
      record.restorable = false;
      record.changes = [];
    }
    this.db.query('UPDATE turn_checkpoints SET data=? WHERE id=?').run(JSON.stringify(record), id);
    this.prune(record.sessionId);
  }
  /** Undo this checkpoint and every later turn of the same session, comparing the latest poststate. */
  restoration(id: string, sessionId: string, workspace: string): CheckpointRecord {
    const records = this.records(sessionId, workspace);
    const index = records.findIndex(r => r.id === id);
    if (index < 0) throw new FutrynError('NOT_FOUND');
    const target = records[index]!;
    const changes = new Map<string, CheckpointFile>();
    for (const record of records.slice(index)) {
      if (!record.restorable) throw new FutrynError('POLICY');
      for (const change of record.changes) {
        const previous = changes.get(change.path);
        if (previous) {
          previous.afterHash = change.afterHash;
          previous.afterMode = change.afterMode;
        } else changes.set(change.path, {...change});
      }
    }
    return {...target, changes: [...changes.values()], files: changes.size};
  }
}
