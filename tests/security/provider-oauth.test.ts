import {afterEach, expect, test} from 'bun:test';
import {OpenRouterPKCE, Redactor} from '@futryn/security';
import {FutrynError} from '@futryn/contracts';
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
