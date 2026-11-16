import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { FutrynError } from '@futryn/contracts';

export interface ResolvedPath {
  /** Canonical absolute path (symlinks resolved), always inside the root. */
  absolute: string;
  /** Path relative to the root with `/` separators; `.` for the root itself. */
  relative: string;
  kind: 'file' | 'directory';
}

/** A denial the dispatcher reports to the model without revealing paths outside the root. */
export class WorkspaceDenied extends FutrynError {
  constructor(readonly reason: 'outside-workspace' | 'not-found' | 'invalid-path' | 'inaccessible') {
    super(reason === 'not-found' ? 'NOT_FOUND' : reason === 'invalid-path' ? 'INVALID_INPUT' : 'POLICY');
  }
}

const inside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The approved workspace. Every model-supplied path is resolved here: lexical containment, then
 * symlink-aware containment of the real path, then a recheck after the file is opened.
 */
export class WorkspaceRoot {
  readonly root: string;

  constructor(root: string) {
    this.root = realpathSync.native(resolve(root));
  }

  resolve(input: string): ResolvedPath {
    if (!input || input.length > 1024 || input.includes('\0')) throw new WorkspaceDenied('invalid-path');
    const lexical = resolve(this.root, input);
    if (!inside(this.root, lexical)) throw new WorkspaceDenied('outside-workspace');
    let absolute: string;
    try { absolute = realpathSync.native(lexical); } catch (error) { throw new WorkspaceDenied(['ENOENT', 'ENOTDIR'].includes((error as {code?:string}).code ?? '') ? 'not-found' : 'inaccessible'); }
    if (!inside(this.root, absolute)) throw new WorkspaceDenied('outside-workspace');
    const stat = statSync(absolute);
    if (!stat.isFile() && !stat.isDirectory()) throw new WorkspaceDenied('invalid-path');
    return { absolute, relative: this.relativeOf(absolute), kind: stat.isFile() ? 'file' : 'directory' };
  }

  relativeOf(absolute: string): string {
    const rel = relative(this.root, absolute);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }

  /**
   * Read at most `maxBytes` of a resolved file. The final component is opened without following
   * symlinks, and the path must still resolve to the same inode inside the root after opening, so
   * a swap between the policy check and the read is detected.
   */
  readBytes(file: ResolvedPath, maxBytes: number): { bytes: Uint8Array; size: number } {
    let fd: number;
    try { fd = openSync(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { throw new WorkspaceDenied(['ENOENT', 'ENOTDIR'].includes((error as {code?:string}).code ?? '') ? 'not-found' : 'inaccessible'); }
    try {
      const opened = fstatSync(fd);
      let again: string;
      try { again = realpathSync.native(file.absolute); } catch { throw new WorkspaceDenied('not-found'); }
      const now = statSync(again);
      if (again !== file.absolute || !inside(this.root, again) || now.ino !== opened.ino || now.dev !== opened.dev || !opened.isFile()) {
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
      return { bytes: bytes.subarray(0, offset), size: opened.size };
    } finally { closeSync(fd); }
  }
}

/** Heuristic used by every reader: a NUL byte in the first 8 KiB means binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}
