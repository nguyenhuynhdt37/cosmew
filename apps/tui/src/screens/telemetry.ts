import type { ThemeTokens } from '@hannes/contracts';
import type { FutrynClient } from '@hannes/sdk';
import type { RenderedBoxLine } from '../components/editor';
export const count = (value: number | null | undefined) => value == null ? 'Unknown / not reported' : value.toLocaleString('en-US');
const money = (value: number | null | undefined) => value == null ? 'Unknown / not reported' : `$${value.toFixed(6)}`;
export function contextDisplay(context: ReturnType<FutrynClient['context']>) {
  const measured = context.measuredCurrentHistory;
  const used = measured ? context.lastMeasured!.usedTokens! : context.estimateTokens;
  const total = measured ? context.lastMeasured!.limitTokens! : context.limitTokens;
  return { used, total, measured, ratio: measured && total ? Math.round(used / total * 1000) / 10 : context.estimatedPercent };
}
export function reportRows(client: FutrynClient, kind: 'status' | 'usage' | 'context', draft = '', details = false): string[] {
  const status = client.status(); const usage = client.usage(); const context = client.context(draft);
  if (!details) {
    const short = (value: number | null | undefined) => value == null ? '—' : value >= 10000 ? `${(value / 1000).toLocaleString('en-US', {maximumFractionDigits: 1})}k` : value.toLocaleString('en-US');
    const field = (label: string, value: string) => label.padEnd(16) + value;
    const tokens = (input: number | null | undefined, output: number | null | undefined) => input == null && output == null ? 'Not reported' : `${short(input)} in · ${short(output)} out`;
    if (kind === 'usage') {
      if (!usage.turns && !usage.historicalTurns) return ['No usage yet.', 'Send a message or resume a conversation.'];
      const quota = usage.last?.usage?.quota?.[0];
      return [
        field('Input', short(usage.inputTokens)), field('Output', short(usage.outputTokens)),
        ...(usage.costUSD != null ? [field('Est. cost', money(usage.costUSD))] : [field(status.activeProvider?.runtime ? 'Billing' : 'Est. cost', status.activeProvider?.runtime ? 'Subscription' : '—')]),
        ...(usage.premiumRequests != null ? [field('Premium units', short(usage.premiumRequests))] : []),
        '', field('Last turn', tokens(usage.last?.usage?.inputTokens, usage.last?.usage?.outputTokens)),
        field('Reported', `${usage.reportedTurns} / ${usage.turns + usage.historicalTurns} turns`),
        ...(quota ? [field('Plan usage', quota.unlimited ? 'Unlimited' : quota.usedPercent == null ? '—' : `${short(quota.usedPercent)}% used`)] : []),
        ...(usage.unknownTurns ? ['', 'Some turns have no usage data.'] : []),
      ];
    }
    if (kind === 'context') {
      const display = contextDisplay(context); const ratio = display.ratio;
      const filled = ratio == null ? 0 : Math.round(Math.min(100, ratio) / 100 * 16);
      return [
        field(display.measured ? 'Last measured' : 'Local estimate', `${display.measured ? '' : '~'}${short(display.used)} / ${short(display.total)} tokens`),
        field('Window', context.limitTokens == null ? '—' : `${short(context.limitTokens)} tokens`),
        field('Output reserve', context.outputReserve == null ? 'Runtime default' : `${short(context.outputReserve)} tokens`),
        ...(ratio == null ? [] : ['', `${'━'.repeat(filled)}${'─'.repeat(16 - filled)}  ${display.measured ? '' : '~'}${ratio}%`]),
        '', display.measured ? 'Reported by runtime.' : context.runtimeHiddenContext ? 'Local history only; runtime adds context.' : 'Estimate includes chat history and draft.',
      ];
    }
    const display = contextDisplay(context);
    const phase = ({ idle: 'Ready', thinking: 'Preparing request', waiting: 'Waiting for provider', reasoning: 'Reasoning summary', streaming: 'Replying', done: 'Finished', error: 'Failed', tool: 'Tool request', permission: 'Awaiting approval' } as Record<string, string>)[status.phase] ?? status.phase;
    return [
      field('Account', status.activeAccount?.alias ?? 'Not connected'),
      field('Provider', status.activeProvider?.name ?? '—'),
      field('Model', status.selection?.modelId ?? 'Not selected'),
      '', field('Request', phase), field('Reasoning', status.reasoningEffort ?? 'Provider default'),
      field('Context', `${display.measured ? '' : '~'}${short(display.used)} / ${short(display.total)} ${display.measured ? 'measured' : 'local'}`),
      field('Session usage', tokens(usage.inputTokens, usage.outputTokens)),
      ...(usage.costUSD != null ? [field('Est. cost', money(usage.costUSD))] : []),
      '', status.activeAccount?.validatedAt ? 'Previously validated · /doctor checks now' : 'Connection not checked · /doctor',
    ];
  }
  const usageRows = [
    'SESSION USAGE · local observations, not account billing',
    `Coverage: ${usage.reportedTurns}/${usage.turns + usage.historicalTurns} turns with input/output counts`,
    `Unknown or historical turns: ${usage.unknownTurns}`,
    `Input subtotal: ${count(usage.inputTokens)} · Output subtotal: ${count(usage.outputTokens)}`,
    `API cost subtotal (estimate): ${money(usage.costUSD)} · priced turns ${usage.pricedTurns}/${usage.turns + usage.historicalTurns}`,
    'Missing prices/usage are excluded, never counted as free.',
    `Premium request units: ${count(usage.premiumRequests)} (not USD)`,
    ...(usage.last?.usage?.quota?.length ? ['ACCOUNT QUOTA · last runtime snapshot (not session totals)', ...usage.last.usage.quota.map(quota => `${quota.name}: ${quota.unlimited ? 'unlimited entitlement' : quota.usedPercent == null ? 'usage unknown' : count(quota.usedPercent) + '% used'} · resets ${quota.resetAt ?? 'unknown'} · observed ${quota.observedAt}`)] : ['Account plan quota/reset: not reported by this integration.']),
    '', 'LAST TURN',
    `Outcome: ${usage.last?.outcome === 'pending' ? 'Pending / unfinalized' : usage.last?.outcome ?? 'No recorded turn'}`,
    `Input: ${count(usage.last?.usage?.inputTokens)} · Output: ${count(usage.last?.usage?.outputTokens)}`,
    `Cache read: ${count(usage.last?.usage?.cacheReadTokens)} · Cache write: ${count(usage.last?.usage?.cacheWriteTokens)}`,
    `Reasoning tokens: ${count(usage.last?.usage?.reasoningTokens)} (subset of output; not added twice)`,
    'Cache read/write counts are subsets of input tokens.',
    `Estimated API cost: ${money(usage.last?.usage?.costUSD)}`,
    `Price source: ${usage.last?.usage?.pricingSource ?? 'Unavailable'}`,
    `Price observed: ${usage.last?.usage?.pricingAt ?? 'Unknown'}`,
    '', 'BY MODEL',
    ...usage.byModel.map(model => `${model.modelId}: ${model.turns} turns · in ${count(model.inputTokens)} · out ${count(model.outputTokens)} · estimated ${money(model.costUSD)}`),
    ...(status.activeProvider?.runtime ? ['', 'Subscription access: API list prices do not represent your subscription bill.'] : []),
  ];
  const contextRows = [
    'CONTEXT WINDOW',
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Window: ${count(context.limitTokens)} · Output reserve: ${count(context.outputReserve)}`,
    `Model output ceiling: ${count(context.outputLimit)}`,
    `Current local history + draft: ~${count(context.estimateTokens)} tokens (${context.messages} messages)`,
    `Method: ${context.estimateMethod}`,
    context.estimatedPercent == null ? 'Context percentage: unavailable for the full runtime request.' : `Estimated occupancy: ~${context.estimatedPercent}% (not a provider measurement)`,
    'Local estimate excludes provider framing and hidden instructions.',
    ...(context.runtimeHiddenContext ? ['Runtime may add hidden instructions, conversation wrappers and internal context.', 'Output reserve is not exposed by this runtime; a model ceiling is not a configured reserve.'] : []),
    `Metadata source: ${context.metadataSource ?? 'Unavailable'}`,
    `Metadata observed: ${context.metadataAt ?? 'Unknown'}`,
    '', 'LAST PROVIDER/RUNTIME MEASUREMENT',
    `Used: ${count(context.lastMeasured?.usedTokens)} · Window: ${count(context.lastMeasured?.limitTokens)}`,
    `Measured at: ${context.lastMeasured?.measuredAt ?? 'Never'}`,
    'This historical measurement is not the next request estimate.',
    'Session cumulative token consumption is not context occupancy.',
    'Automatic context compaction: Not implemented; use /clear or /resume.',
  ];
  if (kind === 'usage') return usageRows;
  if (kind === 'context') return contextRows;
  return [
    'CONNECTION & SESSION',
    `Provider: ${status.activeProvider?.name ?? 'None'} · Account: ${status.activeAccount?.alias ?? 'None'}`,
    `Authentication: ${status.activeProvider?.runtime ?? status.activeAccount?.credential.kind ?? 'None'}`,
    `Model: ${status.selection?.modelId ?? 'None'}`,
    `Session: ${status.activeSessionId ?? 'None'} · Messages: ${status.messageCount}`,
    `Account state: ${status.activeAccount?.status ?? 'None'}`,
    `Connectivity: historical validation at ${status.activeAccount?.validatedAt ?? 'never'}`,
    '/doctor performs a live check; /status itself does not send a request.',
    '', 'REQUEST & REASONING',
    `Phase: ${status.phase === 'thinking' ? 'preparing request' : status.phase} · Effort: ${status.reasoningEffort ?? 'Provider default / not advertised'}`,
    `Available efforts: ${status.activeModel?.reasoningEfforts?.join(', ') || 'Not advertised'}`,
    'Only provider-supplied reasoning summaries are displayed. Ctrl+R expands/collapses.',
    '', `Usage: in ${count(usage.inputTokens)} · out ${count(usage.outputTokens)} · estimated ${money(usage.costUSD)}`,
    `Usage coverage: ${usage.reportedTurns}/${usage.turns + usage.historicalTurns} turns. /usage shows details.`,
    `Context: local estimate ~${count(context.estimateTokens)} / ${count(context.limitTokens)}`,
    `Output reserve: ${count(context.outputReserve)} · /context shows source and limitations.`,
    '', '/switch chooses another account; continuing transfers the committed chat history.',
    '/model selects a model · /model effort <value> sets an advertised effort.',
    '', 'BACKEND CAPABILITIES',
    ...Object.entries(status.capabilities).map(([name, value]) => `${name}: ${value}`),
  ];
}
export function renderReportOverlay(options: { title: string; rows: string[]; width: number; height: number; offset: number; details?: boolean; tokens: ThemeTokens }): { lines: RenderedBoxLine[]; offset: number } {
  const { title, rows, width, height, tokens } = options;
  const w = Math.max(1, width - 4); const wrapped: string[] = [];
  for (const row of rows) {
    let rest = row;
    while (rest.length > w) {
      const space = rest.lastIndexOf(' ', w); const at = space > w / 2 ? space : w;
      wrapped.push(rest.slice(0, at)); rest = rest.slice(at).trimStart();
    }
    wrapped.push(rest);
  }
  const room = Math.max(1, height - 4); const offset = Math.min(Math.max(0, options.offset), Math.max(0, wrapped.length - room));
  const line = (text: string, fg = tokens.foreground, bold = false): RenderedBoxLine => ({ spans: [{ text: ('  ' + text).slice(0, width).padEnd(width), fg, bg: tokens.overlayBackground, bold }] });
  const body = wrapped.slice(offset, offset + room).map(text => {
    const pair = /^(.{1,16}?) {2,}(.+)$/.exec(text);
    if (pair) return { spans: [
      { text: '  ' + pair[1]!.padEnd(16), fg: tokens.foregroundMuted, bg: tokens.overlayBackground },
      { text: pair[2]!.padEnd(Math.max(0, width - 18)), fg: tokens.foreground, bg: tokens.overlayBackground },
    ] };
    return line(text, /^[A-Z][A-Z &/·-]+$/.test(text) ? tokens.accent : tokens.foreground, /^[A-Z][A-Z &/·-]+$/.test(text));
  });
  const scroll = wrapped.length > room ? (width < 40 ? '↑↓ · ' : '↑↓ Scroll · ') : '';
  const footer = `${scroll}D ${options.details ? 'Summary' : 'Details'} · Esc${width >= 40 ? ' Close' : ''}`;
  const lines = [line(title, tokens.accent, true), line(''), ...body, line(footer, tokens.foregroundSubtle)].slice(0, height);
  return { lines, offset };
}
