import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HannesError } from '@hannes/contracts';

export function openPrivateDatabase(directory: string): Database {
  try {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new HannesError('STORAGE');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new HannesError('STORAGE');
    const path = join(root, 'provider-auth.sqlite');
    for (const file of [path, path + '-journal', path + '-wal', path + '-shm']) {
      if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new HannesError('STORAGE');
    }
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd); chmodSync(path, 0o600);
    const db = new Database(path, { strict: true });
    db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;');
    const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { db.close(); throw new HannesError('STORAGE'); }
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, selection TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (conversation TEXT NOT NULL REFERENCES conversations(id), revision INTEGER NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(conversation,revision));
        PRAGMA user_version=1;`);
    })();
    return db;
  } catch { throw new HannesError('STORAGE'); }
}
