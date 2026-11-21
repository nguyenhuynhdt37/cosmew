import {FutrynError, type ProviderAuthChallenge} from '@cosmew/contracts';
import {Redactor} from './secrets';

/** Official OpenRouter headless PKCE flow. No consumer subscription tokens,
 * browser cookies, credential imports, dynamic token endpoints or vault access.
 * https://openrouter.ai/docs/guides/overview/auth/oauth (2026-11-14). */
export class OpenRouterPKCE {
  private readonly challenges = new Map<string, {verifier: string; expires: number}>();
  constructor(
    private readonly redactor: Redactor,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  async begin(): Promise<ProviderAuthChallenge> {
    for (const [id, challenge] of this.challenges) if (challenge.expires <= this.now()) this.challenges.delete(id);
    if (this.challenges.size >= 16) throw new FutrynError('POLICY');
    const id = crypto.randomUUID();
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('code_challenge', Buffer.from(digest).toString('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('key_label', 'COSMEW');
    const expires = this.now() + 600_000;
    this.challenges.set(id, {verifier, expires});
    return {id, authorizationURL: url.href, expiresAt: new Date(expires).toISOString()};
  }

  cancel(id: string): void {
    this.challenges.delete(id);
  }

  async complete(id: string, code: string, signal?: AbortSignal): Promise<string> {
    const challenge = this.challenges.get(id);
    this.challenges.delete(id); // Single-use, including failure and cancellation.
    if (!challenge || challenge.expires <= this.now()) throw new FutrynError('AUTH');
    if (!code || code.length > 8192 || /[\x00-\x20\x7f]/.test(code)) throw new FutrynError('INVALID_INPUT');
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    this.redactor.register(code);
    this.redactor.register(challenge.verifier);
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    try {
      const response = await this.fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
        body: JSON.stringify({code, code_verifier: challenge.verifier, code_challenge_method: 'S256'}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FutrynError(response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'TRANSPORT' : 'AUTH');
      }
      if (!response.body) throw new FutrynError('PROTOCOL');
      const reader = response.body.getReader();
      let raw = '';
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384) throw new FutrynError('PROTOCOL');
          raw += decoder.decode(value, {stream: true});
        }
      } finally {
        await reader.cancel();
      }
      const data = JSON.parse(raw + decoder.decode());
      if (typeof data?.key !== 'string' || !data.key || data.key.length > 8192 || /[\x00-\x20\x7f]/.test(data.key))
        throw new FutrynError('PROTOCOL');
      this.redactor.register(data.key);
      if (combined.aborted) throw new FutrynError('CANCELLED');
      return data.key;
    } catch (error) {
      if (combined.aborted) throw new FutrynError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
      if (error instanceof FutrynError) throw error;
      throw new FutrynError('PROTOCOL');
    }
  }
}
