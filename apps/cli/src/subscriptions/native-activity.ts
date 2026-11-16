import type {RuntimeActivity} from '@futryn/contracts';

/**
 * Display-only descriptions of a runtime's own tools (full-access mode, ADR 0027). They are never
 * Futryn tool calls; they only tell the user what the runtime did.
 */

/** First matching pattern names the tool, Claude Code style. */
const TOOL_PATTERNS: [RegExp, string][] = [
  [/terminal|shell|bash|execute|command/, 'Bash'],
  [/write|edit|replace|patch|delete|move|create/, 'Update'],
  [/read|view|cat/, 'Read'],
  [/grep|search|find|glob/, 'Search'],
  [/list|ls/, 'List'],
  [/web|fetch|url/, 'Web'],
];

/** Argument fields that best describe what the tool acted on, in order of preference. */
const LABEL_FIELDS = ['command', 'cmd', 'path', 'file_path', 'target_file', 'pattern', 'query', 'url'];

/** Claude-style label for a runtime's own tool (Grok/ACP titles and kinds, Copilot names). */
export function nativeTool(rawName: unknown, input: any, kind?: unknown): Pick<RuntimeActivity, 'name' | 'label'> {
  const name = String(rawName ?? kind ?? 'tool');
  const key = (name + ' ' + String(kind ?? '')).toLowerCase();
  const tool = TOOL_PATTERNS.find(([pattern]) => pattern.test(key))?.[1] ?? name.slice(0, 40);

  let label = '';
  if (input && typeof input === 'object') {
    const field = LABEL_FIELDS.find(f => input[f] !== undefined && input[f] !== null);
    label = field ? input[field] : '';
  }
  return {name: tool, label: String(label || (tool === name ? '' : name))};
}

const CODEX_STATUS: Record<string, RuntimeActivity['status']> = {
  completed: 'completed',
  failed: 'failed',
  declined: 'denied',
};

/** A Codex app-server item (command, file change, MCP call, web search) as an activity. */
export function codexActivity(item: any): Partial<RuntimeActivity> & {id: string} {
  const status = CODEX_STATUS[item.status] ?? 'running';
  const id = String(item.id ?? crypto.randomUUID());
  switch (item.type) {
    case 'commandExecution': {
      const output =
        typeof item.aggregatedOutput === 'string' && item.aggregatedOutput
          ? item.aggregatedOutput.slice(0, 4000)
          : undefined;
      return {id, name: 'Bash', label: String(item.command ?? ''), status, output};
    }
    case 'fileChange': {
      const paths = Array.isArray(item.changes)
        ? item.changes
            .map((c: any) => c?.path)
            .filter(Boolean)
            .join(', ')
        : '';
      return {id, name: 'Update', label: paths, status};
    }
    case 'mcpToolCall':
      return {id, name: String(item.tool ?? 'MCP'), label: String(item.server ?? ''), status};
    default:
      return {id, name: 'Web', label: String(item.query ?? ''), status};
  }
}
