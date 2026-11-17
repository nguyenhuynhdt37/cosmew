/**
 * A deterministic language server for tests (ADR 0043). LSP base protocol over stdio.
 * - Diagnostics: every line containing `ERR:` is an error, `WARN:` a warning, published on open/change.
 * - Symbols: `function NAME` declares NAME; definition/implementation jump there, references list
 *   every occurrence, rename replaces them, hover echoes the word and the position it received.
 * - `secretRef` also references `<root>/.env`, `<root>/.git/config` and `/etc/hosts`.
 * - FAKE_LSP_MODE=crash exits on the first request after initialize; =slow never answers hover.
 * - On initialize it tries to write `lsp-write-probe` into its cwd and reports whether that worked.
 */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const mode = process.env.FAKE_LSP_MODE ?? '';
const docs = new Map<string, string>();
let root = process.cwd();
let buffer = Buffer.alloc(0);

const send = (message: unknown) => {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};

function publish(uri: string) {
  const text = docs.get(uri) ?? '';
  const diagnostics = text.split('\n').flatMap((line, index) => {
    const err = line.indexOf('ERR:'),
      warn = line.indexOf('WARN:');
    if (err >= 0)
      return [
        {
          range: {start: {line: index, character: err}, end: {line: index, character: line.length}},
          severity: 1,
          message: 'bad ' + line.slice(err + 4).trim(),
          source: 'fake',
        },
      ];
    if (warn >= 0)
      return [
        {
          range: {start: {line: index, character: warn}, end: {line: index, character: line.length}},
          severity: 2,
          message: 'meh',
          source: 'fake',
        },
      ];
    return [];
  });
  send({jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {uri, diagnostics}});
}

function wordAt(uri: string, position: {line: number; character: number}): string {
  const line = (docs.get(uri) ?? '').split('\n')[position.line] ?? '';
  let start = position.character,
    end = position.character;
  while (start > 0 && /[\w\p{Extended_Pictographic}]/u.test(line[start - 1]!)) start--;
  while (end < line.length && /\w/.test(line[end]!)) end++;
  return line.slice(start, end);
}

function occurrences(word: string, declarationOnly = false) {
  const out: {
    uri: string;
    range: {start: {line: number; character: number}; end: {line: number; character: number}};
  }[] = [];
  for (const [uri, text] of docs)
    text.split('\n').forEach((line, index) => {
      const pattern = new RegExp(`${declarationOnly ? 'function ' : ''}\\b${word}\\b`, 'g');
      for (const match of line.matchAll(pattern)) {
        const at = match.index! + (declarationOnly ? 'function '.length : 0);
        out.push({uri, range: {start: {line: index, character: at}, end: {line: index, character: at + word.length}}});
      }
    });
  return out;
}

const item = (name: string, uri: string, line: number) => ({
  name,
  kind: 12,
  uri,
  range: {start: {line, character: 0}, end: {line, character: 1}},
  selectionRange: {start: {line, character: 0}, end: {line, character: 1}},
});

let initialized = false;
function handle(message: {id?: number; method?: string; params?: any}) {
  const {id, method, params} = message;
  if (method === 'initialize') {
    root = params.rootPath ?? root;
    let write = 'denied';
    try {
      writeFileSync(join(process.cwd(), 'lsp-write-probe'), 'x');
      write = 'allowed';
    } catch {
      /* read-only sandbox */
    }
    send({
      jsonrpc: '2.0',
      id,
      result: {capabilities: {textDocumentSync: 1}, serverInfo: {name: 'fake', version: `write=${write}`}},
    });
    initialized = true;
    return;
  }
  if (method === 'initialized' || method === '$/cancelRequest') return;
  if (method === 'exit') process.exit(0);
  if (mode === 'crash' && initialized && id !== undefined) process.exit(3);
  if (method === 'textDocument/didOpen') {
    docs.set(params.textDocument.uri, params.textDocument.text);
    return publish(params.textDocument.uri);
  }
  if (method === 'textDocument/didChange') {
    docs.set(params.textDocument.uri, params.contentChanges[0].text);
    return publish(params.textDocument.uri);
  }
  if (id === undefined) return;
  const reply = (result: unknown) => send({jsonrpc: '2.0', id, result});
  const uri = params?.textDocument?.uri;
  const word = uri && params.position ? wordAt(uri, params.position) : '';
  switch (method) {
    case 'shutdown':
      return reply(null);
    case 'textDocument/definition':
    case 'textDocument/implementation':
      return reply(occurrences(word, true));
    case 'textDocument/references': {
      const refs: unknown[] = occurrences(word);
      if (word === 'secretRef')
        refs.push(
          {
            uri: pathToFileURL(join(root, '.env')).href,
            range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}},
          },
          {
            uri: pathToFileURL(join(root, '.git', 'config')).href,
            range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}},
          },
          {
            uri: pathToFileURL(join(root, 'hidden.ts')).href,
            range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}},
          },
          {uri: 'file:///etc/hosts', range: {start: {line: 2, character: 0}, end: {line: 2, character: 3}}},
        );
      return reply(refs);
    }
    case 'textDocument/hover':
      if (mode === 'slow') return;
      return reply({
        contents: {kind: 'plaintext', value: `${word} @ ${params.position.line}:${params.position.character}`},
      });
    case 'textDocument/documentSymbol':
      return reply(
        occurrences('\\w+', true)
          .filter(o => o.uri === uri)
          .map(o => ({
            name: (docs.get(uri) ?? '')
              .split('\n')
              [o.range.start.line]!.slice(o.range.start.character)
              .match(/\w+/)![0],
            kind: 12,
            range: o.range,
            selectionRange: o.range,
          })),
      );
    case 'workspace/symbol':
      return reply(occurrences(params.query, true).map(o => ({name: params.query, kind: 12, location: o})));
    case 'textDocument/prepareCallHierarchy': {
      const decl = occurrences(word, true)[0];
      return reply(decl ? [item(word, decl.uri, decl.range.start.line)] : null);
    }
    case 'callHierarchy/incomingCalls':
    case 'callHierarchy/outgoingCalls': {
      const callers = occurrences(method.includes('incoming') ? 'caller' : 'callee', true);
      return reply(
        callers.map(c => ({
          [method.includes('incoming') ? 'from' : 'to']: item(
            method.includes('incoming') ? 'caller' : 'callee',
            c.uri,
            c.range.start.line,
          ),
          fromRanges: [],
        })),
      );
    }
    case 'textDocument/rename': {
      if (mode === 'invalid-rename')
        return reply({
          changes: {
            [uri]: [
              {range: {start: {line: -1, character: 0}, end: {line: 0, character: 50000}}, newText: params.newName},
            ],
          },
        });

      const changes: Record<string, unknown[]> = {};
      for (const o of occurrences(word)) (changes[o.uri] ??= []).push({range: o.range, newText: params.newName});
      return reply({changes});
    }
    default:
      return send({jsonrpc: '2.0', id, error: {code: -32601, message: 'unknown'}});
  }
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
