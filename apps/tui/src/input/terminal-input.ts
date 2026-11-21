/** Startup-only terminal string drain. Never install this stateful parser in the live key path. */
export class TerminalStringFilter {
  private string = false;
  private escape = false;
  private swallowed = false;
  get pendingEscape(): boolean {
    return this.escape && !this.string;
  }
  flushEscape(): string {
    if (!this.pendingEscape) return '';
    this.escape = false;
    return '\x1b';
  }
  feed(chunk: string): string {
    let output = '';
    for (const char of chunk) {
      if (this.string) {
        if (char === '\x07' || (this.escape && char === '\\')) {
          this.string = false;
          this.swallowed = true;
        }
        this.escape = char === '\x1b';
        continue;
      }
      if (this.escape) {
        this.escape = false;
        if (char === ']' || char === 'P' || char === '_') {
          this.string = true;
          continue;
        }
        if (char === '\\' && this.swallowed) continue; // Orphaned ST after a swallowed string.
        output += '\x1b';
      }
      if (char === '\x1b') this.escape = true;
      else {
        output += char;
        this.swallowed = false;
      }
    }
    return output;
  }
}
