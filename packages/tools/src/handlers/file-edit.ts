import {z} from 'zod';
import {locateWriteTarget, WorkspaceDenied, WriteBoundaryError, contentHash, type WriteTarget} from '@cosmew/workspace';
import {sandboxConfig, type ToolDispatcherOptions, type ToolOutput} from '../context';
import {PatchError} from '../patch/parser';
import {ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {ReadLedger} from '../runtimes/read-ledger';
import type {PreparedTool, ToolHandler} from './types';

/**
 * Claude Code–style `edit` and `write` (ADR 0038). Both compile to a one-file patch plan, so they
 * share apply_patch's path policy, approval with the full diff, revalidation and receipt. Existing
 * files may change only when the model read their current content first (ReadLedger).
 */

const MAX_CONTENT_BYTES = 1024 * 1024;
const path = z.string().min(1).max(1024);

export const editDescriptor = {
  name: 'edit',
  description:
    'Replace exact text in an existing UTF-8 workspace file after user approval. Read the file first; the edit is refused if the file changed since you read it. old_string must match the file exactly (including indentation and line breaks) and be unique, unless replace_all is true. Copy old_string from the read output without the line-number prefix. Prefer edit for focused changes; use write to create a file or replace all of its content.',
  capability: 'fs.write' as const,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File path relative to the workspace, or an absolute path inside permissions.additionalDirectories.',
      },
      old_string: {type: 'string', description: 'Exact text to replace.'},
      new_string: {type: 'string', description: 'Replacement text (must differ from old_string).'},
      replace_all: {type: 'boolean', description: 'Replace every occurrence instead of exactly one (default false).'},
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
};

export const writeDescriptor = {
  name: 'write',
  description:
    'Create a UTF-8 workspace file, or replace the whole content of one, after user approval. Missing parent directories are created. To overwrite an existing file you must have read its current content first. Prefer edit for changes to part of a file.',
  capability: 'fs.write' as const,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File path relative to the workspace, or an absolute path inside permissions.additionalDirectories.',
      },
      content: {type: 'string', description: 'The complete new file content.'},
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

const editInput = z.strictObject({
  path,
  old_string: z.string().min(1).max(MAX_CONTENT_BYTES),
  new_string: z.string().max(MAX_CONTENT_BYTES),
  replace_all: z.boolean().optional(),
});
const writeInput = z.strictObject({path, content: z.string().max(MAX_CONTENT_BYTES)});

/** Count non-overlapping occurrences. */
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Apply one edit to `before`; plain string slicing, so `$` sequences in the replacement stay literal. */
export function replaceText(
  before: string,
  input: {old_string: string; new_string: string; replace_all?: boolean},
): string {
  let {old_string: from, new_string: to} = input;
  if (from === to) throw new PatchError('EDIT_NO_CHANGE', 'old_string and new_string are identical; nothing to edit.');
  // Read output shows LF; match a CRLF file by translating both sides, so the file keeps its line endings.
  if (!before.includes(from) && before.includes('\r\n') && from.includes('\n') && !from.includes('\r')) {
    from = from.replace(/\n/g, '\r\n');
    to = to.replace(/\r?\n/g, '\r\n');
  }
  const count = occurrences(before, from);
  if (count === 0)
    throw new PatchError(
      'EDIT_NO_MATCH',
      'old_string was not found in the file. Read the file again and copy the exact text, including whitespace.',
    );
  if (count > 1 && !input.replace_all)
    throw new PatchError(
      'EDIT_AMBIGUOUS',
      `old_string matches ${count} places. Include more surrounding lines to make it unique, or set replace_all.`,
    );
  if (input.replace_all) return before.split(from).join(to);
  const at = before.indexOf(from);
  return before.slice(0, at) + to + before.slice(at + from.length);
}

/** Refuse a change to an existing file whose current content the model has not seen. */
function requireCurrentRead(ledger: ReadLedger, path: string, before: string): void {
  const state = ledger.check(path, contentHash(before));
  if (state === 'unread')
    throw new PatchError('READ_REQUIRED', `Read ${path} before changing it; existing files are not edited blind.`);
  if (state === 'stale')
    throw new PatchError(
      'FILE_CHANGED_SINCE_READ',
      `${path} changed since you last read it (by the user, a command or a tool). Read it again before changing it.`,
    );
}

function failure(name: string, error: unknown): ToolOutput {
  if (error instanceof WriteBoundaryError)
    return {
      status: 'denied',
      code: 'DENIED',
      content: `${name} rejected by the workspace write boundary (${error.code}). No changes were made.`,
    };
  if (error instanceof PatchError) return {status: 'error', code: error.code, content: error.message};
  return {
    status: 'error',
    code: 'PATCH_VERIFY_FAILED',
    content: `The ${name} could not be verified. No changes were made.`,
  };
}

abstract class FileChangeHandler implements ToolHandler {
  abstract readonly descriptor: typeof editDescriptor | typeof writeDescriptor;
  readonly unavailable: ToolOutput = {
    status: 'error',
    code: 'WRITE_UNAVAILABLE',
    content: 'Safe directory-relative writes are unavailable on this host.',
  };
  protected readonly runtime: ApplyPatchRuntime;
  constructor(
    private readonly options: ToolDispatcherOptions,
    protected readonly ledger: ReadLedger,
  ) {
    this.runtime = new ApplyPatchRuntime(options);
  }
  /** Ledger key for this path. A granted-directory file is keyed by its canonical absolute path. */
  protected targetOf(input: string): WriteTarget | ToolOutput {
    try {
      return locateWriteTarget(this.options.workspace, input, sandboxConfig(this.options).additionalDirectories);
    } catch (error) {
      if (error instanceof WorkspaceDenied)
        return {
          status: 'denied',
          code: 'DENIED',
          content: 'Access denied: the path is outside the approved workspace.',
        };
      throw error;
    }
  }
  available(): boolean {
    return this.runtime.available();
  }
  abstract prepare(args: unknown): PreparedTool | ToolOutput;

  /** Plan the change; after a successful apply the written content counts as seen. */
  protected planned(target: string, next: (before: string | null) => string): PreparedTool | ToolOutput {
    try {
      const plan = this.runtime.verifyFile(target, next);
      const after = plan.changes[0]!.after!;
      return {
        kind: 'patch',
        plan,
        runtime: this.runtime,
        execute: signal => {
          const result = this.runtime.apply(plan, signal);
          if (result.status === 'ok') this.ledger.record(target, after);
          else this.ledger.forget(target);
          return result;
        },
      };
    } catch (error) {
      return failure(this.descriptor.name, error);
    }
  }
}

export class EditHandler extends FileChangeHandler {
  readonly descriptor = editDescriptor;
  prepare(args: unknown): PreparedTool | ToolOutput {
    const parsed = editInput.safeParse(args);
    if (!parsed.success)
      return {
        status: 'error',
        code: 'INVALID_INPUT',
        content: 'edit requires path, a non-empty old_string and new_string (optional replace_all).',
      };
    const input = parsed.data;
    const located = this.targetOf(input.path);
    if (!('key' in located)) return located;
    return this.planned(located.key, before => {
      if (before === null)
        throw new PatchError('NOT_FOUND', `${located.key} does not exist. Use write to create a new file.`);
      requireCurrentRead(this.ledger, located.key, before);
      return replaceText(before, input);
    });
  }
}

export class WriteHandler extends FileChangeHandler {
  readonly descriptor = writeDescriptor;
  prepare(args: unknown): PreparedTool | ToolOutput {
    const parsed = writeInput.safeParse(args);
    if (!parsed.success)
      return {status: 'error', code: 'INVALID_INPUT', content: 'write requires path and content strings.'};
    const input = parsed.data;
    const located = this.targetOf(input.path);
    if (!('key' in located)) return located;
    return this.planned(located.key, before => {
      if (before !== null) requireCurrentRead(this.ledger, located.key, before);
      return input.content;
    });
  }
}
