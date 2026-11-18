import type {AgentTypeView, SubagentSummaryView, Usage} from '@futryn/contracts';

export function tokenTotal(usage: Usage | null): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function typeRow(type: AgentTypeView): string {
  const tools = type.tools ? type.tools.join(',') || 'no tools' : 'all tools';
  const source = type.source === 'builtin' ? 'built-in' : type.source;
  return `${type.name} (${source}) [${tools}] ${type.description.length > 90 ? `${type.description.slice(0, 89)}…` : type.description}`;
}

export function childRow(child: SubagentSummaryView, selected: boolean, now = Date.now()): string {
  const end = child.finishedAt ? Date.parse(child.finishedAt) : now;
  const elapsed = formatDuration(end - Date.parse(child.createdAt));
  const tokens = tokenTotal(child.usage);
  const mode = child.background ? 'bg' : 'fg';
  return `${selected ? '>' : ' '} ${child.id.slice(0, 8)} [${child.agentType}] ${child.description} · ${child.status} · ${mode} · ${child.toolCount} tools · ${tokens} tokens · ${elapsed}`;
}

export function transcriptLines(child: SubagentSummaryView): string[] {
  const lines = [
    `[${child.agentType}] ${child.description}`,
    `id ${child.id} · ${child.status}${child.errorCode ? ` (${child.errorCode})` : ''}`,
    '',
  ];
  for (const step of child.steps) {
    if (step.kind === 'tool') {
      lines.push(`⏺ ${step.toolName}${step.target ? ` ${step.target}` : ''} [${step.status ?? 'ok'}]`);
      if (step.output) for (const line of step.output.split('\n').slice(0, 6)) lines.push(`  ⎿ ${line}`);
    } else if (step.text) {
      lines.push('', ...step.text.split('\n'));
    }
  }
  return lines;
}

/** All rows of the list screen; `selectableOffsets` maps a child index to its row for scrolling. */
export function listRows(
  types: readonly AgentTypeView[],
  warnings: readonly string[],
  children: readonly SubagentSummaryView[],
  index: number,
  now = Date.now(),
): {rows: string[]; childRowIndex: number[]} {
  const rows: string[] = ['Agent types'];
  for (const type of types) rows.push('  ' + typeRow(type));
  for (const warning of warnings) rows.push(`  ! ${warning}`);
  rows.push('', 'Subagents in this session');
  const childRowIndex: number[] = [];
  if (!children.length) rows.push('  none');
  children.forEach((child, n) => {
    childRowIndex.push(rows.length);
    rows.push(childRow(child, n === index, now));
  });
  return {rows, childRowIndex};
}
