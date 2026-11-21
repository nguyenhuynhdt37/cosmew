import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {FutrynError} from '@cosmew/contracts';

export const MCP_TIMEOUT_MS = 30_000;
export const MAX_MCP_RESPONSE_BYTES = 256 * 1024;
export const MAX_MCP_OUTPUT_BYTES = 64 * 1024;

export interface McpClientOptions {
  endpoint: URL;
  headers?: Record<string, string>;
  redact(text: string): string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Text-only bounded result. Remote tool results are data and never executable instructions. */
export interface McpTextResult {
  text: string;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * One SDK Streamable HTTP session per configured endpoint. No stdio, OAuth, sampling or server-
 * requested filesystem access in W5. This client is a transport adapter; callers must authorize
 * the capability through ToolDispatcher before calling it (ADR 0044).
 */
export class McpClient {
  private client?: Client;
  private pendingClient?: Client;
  private attempt?: AbortController;
  private activeCalls = 0;
  private transport?: StreamableHTTPClientTransport;
  private connecting?: Promise<void>;
  private closed = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: McpClientOptions) {
    const endpoint = options.endpoint;
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
      throw new FutrynError('POLICY');
  }

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new FutrynError('RUNTIME_UNAVAILABLE'));
    if (this.client) return Promise.resolve();
    return (this.connecting ??= (async () => {
      const attempt = new AbortController();
      this.attempt = attempt;
      const client = new Client({name: 'cosmew', version: '0.1.0'}, {capabilities: {}});
      this.pendingClient = client;
      const fetchImpl = this.options.fetch ?? fetch;
      const boundedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        // The SDK must never follow redirects, leak credentials cross-origin or use ambient cookies.
        const response = await fetchImpl(input, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.any([
            this.lifetime.signal,
            attempt.signal,
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(this.options.timeoutMs ?? MCP_TIMEOUT_MS),
          ]),
        });
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
              if (total > MAX_MCP_RESPONSE_BYTES) {
                await reader.cancel();
                controller.error(new FutrynError('PROTOCOL'));
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
        requestInit: {headers: this.options.headers},
        fetch: boundedFetch,
      });
      try {
        await client.connect(this.transport, {
          timeout: this.options.timeoutMs ?? MCP_TIMEOUT_MS,
          signal: AbortSignal.any([this.lifetime.signal, attempt.signal]),
        });
        if (this.closed || attempt.signal.aborted) throw new FutrynError('CANCELLED');
        this.client = client;
        client.onclose = () => {
          if (this.client === client) this.client = undefined;
        };
      } catch (error) {
        attempt.abort();
        await client.close().catch(() => undefined);
        throw error;
      } finally {
        if (this.pendingClient === client) this.pendingClient = undefined;
        if (this.attempt === attempt) this.attempt = undefined;
        this.connecting = undefined;
      }
    })());
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpTextResult> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? MCP_TIMEOUT_MS);
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    this.activeCalls++;
    try {
      await abortable(this.connect(), combined);
      if (combined.aborted || !this.client) throw new FutrynError('CANCELLED');
      const result = await this.client.callTool({name, arguments: args}, undefined, {
        signal: combined,
        timeout: this.options.timeoutMs ?? MCP_TIMEOUT_MS,
      });
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
        .join('\n');
      const safe = clip(this.options.redact(text), MAX_MCP_OUTPUT_BYTES);
      // structuredContent is not forwarded raw: the search adapter parses it then redacts its output.
      return {
        text: safe,
        ...(result.isError ? {isError: true} : {}),
        ...(result.structuredContent
          ? {structuredContent: JSON.parse(this.options.redact(JSON.stringify(result.structuredContent)))}
          : {}),
      };
    } catch (error) {
      if (signal?.aborted || this.lifetime.signal.aborted) throw new FutrynError('CANCELLED');
      if (deadline.aborted || (error instanceof Error && /timed out/i.test(error.message)))
        throw new FutrynError('TIMEOUT');
      if (error instanceof FutrynError) throw error;
      // SDK errors may embed endpoint query credentials or remote response bodies. Never return them.
      throw new FutrynError('TRANSPORT');
    } finally {
      this.activeCalls--;
      if (!this.activeCalls && this.connecting) this.attempt?.abort();
    }
  }

  /** Tool names and schemas. Same deadlines and error mapping as `call`. No sampling or filesystem host services. */
  async listTools(
    signal?: AbortSignal,
  ): Promise<{name: string; description?: string; inputSchema?: Record<string, unknown>; readOnlyHint?: boolean}[]> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? MCP_TIMEOUT_MS);
    const combined = AbortSignal.any([this.lifetime.signal, deadline, ...(signal ? [signal] : [])]);
    this.activeCalls++;
    try {
      await abortable(this.connect(), combined);
      if (combined.aborted || !this.client) throw new FutrynError('CANCELLED');
      const tools: {
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        readOnlyHint?: boolean;
      }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4 && tools.length < 64; page++) {
        const listed = await this.client.listTools(cursor ? {cursor} : undefined, {
          signal: combined,
          timeout: this.options.timeoutMs ?? MCP_TIMEOUT_MS,
        });
        for (const tool of listed.tools) {
          if (tool.execution?.taskSupport === 'required') continue;
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            readOnlyHint: tool.annotations?.readOnlyHint === true,
          });
          if (tools.length >= 64) break;
        }
        const next = typeof listed.nextCursor === 'string' ? listed.nextCursor : undefined;
        if (!next || next === cursor) break;
        cursor = next;
      }
      return tools;
    } catch (error) {
      if (signal?.aborted || this.lifetime.signal.aborted) throw new FutrynError('CANCELLED');
      if (deadline.aborted || (error instanceof Error && /timed out/i.test(error.message)))
        throw new FutrynError('TIMEOUT');
      if (error instanceof FutrynError) throw error;
      throw new FutrynError('TRANSPORT');
    } finally {
      this.activeCalls--;
      if (!this.activeCalls && this.connecting) this.attempt?.abort();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.attempt?.abort();
    await Promise.allSettled([this.client?.close(), this.pendingClient?.close()]);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
