import {spawn} from 'node:child_process';
import {
  FutrynError,
  type Account,
  type CredentialVault,
  type ProviderAuthChallenge,
  type ProviderAuthProgress,
} from '@futryn/contracts';
import type {Redactor} from '@futryn/security';

/**
 * "Sign in with ChatGPT" for the direct API (ADR 0047): OAuth authorization code + PKCE against
 * auth.openai.com with a dynamically registered, Futryn-owned client. The authorization request names
 * the registration client `dynamic_agent_client` with `agent_name_hint=Futryn`; the callback returns the
 * client id OpenAI issued. Mechanism and endpoints follow OpenCode 0ac0d7e
 * (packages/core/src/plugin/provider/chatgpt.ts); live behavior is Needs verification (ADR 0047).
 * Tokens live only in the OS keyring (as the account's secret) and are refreshed here.
 */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'Futryn';
export const TOKEN_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
const DEFAULT_ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const LOGIN_WINDOW_MS = 600_000;

export interface ChatGPTOAuthOptions {
  issuer?: string;
  fetch?: typeof fetch;
  openURL?: (url: string) => Promise<void>;
  now?: () => number;
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

  constructor(
    private readonly redactor: Redactor,
    options: ChatGPTOAuthOptions = {},
  ) {
    this.issuer = options.issuer ?? DEFAULT_ISSUER;
    this.fetchImpl = options.fetch ?? fetch;
    this.openURL = options.openURL ?? openExternalURL;
    this.now = options.now ?? Date.now;
  }

  private get tokenURL() {
    return `${this.issuer}/api/accounts/oauth/token`;
  }

  async begin(signal?: AbortSignal): Promise<ProviderAuthChallenge> {
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
    const page = (message: string, status = 200) =>
      new Response(`<!doctype html><meta charset="utf-8"><title>Futryn</title><p>${message}</p>`, {
        status,
        headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'},
      });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const url = new URL(request.url);
        if (url.pathname !== '/auth/callback') return new Response('Not found', {status: 404});
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error || !code || url.searchParams.get('state') !== state) {
          reject(new FutrynError('AUTH'));
          return page('Sign-in failed. Return to Futryn and try again.', 400);
        }
        resolve({code, clientID: url.searchParams.get('client_id') ?? undefined});
        return page('Signed in. You can close this window and return to Futryn.');
      },
    });
    const redirect = `http://127.0.0.1:${server.port}/auth/callback`;
    const authorizationURL = `${this.issuer}/api/accounts/authorize?${new URLSearchParams({
      client_id: REGISTRATION_CLIENT_ID,
      agent_name_hint: AGENT_NAME,
      ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}`,
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
    clearTimeout(login.timer);
    login.progress.state = 'failed';
    login.reject(new FutrynError('CANCELLED'));
    login.server.stop(true);
  }

  /** Waits for the browser callback, exchanges the code and returns the vault secret (a token record). */
  async complete(id: string, signal?: AbortSignal): Promise<string> {
    const login = this.logins.get(id);
    if (!login) throw new FutrynError('AUTH');
    const abort = () => this.cancel(id);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      const result = await login.received;
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      const clientID = result.clientID;
      if (!clientID) throw new FutrynError('PROTOCOL');
      this.redactor.register(result.code);
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
      if (!tokens.scope?.split(' ').includes(TOKEN_SHARING_SCOPE)) throw new FutrynError('FORBIDDEN');
      if (!tokens.id_token) throw new FutrynError('PROTOCOL');
      await this.verifyIDToken(tokens.id_token, clientID, login.nonce);
      return JSON.stringify(this.record(tokens, clientID));
    } catch (error) {
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
        headers: {'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Futryn'},
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
    } catch {
      throw new FutrynError(signal?.aborted ? 'CANCELLED' : 'TRANSPORT', !signal?.aborted);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // A refused grant (revoked, expired or reused refresh token) needs a new sign-in.
      throw new FutrynError(
        response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'TRANSPORT' : 'AUTH',
        response.status >= 500,
      );
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
  private async verifyIDToken(token: string, clientID: string, nonce: string): Promise<void> {
    try {
      const [head, body, signature] = token.split('.');
      if (!head || !body || !signature) throw new Error('shape');
      const header = JSON.parse(Buffer.from(head, 'base64url').toString());
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (header.alg !== 'RS256') throw new Error('alg');
      const response = await this.fetchImpl(`${this.issuer}/.well-known/jwks.json`, {
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('jwks');
      const jwks = (await response.json()) as {keys?: (JsonWebKey & {kid?: string})[]};
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
    } catch {
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
