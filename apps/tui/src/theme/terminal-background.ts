import {TerminalStringFilter} from '../input/terminal-input';

/** Terminal background detection for theme `auto` (ADR 0066): OSC 11, never the host OS appearance. */
export type Rgb = readonly [number, number, number];

/** Parses an OSC 11 reply (`rgb:RRRR/GGGG/BBBB`, 1-4 hex digits per channel, or `#rrggbb`) into 0-255 channels. */
export function parseOsc11(reply: string): Rgb | undefined {
  const rgb = /\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\x07|\x1b\\)/i.exec(reply);
  if (rgb) {
    const channel = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
    return [channel(rgb[1]!), channel(rgb[2]!), channel(rgb[3]!)];
  }
  const short = /\x1b\]11;#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:\x07|\x1b\\)/i.exec(reply);
  return short ? [parseInt(short[1]!, 16), parseInt(short[2]!, 16), parseInt(short[3]!, 16)] : undefined;
}
/** Perceived brightness below one half = dark terminal. */
export function isDarkBackground([r, g, b]: Rgb): boolean {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}
export interface BackgroundStreams {
  stdin: NodeJS.ReadableStream & {isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown};
  stdout: NodeJS.WritableStream & {isTTY?: boolean};
}
/**
 * Query for at most timeoutMs, then drain replies for 500 ms before Ink starts.
 * Keep paused reads and raw mode throughout the bounded drain; never wrap Ink's reader.
 */
export function queryTerminalBackground({stdin, stdout}: BackgroundStreams, timeoutMs = 150): Promise<Rgb | undefined> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return Promise.resolve(undefined);
  const wasRaw = Boolean(stdin.isRaw);
  return new Promise(resolve => {
    const filter = new TerminalStringFilter();
    let buffer = '';
    let keys = '';
    let value: Rgb | undefined;
    let draining = false;
    let done = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drain);
      stdin.removeListener('readable', onReadable);
      keys += filter.flushEscape();
      // Restore ordinary input only after detaching our listener. Bound queued startup input.
      if (keys) stdin.unshift(keys);
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch {
        /* best effort */
      }
      resolve(value);
    };
    const startDrain = () => {
      if (draining) return;
      draining = true;
      clearTimeout(timer);
      drain = setTimeout(finish, 500);
    };
    const onReadable = () => {
      let chunk: Buffer | string | null;
      while (!done && (chunk = stdin.read()) !== null) {
        const text = chunk.toString();
        keys = (keys + filter.feed(text)).slice(-4096);
        if (!draining) {
          buffer = (buffer + text).slice(-4096);
          value = parseOsc11(buffer);
          if (value) startDrain();
        }
      }
    };
    const timer = setTimeout(startDrain, Math.max(1, timeoutMs));
    try {
      stdin.setRawMode?.(true);
      // Switching through data/resume/pause can drop Bun's stdin handle.
      stdin.on('readable', onReadable);
      stdout.write('\x1b]11;?\x07');
    } catch {
      finish();
    }
  });
}
