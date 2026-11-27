import {
  FutrynError,
  ProviderBillingError,
  type Account,
  type CredentialVault,
  type NetworkPolicy,
  type Provider,
} from '@cosmew/contracts';
import {resolveAwsCredentials} from './aws-auth';
import {signAwsSigV4} from './aws-sigv4';
import {GoogleAdcTokenProvider} from './google-auth';

function unwrapCosmewError(error: unknown): FutrynError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= 10 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof FutrynError) return current;
    current = (current as {cause?: unknown}).cause;
  }
  return undefined;
}

function normalizedErrorFields(error: unknown): {message: string; markers: string[]} {
  if (!error || typeof error !== 'object') return {message: '', markers: []};
  const value = error as Record<string, unknown>;
  const messages: string[] = [];
  const markers: string[] = [];
  const collect = (source: unknown) => {
    const fields = errorFields(source);
    if (fields.message) messages.push(fields.message);
    for (const marker of fields.markers) if (marker) markers.push(marker);
  };
  collect(value);
  if (value.data && typeof value.data === 'object') collect(value.data);
  if (typeof value.responseBody === 'string' && value.responseBody.length <= 8192) {
    try {
      collect(JSON.parse(value.responseBody));
    } catch {
      messages.push(value.responseBody);
    }
  }
  return {message: messages.join(' '), markers};
}

export function normalizeError(error: unknown, signal?: AbortSignal): FutrynError {
  if (signal?.aborted) return new FutrynError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
  const wrapped = unwrapCosmewError(error);
  if (wrapped) {
    if (isEncryptedHistoryError(wrapped) || isEncryptedHistoryError(error))
      (wrapped as unknown as {encryptedHistory?: boolean}).encryptedHistory = true;
    if (isCacheControlRejectionError(wrapped) || isCacheControlRejectionError(error))
      (wrapped as unknown as {cacheControlRejected?: boolean}).cacheControlRejected = true;
    return wrapped;
  }
  if (isEncryptedHistoryError(error)) {
    const err = new FutrynError('INVALID_INPUT');
    (err as unknown as {encryptedHistory?: boolean}).encryptedHistory = true;
    if (error instanceof Error && error.message) err.message = error.message;
    return err;
  }
  if (isCacheControlRejectionError(error)) {
    const err = new FutrynError('INVALID_INPUT');
    (err as unknown as {cacheControlRejected?: boolean}).cacheControlRejected = true;
    if (error instanceof Error && error.message) err.message = error.message;
    return err;
  }
  const fields = normalizedErrorFields(error);
  if (fields.markers.some(marker => contextErrorCodes.has(marker))) return new FutrynError('CONTEXT_LIMIT');
  if ([...fields.markers, fields.message].some(text => billingMarker.test(text.replaceAll('_', ' ')))) {
    return new ProviderBillingError();
  }
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
  if (status && status >= 400) return statusError(status, null);
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const cause = value.cause;
    const message = typeof value.message === 'string' ? value.message : '';
    const causeMessage = cause instanceof Error ? cause.message : '';
    if (
      value.isRetryable === true ||
      cause instanceof TypeError ||
      /\b(?:socket|network|econnreset|epipe|etimedout|premature close|terminated|fetch failed)\b/i.test(
        `${message} ${causeMessage}`,
      )
    ) {
      return new FutrynError('TRANSPORT', true);
    }
  }
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

export const encryptedHistoryMarker = /\b(?:encrypted history|reasoning\.encrypted_content|original account)\b/i;

export function isEncryptedHistoryError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && (error as {encryptedHistory?: boolean}).encryptedHistory) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && 'message' in (error as Record<string, unknown>)
          ? String((error as Record<string, unknown>).message)
          : '';
  const body =
    typeof error === 'object' && error !== null && 'responseBody' in (error as Record<string, unknown>)
      ? String((error as Record<string, unknown>).responseBody)
      : '';
  return encryptedHistoryMarker.test(message) || encryptedHistoryMarker.test(body);
}

export const cacheControlRejectionMarker = /\b(?:cache_control|cache[ _-]?point|prompt[_ -]caching)\b/i;

export function isCacheControlRejectionError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && (error as {cacheControlRejected?: boolean}).cacheControlRejected) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && 'message' in (error as Record<string, unknown>)
          ? String((error as Record<string, unknown>).message)
          : '';
  const body =
    typeof error === 'object' && error !== null && 'responseBody' in (error as Record<string, unknown>)
      ? String((error as Record<string, unknown>).responseBody)
      : '';
  return cacheControlRejectionMarker.test(message) || cacheControlRejectionMarker.test(body);
}

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

export interface CloudTransportOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  onSecret?: (secret: string) => void;
  googleAdc?: GoogleAdcTokenProvider;
  googleTokenEndpointOverride?: string;
  now?: () => Date;
}

function inferAwsRegion(provider: Provider, baseHost: string, env: Record<string, string | undefined>): string {
  if (provider.aws?.region) return provider.aws.region;
  const hostMatch = /^bedrock(?:-runtime)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/i.exec(baseHost);
  if (hostMatch?.[1]) return hostMatch[1].toLowerCase();
  const envRegion = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim();
  if (envRegion && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(envRegion)) return envRegion;
  return 'us-east-1';
}

/** Controlled AWS Bedrock control-plane catalog host matching the configured Bedrock runtime endpoint. */
export function bedrockControlPlaneOrigin(provider: Provider): string | undefined {
  if (provider.protocol !== 'bedrock') return undefined;
  const base = new URL(provider.baseURL);
  if (base.protocol === 'https:' && base.hostname.startsWith('bedrock-runtime.')) {
    return `https://bedrock.${base.hostname.slice('bedrock-runtime.'.length)}`;
  }
  return undefined;
}

function isAllowedBedrockCatalogTarget(provider: Provider, target: URL): boolean {
  if (provider.protocol !== 'bedrock' || provider.catalog !== 'bedrock') return false;
  const controlOrigin = bedrockControlPlaneOrigin(provider);
  if (!controlOrigin || target.origin !== controlOrigin) return false;
  return target.pathname === '/foundation-models' || target.pathname === '/inference-profiles';
}

function toSignableBody(payload: BodyInit | null | undefined): Uint8Array | string | null {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  throw new FutrynError('PROTOCOL');
}

export class ProviderTransport {
  private readonly defaultGoogleAdc = new GoogleAdcTokenProvider();
  constructor(
    readonly provider: Provider,
    readonly account: Account,
    private readonly vault: CredentialVault,
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokenSource?: TokenSource,
    private readonly sanitizeErrorText?: (text: string) => string,
    private readonly cloudOptions?: CloudTransportOptions,
  ) {}
  async credential(signal?: AbortSignal): Promise<string | undefined> {
    this.policy.authorize(this.provider, this.account);
    if (this.provider.auth === 'command' || this.provider.auth === 'oauth') {
      const token = await this.tokenSource?.(this.provider, this.account, signal);
      if (!token) throw new FutrynError('AUTH');
      this.cloudOptions?.onSecret?.(token);
      return token;
    }
    if (this.provider.auth === 'google-adc') {
      const adc = this.cloudOptions?.googleAdc ?? this.defaultGoogleAdc;
      return adc.getAccessToken({
        credentialFile: this.provider.vertex?.credentialFile,
        env: this.cloudOptions?.env,
        homeDir: this.cloudOptions?.homeDir,
        fetchImpl: this.fetchImpl,
        tokenEndpointOverride: this.cloudOptions?.googleTokenEndpointOverride,
        now: this.cloudOptions?.now ? () => this.cloudOptions!.now!().getTime() : undefined,
        onSecret: this.cloudOptions?.onSecret,
        signal,
      });
    }
    if (this.provider.auth === 'aws-sigv4') {
      // Validate AWS credentials eagerly so missing credentials surface as AUTH before invoking the SDK.
      resolveAwsCredentials({
        profile: this.provider.aws?.profile,
        env: this.cloudOptions?.env,
        homeDir: this.cloudOptions?.homeDir,
        onSecret: this.cloudOptions?.onSecret,
      });
      return undefined;
    }
    const key = await this.vault.get(this.account.credential);
    if (this.provider.auth === 'api-key' && !key) throw new FutrynError('AUTH');
    if (key) this.cloudOptions?.onSecret?.(key);
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
    const allowedBedrockControl = isAllowedBedrockCatalogTarget(this.provider, target);
    const allowedPath =
      allowedBedrockControl ||
      target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') ||
      (this.provider.catalog === 'ollama' && target.pathname === '/api/tags');
    if (
      (!allowedBedrockControl && target.origin !== base.origin) ||
      !allowedPath ||
      target.username ||
      target.password ||
      target.hash ||
      target.searchParams.has('key')
    )
      throw new FutrynError('POLICY');
    const headers = new Headers(init.headers);
    const env = this.cloudOptions?.env ?? process.env;
    decorate(this.provider, target, headers, env);
    if (
      this.provider.protocol === 'azure' &&
      this.provider.azure?.apiVersion &&
      !target.searchParams.has('api-version') &&
      this.provider.azure.useDeploymentBasedUrls !== false
    ) {
      target.searchParams.set('api-version', this.provider.azure.apiVersion);
    }
    if (this.provider.protocol === 'azure' && this.provider.auth === 'api-key') {
      const bearer = headers.get('authorization');
      if (bearer && /^Bearer\s+/i.test(bearer) && !headers.has('api-key')) {
        headers.set('api-key', bearer.replace(/^Bearer\s+/i, ''));
        headers.delete('authorization');
      }
    }
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
    if (this.provider.protocol === 'bedrock' && this.provider.auth === 'aws-sigv4') {
      const credentials = resolveAwsCredentials({
        profile: this.provider.aws?.profile,
        env,
        homeDir: this.cloudOptions?.homeDir,
        onSecret: this.cloudOptions?.onSecret,
      });
      const region = inferAwsRegion(this.provider, base.hostname, env);
      signAwsSigV4({
        method: init.method ?? 'GET',
        url: target,
        headers,
        body: toSignableBody(payload),
        service: 'bedrock',
        region,
        credentials,
        now: this.cloudOptions?.now?.(),
      });
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
          if (encryptedHistoryMarker.test(message) || markers.some(m => encryptedHistoryMarker.test(m))) {
            const err = new FutrynError('INVALID_INPUT');
            err.message = message || 'This conversation contains encrypted history for the original account.';
            (err as unknown as {encryptedHistory?: boolean}).encryptedHistory = true;
            throw err;
          }
          if (cacheControlRejectionMarker.test(message) || markers.some(m => cacheControlRejectionMarker.test(m))) {
            const err = new FutrynError('INVALID_INPUT');
            err.message = message || 'Provider rejected cache_control prompt caching fields.';
            (err as unknown as {cacheControlRejected?: boolean}).cacheControlRejected = true;
            throw err;
          }
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
                : new FutrynError('TRANSPORT', true),
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
      } else if (
        this.provider.protocol === 'gemini' ||
        ((this.provider.protocol === 'vertex' || this.provider.protocol === 'vertex-anthropic') &&
          this.provider.auth === 'api-key')
      ) {
        headers['x-goog-api-key'] = key;
      } else if (this.provider.protocol === 'azure' && this.provider.auth === 'api-key') {
        headers['api-key'] = key;
      } else {
        headers.authorization = `Bearer ${key}`;
      }
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
