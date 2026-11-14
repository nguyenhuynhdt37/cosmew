import { createInterface } from 'node:readline/promises';
import { HannesError } from '@hannes/contracts';

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
