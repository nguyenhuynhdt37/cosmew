import {fileURLToPath} from 'node:url';
import {isAbsolute, relative} from 'node:path';
import {z} from 'zod';
import {FutrynError, type ToolDescriptor} from '@futryn/contracts';
import {lspFailureMessage, offsetAt, toCodePointColumn, toUtf16Character, type LspManager} from '@futryn/code-intel';
import {WorkspaceDenied, type ResolvedPath} from '@futryn/workspace';
import {readDecision, type ToolDispatcherOptions, type ToolOutput} from '../context';
import {PatchError} from '../patch/parser';
import {ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {PreparedTool, ToolHandler} from './types';

/**
 * Code intelligence tools (ADR 0043). `lsp` answers the nine read operations of OpenCode v1.19.5
 * `tool/lsp.ts` (read 2026-11-17); `lsp_rename` turns the server's WorkspaceEdit into one patch
 * plan that goes through the normal write approval. Positions are 1-based lines and 1-based
 * code-point columns. Locations are filtered by the read policy: code is quoted only for files the
 * read policy allows; other workspace files show path and line; Git and Futryn state are omitted;
 * files outside the workspace show their path and line only.
 */
export const LSP_OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const;
const MAX_RESULTS = 100;

const lspInput = z.strictObject({
  operation: z.enum(LSP_OPERATIONS),
  path: z.string().min(1).max(1024),
  line: z.number().int().min(1).optional(),
  character: z.number().int().min(1).optional(),
  query: z.string().max(200).optional(),
});

export const lspDescriptor: ToolDescriptor = {
  name: 'lsp',
  capability: 'code.intel',
  description:
    'Ask the project language server (TypeScript/JavaScript, Python, Go, Rust) about code. Operations: goToDefinition, findReferences, hover, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls (need path, line and character, 1-based as shown by read), documentSymbol (path) and workspaceSymbol (query; path picks the language). Prefer it over grep for definitions, references and types: it is exact and cheaper. Results list path:line:column with the code line.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {type: 'string', enum: [...LSP_OPERATIONS]},
      path: {type: 'string', description: 'File path relative to the workspace root.'},
      line: {type: 'integer', minimum: 1, description: '1-based line.'},
      character: {type: 'integer', minimum: 1, description: '1-based column (characters, as in read output).'},
      query: {type: 'string', description: 'Symbol name for workspaceSymbol.'},
    },
    required: ['operation', 'path'],
    additionalProperties: false,
  },
  parallel: true,
};

const renameInput = z.strictObject({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(1),
  character: z.number().int().min(1),
  newName: z.string().min(1).max(200),
});

export const lspRenameDescriptor: ToolDescriptor = {
  name: 'lsp_rename',
  capability: 'fs.write',
  description:
    'Rename a symbol everywhere with the project language server. Give the symbol position (1-based line and column) and newName. The edit across files is shown and approved like any other patch.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {type: 'string'},
      line: {type: 'integer', minimum: 1},
      character: {type: 'integer', minimum: 1},
      newName: {type: 'string'},
    },
    required: ['path', 'line', 'character', 'newName'],
    additionalProperties: false,
  },
};

type Range = {start: {line: number; character: number}; end: {line: number; character: number}};
type Location = {uri?: string; targetUri?: string; range?: Range; targetSelectionRange?: Range; targetRange?: Range};

const refuse = (code: string, content: string): ToolOutput => ({status: 'error', code, content});

function position(text: string, line: number, character: number) {
  const lines = text.split('\n');
  const zeroLine = Math.min(line - 1, Math.max(0, lines.length - 1));
  return {line: zeroLine, character: toUtf16Character(lines[zeroLine] ?? '', character)};
}

/** A location rendered under the read policy (see the module comment). */
function locationLine(
  options: ToolDispatcherOptions,
  uri: string | undefined,
  range: Range | undefined,
  label = '',
): string | null {
  if (!uri || !range) return null;
  let absolute: string;
  try {
    absolute = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = relative(options.workspace.root, absolute);
  const inside = rel && !rel.startsWith('..') && !isAbsolute(rel);
  const line = range.start.line + 1;
  if (!inside) return `${absolute}:${line}${label ? `  ${label}` : ''} (outside the workspace)`;
  let file: ResolvedPath;
  try {
    file = options.workspace.resolve(rel.split('\\').join('/'));
  } catch {
    return null;
  }
  const decision = readDecision(options, file.relative, file.absolute);
  if (decision.effect === 'deny') return null;
  let code = '';
  let column = range.start.character + 1;
  if (decision.effect === 'allow' && file.kind === 'file') {
    try {
      const text = new TextDecoder().decode(options.workspace.readBytes(file, 8 * 1024 * 1024).bytes);
      const source = text.split('\n')[range.start.line] ?? '';
      column = toCodePointColumn(source, range.start.character);
      code = source.trim().slice(0, 200);
    } catch {
      /* path and line only */
    }
  }
  return `${file.relative}:${line}:${column}${label ? `  ${label}` : ''}${code ? `  ${code}` : ''}`;
}

const SYMBOL_KINDS = [
  '',
  'File',
  'Module',
  'Namespace',
  'Package',
  'Class',
  'Method',
  'Property',
  'Field',
  'Constructor',
  'Enum',
  'Interface',
  'Function',
  'Variable',
  'Constant',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Key',
  'Null',
  'EnumMember',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];
const kindName = (kind: unknown) => SYMBOL_KINDS[Number(kind)] ?? 'Symbol';

function hoverText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const contents = (value as {contents?: unknown}).contents;
  const one = (item: unknown): string =>
    typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? String((item as {value?: unknown}).value ?? '')
        : '';
  return (Array.isArray(contents) ? contents.map(one).join('\n') : one(contents)).slice(0, 8192);
}

function locations(options: ToolDispatcherOptions, value: unknown): string[] {
  const list = (Array.isArray(value) ? value : value ? [value] : []) as Location[];
  return list
    .slice(0, MAX_RESULTS)
    .map(l => locationLine(options, l.uri ?? l.targetUri, l.range ?? l.targetSelectionRange ?? l.targetRange))
    .filter((l): l is string => l !== null);
}

function documentSymbols(value: unknown, depth = 0, out: string[] = []): string[] {
  for (const symbol of (Array.isArray(value) ? value : []) as {
    name?: string;
    kind?: number;
    range?: Range;
    location?: {range?: Range};
    children?: unknown[];
  }[]) {
    if (out.length >= 500) break;
    const range = symbol.range ?? symbol.location?.range;
    out.push(
      `${'  '.repeat(depth)}${kindName(symbol.kind)} ${symbol.name ?? '?'}${range ? ` :${range.start.line + 1}` : ''}`,
    );
    if (symbol.children) documentSymbols(symbol.children, depth + 1, out);
  }
  return out;
}

export function lspHandler(options: ToolDispatcherOptions): ToolHandler {
  const lsp = () => options.codeIntel!;
  return {
    descriptor: lspDescriptor,
    available: () => options.codeIntel?.available() === true,
    unavailable: {
      status: 'error',
      code: 'LSP_UNAVAILABLE',
      content: 'Language servers need the native command sandbox, which is not available on this host.',
    },
    prepare(args) {
      const parsed = lspInput.safeParse(args);
      if (!parsed.success)
        return refuse(
          'INVALID_INPUT',
          `Expected {operation: ${LSP_OPERATIONS.join('|')}, path, line?, character?, query?}.`,
        );
      const input = parsed.data;
      const positional = !['documentSymbol', 'workspaceSymbol'].includes(input.operation);
      if (positional && (input.line === undefined || input.character === undefined))
        return refuse('INVALID_INPUT', `${input.operation} needs line and character (1-based).`);
      if (input.operation === 'workspaceSymbol' && !input.query)
        return refuse('INVALID_INPUT', 'workspaceSymbol needs a query.');
      const file = options.workspace.resolve(input.path);
      if (file.kind !== 'file') return refuse('INVALID_INPUT', `${file.relative} is not a file.`);
      const status = lsp().status(file);
      if (!status.ok) return refuse('LSP_UNAVAILABLE', status.message);
      return {
        kind: 'read',
        file,
        execute: async signal => {
          try {
            return await runOperation(options, lsp(), file, input, signal);
          } catch (error) {
            if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED')) throw error;
            if (error instanceof FutrynError && error.code === 'TIMEOUT')
              return refuse('LSP_TIMEOUT', 'The language server did not answer within 10 seconds.');
            return refuse('LSP_FAILED', lspFailureMessage(error) ?? 'The language server request failed.');
          }
        },
      };
    },
  };
}

async function runOperation(
  options: ToolDispatcherOptions,
  lsp: LspManager,
  file: ResolvedPath,
  input: z.infer<typeof lspInput>,
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const at = (uri: string, text: string) => ({
    textDocument: {uri},
    position: position(text, input.line ?? 1, input.character ?? 1),
  });
  const done = (lines: string[], empty: string): ToolOutput => ({
    status: 'ok',
    target: file.relative,
    content: lines.length ? lines.join('\n') : empty,
  });
  switch (input.operation) {
    case 'goToDefinition':
    case 'goToImplementation':
    case 'findReferences': {
      const method =
        input.operation === 'goToDefinition'
          ? 'textDocument/definition'
          : input.operation === 'goToImplementation'
            ? 'textDocument/implementation'
            : 'textDocument/references';
      const {result} = await lsp.request<unknown>(
        file,
        method,
        (uri, text) => ({
          ...at(uri, text),
          ...(method === 'textDocument/references' ? {context: {includeDeclaration: true}} : {}),
        }),
        signal,
      );
      return done(locations(options, result), 'No results.');
    }
    case 'hover': {
      const {result} = await lsp.request<unknown>(file, 'textDocument/hover', at, signal);
      return done(hoverText(result) ? [hoverText(result)] : [], 'No hover information.');
    }
    case 'documentSymbol': {
      const {result} = await lsp.request<unknown>(
        file,
        'textDocument/documentSymbol',
        uri => ({textDocument: {uri}}),
        signal,
      );
      return done(documentSymbols(result), 'No symbols.');
    }
    case 'workspaceSymbol': {
      const result = await lsp.workspaceRequest<unknown>(file, 'workspace/symbol', {query: input.query}, signal);
      const lines = ((Array.isArray(result) ? result : []) as {name?: string; kind?: number; location?: Location}[])
        .slice(0, MAX_RESULTS)
        .map(symbol =>
          locationLine(
            options,
            symbol.location?.uri,
            symbol.location?.range,
            `${kindName(symbol.kind)} ${symbol.name ?? '?'}`,
          ),
        )
        .filter((l): l is string => l !== null);
      return done(lines, 'No symbols.');
    }
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls': {
      const {result} = await lsp.request<unknown>(file, 'textDocument/prepareCallHierarchy', at, signal);
      const items = (Array.isArray(result) ? result : []) as {
        name?: string;
        kind?: number;
        uri?: string;
        selectionRange?: Range;
        range?: Range;
      }[];
      if (input.operation === 'prepareCallHierarchy')
        return done(
          items
            .map(item =>
              locationLine(
                options,
                item.uri,
                item.selectionRange ?? item.range,
                `${kindName(item.kind)} ${item.name ?? '?'}`,
              ),
            )
            .filter((l): l is string => l !== null),
          'No call hierarchy item at this position.',
        );
      if (!items[0]) return done([], 'No call hierarchy item at this position.');
      const incoming = input.operation === 'incomingCalls';
      const calls = await lsp.workspaceRequest<unknown>(
        file,
        incoming ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls',
        {item: items[0]},
        signal,
      );
      const lines = ((Array.isArray(calls) ? calls : []) as {from?: (typeof items)[0]; to?: (typeof items)[0]}[])
        .slice(0, MAX_RESULTS)
        .map(call => {
          const item = incoming ? call.from : call.to;
          return item
            ? locationLine(
                options,
                item.uri,
                item.selectionRange ?? item.range,
                `${kindName(item.kind)} ${item.name ?? '?'}`,
              )
            : null;
        })
        .filter((l): l is string => l !== null);
      return done(lines, incoming ? 'No callers.' : 'No callees.');
    }
  }
}

type TextEdit = {range: Range; newText: string};

/** WorkspaceEdit → per-file text edits; file creation/rename/deletion is refused. */
function workspaceEdits(
  edit: unknown,
): Map<string, TextEdit[]> | {code: 'INVALID_PATCH' | 'UNSUPPORTED'; message: string} {
  const out = new Map<string, TextEdit[]>();
  if (edit === null || edit === undefined) return out;
  if (!edit || typeof edit !== 'object' || Array.isArray(edit))
    return {code: 'INVALID_PATCH', message: 'The language server returned an invalid WorkspaceEdit.'};
  const value = edit as {changes?: unknown; documentChanges?: unknown};
  const range = z.object({
    start: z.object({line: z.number().int().nonnegative(), character: z.number().int().nonnegative()}),
    end: z.object({line: z.number().int().nonnegative(), character: z.number().int().nonnegative()}),
  });
  const editsSchema = z.array(z.object({range, newText: z.string()})).max(10000);
  if (value.changes !== undefined) {
    if (!value.changes || typeof value.changes !== 'object' || Array.isArray(value.changes))
      return {code: 'INVALID_PATCH', message: 'The language server returned invalid changes.'};
    for (const [uri, edits] of Object.entries(value.changes)) {
      const checked = editsSchema.safeParse(edits);
      if (!checked.success) return {code: 'INVALID_PATCH', message: 'The language server returned invalid text edits.'};
      out.set(uri, [...(out.get(uri) ?? []), ...checked.data]);
    }
  }
  if (value.documentChanges !== undefined) {
    if (!Array.isArray(value.documentChanges))
      return {code: 'INVALID_PATCH', message: 'The language server returned invalid document changes.'};
    for (const change of value.documentChanges) {
      if (!change || typeof change !== 'object')
        return {code: 'INVALID_PATCH', message: 'The language server returned an invalid document change.'};
      if ('kind' in change)
        return {
          code: 'UNSUPPORTED',
          message: 'The rename would create, move or delete files; Futryn only applies text edits.',
        };
      const checked = z
        .object({
          textDocument: z.object({uri: z.string(), version: z.number().int().nullable().optional()}),
          edits: editsSchema,
        })
        .safeParse(change);
      if (!checked.success)
        return {code: 'INVALID_PATCH', message: 'The language server returned an invalid document edit.'};
      const uri = checked.data.textDocument.uri;
      out.set(uri, [...(out.get(uri) ?? []), ...checked.data.edits]);
    }
  }
  return out;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const valid = (p: {line: number; character: number}) =>
    p &&
    Number.isInteger(p.line) &&
    Number.isInteger(p.character) &&
    p.line >= 0 &&
    p.line < lines.length &&
    p.character >= 0 &&
    p.character <= lines[p.line]!.length &&
    !(
      p.character > 0 &&
      p.character < lines[p.line]!.length &&
      /[\uD800-\uDBFF]/.test(lines[p.line]![p.character - 1]!) &&
      /[\uDC00-\uDFFF]/.test(lines[p.line]![p.character]!)
    );
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.newText !== 'string' ||
      !edit.range ||
      !valid(edit.range.start) ||
      !valid(edit.range.end) ||
      offsetAt(text, edit.range.end) < offsetAt(text, edit.range.start)
    )
      throw new PatchError('INVALID_PATCH', 'The language server returned an invalid edit range.');
  }
  const sorted = edits
    .map(edit => ({start: offsetAt(text, edit.range.start), end: offsetAt(text, edit.range.end), text: edit.newText}))
    .sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]!.end > sorted[i - 1]!.start)
      throw new PatchError('INVALID_PATCH', 'The language server returned overlapping edits.');
  let out = text;
  for (const edit of sorted) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

export function lspRenameHandler(options: ToolDispatcherOptions): ToolHandler {
  const runtime = new ApplyPatchRuntime(options);
  return {
    descriptor: lspRenameDescriptor,
    available: () => options.codeIntel?.available() === true && runtime.available(),
    unavailable: {
      status: 'error',
      code: 'LSP_UNAVAILABLE',
      content: 'Language servers need the native command sandbox, which is not available on this host.',
    },
    prepare(args) {
      const parsed = renameInput.safeParse(args);
      if (!parsed.success) return refuse('INVALID_INPUT', 'Expected {path, line, character, newName}.');
      const input = parsed.data;
      const file = options.workspace.resolve(input.path);
      if (file.kind !== 'file') return refuse('INVALID_INPUT', `${file.relative} is not a file.`);
      const status = options.codeIntel!.status(file);
      if (!status.ok) return refuse('LSP_UNAVAILABLE', status.message);
      return {
        kind: 'deferred',
        file,
        // Never called: the orchestrator executes what `resolve` returns.
        execute: () => refuse('INVALID_STATE', 'Rename was not resolved.'),
        resolve: async (signal): Promise<PreparedTool | ToolOutput> => {
          let result: unknown;
          let sourceText: string;
          try {
            ({result, text: sourceText} = await options.codeIntel!.request<unknown>(
              file,
              'textDocument/rename',
              (uri, text) => ({
                textDocument: {uri},
                position: position(text, input.line, input.character),
                newName: input.newName,
              }),
              signal,
            ));
          } catch (error) {
            if (signal?.aborted) throw error;
            return refuse(
              'LSP_FAILED',
              lspFailureMessage(error) ?? 'The language server could not rename this symbol.',
            );
          }
          const edits = workspaceEdits(result);
          if (!(edits instanceof Map)) return refuse(edits.code, edits.message);
          if (!edits.size) return refuse('NO_CHANGE', 'The language server found nothing to rename here.');
          const byPath = new Map<string, TextEdit[]>();
          for (const [uri, list] of edits) {
            let absolute: string;
            try {
              absolute = fileURLToPath(uri);
            } catch {
              return refuse('INVALID_PATCH', 'The language server returned an invalid file URI.');
            }
            const rel = relative(options.workspace.root, absolute);
            if (!rel || rel.startsWith('..') || isAbsolute(rel))
              return {
                status: 'denied',
                code: 'DENIED',
                content: 'The rename would change files outside the workspace. Nothing was changed.',
              };
            const path = rel.split('\\').join('/');
            byPath.set(path, [...(byPath.get(path) ?? []), ...list]);
          }
          try {
            if (new TextDecoder().decode(options.workspace.readBytes(file, 8 * 1024 * 1024).bytes) !== sourceText)
              throw new PatchError('STALE_PATCH', 'The source file changed while preparing rename. Retry.');
            const plan = runtime.verifyFiles([...byPath.keys()], (path, before) => {
              if (path === file.relative && before !== sourceText)
                throw new PatchError(
                  'STALE_PATCH',
                  'The source file changed while the language server was preparing the rename. Retry.',
                );
              return applyEdits(before, byPath.get(path)!);
            });
            return {kind: 'patch', plan, runtime, execute: s => runtime.apply(plan, s)};
          } catch (error) {
            if (error instanceof PatchError) return refuse(error.code, error.message);
            if (error instanceof WorkspaceDenied) throw error;
            return {
              status: 'denied',
              code: 'DENIED',
              content: 'The rename touches protected files. Nothing was changed.',
            };
          }
        },
      };
    },
  };
}
