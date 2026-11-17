import {FutrynError, providerSchema, type Account, type NetworkPolicy, type Provider} from '@futryn/contracts';

export function validateEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new FutrynError('POLICY');
  return url.href.replace(/\/$/, '');
}

export class ConfiguredNetworkPolicy implements NetworkPolicy {
  authorize(provider: Provider, account: Account): void {
    providerSchema.parse(provider);
    validateEndpoint(provider.baseURL);
    if (
      account.providerId !== provider.id ||
      account.status === 'logged-out' ||
      ((provider.auth === 'api-key' || provider.auth === 'oauth') && account.credential.kind === 'none')
    )
      throw new FutrynError('POLICY');
  }
}

/** Explicit CLI advisory-catalog capability. Never accepts credentials or prompts. */
export async function fetchModelsDev(signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const target = validateEndpoint('https://models.dev/api.json');
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
  try {
    const response = await fetchImpl(target, {redirect: 'error', signal: combined, credentials: 'omit'});
    if (!response.ok || !response.body) throw new FutrynError('TRANSPORT');
    let bytes = 0;
    let text = '';
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32 * 1024 * 1024) throw new FutrynError('PROTOCOL');
        text += decoder.decode(chunk.value, {stream: true});
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(text + decoder.decode());
  } catch (e) {
    if (e instanceof FutrynError) throw e;
    if (combined.aborted) throw new FutrynError(combined.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
    throw new FutrynError('PROTOCOL');
  }
}
