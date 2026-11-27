/** Terminal mouse reports are transport input, never composer text or keybindings. */
export interface TerminalWheel {
  direction: -1 | 1;
  column: number;
  row: number;
}

export interface TerminalClick {
  kind: 'click';
  column: number;
  row: number;
}

export interface TerminalSelectionEvent {
  phase: 'start' | 'move' | 'end';
  column: number;
  row: number;
}
export type TerminalMouseEvent = TerminalWheel | TerminalClick;

export const ENABLE_TERMINAL_MOUSE = '\x1b[?1000h\x1b[?1006h\x1b[?1002h';
export const DISABLE_TERMINAL_MOUSE = '\x1b[?1002l\x1b[?1006l\x1b[?1000l';

/** Bounded incremental decoder; pasted text and terminal strings cannot generate wheel events. */
export class MouseInputFilter {
  private pending = '';
  private paste = false;
  private string = false;
  private stringEscape = false;
  private leftPressed = false;
  private dragging = false;

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
  get awaitingReport(): boolean {
    return this.paste || this.pending.startsWith('\x1b[<') || this.pending.startsWith('\x1b[M');
  }
  get isSelecting(): boolean {
    return this.leftPressed || this.dragging;
  }
  flush(): string {
    const text = this.pending;
    this.pending = '';
    return text;
  }
  resetSelection(): boolean {
    const wasSelecting = this.leftPressed || this.dragging;
    this.leftPressed = false;
    this.dragging = false;
    return wasSelecting;
  }
  reset(): void {
    this.pending = '';
    this.paste = this.string = this.stringEscape = this.leftPressed = this.dragging = false;
  }
  feed(
    chunk: string,
    onWheel: (event: TerminalWheel) => void,
    onClick?: (event: TerminalClick) => void,
    onSelection?: (event: TerminalSelectionEvent) => void,
    onSelectionReset?: () => void,
  ): string {
    const text = this.pending + chunk;
    this.pending = '';
    let output = '';
    const cancelStaleSelection = () => {
      if (!this.leftPressed && !this.dragging) return;
      this.leftPressed = false;
      this.dragging = false;
      onSelectionReset?.();
    };
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
        cancelStaleSelection();
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
        cancelStaleSelection();
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
        const button = text.charCodeAt(at + 3) - 32;
        const column = text.charCodeAt(at + 4) - 32;
        const row = text.charCodeAt(at + 5) - 32;
        if (column > 0 && row > 0) {
          if (button === 3) {
            if (this.leftPressed) {
              this.leftPressed = false;
              this.dragging = false;
              onSelection?.({phase: 'end', column, row});
            }
          } else {
            this.handlePressOrMotion(button, column, row, onWheel, onClick, onSelection, onSelectionReset);
          }
        }
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
        const button = Number(mouse[1]),
          column = Number(mouse[2]),
          row = Number(mouse[3]);
        if (column > 0 && row > 0) {
          if (mouse[4] === 'M') {
            this.handlePressOrMotion(button, column, row, onWheel, onClick, onSelection, onSelectionReset);
          } else if ((button & 3) === 0 && this.leftPressed) {
            this.leftPressed = false;
            this.dragging = false;
            onSelection?.({phase: 'end', column, row});
          }
        }
      } else {
        cancelStaleSelection();
        output += sequence;
        if (sequence === '\x1b[200~') this.paste = true;
      }
      at = end + 1;
    }
    return output;
  }
  private handlePressOrMotion(
    button: number,
    column: number,
    row: number,
    onWheel: (event: TerminalWheel) => void,
    onClick?: (event: TerminalClick) => void,
    onSelection?: (event: TerminalSelectionEvent) => void,
    onSelectionReset?: () => void,
  ): void {
    const wheelCode = button & ~28;
    if (wheelCode === 64 || wheelCode === 65) {
      if (!this.dragging) {
        if (this.leftPressed) {
          this.leftPressed = false;
          onSelectionReset?.();
        }
        this.wheel(button, column, row, onWheel);
      }
      return;
    }
    // Only plain left-button presses activate controls; never motion or selection modifiers.
    if (button === 0) {
      onClick?.({kind: 'click', column, row});
      this.leftPressed = true;
      this.dragging = false;
      onSelection?.({phase: 'start', column, row});
    } else if (button === 32) {
      this.leftPressed = true;
      this.dragging = true;
      onSelection?.({phase: 'move', column, row});
    }
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
  subscribeMouse?(listener: (event: TerminalMouseEvent) => void): () => void;
  subscribeSelection?(listener: (event: TerminalSelectionEvent) => void): () => void;
  subscribeSelectionReset?(listener: () => void): () => void;
  subscribeCopied?(listener: (text: string) => void): () => void;
  notifyCopied?(text: string): void;
  /** Release mouse reporting for native terminal text selection, without leaving raw input. */
  setCaptureEnabled?(enabled: boolean): void;
  dispose(): void;
}

/**
 * A facade over public stream methods. Ink remains the only stdin reader; the source is never patched or put in
 * flowing mode. Raw-mode ownership also brackets mouse reporting across suspendTerminal/editor/exit.
 */
export function createTerminalMouseInput(source: MouseStdin, stdout: NodeJS.WritableStream): TerminalMouseInput {
  const filter = new MouseInputFilter();
  const listeners = new Set<(event: TerminalWheel) => void>();
  const mouseListeners = new Set<(event: TerminalMouseEvent) => void>();
  const selectionListeners = new Set<(event: TerminalSelectionEvent) => void>();
  const selectionResetListeners = new Set<() => void>();
  const copiedListeners = new Set<(text: string) => void>();
  const notifySelectionReset = () => {
    for (const listener of selectionResetListeners) listener();
  };
  let active = false;
  let disposed = false;
  let captureEnabled = true;
  let reporting = false;
  const syncReporting = () => {
    const enabled = active && captureEnabled && !disposed;
    if (enabled === reporting) return;
    stdout.write(enabled ? ENABLE_TERMINAL_MOUSE : DISABLE_TERMINAL_MOUSE);
    reporting = enabled;
  };
  let ready = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    ready = '';
    filter.reset();
  };
  const emit = (event: TerminalWheel) => {
    if (!captureEnabled || disposed) return;
    for (const listener of listeners) listener(event);
    for (const listener of mouseListeners) listener(event);
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
      const text = filter.feed(
        String(chunk),
        emit,
        event => {
          if (!captureEnabled || disposed) return;
          for (const listener of mouseListeners) listener(event);
        },
        event => {
          if (!captureEnabled || disposed) return;
          for (const listener of selectionListeners) listener(event);
        },
        () => {
          if (disposed) return;
          notifySelectionReset();
        },
      );
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
          const wasSelecting = !mode && !disposed && filter.isSelecting;
          if (!disposed) {
            active = mode;
            syncReporting();
          }
          if (!mode) {
            clear();
            if (wasSelecting) notifySelectionReset();
          }
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
    subscribeMouse(listener) {
      mouseListeners.add(listener);
      return () => {
        mouseListeners.delete(listener);
      };
    },
    subscribeSelection(listener) {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    subscribeSelectionReset(listener) {
      selectionResetListeners.add(listener);
      return () => {
        selectionResetListeners.delete(listener);
      };
    },
    subscribeCopied(listener) {
      copiedListeners.add(listener);
      return () => {
        copiedListeners.delete(listener);
      };
    },
    notifyCopied(text) {
      if (disposed || !text) return;
      for (const listener of copiedListeners) listener(text);
    },
    setCaptureEnabled(enabled) {
      if (disposed || captureEnabled === enabled) return;
      captureEnabled = enabled;
      const wasSelecting = filter.resetSelection();
      if (!enabled && wasSelecting) notifySelectionReset();
      syncReporting();
    },
    dispose() {
      if (disposed) return;
      const wasSelecting = filter.isSelecting;
      disposed = true;
      syncReporting();
      active = false;
      clear();
      if (wasSelecting) notifySelectionReset();
      listeners.clear();
      mouseListeners.clear();
      selectionListeners.clear();
      selectionResetListeners.clear();
      copiedListeners.clear();
    },
  };
}
