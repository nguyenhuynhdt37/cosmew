/** @jsxImportSource react */
import {useCallback, useEffect, useRef, useState} from 'react';
import {useFutrynClient, useStatus, useKeymap, useTextInput} from '../../hooks';
import {Panel, TextLine} from '../../ui';
import {reportRows} from './logic';
import {REPORT_TITLES, type ReportKind} from './types';
export {reportRows, compactTokens, contextDisplay, limitRows} from './logic';
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
  useKeymap(
    {previous: () => setOffset(n => Math.max(0, n - 1)), next: () => setOffset(n => n + 1), submit: onClose},
    {isActive},
  );
  useTextInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      if (input.toLowerCase() === 'd') {
        setDetails(v => !v);
        setOffset(0);
      }
      if (input.toLowerCase() === 'r') refresh();
      if (key.pageDown) setOffset(n => n + 8);
      if (key.pageUp) setOffset(n => Math.max(0, n - 8));
    },
    {isActive},
  );
  return {kind, rows: reportRows(client, kind, draft, details), details, offset, error};
}
export interface UsageProps {
  state: ReturnType<typeof useUsage>;
  width?: number;
  visibleRows?: number;
}
export function Usage({state, width, visibleRows = 12}: UsageProps) {
  const room = Math.max(1, visibleRows);
  const offset = Math.min(state.offset, Math.max(0, state.rows.length - room));
  return (
    <Panel width={width} title={REPORT_TITLES[state.kind]}>
      {state.rows.slice(offset, offset + room).map((row, i) => (
        <TextLine key={i}>{row}</TextLine>
      ))}
      {state.error && <TextLine>{state.error}</TextLine>}
      <TextLine>{`${offset + 1}–${Math.min(offset + room, state.rows.length)}/${state.rows.length} · ↑↓ Scroll · D ${state.details ? 'Summary' : 'Details'} · R refresh · Esc Close`}</TextLine>
    </Panel>
  );
}
