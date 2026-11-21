import {dlopen, read, CString} from 'bun:ffi';
import {
  existsSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  readSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import {FutrynError} from '@cosmew/contracts';

// Same trusted-libc traversal primitives as workspace SecureFiles, kept private to durable storage.
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
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
const fail = (): never => {
  throw new FutrynError('STORAGE');
};
const removedir = process.platform === 'darwin' ? 0x80 : 0x200;
/** Descriptor-relative operations; directory swaps cannot redirect reads or writes. */
export class MemoryDirectory {
  private constructor(readonly fd: number) {}
  static open(root: string, id: string, create: boolean): MemoryDirectory | undefined {
    if (!native) return fail();
    let fd = openSync('/', directoryFlags);
    const rootParts = root.split('/').filter(Boolean);
    const parts = [...rootParts, 'projects', id, 'memory'];
    try {
      for (let i = 0; i < parts.length; i++) {
        const name = c(parts[i]!);
        let next = native.symbols.openat(fd, name, directoryFlags, 0);
        if (next < 0 && errno() === 2) {
          if (!create) {
            closeSync(fd);
            return undefined;
          }
          if (i < rootParts.length - 1 || native.symbols.mkdirat(fd, name, 0o700) !== 0) return fail();
          next = native.symbols.openat(fd, name, directoryFlags, 0);
        }
        if (next < 0) return fail();
        closeSync(fd);
        fd = next;
        if (i >= rootParts.length - 1) {
          const stat = fstatSync(fd);
          if (process.getuid && stat.uid !== process.getuid()) return fail();
          fchmodSync(fd, 0o700);
        }
      }
      return new MemoryDirectory(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  close(): void {
    closeSync(this.fd);
  }
  private file(name: string): number | undefined {
    const fd = native!.symbols.openat(
      this.fd,
      c(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec,
      0,
    );
    if (fd < 0) {
      if (errno() === 2) return undefined;
      return fail();
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      closeSync(fd);
      return fail();
    }
    return fd;
  }
  size(name: string): number | undefined {
    const fd = this.file(name);
    if (fd === undefined) return undefined;
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  }
  modified(name: string): string {
    const fd = this.file(name);
    if (fd === undefined) return fail();
    try {
      return fstatSync(fd).mtime.toISOString();
    } finally {
      closeSync(fd);
    }
  }
  read(name: string, limit: number, prefix = false): string | undefined {
    const fd = this.file(name);
    if (fd === undefined) return undefined;
    try {
      if (!prefix && fstatSync(fd).size > limit) return fail();
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, null);
        if (!n) break;
        length += n;
      }
      if (!prefix && length > limit) return fail();
      return new TextDecoder('utf-8', {fatal: !prefix}).decode(bytes.subarray(0, length));
    } finally {
      closeSync(fd);
    }
  }
  names(): string[] {
    const copy = native!.symbols.openat(this.fd, c('.'), directoryFlags, 0);
    if (copy < 0) return fail();
    const directory = native!.symbols.fdopendir(copy);
    if (!directory) {
      closeSync(copy);
      return fail();
    }
    try {
      const names: string[] = [];
      while (true) {
        const entry = native!.symbols.readdir(directory);
        if (!entry) break;
        const name = new CString(Number(entry) + (process.platform === 'darwin' ? 21 : 19)).toString();
        if (name !== '.' && name !== '..') names.push(name);
        if (names.length > 259) return fail();
      }
      return names.sort();
    } finally {
      native!.symbols.closedir(directory);
    }
  }
  lock(): void {
    if (native!.symbols.mkdirat(this.fd, c('.lock'), 0o700) !== 0) fail();
  }
  unlock(): void {
    if (native!.symbols.unlinkat(this.fd, c('.lock'), removedir) !== 0) fail();
  }
  delete(name: string): void {
    if (this.size(name) === undefined) return;
    if (native!.symbols.unlinkat(this.fd, c(name), 0) !== 0) fail();
  }
  atomic(name: string, text: string): void {
    this.size(name); // Reject symlinks/hardlinks, including dangling links, before replace.
    const temp = c(`.${crypto.randomUUID()}.tmp`);
    const fd = native!.symbols.openat(
      this.fd,
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec,
      0o600,
    );
    if (fd < 0) return fail();
    try {
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (native!.symbols.renameat(this.fd, temp, this.fd, c(name)) !== 0) return fail();
      fsyncSync(this.fd);
    } finally {
      native!.symbols.unlinkat(this.fd, temp, 0);
    }
  }
}
