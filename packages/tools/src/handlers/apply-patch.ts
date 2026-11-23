import {z} from 'zod';
import {WriteBoundaryError} from '@cosmew/workspace';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import {PatchError, parsePatch} from '../patch/parser';
import {ApplyPatchRuntime, type PatchPlan} from '../runtimes/apply-patch';
import type {ReadLedger} from '../runtimes/read-ledger';
import type {ToolHandler, PreparedTool} from './types';
export const applyPatchDescriptor = {
  name: 'apply_patch',
  description:
    'Apply a Codex-format patch to UTF-8 files after approval. Provide the entire *** Begin Patch / *** End Patch text in patch. Supports Add File, Update File with @@ contextual hunks, Delete File and Update File with Move to. Protected paths are denied; stale files are not overwritten. Results report actual changes and any partial failure. No shell or native runtime writes.',
  capability: 'fs.write' as const,
  inputSchema: {
    type: 'object',
    properties: {
      patch: {type: 'string', description: 'The complete Codex patch text.'},
      expected_files: {
        type: 'object',
        description:
          'Optional exact preimage guard: canonical target path to lowercase SHA-256 of current UTF-8 bytes, or null for an absent file. Must cover every source and destination exactly. Conflicts refuse the entire patch before approval.',
        additionalProperties: {anyOf: [{type: 'string', pattern: '^[a-f0-9]{64}$'}, {type: 'null'}]},
      },
      expected_modes: {
        type: 'object',
        description:
          'Optional mode guard accompanying expected_files, with the same exact target key set. Values are permission bits (0..511), or null for an absent file.',
        additionalProperties: {anyOf: [{type: 'integer', minimum: 0, maximum: 511}, {type: 'null'}]},
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
};
const input = z.strictObject({
  patch: z.string().min(1),
  expected_files: z
    .record(
      z.string().min(1),
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    )
    .optional(),
  expected_modes: z.record(z.string().min(1), z.number().int().min(0).max(0o777).nullable()).optional(),
});
export class ApplyPatchHandler implements ToolHandler {
  readonly descriptor = applyPatchDescriptor;
  readonly unavailable: ToolOutput = {
    status: 'error',
    code: 'WRITE_UNAVAILABLE',
    content: 'Safe directory-relative writes are unavailable on this host.',
  };
  private readonly runtime: ApplyPatchRuntime;
  constructor(
    options: ToolDispatcherOptions,
    private readonly ledger?: ReadLedger,
  ) {
    this.runtime = new ApplyPatchRuntime(options);
  }
  /** Content the model just wrote counts as seen; anything else must be read again. */
  private remember(plan: PatchPlan, result: ToolOutput): ToolOutput {
    for (const change of plan.changes) {
      const path = change.snapshot.identity ?? change.snapshot.path;
      if (result.status === 'ok' && change.after !== null) this.ledger?.record(path, change.after);
      else this.ledger?.forget(path);
    }
    return result;
  }
  available(): boolean {
    return this.runtime.available();
  }
  prepare(args: unknown): PreparedTool | ToolOutput {
    const parsed = input.safeParse(args);
    if (!parsed.success)
      return {
        status: 'error',
        code: 'INVALID_INPUT',
        content: 'apply_patch requires a JSON object with one patch string.',
      };
    try {
      const plan = this.runtime.verify(parsePatch(parsed.data.patch));
      if (parsed.data.expected_modes && !parsed.data.expected_files)
        throw new PatchError('PATCH_CONFLICT', 'Mode guards require expected_files. No changes were made.');
      if (parsed.data.expected_files) {
        const expected = parsed.data.expected_files;
        const touched = new Set(plan.changes.map(change => change.snapshot.identity ?? change.snapshot.path));
        if (
          Object.keys(expected).length !== touched.size ||
          Object.keys(expected).some(path => !touched.has(path)) ||
          plan.changes.some(change => {
            const path = change.snapshot.identity ?? change.snapshot.path;
            return !Object.hasOwn(expected, path) || expected[path] !== change.snapshot.hash;
          })
        )
          throw new PatchError(
            'PATCH_CONFLICT',
            'Expected file hashes do not match every patch target. No changes were made. Review the current files before retrying.',
          );
      }
      if (parsed.data.expected_modes) {
        const expected = parsed.data.expected_modes;
        const touched = new Set(plan.changes.map(change => change.snapshot.identity ?? change.snapshot.path));
        if (
          Object.keys(expected).length !== touched.size ||
          Object.keys(expected).some(path => !touched.has(path)) ||
          plan.changes.some(change => {
            const path = change.snapshot.identity ?? change.snapshot.path;
            const mode = change.snapshot.content === null ? null : change.snapshot.mode & 0o777;
            return !Object.hasOwn(expected, path) || expected[path] !== mode;
          })
        )
          throw new PatchError(
            'PATCH_CONFLICT',
            'Expected file modes do not match every patch target. No changes were made.',
          );
      }
      return {
        kind: 'patch',
        plan,
        runtime: this.runtime,
        execute: signal => this.remember(plan, this.runtime.apply(plan, signal)),
      };
    } catch (error) {
      if (error instanceof WriteBoundaryError)
        return {
          status: 'denied',
          code: 'DENIED',
          content: 'Patch rejected by the workspace write boundary (' + error.code + '). No changes were made.',
        };
      if (error instanceof PatchError) return {status: 'error', code: error.code, content: error.message};
      return {
        status: 'error',
        code: 'PATCH_VERIFY_FAILED',
        content: 'The patch could not be verified. No changes were made.',
      };
    }
  }
}
