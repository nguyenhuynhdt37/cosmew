/** Terminal mouse reports are transport input, never composer text or keybindings. */
export interface TerminalWheel {
  direction: -1 | 1;
  column: number;
  row: number;
}

export const ENABLE_TERMINAL_MOUSE = '\x1b[?1000h\x1b[?1006h';
export const DISABLE_TERMINAL_MOUSE = '\x1b[?1006l\x1b[?1000l';

/** Bounded incremental decoder; pasted text and terminal strings cannot generate wheel events. */
export class MouseInputFilter {
  private pending = '';
  private paste = false;
  private string = false;
  private stringEscape = false;

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
  get awaitingReport(): boolean {
    return this.paste || this.pending.startsWith('\x1b[<') || this.pending.startsWith('\x1b[M');
  }
  flush(): string {
    const text = this.pending;
    this.pending = '';
    return text;
  }
  reset(): void {
    this.pending = '';
    this.paste = this.string = this.stringEscape = false;
  }
  feed(chunk: string, onWheel: (event: TerminalWheel) => void): string {
    const text = this.pending + chunk;
    this.pending = '';
    let output = '';
    for (let at = 0; at < text.length;) {
      const char = text[at]!;
      if (this.paste) {
        const end = '\x1b[201~';
        if (text.startsWith(end, at)) {
          this.paste = false;
          output += end;
          at += end.length;
        } else if (char === '\x1b' && end.startsWith(text.slice(at))) {
          this.pending = text.slice(at);
          break;
        } else output += text[at++]!;
        continue;
      }
      if (this.string) {
        output += char;
        at++;
        if (char === '\x07' || (this.stringEscape && char === '\\')) this.string = false;
        this.stringEscape = char === '\x1b';
        continue;
      }
      if (char !== '\x1b') {
        output += char;
        at++;
        continue;
      }
      if (at + 1 === text.length) {
        this.pending = text.slice(at);
        break;
      }
      const next = text[at + 1]!;
      if (next === ']' || next === 'P' || next === '_' || next === '^') {
        this.string = true;
        this.stringEscape = false;
        output += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (next !== '[') {
        output += char;
        at++;
        continue;
      }
      // Legacy X10 reports may be sent by terminals which ignore SGR mode.
      if (text.startsWith('\x1b[M', at)) {
        if (text.length - at < 6) {
          this.pending = text.slice(at);
          break;
        }
        this.wheel(text.charCodeAt(at + 3) - 32, text.charCodeAt(at + 4) - 32, text.charCodeAt(at + 5) - 32, onWheel);
        at += 6;
        continue;
      }
      let end = at + 2;
      while (end < text.length && end - at < 64 && !/[@-~]/.test(text[end]!)) end++;
      if (end === text.length && end - at < 64) {
        this.pending = text.slice(at);
        break;
      }
      const sequence = text.slice(at, end + 1);
      const mouse = /^\x1b\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])$/.exec(sequence);
      if (mouse) {
        if (mouse[4] === 'M') this.wheel(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), onWheel);
      } else {
        output += sequence;
        if (sequence === '\x1b[200~') this.paste = true;
      }
      at = end + 1;
    }
    return output;
  }
  private wheel(button: number, column: number, row: number, emit: (event: TerminalWheel) => void): void {
    const code = button & ~28; // Shift, Alt and Ctrl do not change the wheel's direction.
    if (column > 0 && row > 0 && (code === 64 || code === 65)) emit({direction: code === 64 ? -1 : 1, column, row});
  }
}

type MouseStdin = NodeJS.ReadableStream & {isTTY?: boolean; setRawMode?: (mode: boolean) => unknown};
export interface TerminalMouseInput {
  stdin: MouseStdin;
  subscribe(listener: (event: TerminalWheel) => void): () => void;
  dispose(): void;
}

/**
 * A facade over public stream methods. Ink remains the only stdin reader; the source is never patched or put in
 * flowing mode. Raw-mode ownership also brackets mouse reporting across suspendTerminal/editor/exit.
 */
export function createTerminalMouseInput(source: MouseStdin, stdout: NodeJS.WritableStream): TerminalMouseInput {
  const filter = new MouseInputFilter();
  const listeners = new Set<(event: TerminalWheel) => void>();
  let active = false;
  let disposed = false;
  let ready = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    ready = '';
    filter.reset();
  };
  const emit = (event: TerminalWheel) => {
    for (const listener of listeners) listener(event);
  };
  const read = () => {
    if (ready) {
      const text = ready;
      ready = '';
      return text;
    }
    let chunk: string | Buffer | null;
    while ((chunk = source.read()) !== null) {
      if (!active) return chunk;
      clearTimeout(timer);
      const text = filter.feed(String(chunk), emit);
      if (filter.hasPending && !filter.awaitingReport) {
        // Keep standalone Escape responsive while allowing split CSI/mouse reports to join.
        timer = setTimeout(() => {
          ready += filter.flush();
          if (ready) source.emit('readable');
        }, 10);
        timer.unref?.();
      }
      if (text) return text;
    }
    return null;
  };
  const stdin = new Proxy(source, {
    get(target, property) {
      if (property === 'read') return read;
      if (property === 'setRawMode' && source.setRawMode)
        return (mode: boolean) => {
          source.setRawMode!(mode);
          if (!disposed && active !== mode) {
            active = mode;
            stdout.write(mode ? ENABLE_TERMINAL_MOUSE : DISABLE_TERMINAL_MOUSE);
          }
          if (!mode) clear();
          return stdin;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    stdin,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      if (active) stdout.write(DISABLE_TERMINAL_MOUSE);
      active = false;
      clear();
      listeners.clear();
    },
  };
}
