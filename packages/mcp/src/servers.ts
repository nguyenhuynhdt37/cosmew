import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {FutrynError} from '@cosmew/contracts';
import {
  McpClient,
  MCP_TIMEOUT_MS,
  clip,
  MAX_MCP_OUTPUT_BYTES,
  type McpTextResult,
  discoverTools,
  discoverResources,
  discoverResourceTemplates,
  readRemoteResource,
  normalizeResult,
} from './client';
import {qualifiedMcpName, type McpServerSpec} from './config';

/** What `cosmew mcp` and `/mcp` may show. No command, arguments, environment, URL or headers. */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  state: 'stopped' | 'connecting' | 'reconnecting' | 'connected' | 'needs-auth' | 'failed' | 'disabled';
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
  readOnlyHint?: boolean;
  identity?: string;
}

export interface McpResourceItem {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplateItem {
  server: string;
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
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
  fetch?: typeof fetch;
  authProvider?(spec: Extract<McpServerSpec, {transport: 'http'}>): OAuthClientProvider | undefined;
  onDisconnect?(): void;
  onStatusChange?(): void;
  warnings?: string[];
}

interface LiveServer {
  status: McpServerStatus;
  tools: McpToolRecord[];
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | {text: string; isError: true}>;
  listResources(signal?: AbortSignal): Promise<readonly McpResourceItem[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<readonly McpResourceTemplateItem[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/**
 * User-configured MCP servers (ADR 0068). Stdio processes are spawned only from specs the
 * composition root parsed out of the user file. Results are redacted text. The hub does not
 * decide permissions: ToolDispatcher does, before `call`.
 */
interface ServerEntry {
  identity: string;
  spec: McpServerSpec;
  enabled: boolean;
  generation: number;
  status: McpServerStatus;
  lifetime?: AbortController;
  live?: LiveServer;
  pending?: Promise<void>;
  stopping?: Promise<void>;
  warnings: string[];
}

export class McpHub {
  private readonly entries = new Map<string, ServerEntry>();
  private closed = false;
  private readonly identity = crypto.randomUUID();
  constructor(
    specs: readonly McpServerSpec[],
    private readonly options: McpHubOptions,
  ) {
    for (const spec of specs) this.entries.set(spec.name, this.entry(spec));
  }

  private entry(spec: McpServerSpec): ServerEntry {
    const enabled = spec.enabled !== false;
    return {
      identity: crypto.randomUUID(),
      spec: structuredClone(spec),
      enabled,
      generation: 0,
      warnings: [],
      status: {name: spec.name, transport: spec.transport, state: enabled ? 'stopped' : 'disabled', tools: 0},
    };
  }

  snapshot(): McpSnapshot {
    return {
      configPath: this.options.configPath,
      servers: [...this.entries.values()].map(entry => ({...entry.status})),
      problems: [
        ...(this.options.problems ?? []),
        ...[...this.entries.values()].flatMap(entry => entry.warnings.map(warning => `${entry.spec.name}: ${warning}`)),
      ],
    };
  }

  tools(): McpToolRecord[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.status.state === 'connected'
        ? (entry.live?.tools ?? []).map(tool => ({
            ...tool,
            inputSchema: structuredClone(tool.inputSchema),
            identity: `${this.identity}:${entry.identity}:${entry.generation}`,
          }))
        : [],
    );
  }

  async connect(signal?: AbortSignal): Promise<McpSnapshot> {
    this.check(signal);
    const entries = [...this.entries.values()];
    // Worker pool (concurrency 4) so one slow or unresponsive server never stalls the rest of the queue.
    let next = 0;
    const worker = async () => {
      while (next < entries.length && !this.closed && !signal?.aborted) {
        const entry = entries[next++]!;
        await this.start(entry, signal);
      }
    };
    await Promise.all(Array.from({length: Math.min(4, entries.length)}, worker));
    return this.snapshot();
  }

  async reconnect(name?: string, signal?: AbortSignal): Promise<McpSnapshot> {
    this.check(signal);
    const entries = name ? [this.require(name)] : [...this.entries.values()];
    await Promise.all(
      entries.map(async entry => {
        await this.stop(entry);
        if (entry.enabled) await this.start(entry, signal, true);
      }),
    );
    return this.snapshot();
  }

  async setEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<McpSnapshot> {
    this.check(signal);
    const entry = this.require(name);
    entry.enabled = enabled;
    if (!enabled) await this.stop(entry);
    else await this.start(entry, signal);
    return this.snapshot();
  }

  async replaceSpecs(specs: readonly McpServerSpec[], signal?: AbortSignal): Promise<McpSnapshot> {
    this.check(signal);
    const next = new Map(specs.map(spec => [spec.name, spec]));
    const stopping: Promise<void>[] = [];
    for (const [name, entry] of this.entries) {
      if (!next.has(name) || JSON.stringify(entry.spec) !== JSON.stringify(next.get(name))) {
        this.entries.delete(name);
        stopping.push(this.stop(entry));
      }
    }
    for (const spec of specs) if (!this.entries.has(spec.name)) this.entries.set(spec.name, this.entry(spec));
    await Promise.all(stopping);
    return this.connect(signal);
  }

  servers(): readonly {name: string; identity: string}[] {
    return [...this.entries.values()]
      .filter(entry => entry.status.state === 'connected' && Boolean(entry.live))
      .map(entry => ({
        name: entry.spec.name,
        identity: `${this.identity}:${entry.identity}:${entry.generation}`,
      }));
  }

  async listResources(server: string, signal?: AbortSignal): Promise<readonly McpResourceItem[]> {
    this.check(signal);
    const entry = this.entries.get(server);
    if (!entry || entry.status.state !== 'connected' || !entry.live) throw new FutrynError('NOT_FOUND');
    return entry.live.listResources(signal);
  }

  async listResourceTemplates(server: string, signal?: AbortSignal): Promise<readonly McpResourceTemplateItem[]> {
    this.check(signal);
    const entry = this.entries.get(server);
    if (!entry || entry.status.state !== 'connected' || !entry.live) throw new FutrynError('NOT_FOUND');
    return entry.live.listResourceTemplates(signal);
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<string> {
    this.check(signal);
    const entry = this.entries.get(server);
    if (!entry || entry.status.state !== 'connected' || !entry.live) throw new FutrynError('NOT_FOUND');
    return entry.live.readResource(uri, signal);
  }

  async call(
    qualifiedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | {text: string; isError: true}> {
    this.check(signal);
    for (const entry of this.entries.values()) {
      const match = entry.status.state === 'connected' && entry.live?.tools.find(tool => tool.name === qualifiedName);
      if (match && entry.live) return entry.live.call(match.tool, args, signal);
    }
    throw new FutrynError('NOT_FOUND');
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.values()].map(entry => this.stop(entry)));
  }

  private check(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new FutrynError('CANCELLED');
  }

  private require(name: string): ServerEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new FutrynError('NOT_FOUND');
    return entry;
  }

  private async stop(entry: ServerEntry): Promise<void> {
    entry.generation++;
    entry.lifetime?.abort();
    const live = entry.live;
    const pending = entry.pending;
    entry.live = undefined;
    entry.pending = undefined;
    entry.status = {...entry.status, state: entry.enabled ? 'stopped' : 'disabled', tools: 0, error: undefined};
    this.options.onStatusChange?.();
    const stopping = Promise.allSettled([entry.stopping, live?.close(), pending]).then(() => undefined);
    entry.stopping = stopping;
    await stopping;
    if (entry.stopping === stopping) entry.stopping = undefined;
  }

  private start(entry: ServerEntry, signal?: AbortSignal, reconnecting = false): Promise<void> {
    if (this.closed || signal?.aborted || !entry.enabled || entry.live) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const generation = ++entry.generation;
    const lifetime = new AbortController();
    entry.lifetime = lifetime;
    entry.warnings = [];
    entry.status = {...entry.status, state: reconnecting ? 'reconnecting' : 'connecting', tools: 0, error: undefined};
    this.options.onStatusChange?.();
    const startup = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    const current = () =>
      !this.closed && entry.enabled && entry.generation === generation && this.entries.get(entry.spec.name) === entry;
    const options: McpHubOptions = {
      ...this.options,
      warnings: entry.warnings,
      onDisconnect: () => {
        if (current()) {
          entry.live = undefined;
          entry.status = {...entry.status, state: 'failed', tools: 0, error: 'connection closed'};
          lifetime.abort();
          this.options.onStatusChange?.();
        }
      },
    };
    const priorStopping = entry.stopping;
    const pending = (async () => {
      let live: LiveServer | undefined;
      try {
        if (priorStopping) await priorStopping;
        if (!current() || startup.aborted) throw new FutrynError('CANCELLED');
        live =
          entry.spec.transport === 'stdio'
            ? await connectStdio(entry.spec, options, startup, lifetime.signal)
            : await connectHttp(entry.spec, options, startup, lifetime.signal);
        if (!current() || startup.aborted) {
          await live.close();
          throw new FutrynError('CANCELLED');
        }
        entry.live = live;
        entry.status = live.status;
        this.options.onStatusChange?.();
      } catch (error) {
        if (current()) {
          entry.status = {
            ...entry.status,
            state: error instanceof FutrynError && error.code === 'AUTH' ? 'needs-auth' : 'failed',
            tools: 0,
            error:
              error instanceof FutrynError && error.code === 'AUTH'
                ? 'authentication required'
                : error instanceof FutrynError && error.code === 'TIMEOUT'
                  ? 'timed out'
                  : error instanceof FutrynError && error.code === 'PROTOCOL'
                    ? 'protocol error'
                    : signal?.aborted || this.closed
                      ? 'cancelled'
                      : 'failed to start',
          };
          this.options.onStatusChange?.();
        }
      } finally {
        if (entry.generation === generation) entry.pending = undefined;
      }
    })();
    entry.pending = pending;
    return pending;
  }
}

async function connectHttp(
  spec: Extract<McpServerSpec, {transport: 'http'}>,
  options: McpHubOptions,
  signal?: AbortSignal,
  ownedSignal?: AbortSignal,
): Promise<LiveServer> {
  const client = new McpClient({
    endpoint: new URL(spec.url),
    headers: spec.headers,
    redact: options.redact,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
    authProvider: options.authProvider?.(spec),
    onDisconnect: options.onDisconnect,
  });
  try {
    const onAbort = () => void client.close();
    ownedSignal?.addEventListener('abort', onAbort, {once: true});
    const listed = await client.listTools(signal);
    options.warnings?.push(...client.warnings);
    const tools = expose(spec.name, listed, options.redact, options.warnings);
    return {
      status: {name: spec.name, transport: 'http', state: 'connected', tools: tools.length},
      tools,
      call: async (tool, args, callSignal) => textOf(await client.call(tool, args, callSignal)),
      listResources: async callSignal =>
        (await client.listResources(callSignal)).map(item => ({server: spec.name, ...item})),
      listResourceTemplates: async callSignal =>
        (await client.listResourceTemplates(callSignal)).map(item => ({server: spec.name, ...item})),
      readResource: (uri, callSignal) => client.readResource(uri, callSignal),
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
  ownedSignal?: AbortSignal,
): Promise<LiveServer> {
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    lifetime.abort();
    return (closing ??= client.close().catch(() => undefined));
  };
  const onAbort = () => {
    void close();
  };
  ownedSignal?.addEventListener('abort', onAbort, {once: true});
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
  const connectDeadline = AbortSignal.timeout(timeout);
  try {
    await client.connect(transport, {
      timeout,
      signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), connectDeadline]),
    });
    if (lifetime.signal.aborted) throw new FutrynError('CANCELLED');
    const listed = await discoverTools(
      client,
      timeout,
      AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), connectDeadline]),
      options.warnings ?? [],
    );
    client.onclose = () => options.onDisconnect?.();
    const tools = expose(spec.name, listed, options.redact, options.warnings);
    const stdioRun = async <T>(callSignal: AbortSignal | undefined, fn: (combined: AbortSignal) => Promise<T>) => {
      if (callSignal?.aborted || lifetime.signal.aborted) throw new FutrynError('CANCELLED');
      const deadline = AbortSignal.timeout(timeout);
      const combined = AbortSignal.any([lifetime.signal, deadline, ...(callSignal ? [callSignal] : [])]);
      try {
        return await fn(combined);
      } catch (error) {
        if (callSignal?.aborted || lifetime.signal.aborted) throw new FutrynError('CANCELLED');
        if (deadline.aborted || (error instanceof Error && /timed out|timeout/i.test(error.message)))
          throw new FutrynError('TIMEOUT');
        if (error instanceof FutrynError) throw error;
        throw new FutrynError('TRANSPORT');
      }
    };
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
      listResources: callSignal =>
        stdioRun(callSignal, async combined =>
          (await discoverResources(client, timeout, combined, options.redact, options.warnings ?? [])).map(item => ({
            server: spec.name,
            ...item,
          })),
        ),
      listResourceTemplates: callSignal =>
        stdioRun(callSignal, async combined =>
          (await discoverResourceTemplates(client, timeout, combined, options.redact, options.warnings ?? [])).map(
            item => ({server: spec.name, ...item}),
          ),
        ),
      readResource: (uri, callSignal) =>
        stdioRun(callSignal, combined => readRemoteResource(client, uri, timeout, combined, options.redact)),
      close: async () => {
        lifetime.abort();
        ownedSignal?.removeEventListener('abort', onAbort);
        await close();
      },
    };
  } catch (error) {
    ownedSignal?.removeEventListener('abort', onAbort);
    await close();
    if (error instanceof FutrynError) throw error;
    if (connectDeadline.aborted || (error instanceof Error && /timed out|timeout/i.test(error.message)))
      throw new FutrynError('TIMEOUT');
    if (signal?.aborted || ownedSignal?.aborted || lifetime.signal.aborted) throw new FutrynError('CANCELLED');
    throw new FutrynError('TRANSPORT');
  }
}

async function callRemote(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  redact: (text: string) => string,
  timeout: number,
  signal: AbortSignal,
): Promise<string | {text: string; isError: true}> {
  try {
    const result = await client.callTool({name, arguments: args}, undefined, {timeout, signal});
    return textOf(normalizeResult(result, redact));
  } catch (error) {
    if (signal.aborted) throw new FutrynError('CANCELLED');
    if (error instanceof FutrynError) throw error;
    if (error instanceof Error && /timed out/i.test(error.message)) throw new FutrynError('TIMEOUT');
    throw new FutrynError('TRANSPORT');
  }
}

function expose(
  server: string,
  tools: {name: string; description?: string; inputSchema?: Record<string, unknown>; readOnlyHint?: boolean}[],
  redact: (text: string) => string,
  warnings: string[] = [],
): McpToolRecord[] {
  const records: McpToolRecord[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = qualifiedMcpName(server, tool.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = schemaOf(tool.inputSchema);
    } catch {
      if (!warnings.includes('A tool was skipped: invalid or oversized input schema.'))
        warnings.push('A tool was skipped: invalid or oversized input schema.');
      continue;
    }
    records.push({
      name,
      server,
      tool: tool.name,
      description: clip(redact(tool.description ?? `MCP tool ${tool.name} on ${server}.`), 500),
      inputSchema,
      readOnlyHint: tool.readOnlyHint === true,
    });
  }
  return records;
}

function schemaOf(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  try {
    if (!schema || schema.type !== 'object') throw new Error('invalid schema');
    const encoded = JSON.stringify(schema);
    if (Buffer.byteLength(encoded) > 8192) throw new Error('oversized schema');
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    throw new FutrynError('PROTOCOL');
  }
}

function textOf(result: McpTextResult): string | {text: string; isError: true} {
  const structured = result.structuredContent ? '\n' + JSON.stringify(result.structuredContent) : '';
  const safe = clip(result.text + structured, MAX_MCP_OUTPUT_BYTES);
  return result.isError ? {text: safe, isError: true} : safe;
}
