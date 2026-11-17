import {expect, test} from 'bun:test';
import {JsonRpcConnection, LspClient, LspManager} from '@futryn/code-intel';
import {WorkspaceRoot} from '@futryn/workspace';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ServiceProcess} from '@futryn/contracts';

function wire() {
  let receive: (data: Uint8Array) => void = () => {};
  const sent: Buffer[] = [];
  let killed = false;
  const process: ServiceProcess = {
    pid: undefined,
    write: bytes => {
      sent.push(Buffer.from(bytes));
    },
    onData: listener => {
      receive = listener;
    },
    onExit: () => {},
    kill: () => {
      killed = true;
    },
  };
  const rpc = new JsonRpcConnection(process);
  const feed = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    receive(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  };
  return {
    rpc,
    process,
    sent,
    feed,
    raw: (s: string | Uint8Array) => receive(typeof s === 'string' ? Buffer.from(s) : s),
    killed: () => killed,
  };
}

test('LSP frame headers remain bounded even when a partial Content-Length is present', () => {
  const w = wire();
  w.raw('Content-Length: 1\r\nX: ' + 'a'.repeat(9000));
  expect(w.rpc.closed).toBe(true);
  expect(w.killed()).toBe(true);
});

test('LSP rejects non-object messages and terminates the invalid peer', () => {
  const w = wire();
  expect(() => w.feed(null)).not.toThrow();
  expect(w.rpc.closed).toBe(true);
  expect(w.killed()).toBe(true);
});

test('LSP supports fragmented UTF-8 frames, cancels requests and rejects unknown server requests', async () => {
  const w = wire();
  const response = w.rpc.request<string>('hover', {});
  const body = Buffer.from(JSON.stringify({jsonrpc: '2.0', id: 1, result: '🌱'}));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  for (const byte of frame) w.raw(Uint8Array.of(byte));
  expect(await response).toBe('🌱');
  const ac = new AbortController();
  const cancelled = w.rpc.request('slow', {}, {signal: ac.signal});
  ac.abort();
  await expect(cancelled).rejects.toMatchObject({code: 'CANCELLED'});
  w.feed({jsonrpc: '2.0', id: 50, method: 'workspace/applyEdit', params: {}});
  expect(w.sent.at(-1)!.toString()).toContain('-32601');
  expect(w.sent.map(x => x.toString()).join('')).toContain('$/cancelRequest');
  w.rpc.close('test');
});

test('LSP rejects duplicate lengths and notifies all pending requests on protocol failure', async () => {
  const w = wire();
  const pending = w.rpc.request('hover', {});
  w.raw('Content-Length: 2\r\nContent-Length: 10\r\n\r\n{}');
  expect(w.rpc.closed).toBe(true);
  await expect(pending).rejects.toMatchObject({code: 'RUNTIME_UNAVAILABLE'});
});

test('diagnostics accept only valid current versions of opened documents and didClose releases them', () => {
  const w = wire();
  const client = new LspClient(w.process, '/workspace');
  const uri = 'file:///workspace/a.ts';
  const good = {range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}, message: 'valid', severity: 1};
  client.sync(uri, 'typescript', 'one');
  client.sync(uri, 'typescript', 'two');
  w.feed({jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {uri, version: 1, diagnostics: [good]}});
  expect(client.knownDiagnostics(uri)).toBeUndefined();
  w.feed({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {uri, version: 2, diagnostics: [null, {message: 'bad'}, good]},
  });
  expect(client.knownDiagnostics(uri)).toEqual([good]);
  const before = client.seq;
  for (let i = 0; i < 100; i++)
    w.feed({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {uri: 'file:///workspace/unopened' + i, diagnostics: [good]},
    });
  expect(client.seq).toBe(before);
  client.closeDocument(uri);
  expect(client.knownDiagnostics(uri)).toBeUndefined();
  expect(w.sent.at(-1)!.toString()).toContain('textDocument/didClose');
  client.terminate();
});

test('manager shutdown owns an initializing server and refuses its late initialize response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fyn-lsp-init-'));
  writeFileSync(join(root, 'a.ts'), 'one');
  const w = wire();
  const manager = new LspManager({
    workspace: new WorkspaceRoot(root),
    launch: () => w.process,
    servers: [
      {
        id: 'typescript',
        extensions: ['.ts'],
        roots: [],
        languageId: () => 'typescript',
        commands: () => [['fixture']],
        install: 'fixture',
      },
    ],
  });
  try {
    const pending = manager.request(new WorkspaceRoot(root).resolve('a.ts'), 'hover', () => ({}));
    const outcome = pending.catch(error => error);
    await manager.shutdown();
    w.feed({jsonrpc: '2.0', id: 1, result: {capabilities: {}}});
    expect(w.killed()).toBe(true);
    expect((await outcome).code).toBeDefined();
    expect(manager.available()).toBe(false);
  } finally {
    await manager.shutdown();
    rmSync(root, {recursive: true, force: true});
  }
});

test('diagnostics for more than the open-document cap cannot grow retained state indefinitely', () => {
  const w = wire();
  const client = new LspClient(w.process, '/workspace');
  for (let i = 0; i < 140; i++) client.sync('file:///workspace/' + i + '.ts', 'typescript', 'value');
  expect(client.isOpen('file:///workspace/0.ts')).toBe(false);
  expect(client.isOpen('file:///workspace/139.ts')).toBe(true);
  client.terminate();
});
