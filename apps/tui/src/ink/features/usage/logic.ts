import {CONTEXT_COMPACTION_FRACTION, PERMISSION_MODE_LABELS} from '@cosmew/contracts';
import type {AccountLimits, FutrynClient, LimitItem} from '@cosmew/sdk';
import type {ReportKind} from './types';

export const count = (value: number | null | undefined) =>
  value == null ? 'Unknown / not reported' : value.toLocaleString('en-US');
export const money = (value: number | null | undefined) =>
  value == null ? 'Unknown / not reported' : `$${value.toFixed(6)}`;
export function contextDisplay(context: ReturnType<FutrynClient['context']>) {
  // Current local estimate and last runtime snapshot are different measurements.
  return {used: context.estimateTokens, total: context.limitTokens, measured: false, ratio: context.estimatedPercent};
}
export const compactTokens = (value: number) =>
  value >= 1_000_000
    ? `${+(value / 1_000_000).toFixed(2)}M`
    : value >= 1000
      ? `${+(value / 1000).toFixed(1)}k`
      : String(value);

const usd = (value: number | null | undefined) => (value == null ? '—' : `$${value.toFixed(2)}`);

/** Local time for today's resets, otherwise the date; the raw value if it does not parse. */
export function resetLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? at.toTimeString().slice(0, 5) : at.toISOString().slice(0, 10);
}

export function limitKindLabel(item: LimitItem): string {
  return {
    'rate-limit': 'Rate limit',
    'subscription-quota': 'Subscription quota',
    'api-credits': 'API credits',
    unknown: 'Unclassified quota',
  }[item.kind ?? 'unknown'];
}

export function limitItemText(item: LimitItem): string {
  const minutes = item.windowMinutes;
  const window = minutes
    ? `${minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`} window`
    : '';
  const label = `${limitKindLabel(item)} · ${item.label}${window ? ` · ${window}` : ''}`;
  const value =
    item.unit === 'USD'
      ? item.unlimited
        ? `${usd(item.used)} used · no spending cap`
        : `${usd(item.used)} of ${usd(item.limit)} · ${usd(item.remaining)} left`
      : item.unlimited
        ? 'provider reports no limit'
        : item.usedPercent == null
          ? 'usage unknown'
          : `${Math.round(item.usedPercent * 10) / 10}% used`;
  return `${label}: ${value} · resets ${item.resetAt ?? 'unknown'}`;
}

export function limitSnapshotText(account: AccountLimits, now = Date.now()): string {
  const observed = account.observedAt ? Date.parse(account.observedAt) : NaN;
  const age = Number.isFinite(observed) ? `${Math.max(0, Math.floor((now - observed) / 60000))}m old` : 'age unknown';
  return `source ${account.source} · observed ${account.observedAt ?? 'unknown'} · ${age}${account.stale ? ' · STALE' : ''}`;
}

/** Each item can come from a different reply or credit lookup. Never borrow the newest sibling timestamp. */
export function limitItemSnapshotText(account: AccountLimits, item: LimitItem, now = Date.now()): string {
  const legacy = !item.source && account.source !== 'mixed';
  const source = item.source ?? (legacy ? account.source : 'unavailable');
  const observedAt = item.observedAt ?? (legacy ? account.observedAt : null);
  const stale = Boolean(
    (item.resetAt && Date.parse(item.resetAt) <= now) ||
    (source === 'live' && account.error) ||
    (legacy && account.stale),
  );
  return limitSnapshotText({...account, source, observedAt, stale}, now);
}

/** One block per connected account; only provider-reported numbers, never local guesses. */
export function limitRows(limits: AccountLimits[]): string[] {
  const rows = ['LIMITS BY PROVIDER / ACCOUNT'];
  if (!limits.length) return [...rows, 'No connected accounts. Use /login.'];
  for (const account of limits) {
    const head = `${account.providerName} · ${account.alias} (${account.accountId})`;
    rows.push(account.error ? `${head} · check failed (${account.error})` : head);
    if (!account.items.length)
      rows.push(
        account.checking
          ? 'Checking…'
          : account.status === 'unsupported'
            ? 'Quota lookup unsupported by this provider.'
            : 'Quota not reported by provider.',
      );
    for (const item of account.items) rows.push(`${limitItemText(item)} · ${limitItemSnapshotText(account, item)}`);
    rows.push(limitSnapshotText(account));
    if (account.note) rows.push(account.note);
  }
  rows.push('', 'R refresh · live lookup where supported; reply snapshots otherwise');
  return rows;
}

export function usageBreakdownRows(usage: ReturnType<FutrynClient['usage']>): string[] {
  const totals = (row: {
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedCostUSD: number | null;
    reportedCostUSD: number | null;
    unknownCostSources: number;
    unknownInputSources: number;
    unknownOutputSources: number;
  }) =>
    `in ${count(row.inputTokens)}${row.unknownInputSources ? ' (incomplete)' : ''} · out ${count(row.outputTokens)}${row.unknownOutputSources ? ' (incomplete)' : ''} · API estimate ${money(row.estimatedCostUSD)} · reported USD ${money(row.reportedCostUSD)}${row.unknownCostSources ? ` · ${row.unknownCostSources} source(s) unpriced` : ''}`;
  const unknown = 'Unknown source';
  return [
    'SOURCE BREAKDOWN · subdivisions of session totals; do not add sections together',
    ...(usage.breakdownTruncated ? ['Source attribution incomplete: overflow retained in unknown source.'] : []),
    `Turns with incomplete source attribution: ${usage.unknownSourceTurns}; legacy aggregates cannot identify child sources.`,
    'BY PROVIDER',
    ...usage.byProvider.map(row => `${row.providerId ?? unknown}: ${totals(row)}`),
    'BY ACCOUNT',
    ...usage.byAccount.map(
      row => `${row.providerId ?? unknown} / ${row.accountId ?? 'Unknown account'}: ${totals(row)}`,
    ),
    'BY MODEL / PROVIDER / ACCOUNT',
    ...usage.byModel.map(
      row =>
        `${row.modelId ?? 'Unknown model'} / ${row.providerId ?? unknown} / ${row.accountId ?? 'Unknown account'}: ${totals(row)}`,
    ),
    'BY AGENT / SESSION / MODEL / PROVIDER / ACCOUNT',
    ...usage.byAgent.map(
      row =>
        `${row.agentId ?? (row.sessionId ? 'Main session' : 'Unknown agent')} / ${row.sessionId ?? 'Unknown session'} / ${row.modelId ?? 'Unknown model'} / ${row.providerId ?? unknown} / ${row.accountId ?? 'Unknown account'}: ${totals(row)}`,
    ),
  ];
}

export function reportRows(client: FutrynClient, kind: ReportKind, draft = '', details = false): string[] {
  const status = client.status();
  const usage = client.usage();
  const context = client.context(draft);
  const project = client.projectContext();
  const git = client.toolsEnabled() ? client.getWorkspaceDiff() : null;
  const limits = kind === 'usage' ? limitRows(client.limits()) : [];
  if (!details) {
    const short = (value: number | null | undefined) =>
      value == null
        ? '—'
        : value >= 10000
          ? `${(value / 1000).toLocaleString('en-US', {maximumFractionDigits: 1})}k`
          : value.toLocaleString('en-US');
    const field = (label: string, value: string) => label.padEnd(16) + value;
    const tokens = (input: number | null | undefined, output: number | null | undefined) =>
      input == null && output == null ? 'Not reported' : `${short(input)} in · ${short(output)} out`;
    if (kind === 'usage') {
      if (!usage.turns && !usage.historicalTurns)
        return ['No usage yet.', 'Send a message or resume a conversation.', '', ...limits];
      return [
        field('Input total', short(usage.inputTokens)),
        field('Output total', short(usage.outputTokens)),
        field('API estimate', money(usage.estimatedCostUSD)),
        field('Reported USD', money(usage.reportedCostUSD)),
        'API estimates and reported USD are not subscription bills.',
        ...(usage.premiumRequests != null ? [field('Premium units', short(usage.premiumRequests))] : []),
        '',
        field('Last turn', tokens(usage.last?.usage?.inputTokens, usage.last?.usage?.outputTokens)),
        ...(usage.last && ['failed', 'cancelled', 'interrupted'].includes(usage.last.outcome)
          ? [field('Outcome', [usage.last.outcome, usage.last.errorCode].filter(Boolean).join(' · '))]
          : usage.last?.stopReason === 'context_window'
            ? [field('Stopped', 'Context window')]
            : []),
        'All requests; input may repeat. Context: /context.',
        field('Reported', `${usage.reportedTurns} / ${usage.turns + usage.historicalTurns} turns`),
        ...(usage.unknownTurns ? ['', 'Some turns have no usage data.'] : []),
        '',
        ...usageBreakdownRows(usage),
        '',
        ...limits,
      ];
    }
    if (kind === 'context') {
      const display = contextDisplay(context);
      const ratio = display.ratio;
      const filled = ratio == null ? 0 : Math.round((Math.min(100, ratio) / 100) * 16);
      return [
        field(
          display.measured ? 'Last measured' : 'Local estimate',
          `${display.measured ? '' : '~'}${short(display.used)} / ${short(display.total)} tokens`,
        ),
        ...(project
          ? [
              field(
                'Project rules',
                `${project.sources.length} file(s) · ${project.usedBytes}/${project.budgetBytes} bytes`,
              ),
              ...(project.diagnostics.length
                ? [field('Rules warnings', project.diagnostics.map(d => d.code).join(', '))]
                : []),
            ]
          : []),
        field(
          'Last reported',
          context.lastMeasured?.usedTokens == null
            ? 'Not reported'
            : `${short(context.lastMeasured.usedTokens)} / ${short(context.lastMeasured.limitTokens)} tokens`,
        ),
        field('Window', context.limitTokens == null ? '—' : `${short(context.limitTokens)} tokens`),
        field(
          'Output reserve',
          context.outputReserve == null ? 'Runtime default' : `${short(context.outputReserve)} tokens`,
        ),
        ...(ratio == null
          ? []
          : ['', `${'━'.repeat(filled)}${'─'.repeat(16 - filled)}  ${display.measured ? '' : '~'}${ratio}%`]),
        '',
        context.estimateSource === 'history'
          ? 'Estimate includes chat history and draft.'
          : 'Estimate includes model-visible history, tool schemas and Cosmew guidance.',
        'Last reported is a historical snapshot, not the next request.',
      ];
    }
    const display = contextDisplay(context);
    const phase =
      (
        {
          idle: 'Ready',
          thinking: 'Preparing request',
          waiting: 'Waiting for provider',
          reasoning: 'Reasoning summary',
          streaming: 'Replying',
          done: 'Finished',
          error: 'Failed',
          tool: 'Tool request',
          permission: 'Awaiting approval',
        } as Record<string, string>
      )[status.phase] ?? status.phase;
    return [
      field('Workspace', `${status.workspace}${git?.branch ? ` · ${git.branch}` : ''}`),
      field('Session', status.activeSessionId ?? 'Not started'),
      field('Account', `${status.activeAccount?.alias ?? 'Not connected'} · ${status.activeProvider?.name ?? '—'}`),
      field('Model', status.selection?.modelId ?? 'Not selected'),
      field('Mode', status.mode),
      field(
        'Permissions',
        `${PERMISSION_MODE_LABELS[status.permissionMode]} (sandbox ${status.sandbox.enabled ? 'on' : 'off'}) · ${status.pendingPermissions} pending`,
      ),
      field('Backend', status.executionBackend?.label ?? 'No model selected'),
      field(
        'Terminal',
        status.terminalRuntime.available
          ? status.terminalRuntime.label
          : (status.terminalRuntime.reason ?? 'Unavailable'),
      ),
      field(
        'Sandbox',
        `${status.terminalRuntime.sandbox} · unsandboxed escape ${status.terminalRuntime.unsandboxedAllowed ? 'asks' : 'refused'}`,
      ),
      field('Request', `${phase} · effort ${status.reasoningEffort ?? 'provider default'}`),
      field('Context', `~${short(display.used)} / ${short(display.total)} local`),
      field(
        'Session usage',
        `${tokens(usage.inputTokens, usage.outputTokens)}${usage.costUSD != null ? ` · USD subtotal ${money(usage.costUSD)}` : ''}`,
      ),
    ];
  }
  const usageRows = [
    'SESSION USAGE · local observations, not account billing',
    'Totals sum all model requests, including repeated input across tool rounds.',
    'These totals are not context occupancy; /context shows the current window.',
    `Coverage: ${usage.reportedTurns}/${usage.turns + usage.historicalTurns} turns with input/output counts`,
    `Unknown or historical turns: ${usage.unknownTurns}`,
    `Input subtotal: ${count(usage.inputTokens)} · Output subtotal: ${count(usage.outputTokens)}`,
    `API estimate subtotal: ${money(usage.estimatedCostUSD)} · Provider-reported USD subtotal: ${money(usage.reportedCostUSD)} · priced turns ${usage.pricedTurns}/${usage.turns + usage.historicalTurns}`,
    'Missing prices/usage are excluded, never counted as free.',
    `Premium request units: ${count(usage.premiumRequests)} (not USD)`,
    'API estimates and provider-reported USD are not subscription bills.',
    '',
    'LAST TURN',
    `Outcome: ${usage.last?.outcome === 'pending' ? 'Pending / unfinalized' : (usage.last?.outcome ?? 'No recorded turn')}`,
    ...(usage.last?.errorCode
      ? [`Error: ${usage.last.errorCode}`]
      : usage.last?.stopReason === 'context_window'
        ? ['Stopped at the context window.']
        : []),
    `Input: ${count(usage.last?.usage?.inputTokens)} · Output: ${count(usage.last?.usage?.outputTokens)}`,
    `Cache read: ${count(usage.last?.usage?.cacheReadTokens)} · Cache write: ${count(usage.last?.usage?.cacheWriteTokens)}`,
    `Reasoning tokens: ${count(usage.last?.usage?.reasoningTokens)} (subset of output; not added twice)`,
    'Cache read/write counts are subsets of input tokens.',
    `USD subtotal${usage.last?.usage?.costEstimated ? ' (includes API estimates)' : ' (provider-reported)'}: ${money(usage.last?.usage?.costUSD)}`,
    `Price source: ${usage.last?.usage?.pricingSource ?? 'Unavailable'}`,
    `Price observed: ${usage.last?.usage?.pricingAt ?? 'Unknown'}`,
    '',
    ...usageBreakdownRows(usage),
    '',
    ...limits,
  ];
  const contextRows = [
    'CONTEXT WINDOW',
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Workspace reading: ${status.workspaceReadStatus === 'read-only' ? 'read/glob/grep through Cosmew permissions' : status.workspaceReadStatus}`,
    `Window: ${count(context.limitTokens)} · Output reserve: ${count(context.outputReserve)}`,
    `Model output ceiling: ${count(context.outputLimit)}`,
    `Estimated request: ~${count(context.estimateTokens)} tokens (${context.messages} messages)`,
    `Method: ${context.estimateMethod}`,
    context.estimatedPercent == null
      ? 'Context percentage: unavailable (the model reports no context window).'
      : `Estimated occupancy: ~${context.estimatedPercent}% (not a provider measurement)`,
    'Provider-added framing and instructions are outside the local estimate.',
    `Metadata source: ${context.metadataSource ?? 'Unavailable'}`,
    `Metadata observed: ${context.metadataAt ?? 'Unknown'}`,
    '',
    'PROJECT INSTRUCTIONS · USER/PROJECT CONTEXT',
    ...(project
      ? [
          `Root: ${project.root}`,
          `Working directory: ${project.workingDirectory ?? 'Unavailable'}`,
          `Budget: ${project.usedBytes}/${project.budgetBytes} bytes · fingerprint ${project.fingerprint}`,
          `Loaded: ${project.loadedAt}`,
          ...project.sources.map(
            source =>
              `${source.path} · scope ${source.scope} · ${source.bytes} bytes${source.truncated ? ' · truncated' : ''} · sha256 ${source.hash}`,
          ),
          ...project.diagnostics.map(d => `Skipped/limited: ${d.path ?? '(loader)'} · ${d.code}`),
        ]
      : ['Not loaded: folder consent or a conversational request is required.']),
    '',
    'LAST PROVIDER/RUNTIME MEASUREMENT',
    `Used: ${count(context.lastMeasured?.usedTokens)} · Window: ${count(context.lastMeasured?.limitTokens)}`,
    `Measured at: ${context.lastMeasured?.measuredAt ?? 'Never'}`,
    'This historical measurement is not the next request estimate.',
    'Session cumulative token consumption is not context occupancy.',
    `At ${CONTEXT_COMPACTION_FRACTION * 100}% of the context window, automatic compaction tries to summarize older history. /compact runs on demand when idle.`,
  ];
  if (kind === 'usage') return usageRows;
  if (kind === 'context') return contextRows;
  return [
    'CONNECTION & SESSION',
    `Workspace: ${status.workspace}`,
    `Git: ${git?.state === 'ready' ? `${git.branch ?? 'branch unknown'} · ${git.files.length} change entries +${git.totalAdditions} -${git.totalDeletions}${git.truncated ? ' (bounded)' : ''}` : (git?.message ?? 'Not inspected; folder consent is required.')}`,
    `Mode: ${status.mode} · Permission mode: ${PERMISSION_MODE_LABELS[status.permissionMode]} · Pending approvals: ${status.pendingPermissions}`,
    `Sandbox: ${status.sandbox.enabled ? 'on' : 'OFF'} · auto-allow sandboxed commands: ${status.sandbox.autoAllowBashIfSandboxed ? 'on' : 'off'} · network: through the proxy, ${status.sandbox.allowedDomains} allowed domain(s) · excluded commands: ${status.sandbox.excludedCommands}`,
    `Terminal runtime: ${status.terminalRuntime.label} · ${status.terminalRuntime.available ? 'available' : (status.terminalRuntime.reason ?? 'unavailable')}`,
    `Terminal sandbox: ${status.terminalRuntime.sandbox} · dangerouslyDisableSandbox: ${status.terminalRuntime.unsandboxedAllowed ? 'asks' : 'refused'}`,
    ...status.terminalRuntime.limitations,
    `Provider: ${status.activeProvider?.name ?? 'None'} · Account: ${status.activeAccount?.alias ?? 'None'}`,
    `Authentication: ${status.activeProvider?.auth === 'oauth' ? 'oauth' : (status.activeAccount?.credential.kind ?? 'None')}`,
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Workspace reading: ${status.workspaceReadStatus === 'read-only' ? 'read/glob/grep through Cosmew permissions' : status.workspaceReadStatus}`,
    `Session: ${status.activeSessionId ?? 'None'} · Messages: ${status.messageCount}`,
    `Account state: ${status.activeAccount?.status ?? 'None'}`,
    `Connectivity: historical validation at ${status.activeAccount?.validatedAt ?? 'never'}`,
    '/doctor performs a live check; /status itself does not send a request.',
    '',
    'REQUEST & REASONING',
    `Phase: ${status.phase === 'thinking' ? 'preparing request' : status.phase} · Effort: ${status.reasoningEffort ?? 'Provider default / not advertised'}`,
    `Available efforts: ${status.activeModel?.reasoningEfforts?.join(', ') || 'Not advertised'}`,
    'Only provider-supplied reasoning summaries are displayed. Ctrl+O expands/collapses.',
    '',
    `Usage: in ${count(usage.inputTokens)} · out ${count(usage.outputTokens)} · USD subtotal ${money(usage.costUSD)}`,
    `Usage coverage: ${usage.reportedTurns}/${usage.turns + usage.historicalTurns} turns. /usage shows details.`,
    `Context: local estimate ~${count(context.estimateTokens)} / ${count(context.limitTokens)}`,
    `Output reserve: ${count(context.outputReserve)} · /context shows source and limitations.`,
    '',
    '/login manages provider accounts; /model selects the active model.',
    '/model selects a model · /effort <level> sets an advertised effort.',
    '',
    'BACKEND CAPABILITIES',
    ...Object.entries(status.capabilities).map(([name, value]) => `${name}: ${value}`),
  ];
}

/** Glyph kinds of the `/context` grid: used category, free space, autocompact buffer. */
export type ContextCellKind = 'messages' | 'instructions' | 'free' | 'buffer';
export interface ContextCategory {
  kind: ContextCellKind;
  label: string;
  tokens: number;
  percent: number;
  cells: number;
}
export interface ContextBlock {
  rows: ContextCellKind[][];
  categories: ContextCategory[];
  limitTokens: number | null;
  skills: number;
  agents: number;
  /** One line under "MCP tools · /mcp". Empty config stays "User mcp.json". */
  mcpNote: string;
  note: string;
}
export const CONTEXT_COLUMNS = 20;
export const CONTEXT_ROWS = 7;
/** Tokens as `3.1k` / `931.3k` / `33k` / `669` (spec 7, `/context`). */
export function contextTokens(value: number): string {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}
/** `/context` numbers from the SDK's real context estimate; categories the SDK cannot measure are not drawn. */
export function contextBlock(client: FutrynClient, draft = ''): ContextBlock {
  const context = client.context(draft);
  const limit = context.limitTokens;
  const cellsTotal = CONTEXT_COLUMNS * CONTEXT_ROWS;
  const instructions = Math.min(
    context.estimateTokens,
    Math.ceil(context.projectInstructionBytes / (context.estimateSource === 'history' ? 4 : 3)),
  );
  const messages = Math.max(0, context.estimateTokens - instructions);
  const buffer = limit && context.autoCompact ? limit - Math.ceil(limit * CONTEXT_COMPACTION_FRACTION) : 0;
  const used = [
    {kind: 'instructions' as const, label: 'Instructions', tokens: instructions},
    {
      kind: 'messages' as const,
      label: context.estimateSource === 'history' ? 'Messages' : 'Messages, tools and guidance',
      tokens: messages,
    },
  ];
  const free = limit ? Math.max(0, limit - buffer - instructions - messages) : 0;
  const percent = (tokens: number) => (limit ? Math.round((tokens / limit) * 1000) / 10 : 0);
  const cellsFor = (tokens: number) =>
    limit && tokens > 0 ? Math.max(1, Math.round((tokens / limit) * cellsTotal)) : 0;
  const categories: ContextCategory[] = [
    ...used.map(item => ({...item, percent: percent(item.tokens), cells: cellsFor(item.tokens)})),
    {kind: 'free' as const, label: 'Free space', tokens: free, percent: percent(free), cells: 0},
    {
      kind: 'buffer' as const,
      label: 'Autocompact buffer',
      tokens: buffer,
      percent: percent(buffer),
      cells: cellsFor(buffer),
    },
  ];
  const fixed = categories.filter(c => c.kind !== 'free').reduce((sum, c) => sum + c.cells, 0);
  categories.find(c => c.kind === 'free')!.cells = Math.max(0, cellsTotal - fixed);
  const flat: ContextCellKind[] = [];
  for (const kind of ['instructions', 'messages', 'free', 'buffer'] as const) {
    const category = categories.find(c => c.kind === kind)!;
    for (let i = 0; i < category.cells && flat.length < cellsTotal; i++) flat.push(kind);
  }
  while (flat.length < cellsTotal) flat.push('free');
  return {
    rows: Array.from({length: CONTEXT_ROWS}, (_, row) =>
      flat.slice(row * CONTEXT_COLUMNS, (row + 1) * CONTEXT_COLUMNS),
    ),
    categories,
    limitTokens: limit,
    skills: client.skills().skills.length,
    agents: client.agentTypes().types.filter(type => type.source !== 'builtin').length,
    mcpNote: mcpContextNote(client),
    note:
      context.estimateSource === 'history'
        ? 'System prompt and tool schemas are not measured.'
        : 'Provider-added framing is outside the estimate. Drafts use context available before sending.',
  };
}
function mcpContextNote(client: FutrynClient): string {
  const report = client.mcpStatus();
  if (report.servers.length === 0) return '└ User mcp.json';
  const tools = report.servers.reduce((sum, server) => sum + server.tools, 0);
  const servers = `${report.servers.length} ${report.servers.length === 1 ? 'server' : 'servers'}`;
  return `└ ${servers} · ${tools} ${tools === 1 ? 'tool' : 'tools'}`;
}
export const CONTEXT_GLYPH: Record<ContextCellKind, string> = {
  messages: '⛁',
  instructions: '⛁',
  free: '⛶',
  buffer: '⛝',
};
/** Plain lines of the block (transcript output, tests): grid left, legend right. */
export function contextText(block: ContextBlock): string[] {
  const legend = [
    'Estimated usage by category',
    ...block.categories.map(
      c => `${CONTEXT_GLYPH[c.kind]} ${c.label}: ${contextTokens(c.tokens)} tokens (${c.percent}%)`,
    ),
  ];
  const lines = block.rows.map((row, at) => {
    const grid = row.map(kind => CONTEXT_GLYPH[kind]).join(' ');
    const side = legend[at - 1];
    return side ? `${grid}   ${side}` : grid;
  });
  return [
    ...lines,
    '',
    `Context window:  ${block.limitTokens ? `${contextTokens(block.limitTokens)} tokens` : 'Not reported'}`,
    '',
    'MCP tools · /mcp',
    block.mcpNote,
    '',
    'Custom agents · .cosmew/agents/',
    `└ ${block.agents} agents`,
    '',
    'Skills · /skills',
    `└ ${block.skills} skills`,
    '',
    block.note,
  ];
}
