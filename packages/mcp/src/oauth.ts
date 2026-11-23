import {pinnedMcpOAuthFetch, validateMcpOAuthFetchTarget, type McpOAuthLookup} from './oauth-network';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {
  auth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';

import {LATEST_PROTOCOL_VERSION} from '@modelcontextprotocol/sdk/types.js';
import type {McpOAuthIssue} from '@cosmew/contracts';

export class McpOAuthError extends UnauthorizedError {
  constructor(readonly issue: McpOAuthIssue) {
    super('MCP_OAUTH_FAILED');
  }
}

export interface McpAuthStore {
  read(endpoint: string): Promise<unknown | undefined>;
  write(endpoint: string, value: unknown): Promise<void>;
  delete(endpoint: string): Promise<void>;
}
export interface McpOAuthOptions {
  store: McpAuthStore;
  openURL(url: string): Promise<void>;
  fetch?: FetchLike;
  registerSecret?(secret: string): void;
  timeoutMs?: number;
  lookup?: McpOAuthLookup;
}
export interface McpOAuthStatus {
  status: 'needs-login' | 'authorized' | 'expired';
  scopes?: string[];
  issue?: McpOAuthIssue;
}
export interface McpLogoutResult {
  localCleared: true;
  remoteRevoked: boolean;
  remoteStatus: 'revoked' | 'unsupported' | 'failed' | 'not-needed';
}
interface AuthRecord {
  _storeEpoch?: string;
  _storeRevision?: string;
  endpoint: string;
  discovery?: OAuthDiscoveryState;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  bearer?: string;
}
interface Login {
  redirect: string;
  state: string;
  verifier?: string;
  consumed: boolean;
  abort: AbortController;
  expiresAt: number;
  stage: McpOAuthIssue;
  tokenAuthMethod: string;
}
const failed = () => new Error('MCP_OAUTH_FAILED');

/** Exact canonical identity; HTTP is supported only for loopback development servers. */
export function canonicalMcpEndpoint(input: string | URL): string {
  try {
    const url = new URL(input);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
      throw failed();
    return url.href;
  } catch {
    throw failed();
  }
}
function issuerOf(discovery: OAuthDiscoveryState): string {
  const issuer = canonicalMcpEndpoint(discovery.authorizationServerUrl);
  const metadata = discovery.authorizationServerMetadata;
  if (!metadata || canonicalMcpEndpoint(metadata.issuer) !== issuer) throw failed();
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
    if (endpoint) canonicalMcpEndpoint(endpoint);
  }
  return issuer;
}
function validateDiscovery(endpoint: string, discovery: OAuthDiscoveryState) {
  issuerOf(discovery);
  if (discovery.resourceMetadata && canonicalMcpEndpoint(discovery.resourceMetadata.resource) !== endpoint)
    throw failed();
}

function registrationAuthMethod(discovery: OAuthDiscoveryState): string | undefined {
  const methods = discovery.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  if (!methods) return 'none';
  return ['none', 'client_secret_basic', 'client_secret_post'].find(method => methods.includes(method));
}

function clientIssue(discovery: OAuthDiscoveryState): McpOAuthIssue | undefined {
  const metadata = discovery.authorizationServerMetadata;
  if (!metadata) return 'metadata-unavailable';
  if (
    !metadata.response_types_supported.includes('code') ||
    (metadata.grant_types_supported && !metadata.grant_types_supported.includes('authorization_code')) ||
    !registrationAuthMethod(discovery) ||
    (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256'))
  )
    return 'unsupported-flow';
  if (!metadata.registration_endpoint) return 'client-registration-required';
}

/** Refresh is available to HTTP transports; opening a browser requires login(). */
export class McpOAuthService {
  private readonly providers = new Map<string, BoundProvider>();
  private readonly generations = new Map<string, number>();
  private readonly logins = new Map<string, Login>();
  private readonly issues = new Map<string, McpOAuthIssue>();
  private pending: Promise<void> = Promise.resolve();
  readonly fetch: FetchLike;
  constructor(private readonly options: McpOAuthOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  getProvider(endpoint: string): OAuthClientProvider {
    endpoint = canonicalMcpEndpoint(endpoint);
    let provider = this.providers.get(endpoint);
    if (!provider) {
      provider = new BoundProvider(this, endpoint, this.generations.get(endpoint) ?? 0);
      this.providers.set(endpoint, provider);
    }
    return provider;
  }
  async openURL(url: string, endpoint: string, signal?: AbortSignal) {
    await validateMcpOAuthFetchTarget(new URL(endpoint), new URL(url), this.options.lookup, signal);
    if (signal?.aborted) throw failed();
    return this.options.openURL(url);
  }
  private async fetchFor(endpoint: string, input: string | URL, init?: RequestInit): Promise<Response> {
    await validateMcpOAuthFetchTarget(new URL(endpoint), new URL(input), this.options.lookup, init?.signal);
    if (init?.signal?.aborted) throw failed();
    if (!this.options.fetch) return pinnedMcpOAuthFetch(new URL(endpoint), new URL(input), init, this.options.lookup);
    return this.fetch(input, {...init, redirect: 'error', credentials: 'omit'});
  }
  registerSecret(secret: string) {
    this.options.registerSecret?.(secret);
  }
  current(endpoint: string, generation: number) {
    if ((this.generations.get(endpoint) ?? 0) !== generation) throw failed();
  }
  active(endpoint: string) {
    return this.logins.get(endpoint);
  }
  async read(endpoint: string): Promise<AuthRecord> {
    const raw = await this.options.store.read(endpoint);
    if (raw === undefined) return {endpoint};
    if (!raw || typeof raw !== 'object' || (raw as AuthRecord).endpoint !== endpoint) throw failed();
    const record = raw as AuthRecord;
    if (record.discovery) validateDiscovery(endpoint, record.discovery);
    if (record.client)
      record.client =
        OAuthClientInformationFullSchema.safeParse(record.client).data ??
        OAuthClientInformationSchema.parse(record.client);
    if (record.tokens) record.tokens = OAuthTokensSchema.parse(record.tokens);
    const issuer = record.discovery && issuerOf(record.discovery);
    for (const value of [record.client, record.tokens]) {
      if (value && (!issuer || typeof value.issuer !== 'string' || canonicalMcpEndpoint(value.issuer) !== issuer))
        throw failed();
    }
    if (record.expiresAt !== undefined && (!Number.isFinite(record.expiresAt) || record.expiresAt < 0)) throw failed();
    if (
      record.bearer !== undefined &&
      (typeof record.bearer !== 'string' || !record.bearer || /[\x00-\x20\x7f]/.test(record.bearer))
    )
      throw failed();
    if (record.tokens) this.secrets(record.tokens);
    if (record.client?.client_secret) this.options.registerSecret?.(record.client.client_secret);
    if (record.bearer) this.options.registerSecret?.(record.bearer);
    return record;
  }
  private secrets(tokens: OAuthTokens) {
    this.options.registerSecret?.(tokens.access_token);
    if (tokens.refresh_token) this.options.registerSecret?.(tokens.refresh_token);
  }
  update(endpoint: string, generation: number, change: (record: AuthRecord) => void): Promise<void> {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        this.current(endpoint, generation);
        const record = await this.read(endpoint);
        change(record);
        this.current(endpoint, generation);
        await this.options.store.write(endpoint, record);
      });
    this.pending = operation.catch(() => {});
    return operation;
  }
  reportIssue(endpoint: string, issue: McpOAuthIssue): McpOAuthError {
    this.issues.set(endpoint, issue);
    return new McpOAuthError(issue);
  }
  async status(input: string): Promise<McpOAuthStatus> {
    const endpoint = canonicalMcpEndpoint(input);
    const record = await this.read(endpoint);
    if (record.bearer) return {status: 'authorized'};
    const issue =
      this.issues.get(endpoint) ?? (!record.client && record.discovery ? clientIssue(record.discovery) : undefined);
    if (!record.tokens) return {status: 'needs-login', ...(issue ? {issue} : {})};
    return {
      status: record.expiresAt !== undefined && record.expiresAt <= Date.now() ? 'expired' : 'authorized',
      ...(record.tokens.scope ? {scopes: record.tokens.scope.split(/\s+/).filter(Boolean)} : {}),
      ...(issue ? {issue} : {}),
    };
  }
  async setBearer(endpoint: string, secret: string): Promise<void> {
    endpoint = canonicalMcpEndpoint(endpoint);
    if (!secret || secret.length > 4096 || /[\x00-\x20\x7f]/.test(secret)) throw failed();
    this.options.registerSecret?.(secret);
    await this.update(endpoint, this.generations.get(endpoint) ?? 0, record => {
      record.bearer = secret;
    });
    this.issues.delete(endpoint);
  }
  async bearer(endpoint: string): Promise<string | undefined> {
    return (await this.read(canonicalMcpEndpoint(endpoint))).bearer;
  }
  async clearBearer(endpoint: string): Promise<void> {
    endpoint = canonicalMcpEndpoint(endpoint);
    await this.update(endpoint, this.generations.get(endpoint) ?? 0, record => {
      delete record.bearer;
    });
  }
  private async probeChallenge(endpoint: string, fetchFn: FetchLike) {
    try {
      // Initialize is the ordinary MCP handshake. No configured headers or credentials are sent.
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {name: 'Cosmew', version: '1'},
          },
        }),
      });
      const challenge = response.status === 401 ? extractWWWAuthenticateParams(response) : {};
      await response.body?.cancel();
      return challenge;
    } catch {
      // An explicit login can still use the standard metadata locations when no challenge is available.
      return {};
    }
  }

  async login(input: string, options: {signal?: AbortSignal} = {}): Promise<void> {
    const endpoint = canonicalMcpEndpoint(input);
    if (this.logins.has(endpoint) || options.signal?.aborted) throw failed();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    options.signal?.addEventListener('abort', cancel, {once: true});
    let server: Server | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const login: Login = {
      redirect: 'http://127.0.0.1/oauth/callback',
      state: randomBytes(32).toString('base64url'),
      consumed: false,
      abort,
      stage: 'metadata-unavailable',
      tokenAuthMethod: 'none',
      expiresAt: Date.now() + (this.options.timeoutMs ?? 120_000),
    };
    this.logins.set(endpoint, login);
    const provider = new BoundProvider(this, endpoint, this.generations.get(endpoint) ?? 0, login);
    try {
      const code = new Promise<string>((resolve, reject) => {
        // A rejection handler is attached immediately; early cancellation never leaks a rejection.
        abort.signal.addEventListener('abort', () => reject(failed()), {once: true});
        server = createServer((request, response) => {
          const finish = (status: number, message: string) => {
            response.writeHead(status, {'content-type': 'text/plain', 'cache-control': 'no-store'});
            response.end(message);
          };
          if (request.method !== 'GET' || request.headers.host !== new URL(login.redirect).host) {
            finish(400, 'Invalid OAuth callback');
            return;
          }
          const callback = new URL(request.url ?? '/', login.redirect);
          if (callback.pathname !== '/oauth/callback') {
            finish(404, 'Not found');
            return;
          }
          if (callback.origin !== new URL(login.redirect).origin) {
            finish(400, 'Invalid OAuth callback');
            return;
          }
          const supplied = callback.searchParams.get('state') ?? '';
          const a = Buffer.from(supplied);
          const b = Buffer.from(login.state);
          const duplicate = ['state', 'code', 'error', 'iss', 'resource'].some(
            key => callback.searchParams.getAll(key).length > 1,
          );
          if (
            duplicate ||
            login.consumed ||
            Date.now() >= login.expiresAt ||
            a.length !== b.length ||
            !timingSafeEqual(a, b)
          ) {
            finish(400, 'Invalid OAuth callback');
            reject(failed());
            return;
          }
          login.consumed = true;
          void this.read(endpoint)
            .then(record => {
              const discovery = record.discovery;
              if (!discovery || abort.signal.aborted) throw failed();
              const issuer = callback.searchParams.get('iss');
              const metadata = discovery.authorizationServerMetadata as Record<string, unknown>;
              if (
                (metadata.authorization_response_iss_parameter_supported === true && !issuer) ||
                (issuer && canonicalMcpEndpoint(issuer) !== issuerOf(discovery))
              )
                throw failed();
              const resource = callback.searchParams.get('resource');
              if (resource && canonicalMcpEndpoint(resource) !== endpoint) throw failed();
              const authorizationCode = callback.searchParams.get('code');
              if (callback.searchParams.has('error') || !authorizationCode || authorizationCode.length > 8192)
                throw failed();
              finish(200, 'Authentication received. You may close this window.');
              resolve(authorizationCode);
            })
            .catch(() => {
              finish(400, 'OAuth authorization failed');
              reject(failed());
            });
        });
      });
      void code.catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const address = server!.address();
      if (!address || typeof address === 'string') throw failed();
      login.redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
      if (abort.signal.aborted) throw failed();
      timer = setTimeout(cancel, Math.max(0, login.expiresAt - Date.now()));
      const fetchFn: FetchLike = (request, init) =>
        this.fetchFor(endpoint, request, {
          ...init,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]),
        });
      const cancelled = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(failed()), {once: true});
      });
      const discovery = await provider.discoveryState();
      const challenge = discovery ? {} : await Promise.race([this.probeChallenge(endpoint, fetchFn), cancelled]);
      const result = await Promise.race([auth(provider, {serverUrl: endpoint, fetchFn, ...challenge}), cancelled]);
      if (result === 'REDIRECT') {
        const authorizationCode = await code;
        if (abort.signal.aborted) throw failed();
        login.stage = 'token-exchange-failed';
        if (
          (await Promise.race([auth(provider, {serverUrl: endpoint, authorizationCode, fetchFn}), cancelled])) !==
          'AUTHORIZED'
        )
          throw failed();
      }
      this.issues.delete(endpoint);
    } catch (error) {
      if (abort.signal.aborted) throw failed();
      throw this.reportIssue(endpoint, error instanceof McpOAuthError ? error.issue : login.stage);
    } finally {
      if (timer) clearTimeout(timer);
      login.verifier = undefined;
      if (this.logins.get(endpoint) === login) this.logins.delete(endpoint);
      abort.abort();
      options.signal?.removeEventListener('abort', cancel);
      server?.closeAllConnections();
      server?.close();
    }
  }
  async logout(input: string): Promise<McpLogoutResult> {
    const endpoint = canonicalMcpEndpoint(input);
    this.logins.get(endpoint)?.abort.abort();
    this.issues.delete(endpoint);
    this.generations.set(endpoint, (this.generations.get(endpoint) ?? 0) + 1);
    this.providers.delete(endpoint);
    await this.pending;
    let record: AuthRecord | undefined;
    try {
      record = await this.read(endpoint);
    } catch {
      /* Local clearing must also repair corrupt metadata. */
    }
    await this.options.store.delete(endpoint);
    const result = (remoteStatus: McpLogoutResult['remoteStatus']): McpLogoutResult => ({
      localCleared: true,
      remoteRevoked: remoteStatus === 'revoked',
      remoteStatus,
    });
    if (!record) return result('failed');
    if (!record.tokens) return result('not-needed');
    const metadata = record.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined;
    const revocation = metadata?.revocation_endpoint;
    if (typeof revocation !== 'string') return result('unsupported');
    try {
      const url = canonicalMcpEndpoint(revocation);
      for (const [hint, token] of [
        ['refresh_token', record.tokens.refresh_token],
        ['access_token', record.tokens.access_token],
      ]) {
        if (!token) continue;
        const body = new URLSearchParams({token, token_type_hint: hint!});
        const headers = new Headers({'content-type': 'application/x-www-form-urlencoded'});
        if (record.client?.client_secret)
          headers.set(
            'authorization',
            `Basic ${Buffer.from(`${encodeURIComponent(record.client.client_id)}:${encodeURIComponent(record.client.client_secret)}`).toString('base64')}`,
          );
        else if (record.client) body.set('client_id', record.client.client_id);
        const response = await this.fetchFor(endpoint, url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return result('failed');
      }
      return result('revoked');
    } catch {
      return result('failed');
    }
  }
}

class BoundProvider implements OAuthClientProvider {
  private epoch?: string;
  private observed = false;
  private observe(record: AuthRecord) {
    if (this.observed && this.epoch !== record._storeEpoch) throw failed();
    this.epoch = record._storeEpoch;
    this.observed = true;
    return record;
  }
  constructor(
    private readonly service: McpOAuthService,
    private readonly endpoint: string,
    private readonly generation: number,
    private readonly interactive?: Login,
  ) {}
  private login() {
    return this.interactive && this.service.active(this.endpoint) === this.interactive ? this.interactive : undefined;
  }
  private check() {
    this.service.current(this.endpoint, this.generation);
    if (this.interactive && (this.login() !== this.interactive || this.interactive.abort.signal.aborted))
      throw failed();
  }
  get redirectUrl() {
    this.check();
    return this.login()?.redirect ?? 'http://127.0.0.1/oauth/callback';
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Cosmew',
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.login()?.tokenAuthMethod ?? 'none',
    };
  }
  state() {
    this.check();
    const login = this.login();
    if (!login) throw new UnauthorizedError('MCP_AUTH_REQUIRED');
    return login.state;
  }
  async clientInformation() {
    this.check();
    const {client, discovery} = this.observe(await this.service.read(this.endpoint));
    const login = this.login();
    if (discovery) {
      const issue = clientIssue(discovery);
      if (issue && (!client || issue === 'unsupported-flow')) throw this.service.reportIssue(this.endpoint, issue);
    }
    if (!client && !login) throw new UnauthorizedError('MCP_AUTH_REQUIRED');
    if (login) {
      login.stage = client ? 'authorization-failed' : 'registration-failed';
      if (!client && discovery) login.tokenAuthMethod = registrationAuthMethod(discovery) ?? 'none';
    }
    return client;
  }
  async tokens() {
    this.check();
    return this.observe(await this.service.read(this.endpoint)).tokens;
  }
  async discoveryState() {
    this.check();
    const {discovery, client} = this.observe(await this.service.read(this.endpoint));
    // Allow a server with repaired metadata to recover on a subsequent explicit attempt.
    return this.login() && !client && discovery && clientIssue(discovery) ? undefined : discovery;
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.check();
    if (!discovery.authorizationServerMetadata) throw this.service.reportIssue(this.endpoint, 'metadata-unavailable');
    try {
      validateDiscovery(this.endpoint, discovery);
    } catch {
      throw this.service.reportIssue(this.endpoint, 'metadata-invalid');
    }
    await this.service.update(this.endpoint, this.generation, record => {
      this.check();
      this.observe(record);
      if (record.discovery && issuerOf(record.discovery) !== issuerOf(discovery) && (record.tokens || record.client))
        throw failed();
      record.discovery = discovery;
    });
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.check();
    if (client.client_secret) this.service.registerSecret(client.client_secret);
    const login = this.login();
    if (login) login.stage = 'authorization-failed';
    return this.service.update(this.endpoint, this.generation, record => {
      this.check();
      this.observe(record);
      if (!record.discovery || !client.issuer || canonicalMcpEndpoint(client.issuer) !== issuerOf(record.discovery))
        throw failed();
      record.client = client;
    });
  }
  async saveTokens(tokens: OAuthTokens) {
    this.check();
    this.service.registerSecret(tokens.access_token);
    if (tokens.refresh_token) this.service.registerSecret(tokens.refresh_token);
    return this.service.update(this.endpoint, this.generation, record => {
      this.check();
      this.observe(record);
      if (!record.discovery || !tokens.issuer || canonicalMcpEndpoint(tokens.issuer) !== issuerOf(record.discovery))
        throw failed();
      record.tokens = tokens;
      record.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    });
  }
  async validateResourceURL(server: string | URL, resource?: string) {
    this.check();
    if (
      canonicalMcpEndpoint(server) !== this.endpoint ||
      (resource && canonicalMcpEndpoint(resource) !== this.endpoint)
    )
      throw failed();
    return new URL(this.endpoint);
  }
  async redirectToAuthorization(url: URL) {
    this.check();
    const login = this.login();
    const record = await this.service.read(this.endpoint);
    if (!login) throw new UnauthorizedError('MCP_AUTH_REQUIRED');
    if (login.abort.signal.aborted || !record.discovery) throw failed();
    const metadata = record.discovery.authorizationServerMetadata!;
    const expected = new URL(metadata.authorization_endpoint);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      url.searchParams.get('state') !== login.state ||
      url.searchParams.get('resource') !== this.endpoint ||
      url.searchParams.get('code_challenge_method') !== 'S256'
    )
      throw failed();
    await this.service.openURL(url.href, this.endpoint, login.abort.signal);
  }
  saveCodeVerifier(verifier: string) {
    this.check();
    const login = this.login();
    if (!login || login.consumed) throw failed();
    login.verifier = verifier;
  }
  codeVerifier() {
    this.check();
    const verifier = this.login()?.verifier;
    if (!verifier) throw failed();
    return verifier;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const login = this.login();
    if (login && (scope === 'all' || scope === 'verifier')) login.verifier = undefined;
    return this.service.update(this.endpoint, this.generation, record => {
      this.observe(record);
      if (scope === 'all' || scope === 'client') delete record.client;
      if (scope === 'all' || scope === 'tokens') {
        delete record.tokens;
        delete record.expiresAt;
      }
      if (scope === 'all' || scope === 'discovery') delete record.discovery;
    });
  }
}
