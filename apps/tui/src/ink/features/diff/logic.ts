import type {ToolResult, WorkspaceDiffFile} from '@cosmew/sdk';
import type {DiffLine} from '../../ui/diff';
export interface ChangeReceipt {
  changes: {path: string; action: string; diff: string}[];
  diagnostics: string[];
  details: string[];
  partial: boolean;
}
/** Only execution receipts establish applied changes; input proposals never do. */
export function changeReceipt(result: ToolResult | undefined): ChangeReceipt {
  const partial = result?.status === 'error' && result.code === 'PARTIAL_APPLY';
  const empty: ChangeReceipt = {changes: [], diagnostics: [], details: [], partial};
  if (!result || (result.status !== 'ok' && !partial)) return empty;
  try {
    const receipt: unknown = JSON.parse(result.content);
    if (!receipt || typeof receipt !== 'object') return empty;
    const value = receipt as Record<string, unknown>;
    const strings = (key: string) =>
      Array.isArray(value[key])
        ? value[key].filter((item): item is string => typeof item === 'string').slice(0, 100)
        : [];
    return {
      partial,
      changes: (Array.isArray(value.changes) ? value.changes : [])
        .filter((change): change is Record<string, unknown> => !!change && typeof change === 'object')
        .filter(
          change => typeof change.path === 'string' && ['add', 'update', 'delete'].includes(String(change.action)),
        )
        .slice(0, 64)
        .map(change => ({
          path: String(change.path),
          action: String(change.action),
          diff: typeof change.diff === 'string' ? change.diff : '',
        })),
      diagnostics: strings('diagnostics'),
      details: [
        ...strings('createdDirectories').map(path => `Created directory ${path}`),
        ...(partial ? strings('remaining').map(path => `Not applied: ${path}`) : []),
        ...(typeof value.failureCode === 'string' ? [value.failureCode] : []),
      ],
    };
  } catch {
    return empty;
  }
}
export function workspaceUnifiedDiff(file: WorkspaceDiffFile): string {
  return file.lines
    .map(
      line =>
        (line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'context' ? ' ' : '') + line.content,
    )
    .join('\n');
}

/** Explicit language inference; unsupported extensions stay plain. */
export function diffLanguage(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        json: 'json',
        py: 'python',
        rs: 'rust',
        go: 'go',
        sh: 'bash',
        css: 'css',
        html: 'html',
        md: 'markdown',
        yaml: 'yaml',
        yml: 'yaml',
      } as Record<string, string>
    )[extension] ?? ''
  );
}

/** Preserve SDK numbering and real hunk headers. Session snapshots may have only numbered source rows. */
export function workspaceViewRows(file: WorkspaceDiffFile): DiffLine[] {
  const rows: DiffLine[] = [];
  let first = 0;
  let hasHeader = false;
  let oldStart: number | undefined;
  let newStart: number | undefined;
  let oldCount = 0;
  let newCount = 0;
  const flush = () => {
    if (first < rows.length && !hasHeader) {
      rows.splice(first, 0, {kind: 'hunk', text: `@@ -${oldStart ?? 0},${oldCount} +${newStart ?? 0},${newCount} @@`});
    }
    first = rows.length;
    hasHeader = false;
    oldStart = newStart = undefined;
    oldCount = newCount = 0;
  };
  for (const line of file.lines) {
    if (line.type === 'hunk') {
      flush();
      if (line.content.startsWith('@@ ')) {
        hasHeader = true;
        rows.push({kind: 'hunk', text: line.content});
      } else rows.push({kind: 'meta', text: line.content});
      first = rows.length;
      continue;
    }
    const oldLine = line.oldLine ?? undefined;
    const newLine = line.newLine ?? undefined;
    if (
      (oldLine !== undefined && oldStart !== undefined && oldLine !== oldStart + oldCount) ||
      (newLine !== undefined && newStart !== undefined && newLine !== newStart + newCount)
    )
      flush();
    if (oldLine !== undefined) {
      oldStart ??= oldLine;
      oldCount++;
    }
    if (newLine !== undefined) {
      newStart ??= newLine;
      newCount++;
    }
    const kind = line.type === 'add' ? 'added' : line.type === 'del' ? 'removed' : 'context';
    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    rows.push({kind, oldLine, newLine, text: sign + line.content});
  }
  flush();
  return rows;
}
