/** @jsxImportSource react */
import {useCallback, useState} from 'react';
import {Box} from 'ink';
import type {ModelEvent, SubagentNotice} from '@futryn/contracts';
import {useEvents} from '../../hooks';
import {useTheme} from '../../theme';
import {TextLine, safeText} from '../../ui';
export interface TranscriptNotice {
  id: string;
  text: string;
}
export function compactionNotice(event: Extract<ModelEvent, {type: 'context.compacted'}>): string {
  return `Context compacted (${event.strategy === 'model' ? 'summarized by the model' : 'excerpt checkpoint'}${event.fallback ? '; model summary failed' : ''}): ~${event.tokensBefore} → ~${event.tokensAfter} tokens.`;
}
export function subagentNotice(notice: SubagentNotice): string {
  return `Subagent ${notice.agentType}: ${notice.description} · ${notice.status} · ${notice.delivery}`;
}
export function useNotices(limit = 16) {
  const [notices, setNotices] = useState<TranscriptNotice[]>([]);
  const addNotice = useCallback(
    (text: string) =>
      setNotices(previous => [...previous, {id: crypto.randomUUID(), text: safeText(text)}].slice(-Math.max(1, limit))),
    [limit],
  );
  useEvents({subagent: notice => addNotice(subagentNotice(notice))});
  return {notices, addNotice, clearNotices: useCallback(() => setNotices([]), [])};
}
export interface NoticesProps {
  notices: readonly TranscriptNotice[];
  width?: number;
}
export function Notices({notices, width}: NoticesProps) {
  const {color} = useTheme();
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      {notices.map(notice => (
        <TextLine key={notice.id} width={width} dimColor color={color('foregroundMuted')}>
          {notice.text}
        </TextLine>
      ))}
    </Box>
  );
}
