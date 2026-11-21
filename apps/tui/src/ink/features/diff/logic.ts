import type {ToolResult, WorkspaceDiffFile} from '@cosmew/sdk';
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
