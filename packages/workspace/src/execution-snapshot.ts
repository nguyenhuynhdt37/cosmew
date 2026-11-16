import {mkdirSync, writeFileSync} from 'node:fs';
import {join, relative, isAbsolute} from 'node:path';
import {SecureFiles, WriteBoundaryError} from './secure-files';
import type {WorkspaceRoot} from './paths';

/** A bounded detached copy: untrusted commands never receive a live host workspace mount. */
export function captureExecutionSnapshot(
  workspace: WorkspaceRoot,
  destination: string,
  allow: (path: string) => boolean,
  signal?: AbortSignal,
  limits: {maxBytes?: number; maxFiles?: number} = {},
): {files: number; bytes: number} {
  const rel = relative(workspace.root, destination);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new WriteBoundaryError('UNSAFE_SNAPSHOT');
  const secure = new SecureFiles(workspace);
  let files = 0,
    bytes = 0,
    entries = 0;
  const visit = (source: string, target: string, ancestors: Set<string>, depth: number) => {
    signal?.throwIfAborted();
    if (++entries > 60000 || depth > 40) throw new WriteBoundaryError('SNAPSHOT_LIMIT');
    if ((source !== '.' && !allow(source)) || (target !== '.' && !allow(target))) return;
    const resolved = workspace.resolve(source);
    if (!allow(resolved.relative)) return;
    if (resolved.kind === 'directory') {
      const entry = secure.executionDirectory(resolved.relative);
      if (ancestors.has(entry.identity)) throw new WriteBoundaryError('SNAPSHOT_CYCLE');
      mkdirSync(join(destination, target), {recursive: true, mode: 0o755});
      const next = new Set([...ancestors, entry.identity]);
      for (const name of entry.names)
        visit(
          resolved.relative === '.' ? name : resolved.relative + '/' + name,
          target === '.' ? name : target + '/' + name,
          next,
          depth + 1,
        );
    } else {
      if (++files > (limits.maxFiles ?? 30000)) throw new WriteBoundaryError('SNAPSHOT_LIMIT');
      const file = secure.executionBytes(
        resolved.relative,
        Math.min(32 * 1024 * 1024, (limits.maxBytes ?? 256 * 1024 * 1024) - bytes),
      );
      bytes += file.bytes.length;
      writeFileSync(join(destination, target), file.bytes, {mode: file.mode, flag: 'wx'});
    }
  };
  visit('.', '.', new Set(), 0);
  return {files, bytes};
}
