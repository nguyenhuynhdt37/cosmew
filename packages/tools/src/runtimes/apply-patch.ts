import {join} from 'node:path';
import {SecureFiles, WriteBoundaryError, contentHash, writePath, type FileSnapshot} from '@futryn/workspace';
import {evaluateWrite} from '@futryn/security';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
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
export class ApplyPatchRuntime {
  constructor(private readonly options: ToolDispatcherOptions) {}
  available(): boolean {
    return SecureFiles.available();
  }
  verify(operations: PatchOperation[]): PatchPlan {
    const files = new SecureFiles(this.options.workspace),
      changes: PatchChange[] = [];
    this.checkPaths(operations.flatMap(op => (op.kind === 'update' && op.move ? [op.path, op.move] : [op.path])));
    const change = (path: string, after: string | null, expected: 'existing' | 'new') => {
      const snapshot = files.snapshot(path);
      if ((expected === 'new') !== (snapshot.content === null))
        throw new PatchError(
          'PATCH_MISMATCH',
          expected === 'new' ? 'A destination already exists.' : 'A patch source does not exist.',
        );
      const result: PatchChange = {
        snapshot,
        after,
        diff: unifiedDiff(path, snapshot.content, after),
        action: expected === 'new' ? 'add' : after === null ? 'delete' : 'update',
      };
      changes.push(result);
      return result;
    };
    for (const op of operations) {
      if (op.kind === 'add') change(op.path, op.content, 'new');
      else if (op.kind === 'delete') change(op.path, null, 'existing');
      else {
        const before = files.snapshot(op.path);
        if (before.content === null) throw new PatchError('PATCH_MISMATCH', 'A patch source does not exist.');
        const after = updateFile(before.content, op.chunks);
        if (op.move) {
          const destination = change(op.move, after, 'new');
          destination.mode = before.mode;
          destination.diff = `new file mode ${(0o100000 | before.mode).toString(8)}\n` + destination.diff;
          changes.push({
            snapshot: before,
            after: null,
            diff: unifiedDiff(op.path, before.content, null),
            action: 'delete',
          });
        } else
          changes.push({snapshot: before, after, diff: unifiedDiff(op.path, before.content, after), action: 'update'});
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
    this.checkPaths([path]);
    const files = new SecureFiles(this.options.workspace);
    const snapshot = files.snapshot(path);
    const after = next(snapshot.content);
    return this.plan(files, [
      {
        snapshot,
        after,
        diff: unifiedDiff(path, snapshot.content, after),
        action: snapshot.content === null ? 'add' : 'update',
      },
    ]);
  }

  /** Syntax, size, collision and protected-path checks shared by every write plan. */
  private checkPaths(paths: string[]): void {
    const touched = new Set<string>();
    const names = paths.map(writePath);
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
    for (const path of names) {
      if (touched.has(path.toLowerCase())) throw new PatchError('INVALID_PATCH', 'Patch paths overlap or collide.');
      touched.add(path.toLowerCase());
      if (
        evaluateWrite(path, join(this.options.workspace.root, path), {stateDirectory: this.options.stateDirectory})
          .effect === 'deny'
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
      if (
        evaluateWrite(path, join(this.options.workspace.root, path), {stateDirectory: this.options.stateDirectory})
          .effect === 'deny'
      )
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
      for (const change of plan.changes) {
        if (signal?.aborted) throw new PatchError('CANCELLED', 'Patch cancelled.');
        if (change.snapshot.content === change.after) {
          completed.add(change.snapshot.path);
          continue;
        }
        plan.files.apply(change.snapshot, change.after, change.mode);
        completed.add(change.snapshot.path);
        applied.push({
          path: change.snapshot.path,
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
      remaining: code ? plan.changes.filter(c => !completed.has(c.snapshot.path)).map(c => c.snapshot.path) : [],
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
