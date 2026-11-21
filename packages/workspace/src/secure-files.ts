import {dlopen, read, CString} from 'bun:ffi';
import {
  constants,
  existsSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  openSync,
} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import type {WorkspaceRoot} from './paths';

/** Trusted system libc only. No shell, user-selected library or native helper. */
const load = () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  const library =
    process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : [`/lib/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-linux-gnu/libc.so.6`, '/lib64/libc.so.6'].find(path =>
          existsSync(path),
        );
  if (!library) return null;
  try {
    return dlopen(library, {
      fdopendir: {args: ['i32'], returns: 'ptr'},
      readdir: {args: ['ptr'], returns: 'ptr'},
      closedir: {args: ['ptr'], returns: 'i32'},
      openat: {args: ['i32', 'buffer', 'i32', 'u32'], returns: 'i32'},
      mkdirat: {args: ['i32', 'buffer', 'u32'], returns: 'i32'},
      unlinkat: {args: ['i32', 'buffer', 'i32'], returns: 'i32'},
      renameat: {args: ['i32', 'buffer', 'i32', 'buffer'], returns: 'i32'},
      linkat: {args: ['i32', 'buffer', 'i32', 'buffer', 'i32'], returns: 'i32'},
      ...(process.platform === 'darwin'
        ? {__error: {args: [], returns: 'ptr'} as const}
        : {__errno_location: {args: [], returns: 'ptr'} as const}),
    });
  } catch {
    return null;
  }
};
const native = load();
const c = (s: string) => Buffer.from(s + '\0');
const errno = () => {
  const symbols = native!.symbols;
  return read.i32(('__error' in symbols ? symbols.__error : symbols.__errno_location)()!);
};
const closeOnExec = process.platform === 'darwin' ? 0x1000000 : 0x80000;
export class WriteBoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code = 'UNSAFE_PATH'): never => {
  throw new WriteBoundaryError(code);
};
export interface FileSnapshot {
  path: string;
  content: string | null;
  hash: string | null;
  dev: number | null;
  ino: number | null;
  mode: number;
  parents: {path: string; dev: number; ino: number}[];
  /** Open root when the file is not in the project. Absent for project snapshots. */
  base?: string;
  /** Ledger and resolve key when it differs from `path` (a granted file's absolute path). */
  identity?: string;
}
export const contentHash = (s: string) => createHash('sha256').update(s).digest('hex');
export function writePath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/.test(path) ||
    path.startsWith('/') ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some(p => p === '..' || p === '' || p === '.') ||
    path.normalize('NFC') !== path
  )
    fail();
  return path;
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
/** Descriptor-relative traversal. Every ancestor and final component is opened without symlinks. */
export class SecureFiles {
  static available(): boolean {
    return native !== null;
  }
  readonly createdDirectories: string[] = [];
  private created = new Map<string, {dev: number; ino: number}>();
  constructor(private readonly workspace: WorkspaceRoot) {}
  private parent(
    path: string,
    create = false,
    expected?: FileSnapshot,
    base = expected?.base ?? this.workspace.root,
  ): {fd: number; name: Buffer; parents: FileSnapshot['parents']; missing: boolean} {
    writePath(path);
    if (!native) fail('WRITE_UNAVAILABLE');
    let fd = openSync(base, directoryFlags);
    const parents: FileSnapshot['parents'] = [];
    const parts = path.split('/'),
      name = c(parts.pop()!);
    let prefix = '';
    const createdKey = (dir: string) => base + '\0' + dir;
    try {
      const record = (path: string) => {
        const st = fstatSync(fd);
        const previous = expected?.parents.find(p => p.path === path) ?? this.created.get(createdKey(path));
        if (previous && (st.dev !== previous.dev || st.ino !== previous.ino)) fail('STALE_CONTENT');
        parents.push({path, dev: st.dev, ino: st.ino});
      };
      record('');
      for (const part of parts) {
        prefix = prefix ? prefix + '/' + part : part;
        let next = native!.symbols.openat(fd, c(part), directoryFlags, 0);
        if (next < 0) {
          if (errno() !== 2) fail();
          if (!create) return {fd, name, parents, missing: true};
          if (native!.symbols.mkdirat(fd, c(part), 0o755) !== 0) fail('WRITE_FAILED');
          this.createdDirectories.push(prefix);
          next = native!.symbols.openat(fd, c(part), directoryFlags, 0);
          if (next < 0) fail();
          const st = fstatSync(next);
          this.created.set(createdKey(prefix), {dev: st.dev, ino: st.ino});
        }
        closeSync(fd);
        fd = next;
        record(prefix);
      }
      return {fd, name, parents, missing: false};
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  /** Binary, descriptor-relative read for a sealed command snapshot. No symlinks or hardlinks. */
  executionBytes(path: string, maxBytes: number): {bytes: Buffer; mode: number} {
    const parent = this.parent(path);
    try {
      if (parent.missing) fail();
      const fd = native!.symbols.openat(
        parent.fd,
        parent.name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec,
        0,
      );
      if (fd < 0) fail();
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) fail('UNSAFE_SNAPSHOT');
        const bytes = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < bytes.length) {
          const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!n) fail('STALE_CONTENT');
          offset += n;
        }
        const after = fstatSync(fd);
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs)
          fail('STALE_CONTENT');
        return {bytes, mode: st.mode & 0o111 ? 0o755 : 0o644};
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
  }
  executionDirectory(path: string): {names: string[]; identity: string} {
    const parent =
      path === '.' ? {fd: openSync(this.workspace.root, directoryFlags)} : this.parent(path + '/.snapshot-entry');
    let directory: ReturnType<NonNullable<typeof native>['symbols']['fdopendir']> = null;
    try {
      const st = fstatSync(parent.fd);
      if (!st.isDirectory()) fail();
      directory = native!.symbols.fdopendir(parent.fd);
      if (!directory) fail();
      const names: string[] = [];
      for (;;) {
        const entry = native!.symbols.readdir(directory);
        if (!entry) break;
        const name = new CString(Number(entry) + (process.platform === 'darwin' ? 21 : 19)).toString();
        if (name !== '.' && name !== '..') names.push(name);
        if (names.length > 30000) fail('SNAPSHOT_LIMIT');
      }
      const after = fstatSync(parent.fd);
      if (st.ino !== after.ino || st.dev !== after.dev || st.mtimeMs !== after.mtimeMs) fail('STALE_CONTENT');
      return {names: names.sort(), identity: `${st.dev}:${st.ino}`};
    } finally {
      if (directory) native!.symbols.closedir(directory);
      else closeSync(parent.fd);
    }
  }
  snapshot(path: string, base = this.workspace.root): FileSnapshot {
    const parent = this.parent(path, false, undefined, base);
    const located = base !== this.workspace.root ? {base} : {};
    try {
      const empty: FileSnapshot = {
        path,
        content: null,
        hash: null,
        dev: null,
        ino: null,
        mode: 0o644,
        parents: parent.parents,
        ...located,
      };
      if (parent.missing) return empty;
      const fd = native!.symbols.openat(
        parent.fd,
        parent.name,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec,
        0,
      );
      if (fd < 0) {
        if (errno() === 2) return empty;
        fail();
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) fail();
        if (st.size > 1024 * 1024) fail('FILE_TOO_LARGE');
        const buffer = Buffer.alloc(Math.min(st.size + 1, 1024 * 1024 + 1));
        let length = 0;
        while (length < buffer.length) {
          const n = readSync(fd, buffer, length, buffer.length - length, null);
          if (!n) break;
          length += n;
        }
        const after = fstatSync(fd);
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs)
          fail('STALE_CONTENT');
        const bytes = buffer.subarray(0, length);
        if (bytes.length > 1024 * 1024 || bytes.includes(0)) fail('UNSUPPORTED_FILE');
        let content = '';
        try {
          content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
        } catch {
          fail('UNSUPPORTED_FILE');
        }
        return {
          path,
          content,
          hash: contentHash(content),
          dev: st.dev,
          ino: st.ino,
          mode: st.mode & 0o777,
          parents: parent.parents,
          ...located,
        };
      } finally {
        closeSync(fd);
      }
    } finally {
      closeSync(parent.fd);
    }
  }
  revalidate(snapshot: FileSnapshot): void {
    const base = snapshot.base ?? this.workspace.root;
    const now = this.snapshot(snapshot.path, base);
    if (
      (now.base ?? '') !== (snapshot.base ?? '') ||
      now.hash !== snapshot.hash ||
      now.dev !== snapshot.dev ||
      now.ino !== snapshot.ino ||
      now.mode !== snapshot.mode ||
      snapshot.parents.some(p => !now.parents.some(n => p.path === n.path && p.dev === n.dev && p.ino === n.ino))
    )
      fail('STALE_CONTENT');
  }
  apply(snapshot: FileSnapshot, content: string | null, mode = snapshot.mode): void {
    this.revalidate(snapshot);
    const parent = this.parent(snapshot.path, content !== null, snapshot);
    try {
      if (parent.missing) fail('STALE_CONTENT');
      if (content === null) {
        if (native!.symbols.unlinkat(parent.fd, parent.name, 0) !== 0) fail('WRITE_FAILED');
        return;
      }
      const temp = c('.hannes-patch-' + randomUUID());
      const fd = native!.symbols.openat(
        parent.fd,
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec,
        0o600,
      );
      if (fd < 0) fail('WRITE_FAILED');
      try {
        const bytes = Buffer.from(content);
        let offset = 0;
        while (offset < bytes.length) {
          const n = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!n) fail('WRITE_FAILED');
          offset += n;
        }
        fchmodSync(fd, mode);
        fsyncSync(fd);
      } catch (error) {
        native!.symbols.unlinkat(parent.fd, temp, 0);
        throw error;
      } finally {
        closeSync(fd);
      }
      try {
        // Atomic replacement never follows the final destination; exclusive linking protects adds.
        this.revalidate(snapshot);
        if (snapshot.content === null) {
          if (native!.symbols.linkat(parent.fd, temp, parent.fd, parent.name, 0) !== 0) fail('STALE_CONTENT');
        } else if (native!.symbols.renameat(parent.fd, temp, parent.fd, parent.name) !== 0) fail('WRITE_FAILED');
      } finally {
        native!.symbols.unlinkat(parent.fd, temp, 0);
      }
    } finally {
      closeSync(parent.fd);
    }
  }
}
