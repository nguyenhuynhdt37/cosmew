/** Raw terminal byte decoding; pure and independent of app state. */
export function parseRawTerminalKey(chunk: Uint8Array | string): string[] {
  const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const keys: string[] = [];
  let i = 0;

  while (i < str.length) {
    if (str.startsWith('\x1b[200~', i) || str.startsWith('\x1b[201~', i)) { i += 6; continue; }
    if (str.startsWith('\x1b\r', i)) { keys.push('Alt+Enter'); i += 2; continue; }
    if (str.startsWith('\x1b[<', i)) {
      const endM = str.indexOf('M', i + 3);
      const endLowerM = str.indexOf('m', i + 3);
      let termIdx = -1;
      if (endM !== -1 && endLowerM !== -1) {
        termIdx = Math.min(endM, endLowerM);
      } else if (endM !== -1) {
        termIdx = endM;
      } else {
        termIdx = endLowerM;
      }

      if (termIdx !== -1) {
        const match = /^(\d{1,5});(\d{1,5});(\d{1,5})$/.exec(str.slice(i + 3, termIdx));
        if (match) {
          const button = Number(match[1]); const col = Number(match[2]) - 1; const row = Number(match[3]) - 1;
          const released = str[termIdx] === 'm';
          if (col >= 0 && row >= 0) {
            if (button === 64 && !released) keys.push('WheelUp');
            else if (button === 65 && !released) keys.push('WheelDown');
            else if (released && (button === 0 || button === 3 || button === 35)) keys.push(`MouseUp:${row}:${col}`);
            else if (button === 0) keys.push(`MouseDown:${row}:${col}`);
            else if (button === 32) keys.push(`MouseDrag:${row}:${col}`);
          }
        }
        i = termIdx + 1;
        continue;
      }
      break; // Incomplete mouse input must never become a composer draft.
    }
    if (str.startsWith('\x1b[I', i)) {
      keys.push('FocusIn');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[O', i)) {
      keys.push('FocusOut');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[A', i)) {
      keys.push('ArrowUp');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[B', i)) {
      keys.push('ArrowDown');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[C', i)) {
      keys.push('ArrowRight');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[D', i)) {
      keys.push('ArrowLeft');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[Z', i)) {
      keys.push('Shift+Tab');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[3~', i)) {
      keys.push('Delete');
      i += 4;
      continue;
    }
    if (str.startsWith('\x1b[5~', i)) {
      keys.push('PageUp');
      i += 4;
      continue;
    }
    if (str.startsWith('\x1b[6~', i)) {
      keys.push('PageDown');
      i += 4;
      continue;
    }
    const ch = str[i]!;
    const code = ch.charCodeAt(0);
    if (ch === '\x1b') {
      keys.push('Escape');
      i++;
    } else if (ch === '\r') {
      keys.push('Enter');
      i++;
    } else if (ch === '\n') {
      keys.push('Ctrl+J');
      i++;
    } else if (ch === '\t') {
      keys.push('Tab');
      i++;
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push('Backspace');
      i++;
    } else if (code === 3) {
      keys.push('Ctrl+C');
      i++;
    } else if (code === 2) {
      keys.push('Ctrl+B');
      i++;
    } else if (code === 4) {
      keys.push('Ctrl+D');
      i++;
    } else if (code === 5) {
      keys.push('Ctrl+E');
      i++;
    } else if (code === 7) {
      keys.push('Ctrl+G');
      i++;
    } else if (code === 13) {
      keys.push('Enter');
      i++;
    } else if (code === 12) {
      keys.push('Ctrl+L');
      i++;
    } else if (code === 14) {
      keys.push('Ctrl+N');
      i++;
    } else if (code === 16) {
      keys.push('Ctrl+P');
      i++;
    } else if (code === 18) {
      keys.push('Ctrl+R');
      i++;
    } else if (code === 19) {
      keys.push('Ctrl+S');
      i++;
    } else if (code === 20) {
      keys.push('Ctrl+T');
      i++;
    } else if (code === 21) {
      keys.push('Ctrl+U');
      i++;
    } else if (code === 23) {
      keys.push('Ctrl+W');
      i++;
    } else if (code === 24) {
      keys.push('Ctrl+X');
      i++;
    } else if (code === 25) {
      keys.push('Ctrl+Y');
      i++;
    } else if (code === 26) {
      keys.push('Ctrl+Z');
      i++;
    } else if (code === 1) {
      keys.push('Ctrl+A');
      i++;
    } else if (code >= 32) {
      keys.push(ch);
      i++;
    } else {
      i++;
    }
  }
  return keys;
}

/** Preserve split CSI/mouse sequences and UTF-8 characters across PTY chunks. */
export class TerminalInputDecoder {
  private pending = '';
  private readonly decoder = new TextDecoder();
  private discardCSI = false;
  get waiting(): boolean { return !!this.pending; }
  feed(chunk: Uint8Array | string): string[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, {stream:true});
    if (this.discardCSI) {
      const final = text.search(/[@-~]/); if (final < 0) return [];
      text = text.slice(final + 1); this.discardCSI = false;
    }
    this.pending += text;
    const at = this.pending.lastIndexOf('\x1b');
    const tail = at >= 0 ? this.pending.slice(at) : '';
    if (tail === '\x1b' || /^\x1b\[[0-?]*$/.test(tail)) {
      const ready = this.pending.slice(0, at); this.pending = tail.length <= 128 ? tail : ''; if (tail.length > 128) this.discardCSI = true;
      return parseRawTerminalKey(ready);
    }
    const ready = this.pending; this.pending = ''; return parseRawTerminalKey(ready);
  }
  flush(): string[] { const escape = this.pending === '\x1b'; if (this.pending.startsWith('\x1b[')) this.discardCSI = true; this.pending = ''; return escape ? ['Escape'] : []; }
}
