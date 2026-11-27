import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {getDefaultEnvironment, StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {FutrynError, type Attachment} from '@cosmew/contracts';
import {
  McpClient,
  MCP_TIMEOUT_MS,
  clip,
  MAX_MCP_OUTPUT_BYTES,
  type McpPromptGetResult,
  type McpResourceReadResult,
  type McpTextResult,
  type RemotePrompt,
  type RemotePromptArgument,
  discoverPrompts,
  discoverTools,
  discoverResources,
  discoverResourceTemplates,
  getRemotePrompt,
  readRemoteResource,
  normalizeResult,
} from './client';
import {qualifiedMcpName, type McpServerSpec} from './config';

export type McpToolCallResult = string | {text: string; isError?: boolean; attachments?: Attachment[]};

/** What `cosmew mcp` and `/mcp` may show. No command, arguments, environment, URL or headers. */
export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  state: 'stopped' | 'connecting' | 'reconnecting' | 'connected' | 'needs-auth' | 'failed' | 'disabled';
  tools: number;
  prompts?: number;
  error?: string;
}

export interface McpPromptRecord {
  qualifiedName: string;
  server: string;
  name: string;
  description?: string;
  arguments: RemotePromptArgument[];
  identity?: string;
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
  /** Called when a server's tool catalog changes dynamically via `notifications/tools/list_changed`. */
  onToolsChanged?(): void;
  warnings?: string[];
}

interface InternalConnectOptions extends McpHubOptions {
  onToolsListChanged?(): void;
  onPromptsListChanged?(): void;
  onResourcesListChanged?(): void;
}

interface LiveServer {
  status: McpServerStatus;
  tools: McpToolRecord[];
  prompts: McpPromptRecord[];
  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
  listResources(signal?: AbortSignal): Promise<readonly McpResourceItem[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<readonly McpResourceTemplateItem[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<string | McpResourceReadResult>;
  getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPromptGetResult>;
  refreshTools(signal?: AbortSignal): Promise<McpToolRecord[]>;
  refreshPrompts(signal?: AbortSignal): Promise<McpPromptRecord[]>;
  close(): Promise<void>;
}

/**
 * User-configured MCP servers (ADR 0068). Stdio processes are spawned only from specs the
 * composition root parsed out of the user file. Results are redacted text (and validated media).
 * The hub does not decide permissions: ToolDispatcher does, before `call`.
 */
interface ServerEntry {
  identity: string;
  spec: McpServerSpec;
  enabled: boolean;
  generation: number;
  toolsEpoch: number;
  status: McpServerStatus;
  lifetime?: AbortController;
  live?: LiveServer;
  pending?: Promise<void>;
  stopping?: Promise<void>;
  refreshingTools?: boolean;
  pendingToolsRefresh?: boolean;
  refreshingPrompts?: boolean;
  pendingPromptsRefresh?: boolean;
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
      toolsEpoch: 0,
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
            identity: `${this.identity}:${entry.identity}:${entry.generation}:${entry.toolsEpoch}`,
          }))
        : [],
    );
  }

  prompts(): McpPromptRecord[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.status.state === 'connected'
        ? (entry.live?.prompts ?? []).map(prompt => ({
            ...prompt,
            arguments: prompt.arguments.map(arg => ({...arg})),
            identity: `${this.identity}:${entry.identity}:${entry.generation}:${entry.toolsEpoch}`,
          }))
        : [],
    );
  }

  async getPrompt(
    qualifiedName: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{record: McpPromptRecord; result: McpPromptGetResult}> {
    this.check(signal);
    for (const entry of this.entries.values()) {
      const match =
        entry.status.state === 'connected' &&
        entry.live?.prompts.find(prompt => prompt.qualifiedName === qualifiedName);
      if (match && entry.live) {
        const result = await entry.live.getPrompt(match.name, args, signal);
        return {record: {...match, arguments: match.arguments.map(a => ({...a}))}, result};
      }
    }
    throw new FutrynError('NOT_FOUND');
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
        identity: `${this.identity}:${entry.identity}:${entry.generation}:${entry.toolsEpoch}`,
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

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<string | McpResourceReadResult> {
    this.check(signal);
    const entry = this.entries.get(server);
    if (!entry || entry.status.state !== 'connected' || !entry.live) throw new FutrynError('NOT_FOUND');
    return entry.live.readResource(uri, signal);
  }

  async call(qualifiedName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
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
    const options: InternalConnectOptions = {
      ...this.options,
      warnings: entry.warnings,
      onDisconnect: () => {
        if (current()) {
          entry.live = undefined;
          entry.status = {...entry.status, state: 'failed', tools: 0, prompts: 0, error: 'connection closed'};
          lifetime.abort();
          this.options.onStatusChange?.();
        }
      },
      onToolsListChanged: () => this.scheduleToolsRefresh(entry, generation),
      onPromptsListChanged: () => this.schedulePromptsRefresh(entry, generation),
      onResourcesListChanged: () => {
        if (current()) this.options.onStatusChange?.();
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

  private scheduleToolsRefresh(entry: ServerEntry, generation: number): void {
    const isCurrent = () =>
      !this.closed && entry.enabled && entry.generation === generation && this.entries.get(entry.spec.name) === entry;
    if (!isCurrent() || !entry.live) return;
    if (entry.refreshingTools) {
      entry.pendingToolsRefresh = true;
      return;
    }
    entry.refreshingTools = true;
    void (async () => {
      try {
        do {
          entry.pendingToolsRefresh = false;
          if (!isCurrent() || !entry.live) break;
          const previousSignature = JSON.stringify(entry.live.tools);
          const nextTools = await entry.live.refreshTools(entry.lifetime?.signal);
          if (!isCurrent() || !entry.live) break;
          entry.live.tools = nextTools;
          entry.status = {...entry.status, tools: nextTools.length};
          if (JSON.stringify(nextTools) !== previousSignature) {
            // Bump toolsEpoch so any in-flight approval bound to the previous tool catalog is invalidated (TOCTOU guard).
            entry.toolsEpoch++;
            this.options.onToolsChanged?.();
          }
          this.options.onStatusChange?.();
        } while (entry.pendingToolsRefresh && isCurrent());
      } catch {
        /* Dynamic refresh failures keep the existing connected session intact until reconnect. */
      } finally {
        entry.refreshingTools = false;
      }
    })();
  }

  private schedulePromptsRefresh(entry: ServerEntry, generation: number): void {
    const isCurrent = () =>
      !this.closed && entry.enabled && entry.generation === generation && this.entries.get(entry.spec.name) === entry;
    if (!isCurrent() || !entry.live) return;
    if (entry.refreshingPrompts) {
      entry.pendingPromptsRefresh = true;
      return;
    }
    entry.refreshingPrompts = true;
    void (async () => {
      try {
        do {
          entry.pendingPromptsRefresh = false;
          if (!isCurrent() || !entry.live) break;
          const nextPrompts = await entry.live.refreshPrompts(entry.lifetime?.signal);
          if (!isCurrent() || !entry.live) break;
          entry.live.prompts = nextPrompts;
          entry.status = {...entry.status, prompts: nextPrompts.length};
          this.options.onStatusChange?.();
        } while (entry.pendingPromptsRefresh && isCurrent());
      } catch {
        /* Ignore transient prompt refresh errors. */
      } finally {
        entry.refreshingPrompts = false;
      }
    })();
  }
}

async function connectHttp(
  spec: Extract<McpServerSpec, {transport: 'http'}>,
  options: InternalConnectOptions,
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
    onToolsListChanged: options.onToolsListChanged,
    onPromptsListChanged: options.onPromptsListChanged,
    onResourcesListChanged: options.onResourcesListChanged,
  });
  try {
    const onAbort = () => void client.close();
    ownedSignal?.addEventListener('abort', onAbort, {once: true});
    const listed = await client.listTools(signal);
    const listedPrompts = await client.listPrompts(signal).catch(() => [] as RemotePrompt[]);
    options.warnings?.push(...client.warnings);
    const tools = expose(spec.name, listed, options.redact, options.warnings);
    const prompts = exposePrompts(spec.name, listedPrompts, options.redact);
    return {
      status: {
        name: spec.name,
        transport: 'http',
        state: 'connected',
        tools: tools.length,
        ...(prompts.length ? {prompts: prompts.length} : {}),
      },
      tools,
      prompts,
      call: async (tool, args, callSignal) => textOf(await client.call(tool, args, callSignal)),
      listResources: async callSignal =>
        (await client.listResources(callSignal)).map(item => ({server: spec.name, ...item})),
      listResourceTemplates: async callSignal =>
        (await client.listResourceTemplates(callSignal)).map(item => ({server: spec.name, ...item})),
      readResource: (uri, callSignal) => client.readResource(uri, callSignal),
      getPrompt: (name, args, callSignal) => client.getPrompt(name, args, callSignal),
      refreshTools: async callSignal =>
        expose(spec.name, await client.listTools(callSignal), options.redact, options.warnings),
      refreshPrompts: async callSignal =>
        exposePrompts(
          spec.name,
          await client.listPrompts(callSignal).catch(() => [] as RemotePrompt[]),
          options.redact,
        ),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectStdio(
  spec: Extract<McpServerSpec, {transport: 'stdio'}>,
  options: InternalConnectOptions,
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
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    options.onToolsListChanged?.();
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    options.onPromptsListChanged?.();
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    options.onResourcesListChanged?.();
  });
  const connectDeadline = AbortSignal.timeout(timeout);
  try {
    const connectSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), connectDeadline]);
    await client.connect(transport, {
      timeout,
      signal: connectSignal,
    });
    if (lifetime.signal.aborted) throw new FutrynError('CANCELLED');
    const listed = await discoverTools(client, timeout, connectSignal, options.warnings ?? []);
    const listedPrompts = await discoverPrompts(
      client,
      timeout,
      connectSignal,
      options.redact,
      options.warnings ?? [],
    ).catch(() => [] as RemotePrompt[]);
    client.onclose = () => options.onDisconnect?.();
    const tools = expose(spec.name, listed, options.redact, options.warnings);
    const prompts = exposePrompts(spec.name, listedPrompts, options.redact);
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
      status: {
        name: spec.name,
        transport: 'stdio',
        state: 'connected',
        tools: tools.length,
        ...(prompts.length ? {prompts: prompts.length} : {}),
      },
      tools,
      prompts,
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
      getPrompt: (name, args, callSignal) =>
        stdioRun(callSignal, combined => getRemotePrompt(client, name, args, timeout, combined, options.redact)),
      refreshTools: callSignal =>
        stdioRun(callSignal, async combined =>
          expose(
            spec.name,
            await discoverTools(client, timeout, combined, options.warnings ?? []),
            options.redact,
            options.warnings,
          ),
        ),
      refreshPrompts: callSignal =>
        stdioRun(callSignal, async combined =>
          exposePrompts(
            spec.name,
            await discoverPrompts(client, timeout, combined, options.redact, options.warnings ?? []).catch(
              () => [] as RemotePrompt[],
            ),
            options.redact,
          ),
        ),
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
): Promise<McpToolCallResult> {
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

function exposePrompts(
  server: string,
  prompts: readonly RemotePrompt[],
  redact: (text: string) => string,
): McpPromptRecord[] {
  const records: McpPromptRecord[] = [];
  const seen = new Set<string>();
  for (const prompt of prompts) {
    const qualifiedName = qualifiedMcpName(server, prompt.name);
    if (!qualifiedName || seen.has(qualifiedName)) continue;
    seen.add(qualifiedName);
    records.push({
      qualifiedName,
      server,
      name: prompt.name,
      ...(prompt.description ? {description: clip(redact(prompt.description), 500)} : {}),
      arguments: prompt.arguments.map(arg => ({...arg})),
    });
  }
  return records;
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

function textOf(result: McpTextResult): McpToolCallResult {
  const structured = result.structuredContent ? '\n' + JSON.stringify(result.structuredContent) : '';
  const safe = clip(result.text + structured, MAX_MCP_OUTPUT_BYTES);
  if (!result.isError && !result.attachments?.length) return safe;
  return {
    text: safe,
    ...(result.isError ? {isError: true} : {}),
    ...(result.attachments?.length ? {attachments: result.attachments} : {}),
  };
}
