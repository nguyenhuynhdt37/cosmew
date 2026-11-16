import type {ThemeManifest, ThemeTokens} from '@futryn/contracts';
import type {FutrynClient, ReactiveAgentEvent} from '@futryn/sdk';
import {FYN_LABELS, type FynState} from '../companion/types';
import type {StyledSpan} from '../../ui';

export function renderTopHeaderBar(options: {
  width: number;
  status: ReturnType<FutrynClient['status']>;
  manifest: ThemeManifest;
  reactiveEvent: ReactiveAgentEvent;
  reactiveEffectsEnabled: boolean;
  isPreviewing: boolean;
  tokens: ThemeTokens;
  companionState?: FynState;
}): StyledSpan[] {
  const {width, status, reactiveEvent, reactiveEffectsEnabled, isPreviewing, tokens, companionState} = options;
  const bg = tokens.backgroundPanel;

  const stateKey: FynState =
    companionState ??
    (reactiveEffectsEnabled && reactiveEvent.kind !== 'idle'
      ? reactiveEvent.kind === 'thinking'
        ? 'thinking'
        : reactiveEvent.kind === 'streaming'
          ? 'streaming'
          : reactiveEvent.kind === 'error'
            ? 'error'
            : reactiveEvent.kind === 'permission'
              ? 'waiting'
              : reactiveEvent.kind === 'done'
                ? 'done'
                : 'idle'
      : 'idle');

  const label = FYN_LABELS[stateKey] ?? 'ready';
  let stateColor = tokens.success;
  switch (stateKey) {
    case 'thinking':
    case 'waiting':
      stateColor = tokens.warning;
      break;
    case 'streaming':
      stateColor = tokens.accent;
      break;
    case 'error':
      stateColor = tokens.error;
      break;
    case 'cancelled':
    case 'sleep':
      stateColor = tokens.foregroundSubtle;
      break;
    default:
      stateColor = tokens.success;
      break;
  }

  const leftParts: StyledSpan[] = [
    {text: ' FUTRYN', fg: tokens.accent, bg, bold: true},
    {text: '   ', fg: tokens.foregroundSubtle, bg},
    {text: '● ', fg: stateColor, bg},
    {text: label, fg: stateColor, bg},
  ];
  const leftLen = leftParts.reduce((sum, span) => sum + span.text.length, 0);
  const bits = [isPreviewing ? 'preview' : '', status.selection?.modelId ?? ''].filter(Boolean);
  const room = Math.max(0, width - leftLen);
  const metadata = bits.join(' · ');
  const clipped = metadata.length > Math.max(0, room - 2) && room > 3 ? metadata.slice(0, room - 3) + '…' : metadata;
  const rightText = room > 0 ? ` ${clipped} `.slice(0, room) : '';
  const padLen = Math.max(0, room - rightText.length);

  return [
    ...leftParts,
    {text: ' '.repeat(padLen), fg: tokens.foregroundMuted, bg},
    {text: rightText, fg: tokens.foregroundMuted, bg},
  ];
}
