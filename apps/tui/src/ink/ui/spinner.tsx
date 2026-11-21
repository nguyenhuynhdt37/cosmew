/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../theme';
import {ResultLine, safeText} from './text-line';
import {useUiTheme} from './ui-theme';
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/** Cosmew's own verbs: [present participle for the spinner, past tense for the end-of-turn line]. */
export const TURN_VERBS: readonly (readonly [string, string])[] = [
  ['Exploring', 'Explored'],
  ['Connecting', 'Connected'],
  ['Crafting', 'Crafted'],
  ['Untangling', 'Untangled'],
  ['Assembling', 'Assembled'],
  ['Refining', 'Refined'],
  ['Weaving', 'Wove'],
  ['Tracing', 'Traced'],
  ['Distilling', 'Distilled'],
  ['Charting', 'Charted'],
  ['Stitching', 'Stitched'],
  ['Polishing', 'Polished'],
  ['Kindling', 'Kindled'],
  ['Mapping', 'Mapped'],
];
export const FUTRYN_VERBS = TURN_VERBS.map(([present]) => present);
/** One-line tips under the spinner; every entry names a feature Cosmew really has. */
export const SPINNER_TIPS: readonly string[] = [
  'Send a message mid-task to steer Cosmew',
  'Press shift+tab to cycle the permission mode',
  'Use /compact to free up context',
  'Use /permissions to review Allow, Ask and Deny rules',
  'Type @ to mention a file',
  'Press ctrl+o to show every tool call',
  'Press ctrl+t to show or hide the todo list',
  'Use /memory to review what Cosmew remembers',
  'Use /agents to see subagents and custom agents',
  'Name sessions with /rename to find them in /resume',
];
/** Elapsed seconds before the spinner adds its `(7s · ↓ 279 tokens)` detail; Needs verification against Claude Code. */
export const SPINNER_DETAIL_AFTER_SECONDS = 2;
function hash(seed: string | number | undefined): number {
  const text = String(seed ?? 0);
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}
/** The same seed gives the same verb pair, so the spinner and the finished line agree. */
export function turnVerb(seed?: string | number): {present: string; past: string} {
  const [present, past] = TURN_VERBS[hash(seed) % TURN_VERBS.length]!;
  return {present, past};
}
export function spinnerTip(seed?: string | number): string {
  return SPINNER_TIPS[hash(seed) % SPINNER_TIPS.length]!;
}
export function spinnerTokens(tokens?: number): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return '';
  const count = Math.max(0, Math.floor(tokens));
  return ` · ↓ ${count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count} tokens`;
}
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
export interface SpinnerProps {
  /** Overrides the seeded verb (for example the active plan step). */
  verb?: string;
  /** Picks the verb and tip; defaults to `startedAt`. */
  seed?: string | number;
  startedAt?: number;
  elapsedMs?: number;
  /** Real output tokens from the SDK; omitted when unknown. */
  tokens?: number;
  /** Reasoning effort label; shown as `thinking with <effort> effort` only while `thinking` is true. */
  effort?: string;
  thinking?: boolean;
  /** Renders the `  ⎿  Tip: …` line under the spinner. */
  tip?: string;
  width?: number;
  animate?: boolean;
}
export function Spinner({
  verb,
  seed,
  startedAt,
  elapsedMs,
  tokens,
  effort,
  thinking = false,
  tip,
  width,
  animate = true,
}: SpinnerProps) {
  const theme = useTheme();
  const ui = useUiTheme();
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
  const label = `${safeText(verb ?? turnVerb(seed ?? startedAt ?? start).present)}…`;
  const details =
    Math.floor(elapsed / 1000) >= SPINNER_DETAIL_AFTER_SECONDS
      ? [
          formatElapsed(elapsed) + spinnerTokens(tokens),
          ...(thinking && effort ? [`thinking with ${safeText(effort)} effort`] : []),
        ].join(' · ')
      : '';
  return (
    <Box flexDirection="column" width={width} minWidth={0}>
      <Text>
        <Text color={ui.color('rule')}>
          {moving ? SPINNER_FRAMES[Math.floor(elapsed / 100) % SPINNER_FRAMES.length] : '✻'} {label}
        </Text>
        {details ? <Text color={ui.color('dim')}>{` (${details})`}</Text> : null}
      </Text>
      {tip ? (
        <ResultLine width={width}>
          <Text color={ui.color('dim')}>{`Tip: ${safeText(tip)}`}</Text>
        </ResultLine>
      ) : null}
    </Box>
  );
}
