/** @jsxImportSource react */
import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {useFutrynClient, useStatus, useKeymap, useTextInput} from '../../hooks';
import {Box, Text} from 'ink';
import {useTheme} from '../../theme';
import {useUiTheme} from '../../ui';
import {SettingsDialog} from '../settings';
import {CONTEXT_GLYPH, contextBlock, contextTokens, reportRows, type ContextBlock, type ContextCellKind} from './logic';
import type {ReportKind} from './types';
export {reportRows, compactTokens, contextDisplay, limitRows, contextBlock, contextText} from './logic';
export type {ReportKind} from './types';
export function useUsage({
  kind = 'usage',
  draft = '',
  onClose,
  isActive = true,
}: {
  kind?: ReportKind;
  draft?: string;
  onClose(): void;
  isActive?: boolean;
}) {
  const client = useFutrynClient();
  useStatus();
  const [details, setDetails] = useState(false);
  const [offset, setOffset] = useState(0);
  const [, update] = useState(0);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    if (request.current || kind !== 'usage') return;
    const abort = new AbortController();
    request.current = abort;
    setError('');
    void client
      .refreshLimits(abort.signal)
      .catch(() => {
        if (!abort.signal.aborted) setError('Limits refresh failed. R to retry.');
      })
      .finally(() => {
        if (!abort.signal.aborted) update(n => n + 1);
        if (request.current === abort) request.current = null;
      });
  }, [client, kind]);
  useEffect(() => {
    setOffset(0);
    setDetails(false);
    refresh();
    if (kind === 'status' && client.toolsEnabled()) void client.refreshWorkspaceDiff().catch(() => {});
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [client, kind, refresh]);
  // Status and usage are tabs of the settings panel, which owns its keys; only /context scrolls here.
  const own = isActive && kind === 'context';
  useKeymap(
    {previous: () => setOffset(n => Math.max(0, n - 1)), next: () => setOffset(n => n + 1), submit: onClose},
    {isActive: own},
  );
  useTextInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      if (key.eventType === 'release') return;
      if (input.toLowerCase() === 'd' || (kind === 'status' && (key.tab || key.leftArrow || key.rightArrow))) {
        setDetails(v => !v);
        setOffset(0);
      }
      if (input.toLowerCase() === 'r') refresh();
      if (key.pageDown) setOffset(n => n + 8);
      if (key.pageUp) setOffset(n => Math.max(0, n - 8));
    },
    {isActive: own},
  );
  return {
    kind,
    /** Plain report rows (headless callers, tests); computed on demand, the panels draw their own views. */
    get rows() {
      return reportRows(client, kind, draft, details);
    },
    details,
    offset,
    error,
  };
}
export interface UsageProps {
  state: ReturnType<typeof useUsage>;
  width?: number;
  visibleRows?: number;
}
export function Usage({state, width}: UsageProps) {
  const client = useFutrynClient();
  if (state.kind !== 'context')
    return <SettingsDialog width={width} initialTab={state.kind === 'status' ? 'Status' : 'Usage'} />;
  return <ContextBlockView block={contextBlock(client)} width={width} />;
}
/** The `/context` grid and legend; also drawn inside the transcript, as Claude Code does. */
export const ContextBlockView = memo(function ContextBlockView({block, width}: {block: ContextBlock; width?: number}) {
  const {color, uiColor} = useContextColors();
  const muted = color('foregroundMuted');
  const legend = block.categories;
  return (
    <Box flexDirection="column" paddingLeft={5} width={width}>
      {block.rows.map((row, at) => {
        const side = at === 0 ? undefined : at === 1 ? 'header' : legend[at - 2];
        return (
          <Text key={at} wrap="truncate-end">
            {row
              .reduce<{kind: ContextCellKind; text: string}[]>((runs, kind, i) => {
                const glyph = `${CONTEXT_GLYPH[kind]}${i < row.length - 1 ? ' ' : ''}`;
                const last = runs.at(-1);
                if (last?.kind === kind) last.text += glyph;
                else runs.push({kind, text: glyph});
                return runs;
              }, [])
              .map(({kind, text}, index) => (
                <Text key={index} color={cellColor(kind)}>
                  {text}
                </Text>
              ))}
            {side === 'header' ? <Text>{'   Estimated usage by category'}</Text> : null}
            {side && side !== 'header' ? (
              <Text>
                {'   '}
                <Text color={cellColor(side.kind)}>{CONTEXT_GLYPH[side.kind]}</Text>
                {` ${side.label}: `}
                <Text color={muted}>{`${contextTokens(side.tokens)} tokens (${side.percent}%)`}</Text>
              </Text>
            ) : null}
          </Text>
        );
      })}
      <Text> </Text>
      <Text>
        <Text bold>Auto-compact window:</Text>
        {`  ${block.limitTokens ? `${contextTokens(block.limitTokens)} tokens` : 'Not reported'}`}
      </Text>
      <Text> </Text>
      <Text>
        <Text bold>MCP tools</Text>
        <Text color={muted}> · /mcp</Text>
      </Text>
      <Text color={muted}>{block.mcpNote}</Text>
      <Text> </Text>
      <Text>
        <Text bold>Custom agents</Text>
        <Text color={muted}> · .cosmew/agents/</Text>
      </Text>
      <Text color={muted}>{`└ ${block.agents} agents`}</Text>
      <Text> </Text>
      <Text>
        <Text bold>Skills</Text>
        <Text color={muted}> · /skills</Text>
      </Text>
      <Text color={muted}>{`└ ${block.skills} skills`}</Text>
      <Text> </Text>
      <Text color={muted}>{block.note}</Text>
    </Box>
  );
  function cellColor(kind: ContextCellKind) {
    return kind === 'free' || kind === 'buffer' ? muted : kind === 'instructions' ? color('info') : uiColor('rule');
  }
});
function useContextColors() {
  const {color} = useTheme();
  const ui = useUiTheme();
  return {color, uiColor: ui.color};
}
