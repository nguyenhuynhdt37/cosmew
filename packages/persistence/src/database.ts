import {Database} from 'bun:sqlite';
import {chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {FutrynError} from '@futryn/contracts';
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
    if (version > 8) {
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
      db.exec('PRAGMA user_version=8;');
    })();
    return db;
  } catch {
    throw new FutrynError('STORAGE');
  }
}
