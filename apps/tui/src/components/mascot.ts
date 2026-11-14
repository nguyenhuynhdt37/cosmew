import type { ThemeTokens } from '@hannes/contracts';
import type { RenderedBoxLine } from './editor';

// UI-only presentation state. Never dispatches commands or resolves approvals.
export type FynState = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'done' | 'error' | 'cancelled' | 'sleep';

const LABELS: Record<FynState, string> = {
  idle: 'ready', thinking: 'processing', streaming: 'replying', waiting: 'awaiting approval',
  done: 'complete', error: 'error', cancelled: 'cancelled', sleep: 'sleeping',
};

export class FynCompanion {
  private state: FynState = 'idle';
  private elapsed = 0;
  private quiet = 0;
  private motion = 0;

  transition(state: FynState): void {
    if (this.state === state) return;
    this.state = state;
    this.elapsed = 0;
    this.quiet = 0;
    this.motion = 0;
  }

  activity(): void {
    this.quiet = 0;
    if (this.state === 'sleep') this.transition('idle');
  }

  tick(delta: number, animate: boolean, speed = 1): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.elapsed += delta;
    this.quiet += delta;
    if (animate) this.motion += delta * speed;
    if ((this.state === 'done' || this.state === 'cancelled') && this.elapsed >= 1.8) {
      this.transition('idle');
    } else if (this.state === 'idle' && this.quiet >= 60) {
      this.transition('sleep');
    }
  }

  view(pendingApproval: boolean, reactive: boolean, reducedMotion: boolean): { state: FynState; time: number } {
    return {
      state: reactive ? (pendingApproval ? 'waiting' : this.state) : 'idle',
      time: reducedMotion ? 0 : this.motion,
    };
  }
}

/** Original 28×24 block art, packed two logical pixels into each terminal row. */
export function renderFyn(options: {
  state: FynState;
  time: number;
  tokens: ThemeTokens;
  width: number;
  compact?: boolean;
}): RenderedBoxLine[] {
  const { state, time, tokens, width, compact } = options;
  if (width < 20) return [];
  const bg = tokens.background;
  const label = `Fyn · ${LABELS[state]}`;
  const ink = state === 'error' ? tokens.error : state === 'waiting' ? tokens.warning : tokens.accent;
  const eyes = state === 'sleep' || state === 'done' || time % 4.6 > 4.35 ? '-' : 'o';
  const textLine = (text: string, fg = ink): RenderedBoxLine => ({
    spans: [{ text: text.slice(0, width), fg, bg }],
  });
  if (compact || width < 28) {
    const face = state === 'error' ? '(x.x)' : `(${eyes}.${eyes})`;
    const cue = state === 'waiting' ? '?' : state === 'error' ? '!' : state === 'sleep' ? 'z'
      : state === 'cancelled' ? 'v' : state === 'done' && time < 1.2 ? '+'
      : state === 'thinking' ? '.'.repeat(1 + Math.floor(time * 3) % 3) : '>';
    const tail = state === 'streaming' && Math.floor(time * 6) % 2 ? '___>>' : '___>';
    return [textLine(` /\_/\  ${cue}`), textLine(` ${face}${state === 'waiting' ? '/ ?' : tail}`), textLine(label)];
  }

  const pixels: (string | null)[][] = Array.from({ length: 24 }, () => Array(28).fill(null));
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
      const row = pixels[y + dy];
      if (row && x + dx >= 0 && x + dx < 28) row[x + dx] = color;
    }
  };
  const bob = state === 'done' ? -Math.round(Math.sin(Math.min(time / 0.8, 1) * Math.PI) * 2)
    : state === 'cancelled' ? 0 : Math.round(Math.sin(time * 2) * 0.55);
  const tail = state === 'cancelled' || state === 'error' ? 1
    : Math.round(Math.sin(time * (state === 'thinking' ? 7 : state === 'streaming' ? 5 : 2)));
  const fur = ink;
  const cream = tokens.foreground;
  // Chevron tail.
  rect(22, 11 + tail, 2, 3, fur); rect(24, 13 + tail, 2, 3, fur);
  rect(26, 15 + tail, 2, 3, cream); rect(24, 17 + tail, 2, 3, fur); rect(21, 19 + tail, 4, 2, fur);
  rect(9, 13 + bob, 13, 9, fur); rect(12, 16 + bob, 6, 5, cream);
  if (state === 'sleep') {
    rect(3, 14, 17, 8, fur); rect(5, 17, 3, 1, bg); rect(13, 17, 3, 1, bg);
    rect(20, 5, 4, 1, cream); rect(22, 6, 1, 1, cream); rect(20, 7, 4, 1, cream);
  } else {
    if (state === 'error') { rect(2, 7, 6, 3, fur); rect(18, 7, 6, 3, fur); }
    else {
      rect(4, 2 + bob, 3, 8, fur); rect(7, 5 + bob, 3, 5, fur);
      rect(18, 2 + bob, 3, 8, fur); rect(15, 5 + bob, 3, 5, fur);
      rect(5, 5 + bob, 1, 3, cream); rect(19, 5 + bob, 1, 3, cream);
    }
    const tilt = state === 'thinking' ? Math.round(Math.sin(time * 3)) : 0;
    rect(4 + tilt, 8 + bob, 17, 8, fur); rect(2 + tilt, 10 + bob, 21, 4, fur);
    rect(6 + tilt, 14 + bob, 13, 3, cream);
    rect(7 + tilt, 10 + bob, 2, eyes === '-' ? 1 : 2, bg);
    rect(16 + tilt, 10 + bob, 2, eyes === '-' ? 1 : 2, bg); rect(12 + tilt, 14 + bob, 1, 1, bg);
    const tap = state === 'streaming' ? Math.floor(time * 6) % 2 : 0;
    rect(9, 21 + bob - tap, 3, 2, fur); rect(19, 21 + bob + tap, 3, 2, fur);
    if (state === 'waiting') { rect(3, 17, 3, 4, fur); rect(1, 15, 3, 3, fur); }
    if (state === 'error') { rect(25, 3, 1, 4, cream); rect(25, 8, 1, 1, cream); }
    if (state === 'thinking') rect(11 + Math.floor(time * 3) % 3 * 3, 0, 2, 1, cream);
    if (state === 'done' && time < 1.2) { rect(24, 2, 1, 5, cream); rect(22, 4, 5, 1, cream); }
  }
  const lines: RenderedBoxLine[] = [];
  for (let y = 0; y < 24; y += 2) {
    const spans = [];
    for (let x = 0; x < 28; x++) {
      const top = pixels[y]![x], bottom = pixels[y + 1]![x];
      spans.push({ text: top ? '▀' : bottom ? '▄' : ' ', fg: top ?? bottom ?? bg, bg: top ? bottom ?? bg : bg });
    }
    lines.push({ spans });
  }
  lines.push(textLine(label));
  return lines;
}
