import {expect, test} from 'bun:test';
import {LspClient} from '@futryn/code-intel';
import type {ServiceProcess} from '@futryn/contracts';

type Rpc = {
  id?: number;
  method?: string;
  params?: {textDocument?: {uri: string; text?: string}; contentChanges?: {text: string}[]; previousResultId?: string};
  result?: unknown;
  error?: unknown;
};
function peer(deferPull = false) {
  let receive: (data: Uint8Array) => void = () => {};
  const requests: Rpc[] = [];
  const documents = new Map<string, string>();
  const pending: Rpc[] = [];
  let killed = false;
  const feed = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message));
    receive(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  const process: ServiceProcess = {
    pid: undefined,
    onData: fn => {
      receive = fn;
    },
    onExit: () => {},
    kill: () => {
      killed = true;
    },
    write: bytes => {
      const raw = Buffer.from(bytes).toString();
      const message = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) as Rpc;
      requests.push(message);
      const uri = message.params?.textDocument?.uri;
      if (message.method === 'initialize')
        feed({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            capabilities: {
              diagnosticProvider: {identifier: 'fixture', interFileDependencies: false, workspaceDiagnostics: false},
            },
          },
        });
      else if (message.method === 'textDocument/didOpen' && uri)
        documents.set(uri, message.params!.textDocument!.text ?? '');
      else if (message.method === 'textDocument/didChange' && uri)
        documents.set(uri, message.params!.contentChanges?.[0]?.text ?? '');
      else if (message.method === 'textDocument/diagnostic') {
        pending.push(message);
        if (!deferPull)
          feed({
            jsonrpc: '2.0',
            id: message.id,
            result: {kind: 'full', resultId: String(pending.length), items: diagnostics(documents.get(uri!) ?? '')},
          });
      } else if (message.method === 'shutdown') {
        if (Object.hasOwn(message, 'params'))
          feed({jsonrpc: '2.0', id: message.id, error: {code: -32602, message: 'shutdown takes no params'}});
        else feed({jsonrpc: '2.0', id: message.id, result: null});
      }
    },
  };
  return {
    client: new LspClient(process, '/workspace'),
    requests,
    pending,
    reply: (index: number, text: string) =>
      feed({
        jsonrpc: '2.0',
        id: pending[index]!.id,
        result: {kind: 'full', resultId: String(index + 1), items: diagnostics(text)},
      }),
    killed: () => killed,
  };
}
function diagnostics(text: string) {
  return text.includes('ERR:')
    ? [{message: text, severity: 1, range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}}]
    : [];
}
async function until(check: () => boolean) {
  const end = Date.now() + 250;
  while (!check() && Date.now() < end) await Bun.sleep(1);
  expect(check()).toBe(true);
}

test('pull-diagnostic servers receive advertised capability and cold/warm diagnostics for the synced version', async () => {
  const p = peer();
  try {
    await p.client.initialize();
    const init = p.requests[0] as unknown as {params: {capabilities: {textDocument: {diagnostic?: unknown}}}};
    expect(init.params.capabilities.textDocument.diagnostic).toBeDefined();
    const uri = 'file:///workspace/a.ts';
    p.client.sync(uri, 'typescript', 'ERR: cold');
    const cold = await p.client.waitForDiagnostics(uri, p.client.seq);
    expect(cold?.map(d => d.message)).toEqual(['ERR: cold']);
    const since = p.client.seq;
    p.client.sync(uri, 'typescript', 'ERR: warm');
    const warm = await p.client.waitForDiagnostics(uri, since);
    expect(warm?.map(d => d.message)).toEqual(['ERR: warm']);
    expect(p.pending).toHaveLength(2);
  } finally {
    p.client.terminate();
  }
});

test('a delayed pull result cannot overwrite diagnostics for a newer document version', async () => {
  const p = peer(true);
  try {
    await p.client.initialize();
    const uri = 'file:///workspace/a.ts';
    p.client.sync(uri, 'typescript', 'ERR: old');
    const old = p.client.waitForDiagnostics(uri, p.client.seq);
    await until(() => p.pending.length === 1);
    p.client.sync(uri, 'typescript', 'ERR: new');
    const current = p.client.waitForDiagnostics(uri, p.client.seq);
    await until(() => p.pending.length === 2);
    p.reply(1, 'ERR: new');
    expect((await current)?.map(d => d.message)).toEqual(['ERR: new']);
    p.reply(0, 'ERR: old');
    expect((await old)?.some(d => d.message === 'ERR: old') ?? false).toBe(false);
    expect(p.client.knownDiagnostics(uri)?.map(d => d.message)).toEqual(['ERR: new']);
  } finally {
    p.client.terminate();
  }
});

test('LSP shutdown uses a parameterless JSON-RPC request and accepts its null result before exit', async () => {
  const p = peer();
  await p.client.initialize();
  await p.client.shutdown();
  const shutdown = p.requests.find(r => r.method === 'shutdown')!;
  expect(Object.hasOwn(shutdown, 'params')).toBe(false);
  expect(p.requests.some(r => r.method === 'exit' && !Object.hasOwn(r, 'params'))).toBe(true);
  expect(p.killed()).toBe(true);
});
