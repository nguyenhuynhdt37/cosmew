/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Text} from 'ink';
import {useTheme} from '../theme';
import {safeText} from './text-line';
const frames = ['✻', '✼', '✽', '✶'];
export interface SpinnerProps {
  verb: string;
  startedAt?: number;
  elapsedMs?: number;
  tokens?: number;
  animate?: boolean;
}
export function Spinner({verb, startedAt, elapsedMs, tokens, animate = true}: SpinnerProps) {
  const theme = useTheme();
  const [start] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(Date.now);
  const moving = animate && theme.animate;
  useEffect(() => {
    // Even reduced-motion mode keeps the elapsed clock current.
    if (elapsedMs !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), moving ? 100 : 1000);
    return () => clearInterval(timer);
  }, [moving, elapsedMs]);
  const elapsed = Math.max(0, elapsedMs ?? now - (startedAt ?? start));
  const seconds = Math.floor(elapsed / 1000);
  const duration =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return (
    <Text color={theme.color('accent')}>
      {moving ? frames[Math.floor(elapsed / 100) % frames.length] : '✻'} {safeText(verb)}…{' '}
      <Text color={theme.color('foregroundMuted')}>
        ({duration}
        {tokens === undefined ? '' : ` · ${Math.max(0, Math.floor(tokens))} tokens`})
      </Text>
    </Text>
  );
}
