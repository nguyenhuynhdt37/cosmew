import {pinnedMcpOAuthFetch, validateMcpOAuthFetchTarget, type McpOAuthLookup} from './oauth-network';
import {UnauthorizedError} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  ReadResourceResultSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ResultSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport, StreamableHTTPError} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FutrynError} from '@cosmew/contracts';

export const MCP_TIMEOUT_MS = 30_000;
export const MAX_MCP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_MCP_OUTPUT_BYTES = 64 * 1024;
export const MAX_MCP_RESOURCES = 128;

export interface McpClientOptions {
  endpoint: URL;
  authProvider?: OAuthClientProvider;
  onDisconnect?(): void;
  headers?: Record<string, string>;
  redact(text: string): string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  oauthLookup?: McpOAuthLookup;
}

/** Text-only bounded result. Remote tool results are data and never executable instructions. */
export interface McpTextResult {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
}

interface ClientSession {
  client: Client;
  oversize?: FutrynError;
}

/**
 * One SDK Streamable HTTP session per configured endpoint. OAuth is injected by the host; no
 * sampling or server-requested filesystem access. This client is a transport adapter; callers must authorize
 * the capability through ToolDispatcher before calling it (ADR 0044).
 */
export class McpClient {
  readonly warnings: string[] = [];
  private session?: ClientSession;
  private pendingClient?: Client;
  private attempt?: AbortController;
  private activeCalls = 0;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<ClientSession>;
  private closed = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: McpClientOptions) {
    const endpoint = options.endpoint;
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
      throw new FutrynError('POLICY');
  }

  private connect(): Promise<ClientSession> {
    if (this.closed) return Promise.reject(new FutrynError('RUNTIME_UNAVAILABLE'));
    if (this.session) return Promise.resolve(this.session);
    return (this.connecting ??= (async () => {
      const attempt = new AbortController();
      this.attempt = attempt;
      const client = new Client({name: 'cosmew', version: '0.1.0'}, {capabilities: {}});
      this.pendingClient = client;
      const session: ClientSession = {client};
      const fetchImpl = this.options.fetch ?? fetch;
      const maxResponseBytes = this.options.maxResponseBytes ?? MAX_MCP_RESPONSE_BYTES;
      const failOversize = () => {
        const error = new FutrynError('PROTOCOL');
        session.oversize ??= error;
        attempt.abort(error);
        // Close the transport so SSE-backed requests reject immediately instead of idling until MCP_TIMEOUT_MS.
        void this.transport?.close().catch(() => undefined);
        return error;
      };
      const boundedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const signal = AbortSignal.any([
          this.lifetime.signal,
          attempt.signal,
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(this.options.timeoutMs ?? MCP_TIMEOUT_MS),
        ]);
        const target = new URL(input instanceof Request ? input.url : input);
        const sameOrigin = target.origin === this.options.endpoint.origin;
        if (!sameOrigin)
          await validateMcpOAuthFetchTarget(this.options.endpoint, target, this.options.oauthLookup, signal);
        // Configured headers never enter SDK requestInit: that wrapper reuses them for OAuth discovery.
        const headers = new Headers(sameOrigin ? this.options.headers : undefined);
        new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, key) =>
          headers.set(key, value),
        );
        // The SDK must never follow redirects, leak credentials cross-origin or use ambient cookies.
        const requestInit: RequestInit = {
          ...init,
          headers,
          redirect: 'error',
          credentials: 'omit',
          signal,
        };
        const response =
          !sameOrigin && !this.options.fetch
            ? await pinnedMcpOAuthFetch(this.options.endpoint, target, requestInit, this.options.oauthLookup)
            : await fetchImpl(input, requestInit);
        if (!response.body) return response;
        const reader = response.body.getReader();
        let total = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              total += chunk.value.byteLength;
              if (total > maxResponseBytes) {
                await reader.cancel();
                controller.error(failOversize());
                return;
              }
              controller.enqueue(chunk.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel: reason => reader.cancel(reason),
        });
        return new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      this.transport = new StreamableHTTPClientTransport(this.options.endpoint, {
        fetch: boundedFetch,
        authProvider: this.options.authProvider,
      });
      try {
        await client.connect(this.transport, {
          timeout: this.options.timeoutMs ?? MCP_TIMEOUT_MS,
          signal: AbortSignal.any([this.lifetime.signal, attempt.signal]),
        });
        if (session.oversize) throw session.oversize;
        if (this.closed || attempt.signal.aborted) throw new FutrynError('CANCELLED');
        this.session = session;
        client.onclose = () => {
          if (this.session === session) {
            this.session = undefined;
            this.options.onDisconnect?.();
          }
        };
        return session;
      } catch (error) {
        attempt.abort();
        await client.close().catch(() => undefined);
        throw session.oversize ?? error;
      } finally {
        if (this.pendingClient === client) this.pendingClient = undefined;
        if (this.attempt === attempt) this.attempt = undefined;
        this.connecting = undefined;
      }
    })());
  }

  private async run<T>(
    signal: AbortSignal | undefined,
    execute: (client: Client, combined: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? MCP_TIMEOUT_MS);
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    this.activeCalls++;
    let session: ClientSession | undefined;
    try {
      session = await abortable(this.connect(), combined);
      if (session.oversize) throw session.oversize;
      if (combined.aborted) throw new FutrynError('CANCELLED');
      return await execute(session.client, combined);
    } catch (error) {
      if (session?.oversize) throw session.oversize;
      if (error instanceof FutrynError && error.code === 'PROTOCOL') throw error;
      if (signal?.aborted || this.lifetime.signal.aborted) throw new FutrynError('CANCELLED');
      if (deadline.aborted || (error instanceof Error && /timed out/i.test(error.message)))
        throw new FutrynError('TIMEOUT');
      if (error instanceof FutrynError) throw error;
      if (error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401))
        throw new FutrynError('AUTH');
      // SDK errors may embed endpoint query credentials or remote response bodies. Never return them.
      throw new FutrynError('TRANSPORT');
    } finally {
      this.activeCalls--;
      if (!this.activeCalls && this.connecting) this.attempt?.abort();
    }
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpTextResult> {
    return this.run(signal, async (client, combined) => {
      const result = await client.callTool({name, arguments: args}, undefined, {
        signal: combined,
        timeout: this.options.timeoutMs ?? MCP_TIMEOUT_MS,
      });
      return normalizeResult(result, this.options.redact);
    });
  }

  /** Tool names and schemas. Same deadlines and error mapping as `call`. No sampling or filesystem host services. */
  async listTools(
    signal?: AbortSignal,
  ): Promise<{name: string; description?: string; inputSchema?: Record<string, unknown>; readOnlyHint?: boolean}[]> {
    return this.run(signal, (client, combined) =>
      discoverTools(client, this.options.timeoutMs ?? MCP_TIMEOUT_MS, combined, this.warnings),
    );
  }

  async listResources(signal?: AbortSignal): Promise<RemoteResource[]> {
    return this.run(signal, (client, combined) =>
      discoverResources(client, this.options.timeoutMs ?? MCP_TIMEOUT_MS, combined, this.options.redact, this.warnings),
    );
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<RemoteResourceTemplate[]> {
    return this.run(signal, (client, combined) =>
      discoverResourceTemplates(
        client,
        this.options.timeoutMs ?? MCP_TIMEOUT_MS,
        combined,
        this.options.redact,
        this.warnings,
      ),
    );
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<string> {
    return this.run(signal, (client, combined) =>
      readRemoteResource(client, uri, this.options.timeoutMs ?? MCP_TIMEOUT_MS, combined, this.options.redact),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.attempt?.abort();
    await Promise.allSettled([this.session?.client.close(), this.pendingClient?.close()]);
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new FutrynError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new FutrynError('CANCELLED'));
    signal.addEventListener('abort', abort, {once: true});
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function clip(text: string, maximum: number): string {
  const bytes = Buffer.from(text);
  return bytes.length <= maximum ? text : bytes.subarray(0, maximum - 24).toString('utf8') + '\n[output truncated]';
}

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
}

export interface RemoteResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface RemoteResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export function isMcpMethodNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as {code?: unknown}).code === -32601) return true;
  if (error instanceof Error && /method not found|-32601/i.test(error.message)) return true;
  return false;
}

/** Bound resource discovery visibly; servers without resource capability return an empty list. */
export async function discoverResources(
  client: Client,
  timeout: number,
  signal: AbortSignal,
  redact: (text: string) => string,
  warnings: string[],
): Promise<RemoteResource[]> {
  const resources: RemoteResource[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    let listed: Record<string, unknown>;
    try {
      listed = await client.request({method: 'resources/list', params: cursor ? {cursor} : undefined}, ResultSchema, {
        timeout,
        signal,
      });
    } catch (error) {
      if (isMcpMethodNotFound(error)) return [];
      throw error;
    }
    if (!Array.isArray(listed.resources)) throw new FutrynError('PROTOCOL');
    for (const raw of listed.resources) {
      const parsed = ResourceSchema.safeParse(raw);
      if (!parsed.success) {
        if (!warnings.includes('A resource was skipped: invalid resource metadata.'))
          warnings.push('A resource was skipped: invalid resource metadata.');
        continue;
      }
      if (resources.length >= MAX_MCP_RESOURCES) {
        warnings.push(`MCP resource discovery truncated at ${MAX_MCP_RESOURCES} resources.`);
        return resources;
      }
      const item = parsed.data;
      resources.push({
        uri: clip(redact(item.uri), 2048),
        name: clip(redact(item.name), 256),
        ...(item.description !== undefined ? {description: clip(redact(item.description), 500)} : {}),
        ...(item.mimeType !== undefined ? {mimeType: clip(redact(item.mimeType), 128)} : {}),
        ...(typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? {size: item.size} : {}),
      });
    }
    const next = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
    if (!next) return resources;
    if (resources.length >= MAX_MCP_RESOURCES || page === 3 || cursors.has(next)) {
      warnings.push(`MCP resource discovery truncated (${MAX_MCP_RESOURCES} resources, 4 pages or repeated cursor).`);
      return resources;
    }
    cursors.add(next);
    cursor = next;
  }
  return resources;
}

/** Bound resource template discovery visibly; servers without templates return an empty list. */
export async function discoverResourceTemplates(
  client: Client,
  timeout: number,
  signal: AbortSignal,
  redact: (text: string) => string,
  warnings: string[],
): Promise<RemoteResourceTemplate[]> {
  const templates: RemoteResourceTemplate[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    let listed: Record<string, unknown>;
    try {
      listed = await client.request(
        {method: 'resources/templates/list', params: cursor ? {cursor} : undefined},
        ResultSchema,
        {timeout, signal},
      );
    } catch (error) {
      if (isMcpMethodNotFound(error)) return [];
      throw error;
    }
    if (!Array.isArray(listed.resourceTemplates)) throw new FutrynError('PROTOCOL');
    for (const raw of listed.resourceTemplates) {
      const parsed = ResourceTemplateSchema.safeParse(raw);
      if (!parsed.success) {
        if (!warnings.includes('A resource template was skipped: invalid template metadata.'))
          warnings.push('A resource template was skipped: invalid template metadata.');
        continue;
      }
      if (templates.length >= MAX_MCP_RESOURCES) {
        warnings.push(`MCP resource template discovery truncated at ${MAX_MCP_RESOURCES} templates.`);
        return templates;
      }
      const item = parsed.data;
      templates.push({
        uriTemplate: clip(redact(item.uriTemplate), 2048),
        name: clip(redact(item.name), 256),
        ...(item.description !== undefined ? {description: clip(redact(item.description), 500)} : {}),
        ...(item.mimeType !== undefined ? {mimeType: clip(redact(item.mimeType), 128)} : {}),
      });
    }
    const next = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
    if (!next) return templates;
    if (templates.length >= MAX_MCP_RESOURCES || page === 3 || cursors.has(next)) {
      warnings.push(
        `MCP resource template discovery truncated (${MAX_MCP_RESOURCES} templates, 4 pages or repeated cursor).`,
      );
      return templates;
    }
    cursors.add(next);
    cursor = next;
  }
  return templates;
}

/** Read one MCP server resource strictly via MCP JSON-RPC. Binary blobs are omitted, text is redacted and clipped. */
export async function readRemoteResource(
  client: Client,
  uri: string,
  timeout: number,
  signal: AbortSignal,
  redact: (text: string) => string,
): Promise<string> {
  if (!uri.trim() || uri.length > 2048 || /[\x00-\x1f\x7f]/.test(uri)) throw new FutrynError('INVALID_INPUT');
  let raw: Record<string, unknown>;
  try {
    raw = await client.request({method: 'resources/read', params: {uri}}, ResultSchema, {timeout, signal});
  } catch (error) {
    if (
      isMcpMethodNotFound(error) ||
      (error && typeof error === 'object' && (error as {code?: unknown}).code === -32002)
    )
      throw new FutrynError('NOT_FOUND');
    throw error;
  }
  const parsed = ReadResourceResultSchema.safeParse(raw);
  if (!parsed.success) throw new FutrynError('PROTOCOL');
  const sections: string[] = [];
  for (const item of parsed.data.contents) {
    const headerParts = [`URI: ${redact(item.uri)}`];
    if (item.mimeType) headerParts.push(`MIME: ${redact(item.mimeType)}`);
    const header = headerParts.join(' | ');
    if ('text' in item && typeof item.text === 'string') {
      sections.push(`${header}\n${safeText(item.text, redact)}`);
    } else if ('blob' in item && typeof item.blob === 'string') {
      const mime = item.mimeType ? redact(item.mimeType) : 'application/octet-stream';
      sections.push(`${header}\n[MCP binary resource content (${mime}) is unsupported; content was omitted.]`);
    }
  }
  if (!sections.length) return '[MCP resource returned no content.]';
  return clip(sections.join('\n\n---\n\n'), MAX_MCP_OUTPUT_BYTES);
}

/** Bound discovery visibly; metadata is untrusted and never grants execution authority. */
export async function discoverTools(
  client: Client,
  timeout: number,
  signal: AbortSignal,
  warnings: string[],
): Promise<RemoteTool[]> {
  const tools: RemoteTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const listed = await client.request({method: 'tools/list', params: cursor ? {cursor} : undefined}, ResultSchema, {
      timeout,
      signal,
    });
    if (!Array.isArray(listed.tools)) throw new FutrynError('PROTOCOL');
    for (let i = 0; i < listed.tools.length; i++) {
      const parsed = ToolSchema.safeParse(listed.tools[i]);
      if (!parsed.success) {
        if (!warnings.includes('A tool was skipped: invalid tool metadata or input schema.'))
          warnings.push('A tool was skipped: invalid tool metadata or input schema.');
        continue;
      }
      const tool = parsed.data;
      if (tool.execution?.taskSupport === 'required') {
        if (!warnings.includes('A task-only MCP tool was skipped (unsupported).'))
          warnings.push('A task-only MCP tool was skipped (unsupported).');
        continue;
      }
      if (tools.length === 64) {
        warnings.push('MCP tool discovery truncated at 64 tools.');
        return tools;
      }
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnlyHint: tool.annotations?.readOnlyHint === true,
      });
    }
    const next = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
    if (!next) return tools;
    if (tools.length >= 64 || page === 3 || cursors.has(next)) {
      warnings.push('MCP tool discovery truncated (64 tools, 4 pages or repeated cursor).');
      return tools;
    }
    cursors.add(next);
    cursor = next;
  }
  return tools;
}

/** Redact decoded JSON leaves, never serialized JSON syntax. Keys are data too. */
export function redactJson(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (depth > 64) return '[nested output truncated]';
  if (typeof value === 'string') return safeText(value, redact);
  if (Array.isArray(value)) return value.map(item => redactJson(item, redact, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [safeText(key, redact), redactJson(item, redact, depth + 1)]),
    );
  return value;
}

function safeText(value: string, redact: (text: string) => string): string {
  // Text can itself contain JSON. Decode it before redaction so escaped registered secrets match.
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(redactJson(parsed, redact));
    if (typeof parsed === 'string') return JSON.stringify(redact(parsed));
  } catch {
    /* Ordinary text. */
  }
  return redact(value);
}

export function normalizeResult(result: Record<string, unknown>, redact: (text: string) => string): McpTextResult {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .flatMap(block => (block?.type === 'text' && typeof block.text === 'string' ? [safeText(block.text, redact)] : []))
    .join('\n');
  const unsupported = blocks.some(block => block?.type !== 'text');
  const onlyUnsupported = unsupported && !text && result.structuredContent === undefined;
  return {
    text: clip(
      text + (unsupported ? '\n[MCP nontext content is unsupported; content was omitted.]' : ''),
      MAX_MCP_OUTPUT_BYTES,
    ),
    ...(result.isError || onlyUnsupported ? {isError: true} : {}),
    ...(result.structuredContent !== undefined
      ? {structuredContent: redactJson(result.structuredContent, redact)}
      : {}),
  };
}
