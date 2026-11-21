import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {FutrynError} from '@cosmew/contracts';
import {McpClient, MCP_TIMEOUT_MS, clip, MAX_MCP_OUTPUT_BYTES, type McpTextResult} from './client';
import {qualifiedMcpName, type McpServerSpec} from './config';

/** What `fyn mcp` and `/mcp` may show. No command, arguments, environment, URL or headers. */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  state: 'connected' | 'failed';
  tools: number;
  error?: string;
}

export interface McpToolRecord {
  /** `mcp__server__tool`, the permission-rule target and the model-facing tool name. */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpSnapshot {
  configPath: string;
  servers: McpServerStatus[];
  problems: string[];
}

export interface McpHubOptions {
  redact(text: string): string;
  configPath: string;
  problems?: string[];
  timeoutMs?: number;
}

interface LiveServer {
  status: McpServerStatus;
  tools: McpToolRecord[];
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/**
 * User-configured MCP servers (ADR 0068). Stdio processes are spawned only from specs the
 * composition root parsed out of the user file. Results are redacted text. The hub does not
 * decide permissions: ToolDispatcher does, before `call`.
 */
export class McpHub {
  private readonly servers: LiveServer[] = [];
  private snapshotValue: McpSnapshot;
  private connecting?: Promise<McpSnapshot>;
  private closed = false;
  constructor(
    private readonly specs: readonly McpServerSpec[],
    private readonly options: McpHubOptions,
  ) {
    this.snapshotValue = {configPath: options.configPath, servers: [], problems: [...(options.problems ?? [])]};
  }

  /** Current view. Empty server list until `connect` finishes. */
  snapshot(): McpSnapshot {
    return {
      configPath: this.snapshotValue.configPath,
      servers: this.snapshotValue.servers.map(server => ({...server})),
      problems: [...this.snapshotValue.problems],
    };
  }

  tools(): McpToolRecord[] {
    return this.servers.flatMap(server => server.tools.map(tool => ({...tool, inputSchema: {...tool.inputSchema}})));
  }

  connect(signal?: AbortSignal): Promise<McpSnapshot> {
    if (this.closed) return Promise.reject(new FutrynError('CANCELLED'));
    if (this.servers.length || this.snapshotValue.servers.length) return Promise.resolve(this.snapshot());
    if (this.specs.length === 0) {
      this.snapshotValue = {...this.snapshotValue, servers: []};
      return Promise.resolve(this.snapshot());
    }
    this.connecting ??= this.open(signal).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async call(qualifiedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (this.closed || signal?.aborted) throw new FutrynError('CANCELLED');
    const match = this.servers.flatMap(server => server.tools).find(tool => tool.name === qualifiedName);
    const live = match
      ? this.servers.find(server => server.tools.some(tool => tool.name === qualifiedName))
      : undefined;
    if (!match || !live) throw new FutrynError('NOT_FOUND');
    return live.call(match.tool, args, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    if (pending) await pending.catch(() => undefined);
    const live = this.servers.splice(0);
    await Promise.allSettled(live.map(server => server.close()));
  }

  private async open(signal?: AbortSignal): Promise<McpSnapshot> {
    const statuses: McpServerStatus[] = [];
    for (let index = 0; index < this.specs.length; index += 4) {
      if (signal?.aborted || this.closed) break;
      const batch = this.specs.slice(index, index + 4);
      const started = await Promise.all(batch.map(spec => this.startOne(spec, signal)));
      for (const live of started) {
        this.servers.push(live);
        statuses.push(live.status);
      }
    }
    this.snapshotValue = {...this.snapshotValue, servers: statuses};
    return this.snapshot();
  }

  private async startOne(spec: McpServerSpec, signal?: AbortSignal): Promise<LiveServer> {
    try {
      if (signal?.aborted || this.closed) throw new FutrynError('CANCELLED');
      const live =
        spec.transport === 'stdio'
          ? await connectStdio(spec, this.options, signal)
          : await connectHttp(spec, this.options, signal);
      if (this.closed || signal?.aborted) {
        await live.close().catch(() => undefined);
        throw new FutrynError('CANCELLED');
      }
      return live;
    } catch (error) {
      const failed = error instanceof FutrynError ? error.code : 'TRANSPORT';
      return {
        status: {
          name: spec.name,
          transport: spec.transport,
          state: 'failed',
          tools: 0,
          error: failed === 'TIMEOUT' ? 'timed out' : failed === 'CANCELLED' ? 'cancelled' : 'failed to start',
        },
        tools: [],
        call: () => Promise.reject(new FutrynError('TRANSPORT')),
        close: () => Promise.resolve(),
      };
    }
  }
}

async function connectHttp(
  spec: Extract<McpServerSpec, {transport: 'http'}>,
  options: McpHubOptions,
  signal?: AbortSignal,
): Promise<LiveServer> {
  const client = new McpClient({
    endpoint: new URL(spec.url),
    headers: spec.headers,
    redact: options.redact,
    timeoutMs: options.timeoutMs,
  });
  try {
    const listed = await client.listTools(signal);
    const tools = expose(spec.name, listed, options.redact);
    return {
      status: {name: spec.name, transport: 'http', state: 'connected', tools: tools.length},
      tools,
      call: async (tool, args, callSignal) => textOf(await client.call(tool, args, callSignal)),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectStdio(
  spec: Extract<McpServerSpec, {transport: 'stdio'}>,
  options: McpHubOptions,
  signal?: AbortSignal,
): Promise<LiveServer> {
  const lifetime = new AbortController();
  const onAbort = () => lifetime.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  const timeout = options.timeoutMs ?? MCP_TIMEOUT_MS;
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: {...getDefaultEnvironment(), ...spec.env},
    stderr: 'pipe',
  });
  const errStream = transport.stderr;
  // Drain stderr so a noisy server cannot fill the pipe. The bytes are not returned: they can echo env.
  if (errStream && 'on' in errStream) errStream.on('data', () => undefined);
  const client = new Client({name: 'cosmew', version: '0.1.0'}, {capabilities: {}});
  try {
    await client.connect(transport, {
      timeout,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]),
    });
    if (lifetime.signal.aborted) throw new FutrynError('CANCELLED');
    const listed = await listRemoteTools(client, timeout, lifetime.signal);
    const tools = expose(spec.name, listed, options.redact);
    return {
      status: {name: spec.name, transport: 'stdio', state: 'connected', tools: tools.length},
      tools,
      call: (tool, args, callSignal) =>
        callRemote(
          client,
          tool,
          args,
          options.redact,
          timeout,
          AbortSignal.any([lifetime.signal, ...(callSignal ? [callSignal] : [])]),
        ),
      close: async () => {
        lifetime.abort();
        signal?.removeEventListener('abort', onAbort);
        await client.close().catch(() => undefined);
      },
    };
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    lifetime.abort();
    await client.close().catch(() => undefined);
    throw error instanceof FutrynError ? error : new FutrynError('TRANSPORT');
  }
}

async function listRemoteTools(
  client: Client,
  timeout: number,
  signal: AbortSignal,
): Promise<{name: string; description?: string; inputSchema?: Record<string, unknown>}[]> {
  const tools: {name: string; description?: string; inputSchema?: Record<string, unknown>}[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 4 && tools.length < 64; page++) {
    const listed = await client.listTools(cursor ? {cursor} : undefined, {timeout, signal});
    for (const tool of listed.tools) {
      if (tool.execution?.taskSupport === 'required') continue;
      tools.push({name: tool.name, description: tool.description, inputSchema: tool.inputSchema});
      if (tools.length >= 64) break;
    }
    const next = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return tools;
}

async function callRemote(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  redact: (text: string) => string,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  try {
    const result = await client.callTool({name, arguments: args}, undefined, {timeout, signal});
    if (result.isError) throw new FutrynError('TRANSPORT');
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n');
    const structured = result.structuredContent ? '\n' + JSON.stringify(result.structuredContent) : '';
    return clip(redact(text + structured), MAX_MCP_OUTPUT_BYTES);
  } catch (error) {
    if (signal.aborted) throw new FutrynError('CANCELLED');
    if (error instanceof FutrynError) throw error;
    if (error instanceof Error && /timed out/i.test(error.message)) throw new FutrynError('TIMEOUT');
    throw new FutrynError('TRANSPORT');
  }
}

function expose(
  server: string,
  tools: {name: string; description?: string; inputSchema?: Record<string, unknown>}[],
  redact: (text: string) => string,
): McpToolRecord[] {
  const records: McpToolRecord[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = qualifiedMcpName(server, tool.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    records.push({
      name,
      server,
      tool: tool.name,
      description: clip(redact(tool.description ?? `MCP tool ${tool.name} on ${server}.`), 500),
      inputSchema: schemaOf(tool.inputSchema),
    });
  }
  return records;
}

function schemaOf(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || schema.type !== 'object') return {type: 'object', additionalProperties: true};
  let encoded = '';
  try {
    encoded = JSON.stringify(schema);
  } catch {
    return {type: 'object', additionalProperties: true};
  }
  if (encoded.length > 8192) return {type: 'object', additionalProperties: true};
  return JSON.parse(encoded) as Record<string, unknown>;
}

function textOf(result: McpTextResult): string {
  const structured = result.structuredContent ? '\n' + JSON.stringify(result.structuredContent) : '';
  return clip(result.text + structured, MAX_MCP_OUTPUT_BYTES);
}
