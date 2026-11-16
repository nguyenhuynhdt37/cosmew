/** Raw terminal byte decoding; pure and independent of app state. */
export function parseRawTerminalKey(chunk: Uint8Array | string): string[] {
  const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const keys: string[] = [];
  let i = 0;

  while (i < str.length) {
    if (str.startsWith('\x1b[200~', i)) {
      const end = str.indexOf('\x1b[201~', i + 6);
      if (end < 0) break;
      keys.push(`Paste:${sanitizePaste(str.slice(i + 6, end))}`);
      i = end + 6;
      continue;
    }
    const special = /^(?:\x1b\[(?:H|1~)|\x1bOH)/.exec(str.slice(i));
    const endKey = /^(?:\x1b\[(?:F|4~)|\x1bOF)/.exec(str.slice(i));
    const newline = /^(?:\x1b\[13;2u|\x1b\[27;2;13~)/.exec(str.slice(i));
    if (special || endKey || newline) {
      keys.push(special ? 'Home' : endKey ? 'End' : 'Shift+Enter');
      i += (special ?? endKey ?? newline)![0].length;
      continue;
    }
    if (str.startsWith('\x1b[200~', i) || str.startsWith('\x1b[201~', i)) {
      i += 6;
      continue;
    }
    if (str.startsWith('\x1b\r', i)) {
      keys.push('Alt+Enter');
      i += 2;
      continue;
    }
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
          const button = Number(match[1]);
          const col = Number(match[2]) - 1;
          const row = Number(match[3]) - 1;
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
    const ch = String.fromCodePoint(str.codePointAt(i)!);
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
      i += ch.length;
    } else {
      i++;
    }
  }
  return keys;
}

/** Strip terminal controls from pasted data, keeping only literal newlines and spaces. */
export function sanitizePaste(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
export const MAX_PASTE_LENGTH = 1_048_576;

/** Preserve split sequences/UTF-8 and keep bracketed paste out of the shortcut parser. */
export class TerminalInputDecoder {
  private pending = '';
  private paste: string | null = null;
  private readonly decoder = new TextDecoder();
  private discardCSI = false;
  get waiting(): boolean {
    return this.paste === null && !!this.pending;
  }
  feed(chunk: Uint8Array | string): string[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, {stream: true});
    if (this.discardCSI) {
      const final = text.search(/[@-~]/);
      if (final < 0) return [];
      text = text.slice(final + 1);
      this.discardCSI = false;
    }
    this.pending += text;
    const keys: string[] = [];
    while (this.pending) {
      if (this.paste !== null) {
        const end = this.pending.indexOf(PASTE_END);
        if (end >= 0) {
          this.paste += this.pending.slice(0, end).slice(0, Math.max(0, MAX_PASTE_LENGTH - this.paste.length));
          keys.push(`Paste:${sanitizePaste(this.paste)}`);
          this.paste = null;
          this.pending = this.pending.slice(end + PASTE_END.length);
          continue;
        }
        // Keep a possible split closing marker, while bounding the retained payload.
        let suffix = Math.min(PASTE_END.length - 1, this.pending.length);
        while (suffix && !PASTE_END.startsWith(this.pending.slice(-suffix))) suffix--;
        const consumed = this.pending.length - suffix;
        this.paste += this.pending.slice(0, consumed).slice(0, Math.max(0, MAX_PASTE_LENGTH - this.paste.length));
        this.pending = this.pending.slice(consumed);
        break;
      }
      const begin = this.pending.indexOf(PASTE_START);
      if (begin >= 0) {
        keys.push(...parseRawTerminalKey(this.pending.slice(0, begin)));
        this.pending = this.pending.slice(begin + PASTE_START.length);
        this.paste = '';
        continue;
      }
      const at = this.pending.lastIndexOf('\x1b');
      const tail = at >= 0 ? this.pending.slice(at) : '';
      if (tail === '\x1b' || /^\x1b\[[0-?]*$/.test(tail)) {
        keys.push(...parseRawTerminalKey(this.pending.slice(0, at)));
        this.pending = tail.length <= 128 ? tail : '';
        if (tail.length > 128) this.discardCSI = true;
        break;
      }
      keys.push(...parseRawTerminalKey(this.pending));
      this.pending = '';
    }
    return keys;
  }
  flush(): string[] {
    // A timer is only for standalone Esc/CSI, never for an unfinished paste.
    if (this.paste !== null) return [];
    // A delayed paste marker must not expire and expose its payload as shortcuts.
    if (this.pending.length > 1 && PASTE_START.startsWith(this.pending)) return [];
    const escape = this.pending === '\x1b';
    if (this.pending.startsWith('\x1b[')) this.discardCSI = true;
    this.pending = '';
    return escape ? ['Escape'] : [];
  }
}
