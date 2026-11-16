import {FutrynError, type Account, type CredentialVault, type NetworkPolicy, type Provider} from '@futryn/contracts';

export function normalizeError(error: unknown, signal?: AbortSignal): FutrynError {
  if (signal?.aborted) return new FutrynError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
  if (error instanceof FutrynError) return error;
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : undefined;
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
  if (status === 403) return new FutrynError('FORBIDDEN');
  if (status === 404) return new FutrynError('NOT_FOUND');
  if (status === 429) return new FutrynError('RATE_LIMIT', true, retryAfter(retry));
  if (status >= 500) return new FutrynError('TRANSPORT', true, retryAfter(retry));
  return new FutrynError('INVALID_INPUT');
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

export class ProviderTransport {
  constructor(
    readonly provider: Provider,
    readonly account: Account,
    private readonly vault: CredentialVault,
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async credential(): Promise<string | undefined> {
    this.policy.authorize(this.provider, this.account);
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
    let response: Response;
    try {
      response = await this.fetchImpl(target, {...init, redirect: 'error'});
    } catch {
      throw init.signal?.aborted ? normalizeError(null, init.signal) : new FutrynError('TRANSPORT', true);
    }
    onActivity?.();
    if (!response.ok) {
      await response.body?.cancel();
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
    const key = await this.credential();
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
        const url = path.startsWith('/api/')
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
