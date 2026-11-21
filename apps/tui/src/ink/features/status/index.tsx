/** @jsxImportSource react */
import {Box, Text} from 'ink';
import {TextLine} from '../../ui';
import {useFutrynClient, useStatus, useClientEvents} from '../../hooks';
import {useReducer} from 'react';
import {CONTEXT_COMPACTION_FRACTION, type PermissionMode} from '@cosmew/contracts';
import {useUiTheme} from '../../ui/ui-theme';
import {useTheme} from '../../theme';
import type {FutrynClient} from '@cosmew/sdk';
import {textWidth} from '../../../input/text';
/** Ten cells, same marks as the context report, so a percent is a bar instead of a buried number. */
export function contextCells(percent: number | null, cells = 10): string {
  const room = Math.max(1, cells);
  if (percent == null || !Number.isFinite(percent)) return '-'.repeat(room);
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * room);
  return `${'='.repeat(filled)}${'-'.repeat(room - filled)}`;
}
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '?';
  const n = Math.max(0, Math.floor(value));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
export function useStatusLine(draft = '', workspaceAccess = true) {
  const client = useFutrynClient();
  const status = useStatus();
  const [, update] = useReducer(n => n + 1, 0);
  useClientEvents({subagent: () => update()});
  let branch: string | null | undefined;
  if (workspaceAccess && client.toolsEnabled()) {
    try {
      branch = client.getWorkspaceDiff()?.branch;
    } catch {
      /* Backend may not expose Git. */
    }
  }
  return {
    status,
    context: client.context(draft),
    usage: client.usage(),
    runningAgents: client.subagents().filter(a => a.status === 'running').length,
    branch,
  };
}
export interface StatusLineProps {
  status: ReturnType<FutrynClient['status']>;
  context: ReturnType<FutrynClient['context']>;
  usage: ReturnType<FutrynClient['usage']>;
  runningAgents?: number;
  branch?: string | null;
  width?: number;
}
/** Compatibility export: the composer now owns the single footer row. */
export function StatusLine(_props: StatusLineProps) {
  return null;
}
/** Mode label (coloured) and the dim cycle hint that follows it; wording is the reference's (spec 2). */
export function modeParts(mode: PermissionMode): {label: string; hint: string} {
  switch (mode) {
    case 'acceptEdits':
      return {label: '⏵⏵ accept edits on', hint: ' (shift+tab to cycle)'};
    case 'plan':
      return {label: '⏸ plan mode on', hint: ' (shift+tab to cycle)'};
    case 'bypassPermissions':
      return {label: '⏵⏵ bypass permissions on', hint: ' (shift+tab to cycle)'};
    default:
      return {label: '⏸ manual mode on', hint: ''};
  }
}
export function modeLine(mode: PermissionMode): string {
  const {label, hint} = modeParts(mode);
  return label + hint;
}
/** `← 1 agent` / `2 shells` pieces that follow the mode and `esc to interrupt`, joined by ` · `. */
export function footerSuffix(options: {busy?: boolean; agents?: number; shells?: number}): string[] {
  const parts: string[] = [];
  if (options.busy) parts.push('esc to interrupt');
  const agents = Math.max(0, Math.floor(options.agents ?? 0));
  const shells = Math.max(0, Math.floor(options.shells ?? 0));
  if (shells) parts.push(`${shells} shell${shells === 1 ? '' : 's'}`);
  if (agents) parts.push(`← ${agents} agent${agents === 1 ? '' : 's'}`);
  if (shells || agents) parts.push('↓ to manage');
  return parts;
}
/** Column widths of the `?` table: 24 and 35 cells at the reference width, thirds when narrower. */
export function shortcutWidths(contentWidth: number): [number, number, number] {
  if (contentWidth >= 24 + 35 + 26) return [24, 35, contentWidth - 59];
  const third = Math.floor(contentWidth / 3);
  return [third, third, contentWidth - third * 2];
}
/** Only a current SDK measurement may trigger the warning; estimates are not usage. */
export function contextLeft(context: ReturnType<FutrynClient['context']>): number | null {
  const measured = context.lastMeasured;
  if (
    context.autoCompact === false ||
    !context.measuredCurrentHistory ||
    measured?.source === 'estimate' ||
    measured?.usedTokens == null ||
    measured.limitTokens == null ||
    !Number.isFinite(measured.usedTokens) ||
    !Number.isFinite(measured.limitTokens)
  )
    return null;
  const usable = measured.limitTokens - context.outputReserve;
  if (usable <= 0) return null;
  const threshold = usable * CONTEXT_COMPACTION_FRACTION;
  const left = Math.max(0, Math.min(100, Math.floor(((threshold - measured.usedTokens) / threshold) * 100)));
  return left < 20 ? left : null;
}
export function ComposerFooter({
  mode,
  bash = false,
  busy = false,
  agents = 0,
  shells = 0,
  message,
  remaining,
  context,
  transcriptHint,
  shortcuts,
  width,
}: {
  mode: PermissionMode;
  /** `!` shell prompt: the footer says so instead of showing the permission mode. */
  bash?: boolean;
  busy?: boolean;
  agents?: number;
  shells?: number;
  message?: string;
  remaining?: number | null;
  context?: {usedTokens: number; modelLimitTokens: number | null};
  transcriptHint?: string;
  shortcuts?: readonly (readonly string[])[];
  width: number;
}) {
  const ui = useUiTheme();
  const {color} = ui;
  const theme = useTheme();
  const contentWidth = Math.max(1, width - 2);
  if (shortcuts) {
    const widths = shortcutWidths(contentWidth);
    return (
      <Box width={width} paddingLeft={2}>
        {shortcuts.map((column, index) => (
          <Box key={index} width={widths[index] ?? 0} flexDirection="column" minWidth={0}>
            {column.map(label => (
              <Text key={label} color={color('dim')} wrap="wrap">
                {label}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  }
  if (message)
    return (
      <Box paddingLeft={2} width={width}>
        <TextLine width={contentWidth}>{message}</TextLine>
      </Box>
    );
  if (remaining != null && !context)
    return (
      <Box width={width} paddingLeft={2} justifyContent="flex-end">
        <Text color={color('dim')}>{`Context left until auto-compact: ${remaining}%`}</Text>
      </Box>
    );
  if (bash)
    return (
      <Box paddingLeft={2} width={width}>
        <TextLine width={contentWidth} color={color('bashMode')}>
          ! for shell mode
        </TextLine>
      </Box>
    );
  const {label, hint} = modeParts(mode);
  const labelColor =
    mode === 'bypassPermissions'
      ? color('bypass')
      : mode === 'plan'
        ? color('planMode')
        : mode === 'acceptEdits'
          ? theme.color('warning')
          : color('dim');
  const suffix = footerSuffix({busy, agents, shells});
  if (transcriptHint) suffix.push(transcriptHint);
  const details = hint + suffix.map(part => ` · ${part}`).join('');
  const modelLimit = context?.modelLimitTokens;
  const percent = context && modelLimit ? (context.usedTokens / modelLimit) * 100 : null;
  const ratio = context ? `~${formatTokens(context.usedTokens)}/${formatTokens(modelLimit)}` : '';
  const fullMeter =
    percent == null ? `Context ${ratio}` : `Context [${contextCells(percent)}] ${ratio} · ${Math.round(percent)}%`;
  const available = contentWidth - 3 - textWidth(label + details);
  const meter = [fullMeter, `Ctx ${ratio}`, ratio].find(text => textWidth(text) <= available) ?? ratio;
  const stacked = !!context && textWidth(label + ratio) > contentWidth - 3;
  const meterColor =
    percent != null && percent >= 100
      ? theme.color('error')
      : percent != null && percent >= CONTEXT_COMPACTION_FRACTION * 100
        ? theme.color('warning')
        : color('dim');
  return (
    <Box paddingLeft={2} paddingRight={context ? 2 : 0} width={width} flexDirection={stacked ? 'column' : 'row'}>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={labelColor}>{label}</Text>
          <Text color={color('dim')}>{details}</Text>
        </Text>
      </Box>
      {context ? (
        <Box paddingLeft={stacked ? 0 : 1} flexShrink={0} alignSelf={stacked ? 'flex-end' : undefined}>
          <Text color={meterColor} wrap="truncate-end">
            {meter}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Count reflects backend SANDBOX_DENIED outcomes in the current turn, not an OS log monitor. */
export function SandboxBanner({enabled, count}: {enabled: boolean; count: number}) {
  if (!enabled || count <= 0) return null;
  return <TextLine>{`⧈ Sandbox blocked ${count} ${count === 1 ? 'operation' : 'operations'}`}</TextLine>;
}

/** Session analysis mode is independent of permission mode and the OS sandbox switch. */
export function SessionModeBanner({mode, width}: {mode: 'chat' | 'plan' | 'review'; width: number}) {
  const ui = useUiTheme();
  if (mode === 'chat') return null;
  return (
    <TextLine
      width={width}
      color={ui.color('planMode')}
      wrap="truncate-end"
    >{`${mode === 'review' ? 'Review' : 'Plan'} · read-only · /chat to implement`}</TextLine>
  );
}
