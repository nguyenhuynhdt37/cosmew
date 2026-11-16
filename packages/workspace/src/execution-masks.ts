import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {FutrynError} from '@futryn/contracts';
import type {WorkspaceRoot} from './paths';

/** What a sandboxed command must not see or change inside the live workspace mount (ADR 0034). */
export interface ExecutionMasks {
  /** Files replaced by an empty read-only file (secrets). Workspace-relative, `/` separators. */
  hiddenFiles: string[];
  /** Directories replaced by an empty read-only directory (Futryn state, patch temporaries). */
  hiddenDirectories: string[];
  /** Entries mounted read-only over their real content (Git metadata). */
  readOnly: string[];
  entries: number;
}

export type MaskDecision = 'hide' | 'read-only' | 'keep';

/**
 * Walks the workspace without following symlinks (Dirent types come from the directory, not the
 * target) and classifies every entry. Hidden and read-only directories are not descended. The walk
 * is bounded; a tree that exceeds it, or a path that cannot be expressed as a mount target, fails
 * closed instead of launching with an unmasked secret.
 */
export function scanExecutionMasks(workspace: WorkspaceRoot, classify: (relative: string, directory: boolean) => MaskDecision, limits: {maxEntries: number; maxMasks: number} = {maxEntries: 250_000, maxMasks: 512}, signal?: AbortSignal): ExecutionMasks {
  const masks: ExecutionMasks = {hiddenFiles: [], hiddenDirectories: [], readOnly: [], entries: 0};
  const unsafe = /[,"\n\r\u0000]/;
  const visit = (relative: string) => {
    signal?.throwIfAborted();
    let entries;
    try { entries = readdirSync(relative ? join(workspace.root, relative) : workspace.root, {withFileTypes: true}); }
    catch { throw new FutrynError('POLICY'); }
    for (const entry of entries) {
      if (++masks.entries > limits.maxEntries) throw new FutrynError('BUDGET');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      // Symlinks are never mask targets: the runtime would resolve the target inside the container.
      if (entry.isSymbolicLink()) continue;
      const directory = entry.isDirectory();
      const decision = classify(path, directory);
      if (decision !== 'keep') {
        if (unsafe.test(path)) throw new FutrynError('POLICY');
        if (decision === 'read-only') masks.readOnly.push(path);
        else if (directory) masks.hiddenDirectories.push(path);
        else if (entry.isFile()) masks.hiddenFiles.push(path);
        else throw new FutrynError('POLICY');
        if (masks.hiddenFiles.length + masks.hiddenDirectories.length + masks.readOnly.length > limits.maxMasks) throw new FutrynError('BUDGET');
        continue;
      }
      if (directory) visit(path);
    }
  };
  visit('');
  return masks;
}
