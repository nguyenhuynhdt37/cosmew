import {Database} from 'bun:sqlite';
import {chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {FutrynError} from '@cosmew/contracts';
import {migrateRemovedCodexRuntime, migrateRemovedRuntimes} from './runtime-removal';

export function openPrivateDatabase(directory: string): Database {
  try {
    const root = resolve(directory);
    mkdirSync(root, {recursive: true, mode: 0o700});
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new FutrynError('STORAGE');
    if (process.platform !== 'win32' && stat.mode & 0o077) throw new FutrynError('STORAGE');
    const path = join(root, 'provider-auth.sqlite');
    for (const file of [path, path + '-journal', path + '-wal', path + '-shm']) {
      if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()))
        throw new FutrynError('STORAGE');
    }
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    chmodSync(path, 0o600);
    const db = new Database(path, {strict: true});
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;');
    const version = (db.query('PRAGMA user_version').get() as {user_version: number}).user_version;
    if (version > 13) {
      db.close();
      throw new FutrynError('STORAGE');
    }
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, selection TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (conversation TEXT NOT NULL REFERENCES conversations(id), revision INTEGER NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(conversation,revision));
        CREATE TABLE IF NOT EXISTS turn_receipts (conversation TEXT NOT NULL REFERENCES conversations(id), revision INTEGER NOT NULL,
          data TEXT NOT NULL, PRIMARY KEY(conversation,revision));`);
      // v3 (ADR 0017): tool calls and tool results are stored as JSON next to the message text.
      const columns = db.query('PRAGMA table_info(messages)').all() as {name: string}[];
      if (!columns.some(column => column.name === 'parts')) db.exec('ALTER TABLE messages ADD COLUMN parts TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS tool_audit (at TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, target TEXT,
        phase TEXT NOT NULL, decision TEXT, reason TEXT, outcome TEXT, code TEXT);`);
      db.exec(`CREATE TABLE IF NOT EXISTS execution_turns (
        conversation TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL,
        user_revision INTEGER NOT NULL, end_revision INTEGER, state TEXT NOT NULL,
        owner_pid INTEGER NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(conversation,id));
        CREATE TABLE IF NOT EXISTS conversation_events (
        conversation TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
        turn_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(conversation,seq), FOREIGN KEY(conversation,turn_id) REFERENCES execution_turns(conversation,id));
        CREATE TABLE IF NOT EXISTS conversation_checkpoints (
        conversation TEXT PRIMARY KEY REFERENCES conversations(id), task TEXT, context TEXT);`);
      const auditColumns = db.query('PRAGMA table_info(tool_audit)').all() as {name: string}[];
      if (!auditColumns.some(column => column.name === 'scope_hash'))
        db.exec('ALTER TABLE tool_audit ADD COLUMN scope_hash TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS next_turn_input (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL UNIQUE, content TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS next_turn_input_session ON next_turn_input(conversation,position);`);
      // v6 (wave 1, ADR 0041/0042): tool media apart from messages and the journal (bounded per
      // conversation by the store), nested AGENTS.md directories discovered by reads, the plan.
      db.exec(`CREATE TABLE IF NOT EXISTS tool_attachments (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL REFERENCES conversations(id), call_id TEXT NOT NULL,
        bytes INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(conversation, call_id));
        CREATE TABLE IF NOT EXISTS session_instructions (
        conversation TEXT NOT NULL REFERENCES conversations(id), directory TEXT NOT NULL,
        PRIMARY KEY(conversation, directory));
        CREATE TABLE IF NOT EXISTS session_plan_approval (
          conversation TEXT PRIMARY KEY REFERENCES conversations(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_plan (
        conversation TEXT PRIMARY KEY REFERENCES conversations(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subagent_sessions (
        id TEXT PRIMARY KEY REFERENCES conversations(id),
        parent_conversation TEXT NOT NULL REFERENCES conversations(id),
        parent_turn_id TEXT,
        call_id TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1,
        agent_type TEXT NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        fork_context INTEGER NOT NULL DEFAULT 0,
        background INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        error_code TEXT);
        CREATE INDEX IF NOT EXISTS subagent_sessions_parent ON subagent_sessions(parent_conversation, created_at);`);
      // S5c: additive column for worktree-isolated children (no schema version bump).
      const subagentColumns = db.query('PRAGMA table_info(subagent_sessions)').all() as {name: string}[];
      if (!subagentColumns.some(column => column.name === 'isolation'))
        db.exec('ALTER TABLE subagent_sessions ADD COLUMN isolation TEXT');
      // v7 (ADR 0045): chat-only subscription runtimes are removed; their accounts are logged out.
      if (version < 7) migrateRemovedRuntimes(db);
      // v8 (ADR 0049): the Codex app-server runtime is removed; its accounts and leases are deleted.
      if (version < 8) migrateRemovedCodexRuntime(db);
      // v9 (ADR 0069): append-only input retraction receipts; never rewrite execution evidence.
      db.exec(`CREATE TABLE IF NOT EXISTS input_retractions (
        conversation TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL,
        at TEXT NOT NULL, PRIMARY KEY(conversation,id));`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS turn_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id), workspace TEXT NOT NULL, data TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS rewind_events (position INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL, session_id TEXT NOT NULL, target_session_id TEXT NOT NULL, scope TEXT NOT NULL, at TEXT NOT NULL);`,
      );
      // v10 (ADR 0074): explicit workspace identity and prompt time; unknown legacy data stays NULL.
      const conversationColumns = db.query('PRAGMA table_info(conversations)').all() as {name: string}[];
      if (!conversationColumns.some(c => c.name === 'workspace'))
        db.exec('ALTER TABLE conversations ADD COLUMN workspace TEXT');
      if (!columns.some(c => c.name === 'created_at')) db.exec('ALTER TABLE messages ADD COLUMN created_at TEXT');
      if (version < 10) {
        db.exec(`UPDATE conversations SET workspace=(SELECT workspace FROM turn_checkpoints WHERE session_id=conversations.id LIMIT 1) WHERE workspace IS NULL;
          UPDATE messages SET created_at=(SELECT json_extract(data,'$.startedAt') FROM turn_receipts r WHERE r.conversation=messages.conversation AND r.revision=messages.revision) WHERE role='user' AND created_at IS NULL;`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS prompt_history (
        conversation TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL,
        workspace TEXT, at TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY(conversation,id));
        CREATE INDEX IF NOT EXISTS prompt_history_recent ON prompt_history(at DESC);`);
      if (version < 10) {
        db.exec(`INSERT OR IGNORE INTO prompt_history(conversation,id,workspace,at,content)
          SELECT m.conversation, 'message:' || m.revision, c.workspace, m.created_at, substr(m.content,1,16000)
          FROM messages m JOIN conversations c ON c.id=m.conversation
          WHERE m.role='user' AND m.created_at IS NOT NULL;
          INSERT OR IGNORE INTO prompt_history(conversation,id,workspace,at,content)
          SELECT e.conversation,json_extract(e.data,'$.steerId'),c.workspace,e.at,substr(json_extract(e.data,'$.message.content'),1,16000)
          FROM conversation_events e JOIN conversations c ON c.id=e.conversation
          WHERE json_extract(e.data,'$.type')='user.steered';`);
      }
      db.exec(
        'DELETE FROM prompt_history WHERE rowid IN (SELECT rowid FROM prompt_history ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 5000)',
      );
      // v11 (ADR 0089): inspectable shell snapshots; execution is never reconstructed.
      db.exec(`CREATE TABLE IF NOT EXISTS background_task_history (
        conversation TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL,
        updated_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversation,id));
        CREATE INDEX IF NOT EXISTS background_task_history_recent ON background_task_history(updated_at DESC);`);
      // v12: billing without an agent receipt must not invent a conversation turn.
      db.exec(`CREATE TABLE IF NOT EXISTS session_usage (
        conversation TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, data TEXT NOT NULL);`);
      if (!conversationColumns.some(column => column.name === 'title'))
        db.exec('ALTER TABLE conversations ADD COLUMN title TEXT');
      db.exec('PRAGMA user_version=13;');
    })();
    return db;
  } catch {
    throw new FutrynError('STORAGE');
  }
}
