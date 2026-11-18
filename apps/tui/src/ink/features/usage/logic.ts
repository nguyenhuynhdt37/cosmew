import type {AccountLimits, FutrynClient, LimitItem} from '@futryn/sdk';
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

export function limitItemText(item: LimitItem): string {
  if (item.unit === 'USD') {
    if (item.unlimited) return `${usd(item.used)} used · no spending cap`;
    return `${usd(item.used)} of ${usd(item.limit)} · ${usd(item.remaining)} left`;
  }
  const used = item.unlimited
    ? 'unlimited'
    : item.usedPercent == null
      ? 'usage unknown'
      : `${Math.round(item.usedPercent * 10) / 10}% used`;
  return `${item.label} ${used}${item.resetAt ? ` · resets ${resetLabel(item.resetAt)}` : ''}`;
}

/** One block per connected account; only provider-reported numbers, never local guesses. */
export function limitRows(limits: AccountLimits[]): string[] {
  const rows = ['LIMITS BY PROVIDER'];
  if (!limits.length) return [...rows, 'No connected accounts. Use /login.'];
  for (const account of limits) {
    const label = account.providerName.slice(0, 15).padEnd(16);
    const head = `${label}${account.alias}`;
    if (account.error) {
      rows.push(`${head} · check failed (${account.error})`);
      continue;
    }
    if (!account.items.length) {
      rows.push(`${head} · ${account.checking ? 'checking…' : 'not reported by provider'}`);
      continue;
    }
    const [first, ...rest] = account.items;
    rows.push(`${head} · ${limitItemText(first!)}${account.checking ? ' · refreshing…' : ''}`);
    for (const item of rest) rows.push(`${''.padEnd(16)}${limitItemText(item)}`);
    if (account.note) rows.push(`${''.padEnd(16)}${account.note}`);
  }
  rows.push('', 'R refresh · OpenRouter live · others from last reply');
  return rows;
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
      const quota = usage.last?.usage?.quota?.[0];
      return [
        field('Input total', short(usage.inputTokens)),
        field('Output total', short(usage.outputTokens)),
        ...(usage.costUSD != null
          ? [field('Est. cost', money(usage.costUSD))]
          : [
              field(
                status.activeProvider?.auth === 'oauth' ? 'Billing' : 'Est. cost',
                status.activeProvider?.auth === 'oauth' ? 'Subscription' : '—',
              ),
            ]),
        ...(usage.premiumRequests != null ? [field('Premium units', short(usage.premiumRequests))] : []),
        '',
        field('Last turn', tokens(usage.last?.usage?.inputTokens, usage.last?.usage?.outputTokens)),
        'All requests; input may repeat. Context: /context.',
        field('Reported', `${usage.reportedTurns} / ${usage.turns + usage.historicalTurns} turns`),
        ...(quota
          ? [
              field(
                status.activeProvider?.auth === 'oauth' ? 'Plan usage' : 'Rate limit',
                quota.unlimited ? 'Unlimited' : quota.usedPercent == null ? '—' : `${short(quota.usedPercent)}% used`,
              ),
            ]
          : []),
        ...(usage.unknownTurns ? ['', 'Some turns have no usage data.'] : []),
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
        'Estimate includes chat history and draft.',
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
        `${status.permissionPreset} (${status.sandboxMode}, ${status.approvalPolicy}) · ${status.pendingPermissions} pending`,
      ),
      field('Backend', status.executionBackend?.label ?? 'No model selected'),
      field(
        'Terminal',
        status.terminalRuntime.available
          ? status.terminalRuntime.label
          : (status.terminalRuntime.reason ?? 'Unavailable'),
      ),
      field('Sandbox', `${status.terminalRuntime.sandbox} · network ${status.terminalRuntime.escalation}`),
      field('Request', `${phase} · effort ${status.reasoningEffort ?? 'provider default'}`),
      field('Context', `~${short(display.used)} / ${short(display.total)} local`),
      field(
        'Session usage',
        `${tokens(usage.inputTokens, usage.outputTokens)}${usage.costUSD != null ? ` · est. ${money(usage.costUSD)}` : ''}`,
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
    `API cost subtotal (estimate): ${money(usage.costUSD)} · priced turns ${usage.pricedTurns}/${usage.turns + usage.historicalTurns}`,
    'Missing prices/usage are excluded, never counted as free.',
    `Premium request units: ${count(usage.premiumRequests)} (not USD)`,
    ...(usage.last?.usage?.quota?.length
      ? [
          'ACCOUNT QUOTA / RATE LIMITS · snapshot from the last reply (not session totals)',
          ...usage.last.usage.quota.map(
            quota =>
              `${quota.name}: ${quota.unlimited ? 'unlimited entitlement' : quota.usedPercent == null ? 'usage unknown' : count(quota.usedPercent) + '% used'} · resets ${quota.resetAt ?? 'unknown'} · observed ${quota.observedAt}`,
          ),
        ]
      : ['Account quota / rate limits: not reported by this provider.']),
    '',
    'LAST TURN',
    `Outcome: ${usage.last?.outcome === 'pending' ? 'Pending / unfinalized' : (usage.last?.outcome ?? 'No recorded turn')}`,
    `Input: ${count(usage.last?.usage?.inputTokens)} · Output: ${count(usage.last?.usage?.outputTokens)}`,
    `Cache read: ${count(usage.last?.usage?.cacheReadTokens)} · Cache write: ${count(usage.last?.usage?.cacheWriteTokens)}`,
    `Reasoning tokens: ${count(usage.last?.usage?.reasoningTokens)} (subset of output; not added twice)`,
    'Cache read/write counts are subsets of input tokens.',
    `Estimated API cost: ${money(usage.last?.usage?.costUSD)}`,
    `Price source: ${usage.last?.usage?.pricingSource ?? 'Unavailable'}`,
    `Price observed: ${usage.last?.usage?.pricingAt ?? 'Unknown'}`,
    '',
    'BY MODEL',
    ...usage.byModel.map(
      model =>
        `${model.modelId}: ${model.turns} turns · in ${count(model.inputTokens)} · out ${count(model.outputTokens)} · estimated ${money(model.costUSD)}`,
    ),
    ...(status.activeProvider?.auth === 'oauth'
      ? ['', 'Subscription access: API list prices do not represent your subscription bill.']
      : []),
    '',
    ...limits,
  ];
  const contextRows = [
    'CONTEXT WINDOW',
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Workspace reading: ${status.workspaceReadStatus === 'read-only' ? 'read/glob/grep through Futryn permissions' : status.workspaceReadStatus}`,
    `Window: ${count(context.limitTokens)} · Output reserve: ${count(context.outputReserve)}`,
    `Model output ceiling: ${count(context.outputLimit)}`,
    `Current local history + draft: ~${count(context.estimateTokens)} tokens (${context.messages} messages)`,
    `Method: ${context.estimateMethod}`,
    context.estimatedPercent == null
      ? 'Context percentage: unavailable (the model reports no context window).'
      : `Estimated occupancy: ~${context.estimatedPercent}% (not a provider measurement)`,
    'Local estimate excludes provider framing and hidden instructions.',
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
    'Context compaction: at 90% of the window the current model writes a handoff summary (excerpt checkpoint if that fails); /compact runs it on demand when idle. Source history is retained.',
  ];
  if (kind === 'usage') return usageRows;
  if (kind === 'context') return contextRows;
  return [
    'CONNECTION & SESSION',
    `Workspace: ${status.workspace}`,
    `Git: ${git?.state === 'ready' ? `${git.branch ?? 'branch unknown'} · ${git.files.length} change entries +${git.totalAdditions} -${git.totalDeletions}${git.truncated ? ' (bounded)' : ''}` : (git?.message ?? 'Not inspected; folder consent is required.')}`,
    `Mode: ${status.mode} · Permissions: ${status.permissionPreset} (sandbox ${status.sandboxMode}, approval ${status.approvalPolicy}, mode ${status.permissionMode}) · Pending approvals: ${status.pendingPermissions}`,
    `Sandboxed commands network: ${status.sandboxNetwork ? 'on (network_access / FUTRYN_SANDBOX_NETWORK)' : 'off unless approved'}`,
    `Terminal runtime: ${status.terminalRuntime.label} · ${status.terminalRuntime.available ? 'available' : (status.terminalRuntime.reason ?? 'unavailable')}`,
    `Sandbox: ${status.terminalRuntime.sandbox} · Network escalation: ${status.terminalRuntime.escalation}`,
    ...status.terminalRuntime.limitations,
    `Provider: ${status.activeProvider?.name ?? 'None'} · Account: ${status.activeAccount?.alias ?? 'None'}`,
    `Authentication: ${status.activeProvider?.auth === 'oauth' ? 'oauth' : (status.activeAccount?.credential.kind ?? 'None')}`,
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Workspace reading: ${status.workspaceReadStatus === 'read-only' ? 'read/glob/grep through Futryn permissions' : status.workspaceReadStatus}`,
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
    `Usage: in ${count(usage.inputTokens)} · out ${count(usage.outputTokens)} · estimated ${money(usage.costUSD)}`,
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
