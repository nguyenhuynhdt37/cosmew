import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { HannesError } from '@hannes/contracts';

/** One reader owns chat and wizard input; secret answers never enter terminal history. */
export class ChatInput {
  private hidden = false;
  private ended = false;
  private failure?: HannesError;
  private queue: string[] = [];
  private queuedBytes = 0;
  private waiting?: (line: string | undefined) => void;
  private readonly reader;
  constructor(signal?: AbortSignal) {
    const sink = new Writable({ write: (chunk, _encoding, done) => {
      if (!this.hidden) process.stderr.write(chunk); done();
    } });
    this.reader = createInterface({ input: process.stdin, output: sink, terminal: !!process.stdin.isTTY, historySize: 0 });
    this.reader.on('line', line => {
      if (this.waiting) { const consume = this.waiting; this.waiting = undefined; consume(line); }
      else {
        this.queuedBytes += Buffer.byteLength(line);
        if (this.queue.length >= 200 || this.queuedBytes > 1048576) { this.failure = new HannesError('INVALID_INPUT'); this.close(); }
        else this.queue.push(line);
      }
    });
    const abort = () => this.reader.close();
    this.reader.on('close', () => { signal?.removeEventListener('abort', abort); this.ended = true; this.waiting?.(undefined); this.waiting = undefined; });
    this.reader.on('SIGINT', () => process.emit('SIGINT'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  }
  async line(prompt = ''): Promise<string | undefined> {
    if (this.failure) throw this.failure;
    if (this.queue.length) { const line = this.queue.shift()!; this.queuedBytes -= Buffer.byteLength(line); return line; }
    if (this.ended) return undefined;
    if (prompt && process.stdin.isTTY) process.stderr.write(prompt);
    return new Promise(resolve => { this.waiting = resolve; });
  }
  async ask(label: string, defaultValue?: string): Promise<string> {
    // Prompts are visible for piped wizard scripts too, but answers are never printed.
    const prompt = label + (defaultValue ? ` [${defaultValue}]` : '') + ': ';
    if (!process.stdin.isTTY) process.stderr.write(prompt);
    const answer = await this.line(prompt);
    if (answer === undefined || answer.trim() === '/cancel') throw new HannesError('CANCELLED');
    return answer.trim() || defaultValue || '';
  }
  async secret(): Promise<string> {
    if (!process.stdin.isTTY || this.queue.length) {
      this.queue = []; this.queuedBytes = 0; throw new HannesError('INVALID_INPUT');
    }
    process.stderr.write('API key (hidden): '); this.hidden = true;
    try {
      const answer = await this.line();
      if (answer === undefined) throw new HannesError('CANCELLED');
      if (this.queue.length) { this.queue = []; this.queuedBytes = 0; throw new HannesError('INVALID_INPUT'); }
      if (answer === '/cancel') throw new HannesError('CANCELLED');
      if (!answer || answer.length > 8192 || /[\x00-\x20\x7f]/.test(answer)) throw new HannesError('INVALID_INPUT');
      return answer;
    } finally { this.hidden = false; process.stderr.write('\n'); }
  }
  close() { this.hidden = false; this.reader.close(); }
}

export async function ask(label: string, defaultValue?: string): Promise<string> {
  if (!process.stdin.isTTY) throw new HannesError('INVALID_INPUT');
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await input.question(label + (defaultValue ? ` [${defaultValue}]` : '') + ': ')).trim() || defaultValue || ''; }
  finally { input.close(); }
}
export async function secretInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new HannesError('INVALID_INPUT');
  process.stderr.write('API key (hidden): '); process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => { process.stdin.removeListener('data', onData); };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new HannesError('CANCELLED')); return; }
          if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ' && char !== '\u007f') value += char;
          if (value.length > 8192) { cleanup(); reject(new HannesError('INVALID_INPUT')); return; }
        }
      };
      process.stdin.on('data', onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); }
}
export async function readSecretStdin(): Promise<string> {
  let result = '';
  for await (const data of process.stdin) { result += data.toString(); if (result.length > 8192) throw new HannesError('INVALID_INPUT'); }
  return result.trim();
}
