import type {ThemeTokens} from '@futryn/contracts';
import type {RenderedBoxLine} from '../../ui';
import {FYN_LABELS, type FynState} from './types';

export function renderFyn(options: {
  state: FynState;
  time: number;
  tokens: ThemeTokens;
  width: number;
  compact?: boolean;
  /** 1 is the original mascot. 2 is half size. 5 is the small mark above the composer. */
  scale?: 1 | 2 | 5;
}): RenderedBoxLine[] {
  const {state, time, tokens, width, compact} = options;
  if (width < 20) return [];
  const bg = tokens.background;
  const label = `Fyn · ${FYN_LABELS[state]}`;
  const ink = state === 'error' ? tokens.error : state === 'waiting' ? tokens.warning : tokens.accent;
  const eyes = state === 'sleep' || state === 'done' || time % 4.6 > 4.35 ? '-' : 'o';
  const textLine = (text: string, fg = ink): RenderedBoxLine => ({
    spans: [{text: text.slice(0, width), fg, bg}],
  });
  if (compact || width < 28) {
    const face = state === 'error' ? '(x.x)' : `(${eyes}.${eyes})`;
    const cue =
      state === 'waiting'
        ? '?'
        : state === 'error'
          ? '!'
          : state === 'sleep'
            ? 'z'
            : state === 'cancelled'
              ? 'v'
              : state === 'done' && time < 1.2
                ? '+'
                : state === 'thinking'
                  ? '.'.repeat(1 + (Math.floor(time * 3) % 3))
                  : '>';
    const wag = Math.floor(time * 2) % 2 === 1;
    const tail = state === 'streaming' && Math.floor(time * 6) % 2 ? '___>>' : wag ? '___>' : '__>';
    return [textLine(` /\\_/\\  ${cue}`), textLine(` ${face}${state === 'waiting' ? '/ ?' : tail}`), textLine(label)];
  }

  if (options.scale === 5) {
    // Draw at the destination resolution. Downsampling the full-size face
    // erased its eyes/ears and clipped feet during bobbing. Every pose now
    // has a fixed 14×10 canvas, including room for both tail positions.
    const pose = [
      '  #     #     ',
      '  ##   ##     ',
      ' #########    ',
      ' ##.###.##    ',
      ' ###+++###  # ',
      '  ##+.+##  ## ',
      '   #####  ##  ',
      '   #+++# ##   ',
      '   ##### #    ',
      '   ## ##      ',
    ].map(row => row.split(''));
    const sleeping = state === 'sleep';
    if (eyes === '-' || sleeping) {
      pose[3]![3] = '#';
      pose[3]![7] = '#';
      pose[4]![3] = '.';
      pose[4]![7] = '.';
    }
    if (state === 'thinking' || state === 'streaming') {
      const wag = Math.floor(time * (state === 'streaming' ? 6 : 3)) % 2;
      pose[4]![12] = wag ? ' ' : '#';
      pose[5]![13] = wag ? '#' : ' ';
    }
    if (state === 'streaming' && Math.floor(time * 5) % 2) {
      pose[9]![6] = ' ';
      pose[8]![6] = '+';
    }
    const cue =
      state === 'error'
        ? '!'
        : state === 'waiting'
          ? '?'
          : sleeping
            ? 'z'
            : state === 'done'
              ? '+'
              : state === 'thinking'
                ? ['.', ':', '.'][Math.floor(time * 3) % 3]!
                : Math.floor(time * 2) % 2
                  ? '.'
                  : ' ';
    const color = (pixel: string | undefined) => (pixel === '#' ? ink : pixel === '+' ? tokens.foreground : bg);
    const lines: RenderedBoxLine[] = [];
    for (let y = 0; y < pose.length; y += 2) {
      lines.push({
        spans: pose[y]!.map((_, x) => {
          const top = color(pose[y]![x]);
          const bottom = color(pose[y + 1]?.[x]);
          return top === bg ? {text: bottom === bg ? ' ' : '▄', fg: bottom, bg} : {text: '▀', fg: top, bg: bottom};
        }),
      });
    }
    lines[0]!.spans.push({text: ` ${cue}`, fg: ink, bg});
    lines.push(textLine(label));
    return lines;
  }

  const pixels: (string | null)[][] = Array.from({length: 24}, () => Array(28).fill(null));
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const row = pixels[y + dy];
        if (row && x + dx >= 0 && x + dx < 28) row[x + dx] = color;
      }
  };
  const bob =
    state === 'done'
      ? -Math.round(Math.sin(Math.min(time / 0.8, 1) * Math.PI) * 2)
      : state === 'cancelled'
        ? 0
        : Math.round(Math.sin(time * 2) * 0.55);
  const tail =
    state === 'cancelled' || state === 'error'
      ? 1
      : Math.round(Math.sin(time * (state === 'thinking' ? 7 : state === 'streaming' ? 5 : 2)));
  const fur = ink;
  const cream = tokens.foreground;
  // Chevron tail.
  rect(22, 11 + tail, 2, 3, fur);
  rect(24, 13 + tail, 2, 3, fur);
  rect(26, 15 + tail, 2, 3, cream);
  rect(24, 17 + tail, 2, 3, fur);
  rect(21, 19 + tail, 4, 2, fur);
  rect(9, 13 + bob, 13, 9, fur);
  rect(12, 16 + bob, 6, 5, cream);
  if (state === 'sleep') {
    rect(3, 14, 17, 8, fur);
    rect(5, 17, 3, 1, bg);
    rect(13, 17, 3, 1, bg);
    rect(20, 5, 4, 1, cream);
    rect(22, 6, 1, 1, cream);
    rect(20, 7, 4, 1, cream);
  } else {
    if (state === 'error') {
      rect(2, 7, 6, 3, fur);
      rect(18, 7, 6, 3, fur);
    } else {
      rect(4, 2 + bob, 3, 8, fur);
      rect(7, 5 + bob, 3, 5, fur);
      rect(18, 2 + bob, 3, 8, fur);
      rect(15, 5 + bob, 3, 5, fur);
      rect(5, 5 + bob, 1, 3, cream);
      rect(19, 5 + bob, 1, 3, cream);
    }
    const tilt = state === 'thinking' ? Math.round(Math.sin(time * 3)) : 0;
    rect(4 + tilt, 8 + bob, 17, 8, fur);
    rect(2 + tilt, 10 + bob, 21, 4, fur);
    rect(6 + tilt, 14 + bob, 13, 3, cream);
    rect(7 + tilt, 10 + bob, 2, eyes === '-' ? 1 : 2, bg);
    rect(16 + tilt, 10 + bob, 2, eyes === '-' ? 1 : 2, bg);
    rect(12 + tilt, 14 + bob, 1, 1, bg);
    const tap = state === 'streaming' ? Math.floor(time * 6) % 2 : 0;
    rect(9, 21 + bob - tap, 3, 2, fur);
    rect(19, 21 + bob + tap, 3, 2, fur);
    if (state === 'waiting') {
      rect(3, 17, 3, 4, fur);
      rect(1, 15, 3, 3, fur);
    }
    if (state === 'error') {
      rect(25, 3, 1, 4, cream);
      rect(25, 8, 1, 1, cream);
    }
    if (state === 'thinking') rect(11 + (Math.floor(time * 3) % 3) * 3, 0, 2, 1, cream);
    if (state === 'done' && time < 1.2) {
      rect(24, 2, 1, 5, cream);
      rect(22, 4, 5, 1, cream);
    }
  }
  const step = options.scale === 2 ? 2 : 1;
  const outW = Math.floor(28 / step);
  const outH = Math.floor(24 / step);
  const cell = (py: number, px: number): string | null => {
    if (step === 1) return pixels[py]?.[px] ?? null;
    const x0 = px * step;
    const y0 = py * step;
    const x1 = x0 + step;
    const y1 = y0 + step;
    let marks = 0;
    let holes = 0;
    let mark: string | null = null;
    for (let y = y0; y < y1 && y < 24; y++) {
      for (let x = x0; x < x1 && x < 28; x++) {
        const color = pixels[y]?.[x];
        if (color == null) continue;
        if (color === bg) holes += 1;
        else {
          marks += 1;
          mark = color;
        }
      }
    }
    if (marks === 0 && holes === 0) return null;
    if (holes > marks) return bg;
    return mark;
  };
  const breathe = step > 1 && Math.round(Math.sin(time * 2) * 0.55) !== 0;
  const lines: RenderedBoxLine[] = [];
  for (let y = 0; y < outH; y += 2) {
    const spans = [];
    for (let x = 0; x < outW; x++) {
      const top = cell(y, x);
      const bottom = cell(y + 1, x);
      spans.push({text: top ? '▀' : bottom ? '▄' : ' ', fg: top ?? bottom ?? bg, bg: top ? (bottom ?? bg) : bg});
    }
    lines.push({spans});
  }
  // A leading space disappears once the mark is centered. Wag a real block instead.
  if (breathe && lines.length > 0) {
    lines[lines.length - 1]!.spans.push({text: '▄', fg: ink, bg});
  }
  lines.push(textLine(label));
  return lines;
}
