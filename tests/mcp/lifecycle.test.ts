import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpClient, McpHub, type McpServerSpec} from '@cosmew/mcp';
import {Redactor} from '@cosmew/security';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function fixture(mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lifecycle-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const script = join(dir, 'server.ts');
  const probe = join(dir, 'calls');
  writeFileSync(
    script,
    `import {createInterface} from 'node:readline';
import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(process.env.PROBE+'.pid', String(process.pid));
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result;
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
else if(m.method==='tools/list') { if(process.env.MODE==='startup') return; result={tools:Array.from({length:process.env.MODE==='many'?70:(process.env.MODE==='bad'||process.env.MODE==='malformed')?2:1},(_,i)=>({name:'tool'+i,inputSchema:{type:process.env.MODE==='malformed'&&i===1?'string':'object',...(process.env.MODE==='bad'&&i===1?{description:'x'.repeat(9000)}:{})}})),...(process.env.MODE==='pages'?{nextCursor:String(Number(m.params?.cursor??0)+1)}:{})}; }
else if(m.method==='tools/call'){appendFileSync(process.env.PROBE,'called\\n'); if(process.env.MODE==='slow') return; if(process.env.MODE==='exit')process.exit(0);result={content:[{type:process.env.MODE==='image'?'image':'text',text:'ok',data:'aGVsbG8=',mimeType:'image/png'}]};}
else result={};
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`,
  );
  const spec: McpServerSpec = {
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    env: {MODE: mode, PROBE: probe},
  };
  const hub = new McpHub([spec], {redact: t => t, configPath: join(dir, 'mcp.json'), timeoutMs: 1000});
  cleanup.push(() => hub.close());
  return {dir, script, probe, spec, hub};
}

async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error('fixture condition timed out');
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('startup cancellation is detached after successful connection; disconnect removes tools', async () => {
  const {hub} = fixture('exit');
  const abort = new AbortController();
  await hub.connect(abort.signal);
  abort.abort();
  expect(hub.snapshot().servers[0]?.state).toBe('connected');
  await expect(hub.call('mcp__fixture__tool0', {})).rejects.toMatchObject({code: 'CANCELLED'});
  await until(() => hub.snapshot().servers[0]?.state === 'failed');
  expect(hub.tools()).toHaveLength(0);
});

test('failed startup can recover; per-server reconnect does not replay a call', async () => {
  const {hub, script} = fixture();
  const source = readFileSync(script, 'utf8');
  rmSync(script);
  expect((await hub.connect()).servers[0]?.state).toBe('failed');
  writeFileSync(script, source);
  expect((await hub.connect()).servers[0]?.state).toBe('connected');
  expect((await hub.reconnect('fixture')).servers[0]?.state).toBe('connected');
  expect(await hub.call('mcp__fixture__tool0', {})).toBe('ok');
});

test('disable aborts an owned call, removes tools immediately and awaits process shutdown', async () => {
  const {hub, probe} = fixture('slow');
  await hub.connect();
  const pid = Number(readFileSync(probe + '.pid', 'utf8'));
  const call = hub.call('mcp__fixture__tool0', {});
  const outcome = call.then(
    () => 'unexpected success',
    error => error.code,
  );
  await until(() => {
    try {
      return readFileSync(probe, 'utf8').includes('called');
    } catch {
      return false;
    }
  });
  const disabled = hub.setEnabled('fixture', false);
  expect(hub.tools()).toHaveLength(0);
  await disabled;
  expect(await outcome).toBe('CANCELLED');
  expect(alive(pid)).toBe(false);
  expect(readFileSync(probe, 'utf8')).toBe('called\n');
  await expect(hub.call('mcp__fixture__tool0', {})).rejects.toMatchObject({code: 'NOT_FOUND'});
  expect(hub.snapshot().servers[0]?.state).toBe('disabled');
});

test('disable fences pending startup and close waits for its process', async () => {
  const {hub, probe} = fixture('startup');
  const pending = hub.connect();
  await until(() => {
    try {
      return Number(readFileSync(probe + '.pid', 'utf8')) > 0;
    } catch {
      return false;
    }
  });
  const pid = Number(readFileSync(probe + '.pid', 'utf8'));
  await hub.setEnabled('fixture', false);
  await pending;
  expect(hub.snapshot().servers[0]?.state).toBe('disabled');
  expect(hub.tools()).toHaveLength(0);
  expect(alive(pid)).toBe(false);
});

test('replacement fences stale discovery and retires old processes', async () => {
  const {hub, probe, spec} = fixture('startup');
  const pending = hub.connect();
  await until(() => {
    try {
      return Number(readFileSync(probe + '.pid', 'utf8')) > 0;
    } catch {
      return false;
    }
  });
  const pid = Number(readFileSync(probe + '.pid', 'utf8'));
  const replaced = await hub.replaceSpecs([
    {...spec, env: {...('env' in spec ? spec.env : {}), MODE: 'normal'}} as McpServerSpec,
  ]);
  await pending;
  expect(replaced.servers[0]?.state).toBe('connected');
  expect(alive(pid)).toBe(false);
  expect(await hub.call('mcp__fixture__tool0', {})).toBe('ok');
});

test('pagination limits and isolated bad schemas are visible; image-only results fail explicitly', async () => {
  for (const mode of ['many', 'pages', 'bad', 'malformed', 'image']) {
    const {hub} = fixture(mode);
    const report = await hub.connect();
    expect(report.servers[0]?.state).toBe('connected');
    if (mode === 'many') {
      expect(hub.tools()).toHaveLength(64);
      expect(report.problems.join(' ')).toContain('truncated');
    }
    if (mode === 'pages') expect(report.problems.join(' ')).toContain('4 pages');
    if (mode === 'bad' || mode === 'malformed') {
      expect(hub.tools()).toHaveLength(1);
      expect(report.problems.join(' ')).toContain('schema');
    }
    if (mode === 'image')
      expect(await hub.call('mcp__fixture__tool0', {})).toMatchObject({
        isError: true,
        text: expect.stringContaining('unsupported'),
      });
  }
});

test('HTTP structured JSON and JSON text retain syntax while redacting decoded secret leaves', async () => {
  const redactor = new Redactor();
  const secret = 'fixture-abc"def';
  redactor.register(secret);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, {status: 405});
      const m = (await req.json()) as {id?: number; method: string; params: {protocolVersion: string}};
      if (m.id === undefined) return new Response(null, {status: 202});
      return Response.json({
        jsonrpc: '2.0',
        id: m.id,
        result:
          m.method === 'initialize'
            ? {
                protocolVersion: m.params.protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: 'f', version: '1'},
              }
            : {
                content: [{type: 'text', text: JSON.stringify({secret})}],
                structuredContent: {secret, note: 'Bearer abc"tail'},
              },
      });
    },
  });
  cleanup.push(() => server.stop(true));
  const client = new McpClient({
    endpoint: new URL(`http://127.0.0.1:${server.port}/mcp`),
    redact: t => redactor.text(t),
    timeoutMs: 1000,
  });
  cleanup.push(() => client.close());
  const result = await client.call('tool0', {});
  expect(result.structuredContent).toEqual({secret: '[REDACTED]', note: 'Bearer [REDACTED]"tail'});
  expect(JSON.parse(result.text)).toEqual({secret: '[REDACTED]'});
  expect(JSON.stringify(result)).not.toContain(JSON.stringify(secret).slice(1, -1));
});

test('close fences pending initialization and reconnect aborts a mutating call without replay', async () => {
  const starting = fixture('startup');
  const pending = starting.hub.connect();
  await until(() => {
    try {
      return Number(readFileSync(starting.probe + '.pid', 'utf8')) > 0;
    } catch {
      return false;
    }
  });
  const pid = Number(readFileSync(starting.probe + '.pid', 'utf8'));
  await starting.hub.close();
  await pending;
  expect(alive(pid)).toBe(false);
  expect(starting.hub.tools()).toHaveLength(0);
  const running = fixture('slow');
  await running.hub.connect();
  const call = running.hub.call('mcp__fixture__tool0', {}).then(
    () => 'unexpected',
    error => error.code,
  );
  await until(() => {
    try {
      return readFileSync(running.probe, 'utf8') === 'called\n';
    } catch {
      return false;
    }
  });
  await running.hub.reconnect('fixture');
  expect(await call).toBe('CANCELLED');
  expect(readFileSync(running.probe, 'utf8')).toBe('called\n');
  expect(running.hub.snapshot().servers[0]?.state).toBe('connected');
});

test('HTTP disable aborts the locally owned pending request and never retries it', async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, {status: 405});
      const m = (await req.json()) as {id?: number; method: string; params: {protocolVersion: string}};
      if (m.id === undefined) return new Response(null, {status: 202});
      if (m.method === 'tools/call') {
        calls++;
        await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve(), {once: true}));
        return new Response(null, {status: 499});
      }
      return Response.json({
        jsonrpc: '2.0',
        id: m.id,
        result:
          m.method === 'initialize'
            ? {
                protocolVersion: m.params.protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: 'f', version: '1'},
              }
            : {tools: [{name: 'slow', inputSchema: {type: 'object'}}]},
      });
    },
  });
  cleanup.push(() => server.stop(true));
  const hub = new McpHub([{name: 'http', transport: 'http', url: `http://127.0.0.1:${server.port}/mcp`, headers: {}}], {
    configPath: 'fixture',
    redact: t => t,
    timeoutMs: 1000,
  });
  cleanup.push(() => hub.close());
  await hub.connect();
  const pending = hub.call('mcp__http__slow', {}).then(
    () => 'unexpected',
    error => error.code,
  );
  await until(() => calls === 1);
  await hub.setEnabled('http', false);
  expect(await pending).toBe('CANCELLED');
  expect(calls).toBe(1);
  expect(hub.tools()).toHaveLength(0);
});

test('disabled configured entries remain visible and never start during connect or replacement', async () => {
  const {spec, probe} = fixture();
  const hub = new McpHub([{...spec, enabled: false}], {configPath: 'fixture', redact: t => t, timeoutMs: 1000});
  cleanup.push(() => hub.close());
  expect((await hub.connect()).servers[0]?.state).toBe('disabled');
  expect((await hub.replaceSpecs([{...spec, enabled: false}])).servers[0]?.state).toBe('disabled');
  expect(() => readFileSync(probe + '.pid', 'utf8')).toThrow();
  expect((await hub.setEnabled('fixture', true)).servers[0]?.state).toBe('connected');
  const pid = Number(readFileSync(probe + '.pid', 'utf8'));
  await Promise.all([hub.close(), hub.close()]);
  expect(alive(pid)).toBe(false);
});

test('oversized SSE tools/list fails immediately with PROTOCOL instead of waiting for MCP timeout', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response(null, {status: 405});
      const m = (await req.json()) as {id?: number; method: string; params?: {protocolVersion?: string}};
      if (m.id === undefined) return new Response(null, {status: 202});
      const result =
        m.method === 'initialize'
          ? {
              protocolVersion: m.params?.protocolVersion ?? '2025-11-25',
              capabilities: {tools: {}},
              serverInfo: {name: 'oversize', version: '1'},
            }
          : {tools: [{name: 'big', description: 'x'.repeat(2048), inputSchema: {type: 'object'}}]};
      return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: m.id, result})}\n\n`, {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
      });
    },
  });
  cleanup.push(() => server.stop(true));
  const client = new McpClient({
    endpoint: new URL(`http://127.0.0.1:${server.port}/mcp`),
    redact: t => t,
    timeoutMs: 5000,
    maxResponseBytes: 512,
  });
  cleanup.push(() => client.close());
  const started = Date.now();
  await expect(client.listTools()).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(Date.now() - started).toBeLessThan(2000);
});

test('connect worker pool starts servers beyond slot 4 while an earlier server stalls and emits onStatusChange', async () => {
  const fifthConnectedAt: number[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST') return new Response(null, {status: 405});
      const m = (await req.json()) as {id?: number; method: string; params?: {protocolVersion?: string}};
      if (m.id === undefined) return new Response(null, {status: 202});
      if (path === '/slow' && m.method === 'tools/list') {
        await new Promise<void>(resolve => req.signal.addEventListener('abort', () => resolve(), {once: true}));
        return new Response(null, {status: 499});
      }
      if (path === '/s5' && m.method === 'tools/list') fifthConnectedAt.push(Date.now());
      return Response.json({
        jsonrpc: '2.0',
        id: m.id,
        result:
          m.method === 'initialize'
            ? {
                protocolVersion: m.params?.protocolVersion ?? '2025-11-25',
                capabilities: {tools: {}},
                serverInfo: {name: path.slice(1), version: '1'},
              }
            : {tools: [{name: 'ping', inputSchema: {type: 'object'}}]},
      });
    },
  });
  cleanup.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  let changes = 0;
  const hub = new McpHub(
    [
      {name: 'slow', transport: 'http', url: `${base}/slow`, headers: {}},
      {name: 's2', transport: 'http', url: `${base}/s2`, headers: {}},
      {name: 's3', transport: 'http', url: `${base}/s3`, headers: {}},
      {name: 's4', transport: 'http', url: `${base}/s4`, headers: {}},
      {name: 's5', transport: 'http', url: `${base}/s5`, headers: {}},
    ],
    {
      configPath: 'fixture',
      redact: t => t,
      timeoutMs: 800,
      onStatusChange: () => {
        changes++;
      },
    },
  );
  cleanup.push(() => hub.close());
  const started = Date.now();
  const report = await hub.connect();
  expect(fifthConnectedAt.length).toBe(1);
  // s5 started via worker pool well before slow timed out at 800ms.
  expect(fifthConnectedAt[0]! - started).toBeLessThan(600);
  expect(report.servers.find(s => s.name === 's5')?.state).toBe('connected');
  expect(report.servers.find(s => s.name === 'slow')).toMatchObject({state: 'failed', error: 'timed out'});
  expect(changes).toBeGreaterThan(0);
});
