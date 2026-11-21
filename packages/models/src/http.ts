import {
  FutrynError,
  ProviderBillingError,
  type Account,
  type CredentialVault,
  type NetworkPolicy,
  type Provider,
} from '@cosmew/contracts';

export function normalizeError(error: unknown, signal?: AbortSignal): FutrynError {
  if (signal?.aborted) return new FutrynError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
  if (error instanceof FutrynError) return error;
  const status = (() => {
    if (!error || typeof error !== 'object') return undefined;
    const value = error as Record<string, unknown>;
    const response = value.response;
    const responseStatus =
      response && typeof response === 'object' ? (response as Record<string, unknown>).status : undefined;
    for (const candidate of [value.statusCode, value.status, responseStatus]) {
      const n = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : NaN;
      if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
    return undefined;
  })();
  if (status) return statusError(status, null);
  return new FutrynError('PROTOCOL');
}
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const n = Number(value);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(30000, ms)) : null;
}
export function statusError(status: number, retry: string | null): FutrynError {
  if (status === 401) return new FutrynError('AUTH');
  if (status === 402) return new ProviderBillingError();
  if (status === 403) return new FutrynError('FORBIDDEN');
  if (status === 404) return new FutrynError('NOT_FOUND');
  if (status === 429) return new FutrynError('RATE_LIMIT', true, retryAfter(retry));
  if (status >= 500) return new FutrynError('TRANSPORT', true, retryAfter(retry));
  return new FutrynError('INVALID_INPUT');
}

const billingMarker =
  /\b(?:insufficient[ -](?:quota|credits|balance)|credit[ -]balance|out of credits|spending[ -]limit|billing|payment[ -]required|subscription (?:is )?required|needs? a [\w -]*subscription)\b/i;
const contextErrorCodes = new Set(['context_length_exceeded', 'context_window_exceeded']);

function errorFields(value: unknown) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const envelope = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const error = envelope.error && typeof envelope.error === 'object' ? (envelope.error as Record<string, unknown>) : {};
  return {
    message: text(error.message) || text(envelope.message) || text(envelope.error),
    markers: [text(error.code), text(error.type), text(envelope.code), text(envelope.type), text(envelope.error)],
  };
}

/** Inspect small error bodies only. Cancel oversized bodies without buffering the rest. */
async function readErrorFields(response: Response, onActivity?: () => void) {
  const reader = response.body?.getReader();
  if (!reader) return errorFields(null);
  let size = 0;
  let body = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      onActivity?.();
      if (chunk.done) return errorFields(JSON.parse(body + decoder.decode()));
      size += chunk.value.byteLength;
      if (size > 8192) return errorFields(null);
      body += decoder.decode(chunk.value, {stream: true});
    }
  } catch {
    return errorFields(null);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function billingHint(message: string, sanitize: (text: string) => string): string | undefined {
  // Omit embedded diagnostic dumps. Only publish the single human-readable error line.
  if (/[{}]|\b(?:headers?|authorization|api[ -]key|cookie|request body|payload)\s*:/i.test(message)) return;
  const safe = sanitize(message.split(/[\r\n]/, 1)[0] ?? '')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, url => url.replace(/[?#].*$/, '').replace(/^(https?:\/\/)[^/]*@/i, '$1'))
    .replace(/\s+/g, ' ')
    .trim();
  return safe.length > 200 ? `${safe.slice(0, 199).trimEnd()}…` : safe || undefined;
}
export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(normalizeError(null, signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, {once: true});
  });
}
export function retryDelay(attempt: number, retryMs: number | null, random = Math.random): number {
  return Math.min(30000, Math.max(retryMs ?? 0, Math.floor(250 * 2 ** attempt * (0.5 + random()))));
}

/** Supplies the bearer token of a `command` provider (the composition root runs the user's command). */
export type TokenSource = (provider: Provider, account: Account, signal?: AbortSignal) => Promise<string | undefined>;

/**
 * Host-config request decoration (ADR 0046): query parameters, static headers and headers whose value
 * comes from an environment variable. Credential headers already set by the adapter are never replaced
 * by static headers; env headers are applied only when the variable is set and non-empty (Codex).
 */
export function decorate(
  provider: Provider,
  target: URL,
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, value] of Object.entries(provider.queryParams ?? {}))
    if (!target.searchParams.has(name)) target.searchParams.set(name, value);
  for (const [name, value] of Object.entries(provider.httpHeaders ?? {}))
    if (!headers.has(name)) headers.set(name, value);
  for (const [name, variable] of Object.entries(provider.envHttpHeaders ?? {})) {
    const value = env[variable];
    if (value) headers.set(name, value);
  }
}

export class ProviderTransport {
  constructor(
    readonly provider: Provider,
    readonly account: Account,
    private readonly vault: CredentialVault,
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokenSource?: TokenSource,
    private readonly sanitizeErrorText?: (text: string) => string,
  ) {}
  async credential(signal?: AbortSignal): Promise<string | undefined> {
    this.policy.authorize(this.provider, this.account);
    if (this.provider.auth === 'command' || this.provider.auth === 'oauth') {
      const token = await this.tokenSource?.(this.provider, this.account, signal);
      if (!token) throw new FutrynError('AUTH');
      return token;
    }
    const key = await this.vault.get(this.account.credential);
    if (this.provider.auth === 'api-key' && !key) throw new FutrynError('AUTH');
    return key;
  }
  /** `onActivity` runs when headers arrive and on every body chunk (idle-timeout bookkeeping). */
  async request(
    url: string | URL | Request,
    init: RequestInit = {},
    limit = 4 * 1024 * 1024,
    onActivity?: () => void,
  ): Promise<Response> {
    this.policy.authorize(this.provider, this.account);
    const target = new URL(url instanceof Request ? url.url : url.toString());
    const base = new URL(this.provider.baseURL);
    const allowedPath =
      target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') ||
      (this.provider.catalog === 'ollama' && target.pathname === '/api/tags');
    if (
      target.origin !== base.origin ||
      !allowedPath ||
      target.username ||
      target.password ||
      target.hash ||
      target.searchParams.has('key')
    )
      throw new FutrynError('POLICY');
    const headers = new Headers(init.headers);
    decorate(this.provider, target, headers);
    let payload: BodyInit | null | undefined = init.body;
    // Large request bodies are zstd-compressed where the provider requires it (ADR 0047).
    if (
      this.provider.requestEncoding === 'zstd' &&
      typeof payload === 'string' &&
      Buffer.byteLength(payload) > 256 * 1024
    ) {
      payload = new Uint8Array(await Bun.zstdCompress(new TextEncoder().encode(payload))) as unknown as BodyInit;
      headers.set('content-encoding', 'zstd');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(target, {...init, body: payload, headers, redirect: 'error'});
    } catch {
      throw init.signal?.aborted ? normalizeError(null, init.signal) : new FutrynError('TRANSPORT', true);
    }
    onActivity?.();
    if (!response.ok) {
      const contextStatus = response.status === 400 || response.status === 413;
      if (contextStatus || [402, 403, 429].includes(response.status)) {
        const {message, markers} = await readErrorFields(response, onActivity);
        if (init.signal?.aborted) throw normalizeError(null, init.signal);
        if (contextStatus) {
          if (markers.some(marker => contextErrorCodes.has(marker))) throw new FutrynError('CONTEXT_LIMIT');
        } else if (
          response.status === 402 ||
          [...markers, message].some(text => billingMarker.test(text.replaceAll('_', ' ')))
        ) {
          this.policy.authorize(this.provider, this.account);
          throw new ProviderBillingError(this.sanitizeErrorText && billingHint(message, this.sanitizeErrorText));
        }
      } else {
        await response.body?.cancel();
      }
      throw statusError(response.status, response.headers.get('retry-after'));
    }
    if (!response.body) throw new FutrynError('PROTOCOL');
    const reader = response.body.getReader();
    let size = 0;
    const authorize = () => this.policy.authorize(this.provider, this.account);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          authorize();
          onActivity?.();
          if (chunk.done) {
            controller.close();
            return;
          }
          size += chunk.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            controller.error(new FutrynError('PROTOCOL'));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (e) {
          await reader.cancel().catch(() => {});
          controller.error(
            e instanceof FutrynError
              ? e
              : init.signal?.aborted
                ? normalizeError(null, init.signal)
                : new FutrynError('PROTOCOL'),
          );
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {status: response.status, headers: response.headers});
  }
  async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.provider.timeoutMs)]);
    const key = await this.credential(combined);
    const headers: Record<string, string> = {};
    if (key) {
      if (this.provider.protocol === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else if (this.provider.protocol === 'gemini') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const url = /^https?:\/\//.test(path)
          ? path
          : path.startsWith('/api/')
            ? new URL(path, this.provider.baseURL).href
            : this.provider.baseURL.replace(/\/$/, '') + '/' + path;
        return await (await this.request(url, {headers, signal: combined})).json();
      } catch (error) {
        const safe = normalizeError(error, combined);
        if (!safe.retryable || attempt >= 2 || combined.aborted) throw safe;
        await wait(retryDelay(attempt, safe.retryAfterMs), combined);
      }
    }
  }
}
