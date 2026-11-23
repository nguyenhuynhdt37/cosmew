import {afterEach, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CredentialRef, CredentialVault} from '@cosmew/contracts';
import {McpClient, McpOAuthService} from '@cosmew/mcp';
import {FileMcpAuthStore} from '@cosmew/persistence';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const finish of cleanup.splice(0)) finish();
});
class Vault implements CredentialVault {
  values = new Map<string, string>();
  async get(ref: CredentialRef) {
    return ref.kind === 'keyring' ? this.values.get(ref.key) : undefined;
  }
  async set(key: string, secret: string) {
    if (/[\x00-\x20\x7f]/.test(secret)) throw new Error('Vault whitespace');
    this.values.set(key, secret);
  }
  async delete(ref: CredentialRef) {
    if (ref.kind === 'keyring') this.values.delete(ref.key);
  }
}
function fixture(
  options: {
    wrongIssuer?: boolean;
    wrongResource?: boolean;
    noRegistration?: boolean;
    noMetadata?: boolean;
    challengeOnly?: boolean;
    rejectRegistration?: boolean;
    tokenAuthMethod?: string;
    revoke?: number;
  } = {},
) {
  let challenge = '';
  let redirect = '';
  let origin = '';
  let tokenCalls = 0;
  let refreshCalls = 0;
  let revocations = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource') || url.pathname === '/protected-resource') {
        if (options.challengeOnly && url.pathname !== '/protected-resource') return new Response(null, {status: 404});
        return Response.json({
          resource: options.wrongResource ? `${origin}/other` : `${origin}/mcp`,
          authorization_servers: options.challengeOnly ? [`${origin}/issuer`] : [origin],
        });
      }
      if (url.pathname.startsWith('/.well-known/')) {
        if (
          options.noMetadata ||
          (options.challengeOnly && url.pathname !== '/.well-known/oauth-authorization-server/issuer')
        )
          return new Response(null, {status: 404});
        return Response.json({
          issuer: options.wrongIssuer ? `${origin}/other` : options.challengeOnly ? `${origin}/issuer` : origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          ...(options.noRegistration ? {} : {registration_endpoint: `${origin}/register`}),
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [options.tokenAuthMethod ?? 'none'],
        });
      }
      if (url.pathname === '/register') {
        if (options.rejectRegistration)
          return Response.json({error: 'invalid_client_metadata', error_description: 'PRIVATE_DETAIL'}, {status: 403});
        const body = (await request.json()) as {redirect_uris: string[]; token_endpoint_auth_method: string};
        if (options.tokenAuthMethod && body.token_endpoint_auth_method !== options.tokenAuthMethod)
          return Response.json({error: 'invalid_client_metadata'}, {status: 400});
        return Response.json(
          {
            ...body,
            client_id: 'fixture-client',
            ...(options.tokenAuthMethod === 'client_secret_basic' ? {client_secret: 'fixture-client-secret'} : {}),
          },
          {status: 201},
        );
      }
      if (url.pathname === '/authorize') {
        challenge = url.searchParams.get('code_challenge')!;
        redirect = url.searchParams.get('redirect_uri')!;
        const callback = new URL(redirect);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('code', 'fixture-code');
        callback.searchParams.set('iss', options.challengeOnly ? `${origin}/issuer` : origin);
        return Response.redirect(callback.href, 302);
      }
      if (url.pathname === '/token') {
        tokenCalls++;
        const body = new URLSearchParams(await request.text());
        if (
          options.tokenAuthMethod === 'client_secret_basic' &&
          request.headers.get('authorization') !== `Basic ${btoa('fixture-client:fixture-client-secret')}`
        )
          return Response.json({error: 'invalid_client'}, {status: 401});
        if (body.get('resource') !== `${origin}/mcp`) return Response.json({error: 'invalid_target'}, {status: 400});
        if (body.get('grant_type') === 'refresh_token') {
          refreshCalls++;
          if (body.get('refresh_token') !== 'fixture-refresh-secret')
            return Response.json({error: 'invalid_grant'}, {status: 400});
        } else if (
          body.get('redirect_uri') !== redirect ||
          createHash('sha256').update(body.get('code_verifier')!).digest('base64url') !== challenge
        )
          return Response.json({error: 'invalid_grant'}, {status: 400});
        return Response.json({
          access_token:
            body.get('grant_type') === 'refresh_token' ? 'fixture-access-refreshed' : 'fixture-access-secret',
          refresh_token: 'fixture-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'read write',
        });
      }
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return new Response(null, {status: 405});
        if (request.headers.get('authorization') !== 'Bearer fixture-access-refreshed')
          return new Response(null, {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${origin}${options.challengeOnly ? '/protected-resource' : '/.well-known/oauth-protected-resource/mcp'}"`,
            },
          });
        const rpc = (await request.json()) as {id?: number; method: string};
        if (rpc.id === undefined) return new Response(null, {status: 202});
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: {tools: {}},
                serverInfo: {name: 'oauth-fixture', version: '1'},
              }
            : {tools: []};
        return Response.json({jsonrpc: '2.0', id: rpc.id, result});
      }
      if (url.pathname === '/revoke') {
        revocations++;
        return new Response(null, {status: options.revoke ?? 200});
      }
      return new Response(null, {status: 404});
    },
  });
  origin = server.url.origin;
  cleanup.push(() => server.stop(true));
  return {
    endpoint: `${origin}/mcp`,
    origin,
    get tokenCalls() {
      return tokenCalls;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    get revocations() {
      return revocations;
    },
  };
}
function setup(openURL: (url: string) => Promise<void>, extra: {timeoutMs?: number} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-mcp-auth-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const vault = new Vault();
  const store = new FileMcpAuthStore(root, vault);
  const secrets: string[] = [];
  const service = new McpOAuthService({store, openURL, registerSecret: value => secrets.push(value), ...extra});
  return {root, vault, store, secrets, service};
}
const browser = async (url: string) => {
  const response = await fetch(url, {redirect: 'manual'});
  await fetch(response.headers.get('location')!);
};

test('fresh login follows the protected-resource metadata from the 401 challenge', async () => {
  const remote = fixture({challengeOnly: true});
  const state = setup(browser);
  await state.service.login(remote.endpoint);
  expect(await state.service.status(remote.endpoint)).toMatchObject({status: 'authorized'});
  expect(remote.tokenCalls).toBe(1);
});

for (const [option, issue] of [
  ['noRegistration', 'client-registration-required'],
  ['noMetadata', 'metadata-unavailable'],
  ['rejectRegistration', 'registration-failed'],
] as const) {
  test(`OAuth diagnoses ${issue} without opening a browser or exposing the provider error`, async () => {
    const remote = fixture({[option]: true});
    let opened = false;
    const state = setup(async () => {
      opened = true;
    });
    await expect(state.service.login(remote.endpoint)).rejects.toMatchObject({message: 'MCP_OAUTH_FAILED', issue});
    expect(opened).toBe(false);
    expect(remote.tokenCalls).toBe(0);
    expect(await state.service.status(remote.endpoint)).toMatchObject({status: 'needs-login', issue});
  });
}

test('dynamic registration negotiates a supported token endpoint auth method', async () => {
  const remote = fixture({tokenAuthMethod: 'client_secret_basic'});
  const state = setup(browser);
  await state.service.login(remote.endpoint);
  expect(await state.service.status(remote.endpoint)).toMatchObject({status: 'authorized'});
  expect(state.secrets).toContain('fixture-client-secret');
  expect(remote.tokenCalls).toBe(1);
});

test('an unsupported token auth method is diagnosed before opening a browser', async () => {
  const remote = fixture({tokenAuthMethod: 'private_key_jwt'});
  let opened = false;
  const state = setup(async () => {
    opened = true;
  });
  await expect(state.service.login(remote.endpoint)).rejects.toMatchObject({issue: 'unsupported-flow'});
  expect(opened).toBe(false);
  expect(remote.tokenCalls).toBe(0);
});

test('real loopback OAuth verifies PKCE, persists only references, refreshes after restart and revokes logout', async () => {
  const remote = fixture();
  const state = setup(browser);
  expect(await state.service.status(remote.endpoint)).toEqual({status: 'needs-login'});
  await state.service.login(remote.endpoint);
  expect(await state.service.status(remote.endpoint)).toEqual({status: 'authorized', scopes: ['read', 'write']});
  const directory = join(state.root, 'mcp-auth');
  const disk = readdirSync(directory)
    .map(name => readFileSync(join(directory, name), 'utf8'))
    .join('');
  expect(disk).not.toContain('fixture-access-secret');
  expect(disk).not.toContain('fixture-refresh-secret');
  expect(disk).not.toContain('read write');
  expect(state.secrets).toContain('fixture-access-secret');
  expect(state.secrets).toContain('fixture-refresh-secret');
  const restarted = new McpOAuthService({
    store: new FileMcpAuthStore(state.root, state.vault),
    openURL: async () => {
      throw new Error('No implicit browser');
    },
  });
  const client = new McpClient({
    endpoint: new URL(remote.endpoint),
    authProvider: restarted.getProvider(remote.endpoint),
    redact: () => '[redacted]',
  });
  try {
    expect(await client.listTools()).toEqual([]);
  } finally {
    await client.close();
  }
  expect(remote.refreshCalls).toBe(1);
  expect(await restarted.logout(remote.endpoint)).toEqual({
    localCleared: true,
    remoteRevoked: true,
    remoteStatus: 'revoked',
  });
  expect(remote.revocations).toBe(2);
  expect(state.vault.values.size).toBe(0);
  expect(await restarted.status(remote.endpoint)).toEqual({status: 'needs-login'});
});

for (const fault of ['state', 'issuer', 'resource', 'denied', 'duplicate'] as const)
  test(`callback rejects ${fault} before any token exchange`, async () => {
    const remote = fixture();
    const state = setup(async url => {
      const response = await fetch(url, {redirect: 'manual'});
      const callback = new URL(response.headers.get('location')!);
      if (fault === 'state') callback.searchParams.set('state', 'invalid-state');
      if (fault === 'issuer') callback.searchParams.set('iss', 'https://wrong.example/');
      if (fault === 'resource') callback.searchParams.set('resource', `${remote.origin}/other`);
      if (fault === 'denied') {
        callback.searchParams.delete('code');
        callback.searchParams.set('error', 'access_denied');
        callback.searchParams.set('error_description', 'SECRET_ERROR');
      }
      if (fault === 'duplicate') callback.searchParams.append('state', callback.searchParams.get('state')!);
      expect((await fetch(callback)).status).toBe(400);
    });
    await expect(state.service.login(remote.endpoint)).rejects.toThrow('MCP_OAUTH_FAILED');
    expect(remote.tokenCalls).toBe(0);
  });

for (const fault of ['wrongIssuer', 'wrongResource'] as const)
  test(`discovery rejects ${fault} before browser or token exchange`, async () => {
    const remote = fixture({[fault]: true});
    let opened = false;
    const state = setup(async () => {
      opened = true;
    });
    await expect(state.service.login(remote.endpoint)).rejects.toThrow('MCP_OAUTH_FAILED');
    expect(opened).toBe(false);
    expect(remote.tokenCalls).toBe(0);
  });

test('cancel and timeout close callback listeners and prevent late exchange', async () => {
  const remote = fixture();
  const abort = new AbortController();
  let callback = '';
  const state = setup(async url => {
    callback = (await fetch(url, {redirect: 'manual'})).headers.get('location')!;
    abort.abort();
  });
  await expect(state.service.login(remote.endpoint, {signal: abort.signal})).rejects.toThrow('MCP_OAUTH_FAILED');
  await expect(fetch(callback)).rejects.toThrow();
  expect(remote.tokenCalls).toBe(0);
  const timed = setup(async () => {}, {timeoutMs: 10});
  await expect(timed.service.login(remote.endpoint)).rejects.toThrow('MCP_OAUTH_FAILED');
});

test('logout reports failed revocation while clearing credentials and fencing old providers', async () => {
  const remote = fixture({revoke: 500});
  const state = setup(browser);
  await state.service.login(remote.endpoint);
  const provider = state.service.getProvider(remote.endpoint);
  const tokens = await provider.tokens();
  expect(await state.service.logout(remote.endpoint)).toEqual({
    localCleared: true,
    remoteRevoked: false,
    remoteStatus: 'failed',
  });
  await expect(provider.saveTokens(tokens!)).rejects.toThrow('MCP_OAUTH_FAILED');
  expect(await state.service.status(remote.endpoint)).toEqual({status: 'needs-login'});
});

test('static bearer credentials are endpoint-bound and clearable', async () => {
  const state = setup(browser);
  await state.service.setBearer('https://example.com/mcp', 'fixture-bearer-secret');
  expect(await state.service.bearer('https://example.com/other')).toBeUndefined();
  expect(await state.service.bearer('https://example.com/mcp')).toBe('fixture-bearer-secret');
  await state.service.clearBearer('https://example.com/mcp');
  expect(await state.service.bearer('https://example.com/mcp')).toBeUndefined();
});

test('auth store refuses symlink directories and symlink records', async () => {
  const state = setup(browser);
  const outside = mkdtempSync(join(tmpdir(), 'cosmew-mcp-outside-'));
  cleanup.push(() => rmSync(outside, {recursive: true, force: true}));
  symlinkSync(outside, join(state.root, 'mcp-auth'));
  await expect(state.store.write('https://example.com/mcp', {})).rejects.toThrow();
  expect(readdirSync(outside)).toEqual([]);
  rmSync(join(state.root, 'mcp-auth'));
  mkdirSync(join(state.root, 'mcp-auth'));
  await state.service.setBearer('https://example.com/mcp', 'fixture-secret');
  const path = join(
    state.root,
    'mcp-auth',
    readdirSync(join(state.root, 'mcp-auth')).find(name => name.endsWith('.json'))!,
  );
  rmSync(path);
  symlinkSync(join(outside, 'target'), path);
  await expect(state.store.read('https://example.com/mcp')).rejects.toThrow();
  await expect(state.store.write('https://example.com/mcp', {})).rejects.toThrow();
  expect(readdirSync(outside)).toEqual([]);
});

test('ambient transport never opens browser or registers a new OAuth client', async () => {
  const remote = fixture();
  let opened = 0;
  const state = setup(async () => {
    opened++;
  });
  const client = new McpClient({
    endpoint: new URL(remote.endpoint),
    authProvider: state.service.getProvider(remote.endpoint),
    redact: () => '[redacted]',
  });
  try {
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
  expect(opened).toBe(0);
  expect(remote.tokenCalls).toBe(0);
});

test('logout cancels pending login and rejects its late callback', async () => {
  const remote = fixture();
  let ready!: () => void;
  const opened = new Promise<void>(resolve => {
    ready = resolve;
  });
  let callback = '';
  const state = setup(async url => {
    callback = (await fetch(url, {redirect: 'manual'})).headers.get('location')!;
    ready();
  });
  const login = state.service.login(remote.endpoint);
  const outcome = login.then(
    () => undefined,
    error => error as Error,
  );
  await opened;
  expect((await state.service.logout(remote.endpoint)).localCleared).toBe(true);
  expect((await outcome)?.message).toBe('MCP_OAUTH_FAILED');
  await expect(fetch(callback)).rejects.toThrow();
  expect(remote.tokenCalls).toBe(0);
  expect(await state.service.status(remote.endpoint)).toEqual({status: 'needs-login'});
});

test('unsupported revocation is explicit and corrupted auth can still be cleared', async () => {
  const remote = fixture();
  const state = setup(browser);
  await state.service.login(remote.endpoint);
  const record = (await state.store.read(remote.endpoint)) as {
    discovery: {authorizationServerMetadata: Record<string, unknown>};
  };
  delete record.discovery.authorizationServerMetadata.revocation_endpoint;
  await state.store.write(remote.endpoint, record);
  expect(await state.service.logout(remote.endpoint)).toEqual({
    localCleared: true,
    remoteRevoked: false,
    remoteStatus: 'unsupported',
  });
  await state.store.write(remote.endpoint, {
    ...((await state.store.read(remote.endpoint)) as object),
    endpoint: remote.endpoint,
    tokens: {access_token: 'malformed-secret'},
  });
  expect(await state.service.logout(remote.endpoint)).toEqual({
    localCleared: true,
    remoteRevoked: false,
    remoteStatus: 'failed',
  });
  expect(state.vault.values.size).toBe(0);
});

test('HTTP OAuth scopes configured headers to MCP origin while preserving generated Basic client authentication', async () => {
  const endpoint = 'https://good.example/mcp';
  const issuer = 'https://auth.example/';
  const configured = 'configured-secret-value';
  let crossOrigin = 0;
  let sawBasic = false;
  const state = setup(async () => {
    throw new Error('No browser');
  });
  const provider = state.service.getProvider(endpoint);
  await provider.saveDiscoveryState!({
    authorizationServerUrl: issuer,
    resourceMetadata: {resource: endpoint},
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: `${issuer}authorize`,
      token_endpoint: `${issuer}token`,
      response_types_supported: ['code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    },
  });
  await provider.saveClientInformation!({client_id: 'fixture-client', client_secret: 'oauth-client-secret', issuer});
  await provider.saveTokens({
    access_token: 'expired-access-token',
    refresh_token: 'fixture-refresh-secret',
    token_type: 'Bearer',
    issuer,
  });
  const fetchFixture: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url.origin !== 'https://good.example') {
        crossOrigin++;
        expect([...headers.values()].join(' ')).not.toContain(configured);
        expect(headers.has('x-api-key')).toBe(false);
        expect(headers.has('cookie')).toBe(false);
        if (url.pathname === '/token') {
          sawBasic =
            headers.get('authorization') ===
            `Basic ${Buffer.from('fixture-client:oauth-client-secret').toString('base64')}`;
          return Response.json({
            access_token: 'fixture-access-refreshed',
            refresh_token: 'fixture-refresh-secret',
            token_type: 'Bearer',
          });
        }
        return new Response(null, {status: 404});
      }
      expect(headers.get('x-api-key')).toBe(configured);
      if (headers.get('authorization') !== 'Bearer fixture-access-refreshed')
        return new Response(null, {
          status: 401,
          headers: {'www-authenticate': 'Bearer resource_metadata="https://metadata.example/resource"'},
        });
      const rpc = JSON.parse(String(init?.body)) as {id?: number; method: string};
      if (rpc.id === undefined) return new Response(null, {status: 202});
      return Response.json({
        jsonrpc: '2.0',
        id: rpc.id,
        result:
          rpc.method === 'initialize'
            ? {protocolVersion: '2025-03-26', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1'}}
            : {tools: []},
      });
    },
    {preconnect: fetch.preconnect},
  );
  const client = new McpClient({
    endpoint: new URL(endpoint),
    headers: {Authorization: `Bearer ${configured}`, 'X-API-Key': configured, Cookie: `session=${configured}`},
    authProvider: provider,
    fetch: fetchFixture,
    oauthLookup: async () => [{address: '93.184.216.34', family: 4}],
    redact: value => value,
  });
  try {
    expect(await client.listTools()).toEqual([]);
  } finally {
    await client.close();
  }
  expect(crossOrigin).toBeGreaterThan(0);
  expect(sawBasic).toBe(true);
});

for (const target of [
  'http://169.254.169.254/',
  'https://169.254.169.254/',
  'http://127.0.0.1/',
  'https://127.0.0.1/',
  'https://private.example/',
])
  test(`OAuth discovery denies unsafe target before fetch: ${target}`, async () => {
    const endpoint = 'https://good.example/mcp';
    const calls: string[] = [];
    const state = setup(async () => {
      throw new Error('No browser');
    });
    const service = new McpOAuthService({
      store: state.store,
      openURL: async () => {
        throw new Error('No browser');
      },
      lookup: async hostname => [{address: hostname === 'private.example' ? '10.0.0.1' : '93.184.216.34', family: 4}],
      fetch: async input => {
        const url = new URL(input);
        calls.push(url.href);
        if (url.hostname !== 'good.example') throw new Error('UNSAFE_TARGET_FETCHED');
        return Response.json({resource: endpoint, authorization_servers: [target]});
      },
    });
    await expect(service.login(endpoint)).rejects.toThrow('MCP_OAUTH_FAILED');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(url => new URL(url).hostname === 'good.example')).toBe(true);
  });

test('HTTP401 resource_metadata private target is denied before fetch', async () => {
  const calls: string[] = [];
  const endpoint = 'https://good.example/mcp';
  const state = setup(async () => {});
  const fetchFixture: typeof fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.href);
      if (url.origin !== 'https://good.example') throw new Error('UNSAFE_TARGET_FETCHED');
      return new Response(null, {
        status: 401,
        headers: {'www-authenticate': 'Bearer resource_metadata="https://169.254.169.254/metadata"'},
      });
    },
    {preconnect: fetch.preconnect},
  );
  const client = new McpClient({
    endpoint: new URL(endpoint),
    authProvider: state.service.getProvider(endpoint),
    fetch: fetchFixture,
    oauthLookup: async () => [{address: '93.184.216.34', family: 4}],
    redact: value => value,
  });
  try {
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
  expect(calls.every(url => new URL(url).origin === 'https://good.example')).toBe(true);
});

test('HTTP401 cross-origin resource discovery never receives configured credential headers', async () => {
  const endpoint = 'https://good.example/mcp';
  const secret = 'configured-private-api-key';
  const foreign: string[] = [];
  const state = setup(async () => {});
  const fetchFixture: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url.origin === 'https://good.example')
        return new Response(null, {
          status: 401,
          headers: {'www-authenticate': 'Bearer resource_metadata="https://metadata.example/resource"'},
        });
      foreign.push(url.href);
      expect([...headers.values()].join(' ')).not.toContain(secret);
      expect(headers.has('authorization')).toBe(false);
      expect(headers.has('x-api-key')).toBe(false);
      if (url.origin === 'https://metadata.example')
        return Response.json({resource: endpoint, authorization_servers: ['https://auth.example/']});
      return Response.json({
        issuer: 'https://auth.example/',
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    },
    {preconnect: fetch.preconnect},
  );
  const client = new McpClient({
    endpoint: new URL(endpoint),
    headers: {Authorization: `Bearer ${secret}`, 'X-API-Key': secret},
    authProvider: state.service.getProvider(endpoint),
    fetch: fetchFixture,
    oauthLookup: async () => [{address: '93.184.216.34', family: 4}],
    redact: value => value,
  });
  try {
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
  expect(foreign).toContain('https://metadata.example/resource');
  expect(foreign.some(url => new URL(url).hostname === 'auth.example')).toBe(true);
});

test('persistent logout epoch fences refresh in another store and service instance', async () => {
  const remote = fixture();
  const state = setup(browser);
  await state.service.login(remote.endpoint);
  const secondStore = new FileMcpAuthStore(state.root, state.vault);
  const second = new McpOAuthService({store: secondStore, openURL: browser});
  const provider = second.getProvider(remote.endpoint);
  const tokens = await provider.tokens();
  const stale = await secondStore.read(remote.endpoint);
  await state.service.logout(remote.endpoint);
  await expect(provider.saveTokens(tokens!)).rejects.toThrow('MCP_OAUTH_FAILED');
  await expect(secondStore.write(remote.endpoint, stale)).rejects.toThrow();
  expect(await second.status(remote.endpoint)).toEqual({status: 'needs-login'});
  expect(state.vault.values.size).toBe(0);
});

test('cross-instance logout waits for vault write lock then clears the published record', async () => {
  const state = setup(browser);
  const endpoint = 'https://good.example/mcp';
  await state.service.setBearer(endpoint, 'initial-secret');
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {
    entered = resolve;
  });
  let resume!: () => void;
  const released = new Promise<void>(resolve => {
    resume = resolve;
  });
  const originalSet = state.vault.set.bind(state.vault);
  state.vault.set = async (key, value) => {
    entered();
    await released;
    await originalSet(key, value);
  };
  const second = new McpOAuthService({store: new FileMcpAuthStore(state.root, state.vault), openURL: browser});
  const saving = second.setBearer(endpoint, 'replacement-secret');
  await waiting;
  const logout = state.service.logout(endpoint);
  resume();
  await saving;
  expect((await logout).localCleared).toBe(true);
  expect(await second.bearer(endpoint)).toBeUndefined();
  expect(state.vault.values.size).toBe(0);
});

test('pinned OAuth wire options retain public hostname and reuse only the validated DNS answer', async () => {
  const {pinnedMcpOAuthFetch} = await import('../../packages/mcp/src/oauth-network');
  const {EventEmitter} = await import('node:events');
  const root = new URL('https://good.example/mcp');
  const target = new URL('https://auth.example/token');
  let dnsCalls = 0;
  let wireCalls = 0;
  const wire = ((
    url: URL,
    options: {
      agent: boolean;
      servername: string;
      signal: AbortSignal;
      lookup(hostname: string, options: {all: boolean}, callback: (...args: unknown[]) => void): void;
    },
    response: (stream: unknown) => void,
  ) => {
    wireCalls++;
    expect(url.hostname).toBe('auth.example');
    expect(options.agent).toBe(false);
    expect(options.servername).toBe('auth.example');
    options.lookup('auth.example', {all: true}, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{address: '93.184.216.34', family: 4}]);
    });
    options.lookup('auth.example', {all: false}, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
    });
    const request = Object.assign(new EventEmitter(), {
      end(body: string) {
        expect(body).toBe('grant_type=refresh_token');
        const stream = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: {'content-type': 'application/json'},
        });
        response(stream);
        stream.emit('data', Buffer.from('{"ok":true}'));
        stream.emit('end');
      },
    });
    return request;
  }) as unknown as typeof import('node:https').request;
  const pending = pinnedMcpOAuthFetch(
    root,
    target,
    {method: 'POST', body: new URLSearchParams({grant_type: 'refresh_token'})},
    async () => {
      dnsCalls++;
      return [{address: dnsCalls === 1 ? '93.184.216.34' : '169.254.169.254', family: 4}];
    },
    wire,
  );
  for (let turn = 0; turn < 12 && !wireCalls; turn++) await Promise.resolve();
  expect(wireCalls).toBe(1);
  const response = await pending;
  expect(await response.json()).toEqual({ok: true});
  expect(dnsCalls).toBe(1);
  expect(wireCalls).toBe(1);
});

test('SIGKILL releases a writer kernel lock before another process logout', async () => {
  const state = setup(browser);
  const endpoint = 'https://good.example/mcp';
  const processFixture = Bun.spawn(
    [process.execPath, '--config=/dev/null', '--no-env-file', 'tests/fixtures/mcp-auth-lock.ts', state.root],
    {cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe'},
  );
  try {
    const reader = processFixture.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('vault-write-locked');
    processFixture.kill('SIGKILL');
    await processFixture.exited;
    await reader.cancel();
    await state.store.delete(endpoint);
    expect(await state.service.status(endpoint)).toEqual({status: 'needs-login'});
  } finally {
    processFixture.kill('SIGKILL');
    await processFixture.exited;
  }
});

test('aborting a pending DNS lookup settles without invoking the OAuth wire factory', async () => {
  const {pinnedMcpOAuthFetch} = await import('../../packages/mcp/src/oauth-network');
  const abort = new AbortController();
  let entered!: () => void;
  const lookupStarted = new Promise<void>(resolve => {
    entered = resolve;
  });
  let wireCalls = 0;
  const wire = (() => {
    wireCalls++;
    throw new Error('Unexpected wire request');
  }) as unknown as typeof import('node:https').request;
  const pending = pinnedMcpOAuthFetch(
    new URL('https://good.example/mcp'),
    new URL('https://auth.example/token'),
    {signal: abort.signal},
    async () => {
      entered();
      return new Promise(() => {});
    },
    wire,
  );
  await lookupStarted;
  abort.abort();
  await expect(pending).rejects.toThrow('MCP_OAUTH_NETWORK_DENIED');
  expect(wireCalls).toBe(0);
});
