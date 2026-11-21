/** @jsxImportSource react */
import {useCallback, useState} from 'react';
import {Box, Text} from 'ink';
import type {ModelEvent, SubagentNotice} from '@cosmew/contracts';
import {useEvents} from '../../hooks';
import {useTheme} from '../../theme';
import {ResultLine, safeText, useUiTheme} from '../../ui';
export interface TranscriptNotice {
  id: string;
  text: string;
  /** `event`: an out-of-turn event drawn as `⏺ text` (background command or agent finished). Default: `  ⎿  text`. */
  kind?: 'note' | 'event';
  /** Colours the `⏺` of an event: false for a failed background command. */
  ok?: boolean;
}
/** `Background command "<description>" completed (exit code 0)` (reference L07). Exit codes come from the host. */
export function backgroundCommandNotice(description: string, exitCode: number | null): TranscriptNotice {
  const text =
    exitCode === 0
      ? `Background command "${description}" completed (exit code 0)`
      : `Background command "${description}" failed with ${exitCode === null ? 'a signal' : `exit code ${exitCode}`}`;
  return {id: crypto.randomUUID(), text: safeText(text), kind: 'event', ok: exitCode === 0};
}
export function compactionNotice(event: Extract<ModelEvent, {type: 'context.compacted'}>): string {
  return `Context compacted (${event.strategy === 'model' ? 'summarized by the model' : 'excerpt checkpoint'}${event.fallback ? '; model summary failed' : ''}): ~${event.tokensBefore} → ~${event.tokensAfter} tokens.`;
}
export function subagentNotice(notice: SubagentNotice): string {
  return `Subagent ${notice.agentType}: ${notice.description} · ${notice.status} · ${notice.delivery}`;
}
/** Hook output (`⎿  <Name> says: …`) has no SDK source yet; hosts that get it can pass this to `addNotice`. */
export function hookNotice(name: string, text: string): string {
  return `${name} says: ${text}`;
}
export function useNotices(limit = 16, {subscribeSubagents = true}: {subscribeSubagents?: boolean} = {}) {
  const [notices, setNotices] = useState<TranscriptNotice[]>([]);
  const addNotice = useCallback(
    (notice: string | Omit<TranscriptNotice, 'id'>) =>
      setNotices(previous =>
        [
          ...previous,
          {
            id: crypto.randomUUID(),
            ...(typeof notice === 'string' ? {text: notice} : notice),
            text: safeText(typeof notice === 'string' ? notice : notice.text),
          },
        ].slice(-Math.max(1, limit)),
      ),
    [limit],
  );
  useEvents({
    subagent: notice => {
      if (subscribeSubagents)
        addNotice({text: subagentNotice(notice), kind: 'event', ok: notice.status === 'completed'});
    },
  });
  return {notices, addNotice, clearNotices: useCallback(() => setNotices([]), [])};
}
export interface NoticesProps {
  notices: readonly TranscriptNotice[];
  width?: number;
}
export function Notices({notices, width}: NoticesProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {notices.map(notice =>
        notice.kind === 'event' ? (
          <Box key={notice.id} width={width} minWidth={0}>
            <Text color={notice.ok === false ? color('error') : ui.color('toolSuccess')}>⏺ </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="wrap">{notice.text}</Text>
            </Box>
          </Box>
        ) : (
          <ResultLine key={notice.id} width={width}>
            <Text wrap="wrap" color={color(/⚠|warning/i.test(notice.text) ? 'warning' : 'foregroundMuted')}>
              {notice.text}
            </Text>
          </ResultLine>
        ),
      )}
    </Box>
  );
}
