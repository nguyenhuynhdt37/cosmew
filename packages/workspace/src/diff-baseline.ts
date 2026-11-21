import {lstatSync} from 'node:fs';
import {join} from 'node:path';
import {SecureFiles} from './secure-files';
import {WorkspaceRoot} from './paths';
import {VENDORED_DIRECTORIES} from './files';
export interface WorkspaceDiffSnapshot {
  files: {path: string; before: string | null}[];
  reason?: string;
}
/** Inventory only: descriptor-relative directories, bounded, no Git configuration or symlink traversal. */
export function workspaceDiffPaths(
  root: string,
  canRead: (path: string) => boolean,
): {paths: string[]; reason?: string} {
  const files = new SecureFiles(new WorkspaceRoot(root));
  const paths: string[] = [];
  const deadline = Date.now() + 2000;
  let entries = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 64 || Date.now() > deadline) throw new Error('limit');
    for (const name of files.executionDirectory(directory || '.').names) {
      if (++entries > 20000 || Date.now() > deadline) throw new Error('limit');
      if (['.git', '.cosmew', '.futryn', '.hannes', ...VENDORED_DIRECTORIES].includes(name)) continue;
      const path = directory ? `${directory}/${name}` : name;
      if (!canRead(path)) continue;
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile()) paths.push(path);
    }
  };
  try {
    walk('', 0);
    return {paths};
  } catch {
    return {paths: [], reason: 'Workspace baseline inventory is unavailable or exceeded its bound.'};
  }
}
/** Before any session execution, seal the approved workspace, including files Bash can later change. */
export function captureWorkspaceDiffSnapshot(
  root: string,
  canRead: (path: string) => boolean,
  redact: (text: string) => string,
): WorkspaceDiffSnapshot {
  const inventory = workspaceDiffPaths(root, canRead);
  if (inventory.reason) return {files: [], reason: inventory.reason};
  const secure = new SecureFiles(new WorkspaceRoot(root));
  const files: WorkspaceDiffSnapshot['files'] = [];
  let bytes = 0;
  try {
    for (const path of inventory.paths) {
      if (!canRead(path)) continue;
      const before = secure.executionBytes(path, 1024 * 1024).bytes.toString('utf8');
      bytes += Buffer.byteLength(before) + Buffer.byteLength(path);
      if (bytes > 8 * 1024 * 1024 || redact(before) !== before || redact(path) !== path)
        return {files: [], reason: 'Workspace baseline exceeded its bound or contains redacted data.'};
      if (canRead(path)) files.push({path, before});
    }
    return {files};
  } catch {
    return {files: [], reason: 'Workspace baseline could not be sealed safely.'};
  }
}
