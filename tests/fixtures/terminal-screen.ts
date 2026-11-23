/** Bounded VT text screen for PTY assertions. Applies Ink's cursor/erase deltas, not stream substrings. */
export class TerminalScreen {
  private lines: string[][] = [];
  private row = 0;
  private column = 0;
  private pending = '';
  private decoder = new TextDecoder();
  constructor(
    private columns: number,
    private rows: number,
  ) {}

  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.lines = [];
    this.row = this.column = 0;
  }

  text() {
    return this.lines.map(line => line.join('').trimEnd()).join('\n');
  }

  write(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, {stream: true});
    let offset = 0;
    while (offset < this.pending.length) {
      const remaining = this.pending.slice(offset);
      if (remaining.startsWith('\x1b[')) {
        const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(remaining);
        if (!match) break;
        this.control(match[1]!, match[3]!);
        offset += match[0].length;
      } else if (remaining.startsWith('\x1b]')) {
        const end = /\x07|\x1b\\/.exec(remaining);
        if (!end) break;
        offset += end.index + end[0].length;
      } else if (remaining[0] === '\x1b') {
        if (remaining.length < 2) break;
        offset += 2;
      } else {
        const character = String.fromCodePoint(remaining.codePointAt(0)!);
        offset += character.length;
        if (character === '\r') this.column = 0;
        else if (character === '\n') this.down();
        else if (character === '\b') this.column = Math.max(0, this.column - 1);
        else if (character >= ' ') {
          const width = Bun.stringWidth(character);
          if (!width) continue;
          if (this.column + width > this.columns) {
            this.column = 0;
            this.down();
          }
          const line = (this.lines[this.row] ??= []);
          while (line.length < this.column) line.push(' ');
          line[this.column++] = character;
          for (let i = 1; i < width; i++) line[this.column++] = '';
        }
      }
    }
    this.pending = this.pending.slice(offset);
  }

  private down(count = 1) {
    this.row += count;
    while (this.row >= this.rows) {
      this.lines.shift();
      this.row--;
    }
  }

  private control(parameters: string, command: string) {
    const values = parameters.split(';').map(Number);
    const n = values[0] || 1;
    if (command === 'A') this.row = Math.max(0, this.row - n);
    else if (command === 'B') this.row = Math.min(this.rows - 1, this.row + n);
    else if (command === 'C') this.column = Math.min(this.columns - 1, this.column + n);
    else if (command === 'D') this.column = Math.max(0, this.column - n);
    else if (command === 'G') this.column = n - 1;
    else if (command === 'H' || command === 'f') {
      this.row = n - 1;
      this.column = (values[1] || 1) - 1;
    } else if (command === 'E') {
      this.down(n);
      this.column = 0;
    } else if (command === 'K') {
      const line = (this.lines[this.row] ??= []);
      if (values[0] === 2) this.lines[this.row] = [];
      else line.splice(this.column);
    } else if (command === 'J') {
      if (values[0] === 2) this.lines = [];
      else {
        this.lines.splice(this.row + 1);
        this.lines[this.row]?.splice(this.column);
      }
    } else if (command === 'h' && parameters === '?1049') {
      this.lines = [];
      this.row = this.column = 0;
    }
  }
}
