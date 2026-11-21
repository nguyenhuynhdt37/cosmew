import {spawn} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {
  FutrynError,
  type Account,
  type CredentialVault,
  type ProviderAuthChallenge,
  type ProviderAuthProgress,
} from '@cosmew/contracts';
import type {Redactor} from '@cosmew/security';

/**
 * "Sign in with ChatGPT" for the direct API (ADR 0047): OAuth authorization code + PKCE against
 * auth.openai.com with a dynamically registered, Cosmew-owned client. The authorization request names
 * the registration client `dynamic_agent_client` with `agent_name_hint=Cosmew`; the callback returns the
 * client id OpenAI issued. Mechanism and endpoints follow OpenCode 0ac0d7e
 * (packages/core/src/plugin/provider/chatgpt.ts); live behavior is Needs verification (ADR 0047).
 * Tokens live only in the OS keyring (as the account's secret) and are refreshed here.
 */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Cosmew';
export const TOKEN_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
const DEFAULT_ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const LOGIN_WINDOW_MS = 600_000;

// Provider text is untrusted. Only standard OAuth error names may reach the callback page.
const GRANT_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
]);
class OAuthGrantError extends FutrynError {
  constructor(
    readonly status: number,
    readonly reason?: string,
  ) {
    super(status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'TRANSPORT' : 'AUTH', status >= 500);
  }
}

export interface ChatGPTOAuthOptions {
  issuer?: string;
  fetch?: typeof fetch;
  openURL?: (url: string) => Promise<void>;
  now?: () => number;
  hostID?: string;
}

interface TokenRecord {
  v: 1;
  access: string;
  refresh: string;
  expires: number;
  clientID: string;
}
interface Login {
  server: ReturnType<typeof Bun.serve>;
  received: Promise<{code: string; clientID?: string}>;
  progress: ProviderAuthProgress;
  pkce: {verifier: string};
  nonce: string;
  redirect: string;
  timer: ReturnType<typeof setTimeout>;
  reject(error: unknown): void;
  respond?(message: string, status: number): void;
  clientID?: string;
  recoveryUsed: boolean;
  abort: AbortController;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function openExternalURL(url: string): Promise<void> {
  const executable =
    process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {stdio: 'ignore', shell: false});
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new FutrynError('TRANSPORT'))));
  });
}

export class ChatGPTOAuth {
  private readonly logins = new Map<string, Login>();
  private readonly refreshing = new Map<string, Promise<TokenRecord>>();
  private readonly issuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly openURL: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly hostID: string;

  constructor(
    private readonly redactor: Redactor,
    options: ChatGPTOAuthOptions = {},
  ) {
    this.issuer = options.issuer ?? DEFAULT_ISSUER;
    this.fetchImpl = options.fetch ?? fetch;
    this.openURL = options.openURL ?? openExternalURL;
    this.now = options.now ?? Date.now;
    this.hostID = options.hostID ?? `urn:uuid:${crypto.randomUUID()}`;
  }

  private get tokenURL() {
    return `${this.issuer}/api/accounts/oauth/token`;
  }

  async begin(signal?: AbortSignal, clientID?: string): Promise<ProviderAuthChallenge> {
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    if (this.logins.size >= 4) throw new FutrynError('POLICY');
    const id = crypto.randomUUID();
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = random();
    const nonce = random();
    let resolve!: (value: {code: string; clientID?: string}) => void;
    let reject!: (error: unknown) => void;
    const received = new Promise<{code: string; clientID?: string}>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void received.catch(() => {});
    let settled = false;
    const page = (message: string, status = 200) =>
      new Response(`<!doctype html><meta charset="utf-8"><title>Cosmew</title><p>${message}</p>`, {
        status,
        headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
      });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const url = new URL(request.url);
        if (url.pathname !== '/auth/callback') return new Response('Not found', {status: 404});
        // Only a request carrying this login's state may decide it; anything else (another local
        // process, a web page) gets 400 and cannot abort or complete the pending sign-in.
        const given = Buffer.from(url.searchParams.get('state') ?? '');
        const expected = Buffer.from(state);
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
          return page('This request does not belong to the pending sign-in.', 400);
        if (settled) return page('This sign-in was already answered.', 409);
        settled = true;
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error || !code) {
          reject(new FutrynError('AUTH'));
          setTimeout(() => server.stop(), 0);
          return page('Sign-in failed. Return to Cosmew and try again.', 400);
        }
        // Keep the browser response pending until the code exchange and identity verification finish.
        // Receiving an authorization code alone does not mean the sign-in succeeded.
        return new Promise<Response>(respond => {
          const login = this.logins.get(id)!;
          login.respond = (message, status) => respond(page(message, status));
          resolve({code, clientID: url.searchParams.get('client_id') ?? undefined});
        });
      },
    });
    const redirect = `http://127.0.0.1:${server.port}/auth/callback`;
    const authorizationURL = `${this.issuer}/api/accounts/authorize?${new URLSearchParams({
      client_id: clientID ?? REGISTRATION_CLIENT_ID,
      ...(clientID ? {} : {agent_name_hint: AGENT_NAME}),
      ext_agent_host_id: this.hostID,
      response_type: 'code',
      redirect_uri: redirect,
      scope: `openid profile email offline_access resource.invoke ${TOKEN_SHARING_SCOPE}`,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    })}`;
    const login: Login = {
      server,
      received,
      pkce: {verifier},
      nonce,
      redirect,
      progress: {state: 'pending', authorizationURL, message: 'Complete ChatGPT sign-in in your browser.'},
      reject,
      clientID,
      recoveryUsed: clientID !== undefined,
      abort: new AbortController(),
      timer: setTimeout(() => this.cancel(id), LOGIN_WINDOW_MS),
    };
    this.logins.set(id, login);
    this.redactor.register(verifier);
    void this.openURL(authorizationURL).catch(() => {
      login.progress.message = 'Open the URL below to finish signing in.';
    });
    return {
      id,
      authorizationURL,
      expiresAt: new Date(this.now() + LOGIN_WINDOW_MS).toISOString(),
      autoComplete: true,
      message: login.progress.message,
    };
  }

  progress(id: string): ProviderAuthProgress {
    const login = this.logins.get(id);
    if (!login) throw new FutrynError('NOT_FOUND');
    return {...login.progress};
  }

  has(id: string): boolean {
    return this.logins.has(id);
  }

  /** Cancel and forget a pending sign-in: the listener closes and nothing is stored. */
  cancel(id: string): void {
    const login = this.logins.get(id);
    if (!login) return;
    this.logins.delete(id);
    login.abort.abort();
    clearTimeout(login.timer);
    login.progress.state = 'failed';
    login.reject(new FutrynError('CANCELLED'));
    login.respond?.('Sign-in cancelled. Return to Cosmew to start again.', 400);
    login.server.stop();
  }

  /** Waits for the browser callback, exchanges the code and returns the vault secret (a token record). */
  async complete(id: string, signal?: AbortSignal): Promise<string> {
    const login = this.logins.get(id);
    if (!login) throw new FutrynError('AUTH');
    signal = AbortSignal.any([login.abort.signal, ...(signal ? [signal] : [])]);
    const abort = () => this.cancel(id);
    signal?.addEventListener('abort', abort, {once: true});
    let failure = 'ChatGPT returned a missing or mismatched client ID. Return to Cosmew and try signing in again.';
    try {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      const result = await login.received;
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (login.clientID && result.clientID && login.clientID !== result.clientID) throw new FutrynError('AUTH');
      const clientID = login.clientID ?? result.clientID;
      if (!clientID) throw new FutrynError('PROTOCOL');
      login.clientID = clientID;
      this.redactor.register(result.code);
      failure = 'ChatGPT token exchange failed. Return to Cosmew to check the connection or sign in again.';
      const tokens = await this.tokenRequest(
        {
          grant_type: 'authorization_code',
          client_id: clientID,
          code: result.code,
          code_verifier: login.pkce.verifier,
          redirect_uri: login.redirect,
          resource: RESOURCE,
        },
        signal,
      );
      failure = 'ChatGPT did not grant token sharing. Sign in again and allow token sharing, or use an OpenAI API key.';
      if (!tokens.scope?.split(' ').includes(TOKEN_SHARING_SCOPE)) throw new FutrynError('FORBIDDEN');
      failure = 'ChatGPT returned a missing or invalid ID token. Return to Cosmew and try signing in again.';
      if (!tokens.id_token) throw new FutrynError('PROTOCOL');
      await this.verifyIDToken(tokens.id_token, clientID, login.nonce, signal);
      login.respond?.('ChatGPT identity verified. Return to Cosmew to finish checking API access.', 200);
      login.respond = undefined;
      return JSON.stringify(this.record(tokens, clientID));
    } catch (error) {
      // OpenAI's documented invalid_grant recovery: never resend the code. Reauthorize once with
      // the issued client, fresh state/nonce/PKCE and the same host identity, within this login.
      if (
        error instanceof OAuthGrantError &&
        error.reason === 'invalid_grant' &&
        login.clientID &&
        !login.recoveryUsed &&
        !signal.aborted
      ) {
        login.respond?.(
          'OpenAI refused the authorization code. A fresh ChatGPT sign-in is opening in your browser.',
          400,
        );
        login.respond = undefined;
        login.server.stop();
        const next = await this.begin(signal, login.clientID);
        login.progress = this.logins.get(next.id)!.progress;
        login.progress.message = 'OpenAI refused the first code. Complete the fresh browser sign-in. Esc cancels.';
        const reject = login.reject;
        login.reject = error => {
          reject(error);
          this.cancel(next.id);
        };
        return await this.complete(next.id, signal);
      }
      if (error instanceof FutrynError && ['TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'].includes(error.code))
        failure = 'ChatGPT verification service is unavailable or rate limited. Check the connection and retry later.';
      if (error instanceof OAuthGrantError)
        failure = `OpenAI rejected the token exchange (HTTP ${error.status}${error.reason ? `, ${error.reason}` : ''}). Return to Cosmew. No credentials were stored.`;
      login.respond?.(signal?.aborted ? 'Sign-in cancelled. Return to Cosmew to start again.' : failure, 400);
      login.respond = undefined;
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      throw error instanceof FutrynError ? error : new FutrynError('AUTH');
    } finally {
      signal?.removeEventListener('abort', abort);
      this.cancel(id);
    }
  }

  private record(tokens: {access_token: string; refresh_token: string; expires_in?: number}, clientID: string) {
    this.redactor.register(tokens.access_token);
    this.redactor.register(tokens.refresh_token);
    return {
      v: 1,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: this.now() + (tokens.expires_in ?? 3600) * 1000,
      clientID,
    } satisfies TokenRecord;
  }

  private async tokenRequest(form: Record<string, string>, signal?: AbortSignal) {
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenURL, {
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Cosmew'},
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
    } catch {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      // AbortSignal.timeout() is part of the bounded exchange deadline. Preserve that
      // distinction so callers can offer retry guidance instead of blaming credentials.
      throw new FutrynError(combined.aborted ? 'TIMEOUT' : 'TRANSPORT', true);
    }
    if (!response.ok) {
      // Read only a bounded error body and expose an allowlisted error name, never its description.
      let reason: string | undefined;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          let size = 0;
          let text = '';
          const decoder = new TextDecoder();
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 65536) break;
            text += decoder.decode(next.value, {stream: true});
          }
          if (size <= 65536) {
            const data = JSON.parse(text + decoder.decode());
            const value = typeof data?.error === 'string' ? data.error : data?.error?.code;
            if (GRANT_ERRORS.has(value)) reason = value;
          }
        } catch {
          // The status remains useful even if the error body is absent or malformed.
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      // A refused grant (revoked, expired or reused refresh token) needs a new sign-in.
      throw new OAuthGrantError(response.status, reason);
    }
    const text = await response.text();
    if (text.length > 65536) throw new FutrynError('PROTOCOL');
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FutrynError('PROTOCOL');
    }
    if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string')
      throw new FutrynError('PROTOCOL');
    return data as {
      access_token: string;
      refresh_token: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }

  /** RS256 id_token: signature against the issuer's JWKS, issuer, audience, expiry, subject and nonce. */
  private async verifyIDToken(token: string, clientID: string, nonce: string, signal?: AbortSignal): Promise<void> {
    // Key discovery is a network operation, not a credential check. Preserve its failure category
    // so outages do not send the user through repeated sign-ins, and honour cancellation throughout.
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]);
    let jwks: {keys?: (JsonWebKey & {kid?: string})[]};
    try {
      const response = await this.fetchImpl(`${this.issuer}/.well-known/jwks.json`, {
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FutrynError(response.status === 429 ? 'RATE_LIMIT' : 'TRANSPORT', true);
      }
      const text = await response.text();
      if (text.length > 65536) throw new FutrynError('PROTOCOL');
      try {
        jwks = JSON.parse(text);
        if (!jwks || !Array.isArray(jwks.keys)) throw new Error('shape');
      } catch {
        throw new FutrynError('PROTOCOL');
      }
    } catch (error) {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (error instanceof FutrynError) throw error;
      throw new FutrynError(combined.aborted ? 'TIMEOUT' : 'TRANSPORT', true);
    }
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    try {
      const [head, body, signature] = token.split('.');
      if (!head || !body || !signature) throw new Error('shape');
      const header = JSON.parse(Buffer.from(head, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (header.alg !== 'RS256') throw new Error('alg');
      const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA');
      if (!jwk) throw new Error('kid');
      const key = await crypto.subtle.importKey('jwk', jwk, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, [
        'verify',
      ]);
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${head}.${body}`),
      );
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        !valid ||
        claims.iss !== this.issuer ||
        !audience.includes(clientID) ||
        typeof claims.exp !== 'number' ||
        claims.exp * 1000 <= this.now() ||
        typeof claims.sub !== 'string' ||
        !claims.sub.trim() ||
        claims.nonce !== nonce
      )
        throw new Error('claims');
      if (signal?.aborted) throw new FutrynError('CANCELLED');
    } catch {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      throw new FutrynError('AUTH');
    }
  }

  /** A valid access token for the account, refreshed (single flight) shortly before it expires. */
  async accessToken(account: Account, vault: CredentialVault, signal?: AbortSignal): Promise<string> {
    if (account.credential.kind !== 'keyring') throw new FutrynError('AUTH');
    const raw = await vault.get(account.credential);
    if (!raw) throw new FutrynError('AUTH');
    let record: TokenRecord;
    try {
      record = JSON.parse(raw);
      if (record.v !== 1 || !record.access || !record.refresh || !record.clientID) throw new Error('shape');
    } catch {
      throw new FutrynError('AUTH');
    }
    if (record.expires - 60_000 > this.now()) return record.access;
    const key = account.credential.key;
    let flight = this.refreshing.get(key);
    if (!flight) {
      flight = (async () => {
        const tokens = await this.tokenRequest(
          {grant_type: 'refresh_token', client_id: record.clientID, refresh_token: record.refresh, resource: RESOURCE},
          signal,
        );
        const next = this.record(tokens, record.clientID);
        // Refresh tokens may rotate: the new record replaces the old one before anything is used.
        await vault.set(key, JSON.stringify(next));
        return next;
      })().finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, flight);
    }
    return (await flight).access;
  }
}
