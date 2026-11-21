import {afterEach, expect, setDefaultTimeout, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {providerPresets} from '@cosmew/models';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

setDefaultTimeout(30_000);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const b64 = (value: object | Uint8Array) =>
  Buffer.from(value instanceof Uint8Array ? value : JSON.stringify(value)).toString('base64url');

/** A fake auth.openai.com: authorize is "visited" by the test's openURL, token/JWKS are served here. */
async function issuer(
  options: {
    scope?: string;
    badNonce?: boolean;
    refreshStatus?: number;
    tokenError?: string;
    invalidGrantOnce?: boolean;
    jwksStatus?: number;
    jwksBody?: string;
    jwksWait?: Promise<void>;
    onJwks?: () => void;
  } = {},
) {
  const pair = await crypto.subtle.generateKey(
    {name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'},
    true,
    ['sign', 'verify'],
  );
  const jwk = {...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig'};
  const seen: {
    authorize?: URLSearchParams;
    authorizations: URLSearchParams[];
    tokens: URLSearchParams[];
    issued: number;
  } = {authorizations: [], tokens: [], issued: 0};
  let nonce = '';
  let challenge = '';
  let clientID = '';
  let authorizationCode = 'code-1';
  const sign = async (claims: object) => {
    const head = b64({alg: 'RS256', kid: 'k1', typ: 'JWT'});
    const body = b64(claims);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${b64(new Uint8Array(signature))}`;
  };
  let port = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/jwks.json') {
        options.onJwks?.();
        await options.jwksWait;
        if (options.jwksStatus) return new Response('upstream-private-detail', {status: options.jwksStatus});
        if (options.jwksBody) return new Response(options.jwksBody);
        return Response.json({keys: [jwk]});
      }
      if (url.pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(await request.text());
        seen.tokens.push(form);
        if (options.invalidGrantOnce && seen.tokens.length === 1)
          return Response.json({error: 'invalid_grant'}, {status: 400});
        if (options.tokenError) return Response.json({error: options.tokenError}, {status: 400});
        if (form.get('grant_type') === 'refresh_token') {
          if (options.refreshStatus) return new Response('{"error":"invalid_grant"}', {status: options.refreshStatus});
          seen.issued++;
          return Response.json({
            access_token: `access-${seen.issued + 1}`,
            refresh_token: `refresh-${seen.issued + 1}`,
            expires_in: 3600,
          });
        }
        // PKCE: the verifier must hash to the challenge sent in the authorization request.
        const digest = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (digest !== challenge || form.get('client_id') !== clientID || form.get('code') !== authorizationCode)
          return new Response('{"error":"invalid_grant"}', {status: 400});
        const now = Math.floor(Date.now() / 1000);
        seen.issued++;
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
          id_token: await sign({
            iss: `http://127.0.0.1:${port}`,
            aud: clientID,
            sub: 'user-1',
            exp: now + 3600,
            nonce: options.badNonce ? 'other' : nonce,
          }),
        });
      }
      return new Response('not found', {status: 404});
    },
  });
  port = server.port as number;
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${port}`;
  /** What the browser does: validates the authorization request, then follows the redirect. */
  const browser =
    (callback: {state?: (real: string) => string; code?: string; error?: string; clientID?: string} = {}) =>
    async (target: string) => {
      const auth = new URL(target);
      expect(auth.origin + auth.pathname).toBe(`${url}/api/accounts/authorize`);
      seen.authorize = auth.searchParams;
      seen.authorizations.push(auth.searchParams);
      nonce = auth.searchParams.get('nonce')!;
      challenge = auth.searchParams.get('code_challenge')!;
      clientID = 'client-issued-by-openai';
      authorizationCode = `code-${seen.authorizations.length}`;
      const redirect = new URL(auth.searchParams.get('redirect_uri')!);
      if (callback.error) {
        redirect.searchParams.set('error', callback.error);
        redirect.searchParams.set('state', auth.searchParams.get('state')!);
      } else {
        redirect.searchParams.set('code', callback.code ?? authorizationCode);
        redirect.searchParams.set(
          'state',
          callback.state ? callback.state(auth.searchParams.get('state')!) : auth.searchParams.get('state')!,
        );
        if (auth.searchParams.get('client_id') === 'dynamic_agent_client')
          redirect.searchParams.set('client_id', clientID);
        if (callback.clientID) redirect.searchParams.set('client_id', callback.clientID);
      }
      void fetch(redirect).catch(() => {});
    };
  return {url, seen, browser};
}

async function setup(auth: Awaited<ReturnType<typeof issuer>>, open: (url: string) => Promise<void>) {
  const api = fixtureServer();
  api.set({chatgpt: true, modelName: 'available-model', script: () => ({text: 'hello from api'})});
  const home = mkdtempSync(join(tmpdir(), 'futryn-chatgpt-'));
  const clock = {now: Date.now()};
  const vault = memoryVault();
  const app = startup(home, {vault, chatgpt: {issuer: auth.url, openURL: open, now: () => clock.now}});
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => api.server.stop(true),
    () => app.db.close(),
  );
  // The real preset points at api.openai.com; the test aims the same provider at the fixture API.
  const preset = providerPresets.find(p => p.id === 'chatgpt-api')!;
  app.registry.add({...preset, baseURL: `${api.url}/v1`});
  const client = app.createFutrynClient(home);
  let lastChallenge = '';
  const signIn = async (signal?: AbortSignal) => {
    const challenge = await client.beginProviderAuth('chatgpt-api', 'oauth-browser');
    lastChallenge = challenge.id;
    expect(challenge.autoComplete).toBe(true);
    return client.connectAccount(
      {
        providerId: 'chatgpt-api',
        alias: 'chatgpt',
        credential: {kind: 'keyring', key: crypto.randomUUID()},
        authChallengeId: challenge.id,
      },
      signal,
    );
  };
  return {app, client, api, vault, clock, signIn, lastChallenge: () => lastChallenge};
}

test('ChatGPT API sign-in: dynamic client, PKCE, scope, verified id_token, tokens only in the keyring, then model requests', async () => {
  const auth = await issuer();
  const c = await setup(auth, async url => auth.browser()(url));
  const account = await c.signIn();
  expect(auth.seen.authorize!.get('client_id')).toBe('dynamic_agent_client');
  expect(auth.seen.authorize!.get('agent_name_hint')).toBe('Cosmew');
  expect(auth.seen.authorize!.get('code_challenge_method')).toBe('S256');
  expect(auth.seen.authorize!.get('scope')).toContain('chatgpt.tokens.use.direct');
  expect(auth.seen.authorize!.get('resource')).toBe('https://api.openai.com/v1');
  expect(auth.seen.authorize!.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  expect(account.status).toBe('valid');
  expect(c.client.cachedModels(account.id).map(model => model.id)).toEqual(['available-model']);
  expect(c.client.status().executionBackend).toMatchObject({kind: 'chat-only'});
  c.client.setToolsEnabled(true);
  expect(c.client.status().executionBackend).toMatchObject({kind: 'hannes', loopOwner: 'hannes', toolOwner: 'hannes'});
  // Tokens exist only in the vault, never in settings or the database.
  expect([...c.vault.values.values()].some(v => v.includes('access-1') && v.includes('refresh-1'))).toBe(true);
  expect(JSON.stringify(c.app.settings.read())).not.toContain('access-1');
  expect(JSON.stringify(c.app.settings.read())).not.toContain('refresh-1');
  c.client.selectModel('available-model');
  let text = '';
  for await (const event of c.client.sendMessage('hi')) if (event.type === 'textDelta') text += event.text;
  expect(text).toBe('hello from api');
  expect(c.api.requests.at(-1)!.authorization).toBe('Bearer access-1');
  await c.client.diagnose(undefined, true);
  expect(c.api.requests.at(-1)!.body).toMatchObject({model: 'available-model', stream: true, store: false});
  expect(c.app.redactor.text('x access-1 y refresh-1')).not.toMatch(/access-1|refresh-1/);
});

test('saved manual ChatGPT presets discover the account catalog and validate using streaming inference', async () => {
  const auth = await issuer();
  const c = await setup(auth, auth.browser());
  c.app.settings.update(state => {
    const provider = state.providers.find(p => p.id === 'chatgpt-api')!;
    provider.catalog = 'manual';
    provider.models = ['obsolete-fallback-model'];
  });
  const account = await c.signIn();
  expect(c.client.cachedModels(account.id).map(model => model.id)).toEqual(['available-model']);
  await c.client.diagnose(undefined, true);
  expect(c.api.requests.at(-1)!.body).toMatchObject({model: 'available-model', stream: true, store: false});
});

test('failed sign-ins leave no account, no vault entry and close the callback listener', async () => {
  const cases: [
    string,
    Parameters<typeof issuer>[0],
    Parameters<ReturnType<Awaited<ReturnType<typeof issuer>>['browser']>>[0] extends never ? never : any,
  ][] = [
    ['provider error', {}, {error: 'access_denied'}],
    ['no token-sharing scope', {scope: 'openid offline_access'}, {}],
    ['id_token nonce mismatch', {badNonce: true}, {}],
    ['code not accepted', {}, {code: 'wrong-code'}],
  ];
  for (const [name, options, callback] of cases) {
    const auth = await issuer(options);
    let redirectURL = '';
    const c = await setup(auth, async url => {
      redirectURL = new URL(new URL(url).searchParams.get('redirect_uri')!).origin;
      await auth.browser(callback)(url);
    });
    await expect(c.signIn()).rejects.toBeDefined();
    expect({name, accounts: c.app.accounts.list().length, vault: c.vault.values.size}).toEqual({
      name,
      accounts: 0,
      vault: 0,
    });
    // The loopback listener is gone after a failure.
    await expect(fetch(`${redirectURL}/auth/callback`, {signal: AbortSignal.timeout(1000)})).rejects.toBeDefined();
  }
});

test('a JWKS outage or malformed response does not blame the user credentials', async () => {
  for (const [options, code] of [
    [{jwksStatus: 503}, 'TRANSPORT'],
    [{jwksStatus: 403}, 'TRANSPORT'],
    [{jwksStatus: 429}, 'RATE_LIMIT'],
    [{jwksBody: '<html>upstream-private-detail</html>'}, 'PROTOCOL'],
  ] as const) {
    const auth = await issuer(options);
    const c = await setup(auth, auth.browser());
    await expect(c.signIn()).rejects.toMatchObject({code});
    expect(c.app.accounts.list()).toHaveLength(0);
    expect(c.vault.values.size).toBe(0);
  }
});

test('invalid_grant recovers once with the issued client and a fresh PKCE authorization on the same host', async () => {
  const auth = await issuer({invalidGrantOnce: true});
  const c = await setup(auth, auth.browser());
  const account = await c.signIn();
  expect(account.status).toBe('valid');
  expect(auth.seen.authorizations).toHaveLength(2);
  const [first, next] = auth.seen.authorizations;
  expect(first!.get('client_id')).toBe('dynamic_agent_client');
  expect(next!.get('client_id')).toBe('client-issued-by-openai');
  expect(next!.has('agent_name_hint')).toBe(false);
  expect(next!.get('ext_agent_host_id')).toBe(first!.get('ext_agent_host_id'));
  for (const key of ['state', 'nonce', 'code_challenge']) expect(next!.get(key)).not.toBe(first!.get(key));
  expect(auth.seen.tokens).toHaveLength(2);
  expect(auth.seen.tokens[1]!.get('code')).not.toBe(auth.seen.tokens[0]!.get('code'));
  expect(auth.seen.tokens[1]!.get('client_id')).toBe('client-issued-by-openai');
});

test('the OAuth host identity survives application restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-oauth-host-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const first = startup(home, {vault: memoryVault()});
  const host = first.settings.read().chatgptHostID;
  first.db.close();
  const next = startup(home, {vault: memoryVault()});
  cleanup.push(() => next.db.close());
  expect(host).toBeDefined();
  expect(next.settings.read().chatgptHostID).toBe(host);
});

test('recovery rejects a different callback client before exchanging its code', async () => {
  const auth = await issuer({invalidGrantOnce: true});
  let calls = 0;
  const c = await setup(auth, async url => {
    await auth.browser(++calls === 1 ? {} : {clientID: 'different-client'})(url);
  });
  await expect(c.signIn()).rejects.toMatchObject({code: 'AUTH'});
  expect(auth.seen.tokens).toHaveLength(1);
  expect(c.vault.values.size).toBe(0);
  expect(c.app.accounts.list()).toHaveLength(0);
});

test('cancelling the original challenge also cancels its recovery authorization', async () => {
  const auth = await issuer({invalidGrantOnce: true});
  let second!: () => void;
  const opened = new Promise<void>(resolve => (second = resolve));
  let calls = 0;
  let redirect = '';
  const c = await setup(auth, async url => {
    if (++calls === 1) await auth.browser()(url);
    else {
      redirect = new URL(url).searchParams.get('redirect_uri')!;
      second();
    }
  });
  const pending = c.signIn();
  void pending.catch(() => {});
  await opened;
  await c.client.cancelProviderAuth(c.lastChallenge());
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  await expect(fetch(redirect, {signal: AbortSignal.timeout(1000)})).rejects.toBeDefined();
  expect(c.vault.values.size).toBe(0);
});

test('the callback page waits for token verification and reports its failure without provider data', async () => {
  const auth = await issuer({badNonce: true});
  let callback!: Promise<Response>;
  const c = await setup(auth, async target => {
    // Prime the issuer but capture the callback ourselves so its visible result is tested.
    const redirect = new URL(target).searchParams.get('redirect_uri')!;
    const state = new URL(target).searchParams.get('state')!;
    await auth.browser({state: () => 'wrong-state'})(target);
    callback = fetch(`${redirect}?state=${state}&code=code-1&client_id=client-issued-by-openai`);
  });
  await expect(c.signIn()).rejects.toMatchObject({code: 'AUTH'});
  const response = await callback;
  expect(response.status).toBe(400);
  const page = await response.text();
  expect(page).toContain('ID token');
  expect(page).not.toMatch(/Signed in\.|access-1|refresh-1|code-1|upstream-private-detail/);
});

test('a refused authorization grant reports the safe OAuth reason without reflecting arbitrary provider text', async () => {
  for (const reason of ['invalid_grant', 'private-provider-secret']) {
    const auth = await issuer({tokenError: reason});
    let callback!: Promise<Response>;
    const c = await setup(auth, async target => {
      await auth.browser({state: () => 'wrong-state'})(target);
      const url = new URL(new URL(target).searchParams.get('redirect_uri')!);
      url.searchParams.set('state', new URL(target).searchParams.get('state')!);
      url.searchParams.set('code', 'code-1');
      url.searchParams.set('client_id', 'client-issued-by-openai');
      callback = fetch(url);
    });
    await expect(c.signIn()).rejects.toMatchObject({code: 'AUTH'});
    const response = await callback;
    expect(response.status).toBe(400);
    const page = await response.text();
    expect(page).toContain('HTTP 400');
    if (reason === 'invalid_grant') expect(page).toContain('invalid_grant');
    expect(auth.seen.tokens).toHaveLength(reason === 'invalid_grant' ? 2 : 1);
    expect(page).not.toMatch(/private-provider-secret|code-1|access-1|refresh-1/);
    expect(c.vault.values.size).toBe(0);
    expect(c.app.accounts.list()).toHaveLength(0);
  }
});

test('cancellation interrupts an in-flight JWKS request and leaves no credentials', async () => {
  let started!: () => void;
  let release!: () => void;
  const requested = new Promise<void>(resolve => (started = resolve));
  const wait = new Promise<void>(resolve => (release = resolve));
  const auth = await issuer({onJwks: started, jwksWait: wait});
  const c = await setup(auth, auth.browser());
  const controller = new AbortController();
  const pending = c.signIn(controller.signal);
  void pending.catch(() => {});
  try {
    await requested;
    controller.abort();
    // Do not release the server: completion must come from aborting the HTTP request.
    await expect(Promise.race([pending, Bun.sleep(1000).then(() => 'still waiting')])).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(c.app.accounts.list()).toHaveLength(0);
    expect(c.vault.values.size).toBe(0);
  } finally {
    release();
  }
});

test('cancelling a pending sign-in removes everything and stops the listener', async () => {
  const auth = await issuer();
  let redirect = '';
  const c = await setup(auth, async url => {
    redirect = new URL(url).searchParams.get('redirect_uri')!; // the browser never comes back
  });
  const controller = new AbortController();
  const pending = c.signIn(controller.signal);
  await Bun.sleep(100);
  controller.abort();
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  expect(c.app.accounts.list()).toHaveLength(0);
  expect(c.vault.values.size).toBe(0);
  await expect(fetch(redirect + '?code=late&state=x', {signal: AbortSignal.timeout(1000)})).rejects.toBeDefined();
  expect(auth.seen.tokens).toHaveLength(0); // no token request was ever made
});

test('an expiring access token refreshes once (single flight), rotates the stored refresh token', async () => {
  const auth = await issuer();
  const c = await setup(auth, async url => auth.browser()(url));
  await c.signIn();
  c.client.selectModel('available-model');
  c.clock.now += 3600_000; // the access token is now past its expiry
  const run = async () => {
    let text = '';
    for await (const event of c.client.sendMessage('again')) if (event.type === 'textDelta') text += event.text;
    return text;
  };
  expect(await run()).toBe('hello from api');
  expect(auth.seen.tokens.filter(t => t.get('grant_type') === 'refresh_token')).toHaveLength(1);
  const refresh = auth.seen.tokens.find(t => t.get('grant_type') === 'refresh_token')!;
  expect(refresh.get('refresh_token')).toBe('refresh-1');
  expect(refresh.get('client_id')).toBe('client-issued-by-openai');
  expect(c.api.requests.at(-1)!.authorization).toBe('Bearer access-3');
  expect([...c.vault.values.values()].some(v => v.includes('refresh-3'))).toBe(true);
  expect([...c.vault.values.values()].some(v => v.includes('refresh-1'))).toBe(false);
  // Fresh token: no further refresh.
  await run();
  expect(auth.seen.tokens.filter(t => t.get('grant_type') === 'refresh_token')).toHaveLength(1);
});

test('a refused refresh or a 401 from the API asks for a new sign-in (AUTH), never retries blindly', async () => {
  const refused = await issuer({refreshStatus: 400});
  const c = await setup(refused, async url => refused.browser()(url));
  await c.signIn();
  c.client.selectModel('available-model');
  c.clock.now += 3600_000;
  await expect(
    (async () => {
      for await (const _ of c.client.sendMessage('hi')) {
        /* drain */
      }
    })(),
  ).rejects.toMatchObject({code: 'AUTH'});
  expect(refused.seen.tokens.filter(t => t.get('grant_type') === 'refresh_token')).toHaveLength(1);

  const auth = await issuer();
  const d = await setup(auth, async url => auth.browser()(url));
  await d.signIn();
  d.client.selectModel('available-model');
  d.api.set({status: 401});
  await expect(
    (async () => {
      for await (const _ of d.client.sendMessage('hi')) {
        /* drain */
      }
    })(),
  ).rejects.toMatchObject({code: 'AUTH'});
});

/** The browser is held back: the test sends each callback itself. */
async function manual() {
  const auth = await issuer();
  let target!: URL;
  let release!: () => void;
  const opened = new Promise<void>(resolve => (release = resolve));
  const c = await setup(auth, async url => {
    target = new URL(url);
    release();
  });
  const pending = c.signIn();
  pending.catch(() => {}); // awaited later; avoid an unhandled-rejection race
  await opened;
  const redirect = new URL(target.searchParams.get('redirect_uri')!);
  const state = target.searchParams.get('state')!;
  const callback = (params: Record<string, string>) => {
    const url = new URL(redirect);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url, {signal: AbortSignal.timeout(2000)});
  };
  return {auth, c, pending, state, callback, target};
}
/** Complete the issuer-side bookkeeping the fake browser normally does (nonce, challenge, client). */
async function primeIssuer(m: Awaited<ReturnType<typeof manual>>) {
  await m.auth
    .browser()(m.target.href)
    .catch(() => {});
}

test('a request with a wrong or missing state cannot abort the pending sign-in; the right callback still succeeds', async () => {
  const m = await manual();
  // Hostile local requests: wrong state, no state, error with wrong state.
  for (const params of [{state: 'forged', code: 'x'}, {code: 'x'}, {state: 'forged', error: 'access_denied'}] as Record<
    string,
    string
  >[]) {
    const response = await m.callback(params);
    expect(response.status).toBe(400);
  }
  expect(m.c.app.accounts.list()).toHaveLength(0);
  // The login is still pending: a correct callback (sent through the fake browser) completes it.
  m.auth.seen.authorize = undefined;
  await primeIssuer(m);
  const account = await m.pending;
  expect(account.status).toBe('valid');
  expect([...m.c.vault.values.values()].some(v => v.includes('access-1'))).toBe(true);
});

test('a state-valid error callback fails the sign-in, and a second valid callback is ignored', async () => {
  const m = await manual();
  const denied = await m.callback({state: m.state, error: 'access_denied'});
  expect(denied.status).toBe(400);
  await expect(m.pending).rejects.toMatchObject({code: 'AUTH'});
  expect(m.c.app.accounts.list()).toHaveLength(0);
  expect(m.c.vault.values.size).toBe(0);
  // The listener is closed: nothing answers any more.
  await expect(m.callback({state: m.state, code: 'code-1', client_id: 'x'})).rejects.toBeDefined();
});

test('only one valid callback is accepted: the replay after success is refused or unreachable', async () => {
  const m = await manual();
  await primeIssuer(m);
  const account = await m.pending;
  expect(account.status).toBe('valid');
  await expect(m.callback({state: m.state, code: 'code-2', client_id: 'other'})).rejects.toBeDefined();
  expect(m.auth.seen.tokens.filter(t => t.get('grant_type') === 'authorization_code')).toHaveLength(1);
});
