import {afterEach, expect, test} from 'bun:test';
import {OpenRouterPKCE, Redactor} from '@cosmew/security';
import {FutrynError, type Account, type CredentialRef, type CredentialVault} from '@cosmew/contracts';
import {ChatGPTOAuth} from '../../apps/cli/src/subscriptions/chatgpt-oauth';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function fixture() {
  let code = 'one-time-fixture-code';
  let expectedChallenge = '';
  let receivedVerifier = '';
  let requests = 0;
  let status = 200;
  let delay = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      requests++;
      expect(req.method).toBe('POST');
      expect(req.headers.has('authorization')).toBe(false);
      const body = (await req.json()) as any;
      receivedVerifier = body.code_verifier;
      const hash = Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier)),
      ).toString('base64url');
      if (delay) await Bun.sleep(delay);
      if (body.code !== code || hash !== expectedChallenge || body.code_challenge_method !== 'S256')
        return Response.json({error: 'raw-sensitive-rejection'}, {status: 401});
      if (status !== 200) return Response.json({error: 'raw-sensitive-rejection'}, {status});
      code = '';
      return Response.json({key: 'synthetic-issued-api-key'});
    },
  });
  cleanup.push(() => server.stop(true));
  const redactor = new Redactor();
  let now = Date.now();
  const driver = new OpenRouterPKCE(
    redactor,
    (async (url, init) => {
      expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      return fetch(`http://127.0.0.1:${server.port}`, init);
    }) as typeof fetch,
    () => now,
  );
  return {
    driver,
    redactor,
    requests: () => requests,
    verifier: () => receivedVerifier,
    async begin() {
      const c = await driver.begin();
      expectedChallenge = new URL(c.authorizationURL).searchParams.get('code_challenge')!;
      return c;
    },
    expire() {
      now += 600001;
    },
    fail(code: number) {
      status = code;
    },
    delay() {
      delay = 500;
    },
  };
}

test('official headless OAuth: S256, pinned token endpoint, one-time code exchange, bounded expiry and secret redaction', async () => {
  const f = fixture();
  const c = await f.begin();
  const url = new URL(c.authorizationURL);
  expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
  expect(url.searchParams.has('callback_url')).toBe(false);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.has('code_verifier')).toBe(false);
  expect(await f.driver.complete(c.id, 'one-time-fixture-code')).toBe('synthetic-issued-api-key');
  expect(f.verifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(f.redactor.text('one-time-fixture-code synthetic-issued-api-key ' + f.verifier())).toBe(
    '[REDACTED] [REDACTED] [REDACTED]',
  );
  await expect(f.driver.complete(c.id, 'one-time-fixture-code')).rejects.toMatchObject({code: 'AUTH'});
  expect(f.requests()).toBe(1);
});

test('OAuth expired/cancelled/unknown challenges fail before network; exchange failure is safe and never retried', async () => {
  const f = fixture();
  const expired = await f.begin();
  f.expire();
  await expect(f.driver.complete(expired.id, 'one-time-fixture-code')).rejects.toMatchObject({code: 'AUTH'});
  const cancelled = await f.begin();
  f.driver.cancel(cancelled.id);
  await expect(f.driver.complete(cancelled.id, 'one-time-fixture-code')).rejects.toMatchObject({code: 'AUTH'});
  await expect(f.driver.complete(crypto.randomUUID(), 'code')).rejects.toMatchObject({code: 'AUTH'});
  expect(f.requests()).toBe(0);
  const failed = await f.begin();
  f.fail(403);
  try {
    await f.driver.complete(failed.id, 'one-time-fixture-code');
    throw new Error('must reject');
  } catch (error) {
    expect(error).toBeInstanceOf(FutrynError);
    expect(JSON.stringify(error)).not.toContain('raw-sensitive');
  }
  expect(f.requests()).toBe(1);
  await expect(f.driver.complete(failed.id, 'one-time-fixture-code')).rejects.toMatchObject({code: 'AUTH'});
});

test('OAuth exchange abort never produces credentials or retries', async () => {
  const f = fixture();
  const c = await f.begin();
  f.delay();
  const controller = new AbortController();
  const result = f.driver.complete(c.id, 'one-time-fixture-code', controller.signal);
  setTimeout(() => controller.abort(), 30);
  await expect(result).rejects.toMatchObject({code: 'CANCELLED'});
  expect(f.requests()).toBe(1);
});

function chatgptFixture(handler: (form: URLSearchParams, requestNumber: number) => Promise<Response> | Response) {
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/accounts/oauth/token') return new Response(null, {status: 404});
      requests++;
      const form = new URLSearchParams(await req.text());
      return handler(form, requests);
    },
  });
  cleanup.push(() => server.stop(true));
  const values = new Map<string, string>();
  const vault: CredentialVault = {
    async get(ref: CredentialRef) {
      return ref.kind === 'keyring' ? values.get(ref.key) : undefined;
    },
    async set(key: string, secret: string) {
      values.set(key, secret);
    },
    async delete(ref: CredentialRef) {
      if (ref.kind === 'keyring') values.delete(ref.key);
    },
  };
  const key = crypto.randomUUID();
  const account: Account = {
    id: crypto.randomUUID(),
    providerId: 'chatgpt-api',
    alias: 'chatgpt',
    credential: {kind: 'keyring', key},
    status: 'valid',
    validatedAt: null,
  };
  const clock = {now: 1_000_000};
  const redactor = new Redactor();
  const oauth = new ChatGPTOAuth(redactor, {
    issuer: server.url.origin,
    now: () => clock.now,
    openURL: async () => {},
  });
  return {
    issuer: server.url.origin,
    oauth,
    vault,
    account,
    key,
    clock,
    redactor,
    requests: () => requests,
    seed(record: {access: string; refresh: string; expires: number; clientID: string}) {
      values.set(key, JSON.stringify({v: 1, ...record}));
    },
    readRecord() {
      return JSON.parse(values.get(key)!) as {access: string; refresh: string; expires: number; clientID: string};
    },
  };
}

test('ChatGPTOAuth refresh preserves existing refresh_token when server omits refresh_token rotation', async () => {
  const f = chatgptFixture(form => {
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('initial-refresh');
    if (f.requests() === 1) {
      return Response.json({access_token: 'new-access-1', expires_in: 3600});
    }
    return Response.json({access_token: 'new-access-2', refresh_token: 'rotated-refresh-2', expires_in: 3600});
  });
  f.seed({access: 'stale-access', refresh: 'initial-refresh', expires: f.clock.now + 30_000, clientID: 'client-1'});

  expect(await f.oauth.accessToken(f.account, f.vault)).toBe('new-access-1');
  expect(f.readRecord()).toMatchObject({access: 'new-access-1', refresh: 'initial-refresh', clientID: 'client-1'});
  expect(f.redactor.text('token new-access-1')).toBe('token [REDACTED]');

  f.clock.now += 3600_000;
  expect(await f.oauth.accessToken(f.account, f.vault)).toBe('new-access-2');
  expect(f.readRecord()).toMatchObject({access: 'new-access-2', refresh: 'rotated-refresh-2', clientID: 'client-1'});
  expect(f.redactor.text('new-access-2 rotated-refresh-2')).toBe('[REDACTED] [REDACTED]');
  expect(f.requests()).toBe(2);
});

test('ChatGPTOAuth single-flight refresh isolates caller abort signal without cancelling parallel callers', async () => {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  let releaseServer!: () => void;
  const gate = new Promise<void>(resolve => {
    releaseServer = resolve;
  });
  const f = chatgptFixture(async () => {
    markStarted();
    await gate;
    return Response.json({access_token: 'shared-new-access', refresh_token: 'shared-new-refresh', expires_in: 3600});
  });
  f.seed({access: 'expired-access', refresh: 'initial-refresh', expires: f.clock.now, clientID: 'client-1'});

  const controller1 = new AbortController();
  const controller2 = new AbortController();
  const pending1 = f.oauth.accessToken(f.account, f.vault, controller1.signal);
  const pending2 = f.oauth.accessToken(f.account, f.vault, controller2.signal);
  void pending1.catch(() => {});
  void pending2.catch(() => {});

  await started;
  controller1.abort();
  await expect(pending1).rejects.toMatchObject({code: 'CANCELLED'});

  releaseServer();
  expect(await pending2).toBe('shared-new-access');
  expect(f.requests()).toBe(1);
  expect(f.readRecord()).toMatchObject({access: 'shared-new-access', refresh: 'shared-new-refresh'});
});

test('ChatGPTOAuth rejects non-string refresh_token on refresh and short-circuits pre-aborted callers', async () => {
  const f = chatgptFixture(() => Response.json({access_token: 'new-access', refresh_token: 123, expires_in: 3600}));
  f.seed({access: 'expired-access', refresh: 'initial-refresh', expires: f.clock.now, clientID: 'client-1'});

  const preAborted = new AbortController();
  preAborted.abort();
  await expect(f.oauth.accessToken(f.account, f.vault, preAborted.signal)).rejects.toMatchObject({code: 'CANCELLED'});
  expect(f.requests()).toBe(0);

  await expect(f.oauth.accessToken(f.account, f.vault)).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(f.requests()).toBe(1);
});

test('ChatGPTOAuth initial authorization_code exchange still requires refresh_token', async () => {
  const f = chatgptFixture(() =>
    Response.json({
      access_token: 'initial-access',
      expires_in: 3600,
      scope: 'openid offline_access chatgpt.tokens.use.direct',
      id_token: 'stub.id.token',
    }),
  );
  const oauth = new ChatGPTOAuth(f.redactor, {
    issuer: f.issuer,
    now: () => f.clock.now,
    openURL: async url => {
      const auth = new URL(url);
      const callback = new URL(auth.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', auth.searchParams.get('state')!);
      callback.searchParams.set('code', 'auth-code-1');
      callback.searchParams.set('client_id', 'issued-client');
      void fetch(callback).catch(() => {});
    },
  });
  const challenge = await oauth.begin();
  await expect(oauth.complete(challenge.id)).rejects.toMatchObject({code: 'PROTOCOL'});
  expect(f.requests()).toBe(1);
});
