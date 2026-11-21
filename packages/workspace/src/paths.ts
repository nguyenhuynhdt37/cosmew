import {closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {FutrynError} from '@cosmew/contracts';

export interface ResolvedPath {
  /** Canonical absolute path (symlinks resolved), inside the project or a granted directory. */
  absolute: string;
  /**
   * Project files: path relative to the project with `/` separators (`.` for the root).
   * Files in a granted directory: the canonical absolute path with `/` separators, so the read
   * ledger and a later resolve round-trip.
   */
  relative: string;
  kind: 'file' | 'directory';
  /** Canonical directory this path belongs to. The project root for project files. */
  root: string;
}

/** A denial the dispatcher reports to the model without revealing paths outside working directories. */
export class WorkspaceDenied extends FutrynError {
  constructor(readonly reason: 'outside-workspace' | 'not-found' | 'invalid-path' | 'inaccessible') {
    super(reason === 'not-found' ? 'NOT_FOUND' : reason === 'invalid-path' ? 'INVALID_INPUT' : 'POLICY');
  }
}

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

interface WorkingRoot {
  /** Path as given, before symlink resolution, so `/var` and `/private/var` both match. */
  lexical: string;
  canonical: string;
}

/** Project first, then canonical granted directories. Missing directories and the project itself are dropped. */
function workingRoots(project: string, additional: readonly string[]): WorkingRoot[] {
  const roots: WorkingRoot[] = [{lexical: project, canonical: project}];
  const seen = new Set<string>([project]);
  for (const entry of additional) {
    if (!entry || entry.length > 1024 || entry.includes('\0')) continue;
    const lexical = resolve(entry);
    let canonical: string;
    try {
      canonical = realpathSync.native(lexical);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push({lexical, canonical});
  }
  return roots;
}

/** Project wins when a path sits in both; otherwise the longest granted directory. */
function owningRoot(roots: readonly WorkingRoot[], absolute: string): WorkingRoot | null {
  const project = roots[0]!;
  if (inside(project.canonical, absolute)) return project;
  let best: WorkingRoot | null = null;
  for (const root of roots.slice(1)) {
    if (!inside(root.canonical, absolute)) continue;
    if (!best || root.canonical.length > best.canonical.length) best = root;
  }
  return best;
}

/** A real path may be walked through when it is inside a working directory or is an ancestor of one. */
function ancestorOrInside(roots: readonly WorkingRoot[], real: string): boolean {
  if (owningRoot(roots, real)) return true;
  const prefix = real.endsWith(sep) ? real : real + sep;
  return roots.some(root => root.canonical === real || root.canonical.startsWith(prefix));
}

/**
 * Follow the lexical path one component at a time. An intermediate symlink may enter another
 * working directory. A symlink that leaves every working directory, or a path that was never inside
 * one, is rejected. The final component may be missing (a file to create).
 */
function seal(roots: readonly WorkingRoot[], lexical: string): string | null {
  const parts = lexical.split(sep).filter(Boolean);
  let current: string = sep;
  for (let index = 0; index < parts.length; index++) {
    const next = join(current, parts[index]!);
    try {
      const real = realpathSync.native(next);
      if (!ancestorOrInside(roots, real)) return null;
      current = real;
    } catch (error) {
      const code = (error as {code?: string}).code ?? '';
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      if (!owningRoot(roots, current)) return null;
      const suffix = parts.slice(index);
      if (suffix.some(part => part === '..' || part === '.' || part === '')) return null;
      const absolute = join(current, ...suffix);
      return owningRoot(roots, absolute) ? absolute : null;
    }
  }
  return owningRoot(roots, current) ? current : null;
}

const WRITE_PATH_UNSAFE = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\\]/;

/** Same shape `writePath` accepts, so a project-relative create does not need the file to exist. */
function projectWritePath(path: string): boolean {
  return Boolean(
    path &&
    path.length <= 1024 &&
    !WRITE_PATH_UNSAFE.test(path) &&
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !path.split('/').some(part => part === '..' || part === '' || part === '.') &&
    path.normalize('NFC') === path,
  );
}

const posix = (absolute: string): string => absolute.split(sep).join('/');

export interface WriteTarget {
  /** Directory `SecureFiles` opens (`openat` root). */
  base: string;
  /** `writePath`-safe path relative to `base`. */
  relative: string;
  /** Read-ledger and resolve key. Project-relative, or the canonical absolute path. */
  key: string;
  absolute: string;
}

/**
 * Where a write lands. A plain project-relative path (no leading `/`, no `.` or `..`) stays a
 * create-under-the-project and is not realpath'd, so a new file whose parent does not exist yet
 * still works. Absolute paths and `..` must land in the project or a granted directory.
 */
export function locateWriteTarget(
  workspace: WorkspaceRoot,
  input: string,
  additional: readonly string[] = [],
): WriteTarget {
  if (!input || input.length > 1024 || input.includes('\0')) throw new WorkspaceDenied('invalid-path');
  if (projectWritePath(input)) {
    return {base: workspace.root, relative: input, key: input, absolute: join(workspace.root, input)};
  }
  const lexical = isAbsolute(input) ? resolve(input) : resolve(workspace.root, input);
  const roots = workingRoots(workspace.root, additional);
  const absolute = seal(roots, lexical);
  const owner = absolute ? owningRoot(roots, absolute) : null;
  if (!absolute || !owner) throw new WorkspaceDenied('outside-workspace');
  const rel = relative(owner.canonical, absolute).split(sep).join('/');
  if (!projectWritePath(rel)) throw new WorkspaceDenied('invalid-path');
  return {
    base: owner.canonical,
    relative: rel,
    key: owner.canonical === workspace.root ? rel : posix(absolute),
    absolute,
  };
}

/**
 * The approved workspace. Every model-supplied path is resolved here: containment in the project
 * or a granted directory, then symlink-aware containment of the real path, then a recheck after
 * the file is opened. Granted directories are an argument, never stored on the shared root.
 */
export class WorkspaceRoot {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync.native(resolve(root));
  }

  resolve(input: string, additional: readonly string[] = []): ResolvedPath {
    if (!input || input.length > 1024 || input.includes('\0')) throw new WorkspaceDenied('invalid-path');
    const roots = workingRoots(this.root, additional);
    const lexical = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    // `/outside/symlink-into-a-root` is refused: the spelled path must itself walk through a root.
    if (!roots.some(root => inside(root.lexical, lexical) || inside(root.canonical, lexical))) {
      // `/var/...` and `/private/var/...` name the same tree. `seal` accepts that spelling and
      // still rejects a path that only enters a root by an unrelated symlink.
      if (!seal(roots, lexical)) throw new WorkspaceDenied('outside-workspace');
    }
    let absolute: string;
    try {
      absolute = realpathSync.native(lexical);
    } catch (error) {
      throw new WorkspaceDenied(
        ['ENOENT', 'ENOTDIR'].includes((error as {code?: string}).code ?? '') ? 'not-found' : 'inaccessible',
      );
    }
    const owner = owningRoot(roots, absolute);
    if (!owner) throw new WorkspaceDenied('outside-workspace');
    const stat = statSync(absolute);
    if (!stat.isFile() && !stat.isDirectory()) throw new WorkspaceDenied('invalid-path');
    const project = owner.canonical === this.root;
    return {
      absolute,
      relative: project ? this.relativeOf(absolute) : posix(absolute),
      kind: stat.isFile() ? 'file' : 'directory',
      root: owner.canonical,
    };
  }

  relativeOf(absolute: string): string {
    const rel = relative(this.root, absolute);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }

  /**
   * Read at most `maxBytes` of a resolved file. The final component is opened without following
   * symlinks, and the path must still resolve to the same inode inside its working directory after
   * opening, so a swap between the policy check and the read is detected.
   */
  readBytes(file: ResolvedPath, maxBytes: number): {bytes: Uint8Array; size: number} {
    let fd: number;
    try {
      fd = openSync(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new WorkspaceDenied(
        ['ENOENT', 'ENOTDIR'].includes((error as {code?: string}).code ?? '') ? 'not-found' : 'inaccessible',
      );
    }
    try {
      const opened = fstatSync(fd);
      let again: string;
      try {
        again = realpathSync.native(file.absolute);
      } catch {
        throw new WorkspaceDenied('not-found');
      }
      const now = statSync(again);
      if (
        again !== file.absolute ||
        !inside(file.root, again) ||
        now.ino !== opened.ino ||
        now.dev !== opened.dev ||
        !opened.isFile()
      ) {
        throw new WorkspaceDenied('outside-workspace');
      }
      const length = Math.min(opened.size, maxBytes);
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, bytes, offset, length - offset, offset);
        if (read <= 0) break;
        offset += read;
      }
      return {bytes: bytes.subarray(0, offset), size: opened.size};
    } finally {
      closeSync(fd);
    }
  }
}

/** Heuristic used by every reader: a NUL byte in the first 8 KiB means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}
