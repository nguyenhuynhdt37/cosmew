import {join} from 'node:path';
import type {CheckpointFile} from '@cosmew/contracts';
import {
  locateWriteTarget,
  SecureFiles,
  WorkspaceDenied,
  WriteBoundaryError,
  contentHash,
  writePath,
  type FileSnapshot,
  type WriteTarget,
} from '@cosmew/workspace';
import {evaluateWrite} from '@cosmew/security';
import {sandboxConfig, type ToolDispatcherOptions, type ToolOutput} from '../context';
import {PatchError, unifiedDiff, updateFile, type PatchOperation} from '../patch/parser';
export interface PatchChange {
  snapshot: FileSnapshot;
  after: string | null;
  diff: string;
  action: 'add' | 'update' | 'delete';
  mode?: number;
}
export interface PatchPlan {
  files: SecureFiles;
  changes: PatchChange[];
  diff: string;
  scopeKey: string;
}
const changeId = (snapshot: FileSnapshot): string => snapshot.identity ?? snapshot.path;

export class ApplyPatchRuntime {
  constructor(private readonly options: ToolDispatcherOptions) {}
  available(): boolean {
    return SecureFiles.available();
  }
  verify(operations: PatchOperation[]): PatchPlan {
    const files = new SecureFiles(this.options.workspace),
      changes: PatchChange[] = [];
    // Validate every operation target before de-duplicating the lookup map.  A
    // duplicate path in a single patch must be rejected before an approval is
    // requested; otherwise two operations could snapshot the same file and
    // produce a plan whose writes silently overlap.
    const paths = operations.flatMap(op => (op.kind === 'update' && op.move ? [op.path, op.move] : [op.path]));
    const locatedTargets = paths.map(path => this.locate(path));
    this.checkLocated(locatedTargets);
    const located = new Map<string, WriteTarget>();
    paths.forEach((path, index) => {
      if (!located.has(path)) located.set(path, locatedTargets[index]!);
    });
    const take = (path: string) => {
      const target = located.get(path)!;
      const snapshot = files.snapshot(target.relative, target.base);
      if (target.key !== snapshot.path) snapshot.identity = target.key;
      return {target, snapshot};
    };
    const change = (path: string, after: string | null, expected: 'existing' | 'new') => {
      const {target, snapshot} = take(path);
      if ((expected === 'new') !== (snapshot.content === null))
        throw new PatchError(
          'PATCH_MISMATCH',
          expected === 'new' ? 'A destination already exists.' : 'A patch source does not exist.',
        );
      const result: PatchChange = {
        snapshot,
        after,
        diff: unifiedDiff(target.key, snapshot.content, after),
        action: expected === 'new' ? 'add' : after === null ? 'delete' : 'update',
      };
      changes.push(result);
      return result;
    };
    for (const op of operations) {
      if (op.kind === 'add') change(op.path, op.content, 'new');
      else if (op.kind === 'delete') change(op.path, null, 'existing');
      else {
        const {target, snapshot: before} = take(op.path);
        if (before.content === null) throw new PatchError('PATCH_MISMATCH', 'A patch source does not exist.');
        const after = updateFile(before.content, op.chunks);
        if (op.move) {
          const destination = change(op.move, after, 'new');
          destination.mode = before.mode;
          destination.diff = `new file mode ${(0o100000 | before.mode).toString(8)}\n` + destination.diff;
          changes.push({
            snapshot: before,
            after: null,
            diff: unifiedDiff(target.key, before.content, null),
            action: 'delete',
          });
        } else
          changes.push({
            snapshot: before,
            after,
            diff: unifiedDiff(target.key, before.content, after),
            action: 'update',
          });
      }
    }
    return this.plan(files, changes);
  }

  /**
   * Plan replacing one file's whole content (the edit and write tools, ADR 0038). `next` receives
   * the current content (null when the file does not exist) and returns the new content or throws
   * a PatchError. Same path policy, snapshot, approval diff and revalidation as apply_patch.
   */
  verifyFile(path: string, next: (before: string | null) => string): PatchPlan {
    const target = this.locate(path);
    this.checkLocated([target]);
    const files = new SecureFiles(this.options.workspace);
    const snapshot = files.snapshot(target.relative, target.base);
    if (target.key !== snapshot.path) snapshot.identity = target.key;
    const after = next(snapshot.content);
    return this.plan(files, [
      {
        snapshot,
        after,
        diff: unifiedDiff(target.key, snapshot.content, after),
        action: snapshot.content === null ? 'add' : 'update',
      },
    ]);
  }

  /**
   * Plan replacing several files' whole content at once (LSP rename, ADR 0043): one approval with
   * the complete diff, the same path policy, snapshots and revalidation as apply_patch.
   */
  verifyFiles(paths: string[], next: (path: string, before: string) => string): PatchPlan {
    const located = paths.map(path => this.locate(path));
    this.checkLocated(located);
    const files = new SecureFiles(this.options.workspace);
    return this.plan(
      files,
      located.map(target => {
        const snapshot = files.snapshot(target.relative, target.base);
        if (target.key !== snapshot.path) snapshot.identity = target.key;
        if (snapshot.content === null) throw new PatchError('PATCH_MISMATCH', `${target.key} does not exist.`);
        const after = next(target.key, snapshot.content);
        return {snapshot, after, diff: unifiedDiff(target.key, snapshot.content, after), action: 'update' as const};
      }),
    );
  }

  /** Trusted preimages use the same protected path checks, snapshot and approval as every edit. */
  verifyRestore(entries: CheckpointFile[]): PatchPlan {
    const targets = entries.map(entry => this.locate(entry.path));
    this.checkLocated(targets);
    const files = new SecureFiles(this.options.workspace);
    const changes: PatchChange[] = targets.map((target, i) => {
      const entry = entries[i]!;
      const snapshot = files.snapshot(target.relative, target.base);
      if (target.key !== snapshot.path) snapshot.identity = target.key;
      if (snapshot.hash !== entry.afterHash || (snapshot.content !== null && snapshot.mode !== entry.afterMode))
        throw new PatchError('CHECKPOINT_CONFLICT', 'A file changed after the checkpoint.');
      return {
        snapshot,
        after: entry.before,
        mode: entry.beforeMode,
        diff: unifiedDiff(target.key, snapshot.content, entry.before),
        action: snapshot.content === null ? 'add' : entry.before === null ? 'delete' : 'update',
      };
    });
    return this.plan(files, changes);
  }

  /** A model path in the project or a granted directory. Anything else is a write-boundary denial. */
  private locate(path: string): WriteTarget {
    try {
      return locateWriteTarget(this.options.workspace, path, sandboxConfig(this.options).additionalDirectories);
    } catch (error) {
      if (error instanceof WorkspaceDenied)
        throw new WriteBoundaryError(error.reason === 'outside-workspace' ? 'OUTSIDE_WORKSPACE' : 'UNSAFE_PATH');
      throw error;
    }
  }

  /** Syntax, size, collision and protected-path checks shared by every write plan. */
  private checkLocated(targets: WriteTarget[]): void {
    const touched = new Set<string>();
    const names = targets.map(target => writePath(target.relative));
    if (Buffer.byteLength(JSON.stringify(names)) > 8192)
      throw new PatchError('PATCH_TOO_LARGE', 'Patch paths exceed the aggregate size limit.');
    const directories = new Set(
      names.flatMap(path =>
        path
          .split('/')
          .slice(0, -1)
          .map((_, i) =>
            path
              .split('/')
              .slice(0, i + 1)
              .join('/'),
          ),
      ),
    );
    if (Buffer.byteLength(JSON.stringify([...directories])) > 8192)
      throw new PatchError('PATCH_TOO_LARGE', 'Patch directory paths exceed the aggregate size limit.');
    for (const target of targets) {
      const collision = target.base + '\0' + target.relative.toLowerCase();
      if (touched.has(collision)) throw new PatchError('INVALID_PATCH', 'Patch paths overlap or collide.');
      touched.add(collision);
      if (
        evaluateWrite(target.relative, target.absolute, {stateDirectory: this.options.stateDirectory}).effect === 'deny'
      )
        throw new WriteBoundaryError('PROTECTED_PATH');
    }
  }

  private plan(files: SecureFiles, changes: PatchChange[]): PatchPlan {
    // No patch or diff size ceiling (Codex apply_patch); the approval shows the complete diff.
    const diff = changes.map(c => c.diff).join('');
    const scopeKey =
      'patch:' +
      contentHash(
        JSON.stringify([
          this.options.workspace.root,
          changes.map(c => [c.snapshot, contentHash(c.after ?? ''), c.after === null, c.mode]),
          'write-policy-v1',
        ]),
      );
    return {files, changes, diff, scopeKey};
  }
  revalidate(plan: PatchPlan): void {
    for (const change of plan.changes) {
      const path = change.snapshot.path;
      const base = change.snapshot.base ?? this.options.workspace.root;
      if (evaluateWrite(path, join(base, path), {stateDirectory: this.options.stateDirectory}).effect === 'deny')
        throw new WriteBoundaryError('PROTECTED_PATH');
      plan.files.revalidate(change.snapshot);
    }
  }
  apply(plan: PatchPlan, signal?: AbortSignal): ToolOutput {
    const applied: Record<string, unknown>[] = [];
    const completed = new Set<string>();
    let code: string | undefined;
    try {
      this.revalidate(plan);
      this.options.checkpoints?.capture(
        plan.changes
          .filter(c => c.snapshot.content !== c.after)
          .map(c => ({
            path: c.snapshot.identity ?? c.snapshot.path,
            before: c.snapshot.content,
            beforeMode: c.snapshot.mode,
            afterHash: c.after === null ? null : contentHash(c.after),
            afterMode: c.after === null ? null : (c.mode ?? c.snapshot.mode),
            additions: c.diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length,
            deletions: c.diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length,
          })),
      );
      for (const change of plan.changes) {
        const id = changeId(change.snapshot);
        if (signal?.aborted) throw new PatchError('CANCELLED', 'Patch cancelled.');
        if (
          change.snapshot.content === change.after &&
          (change.mode === undefined || change.mode === change.snapshot.mode)
        ) {
          completed.add(id);
          continue;
        }
        plan.files.apply(change.snapshot, change.after, change.mode);
        completed.add(id);
        applied.push({
          path: id,
          action: change.action,
          beforeMode: change.snapshot.content === null ? null : change.snapshot.mode,
          afterMode: change.after === null ? null : (change.mode ?? change.snapshot.mode),
          beforeHash: change.snapshot.hash,
          afterHash: change.after === null ? null : contentHash(change.after),
          diff: change.diff,
        });
      }
    } catch (error) {
      code = error instanceof WriteBoundaryError || error instanceof PatchError ? error.code : 'WRITE_FAILED';
    }
    const partial = Boolean(code && (applied.length || plan.files.createdDirectories.length));
    const receipt = {
      status: code ? (partial ? 'partial' : 'not-applied') : 'applied',
      ...(code ? {failureCode: code} : {}),
      changes: applied,
      createdDirectories: plan.files.createdDirectories,
      remaining: code
        ? plan.changes.filter(c => !completed.has(changeId(c.snapshot))).map(c => changeId(c.snapshot))
        : [],
      diffsOmitted: false,
    };
    if (Buffer.byteLength(JSON.stringify(receipt)) > 50000) {
      for (const change of applied) delete change.diff;
      receipt.diffsOmitted = true;
    }
    return {
      status: code ? 'error' : 'ok',
      ...(code ? {code: partial ? 'PARTIAL_APPLY' : code} : {}),
      content: JSON.stringify(receipt),
    };
  }
}
