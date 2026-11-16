/**
 * Bounded capture of a command's combined output (ADR 0022). Keeps the first and the last bytes,
 * counts what was dropped in the middle, and never holds more than `maxBytes` in memory however
 * much the process writes. The same buffer is meant to back a future `write_stdin` session.
 */
export class HeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 60000) throw new RangeError('Invalid output byte budget');
    this.headLimit = Math.ceil(maxBytes / 2);
    this.tailLimit = Math.floor(maxBytes / 2);
  }

  push(chunk: Buffer): void {
    if (this.headBytes < this.headLimit) {
      const take = Math.min(chunk.byteLength, this.headLimit - this.headBytes);
      this.head.push(Buffer.from(chunk.subarray(0, take))); this.headBytes += take;
      chunk = chunk.subarray(take);
      if (!chunk.byteLength) return;
    }
    // Copy only bytes that can survive; subarray references could pin an arbitrarily large input.
    if (chunk.byteLength > this.tailLimit) {
      this.dropped += this.tailBytes + chunk.byteLength - this.tailLimit;
      this.tail = this.tailLimit ? [Buffer.from(chunk.subarray(chunk.byteLength - this.tailLimit))] : [];
      this.tailBytes = this.tailLimit;
      return;
    }
    this.tail.push(Buffer.from(chunk)); this.tailBytes += chunk.byteLength;
    while (this.tailBytes > this.tailLimit) {
      const first = this.tail[0]!; const extra = this.tailBytes - this.tailLimit;
      if (first.byteLength <= extra) { this.tail.shift(); this.tailBytes -= first.byteLength; this.dropped += first.byteLength; }
      else { this.tail[0] = Buffer.from(first.subarray(extra)); this.tailBytes -= extra; this.dropped += extra; }
    }
  }

  /** Bytes dropped from the middle. */
  get omittedBytes(): number { return this.dropped; }
  get totalBytes(): number { return this.headBytes + this.tailBytes + this.dropped; }

  text(): string {
    const decode = (parts: Buffer[]) => new TextDecoder().decode(Buffer.concat(parts));
    if (!this.dropped) return decode([...this.head, ...this.tail]);
    return `${decode(this.head)}\n[… ${this.dropped} bytes omitted …]\n${decode(this.tail)}`;
  }
}

/**
 * Terminal output to plain text: CSI/OSC/other escape sequences removed, CR/CRLF normalised, and
 * every remaining control byte except newline and tab dropped, so neither the model nor the TUI
 * receives sequences that could drive a terminal.
 */
/** Userinfo in URLs (`https://user:token@host`) is credentials; it never reaches the model or the TUI. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, '$1***@');
}

export function plainTerminalText(text: string): string {
  return redactUrlCredentials(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
