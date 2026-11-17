import {afterEach, expect, test} from 'bun:test';
import {
  isPublicAddress,
  parseFetchUrl,
  requestPinned,
  WebFetchRuntime,
} from '../../packages/tools/src/runtimes/web-fetch';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('SSRF address checks reject non-public IPv4, IPv6 and alternate URL spellings', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.1.1',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    expect({ip, public: isPublicAddress(ip)}).toEqual({ip, public: false});
  for (const ip of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip)).toBe(true);
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/a',
    'https://user:pass@example.com',
    'http://2130706433',
    'http://0x7f000001',
    'http://[::1]',
    'http://localhost/a',
  ])
    expect(() => parseFetchUrl(url)).toThrow();
  expect(parseFetchUrl('https://example.com/search?q=bun').href).toBe('https://example.com/search?q=bun');
});

test('DNS answers are checked in full before a request; a redirect gets new policy and DNS checks', async () => {
  const calls: string[] = [];
  const authorized: string[] = [];
  const blocked = new WebFetchRuntime({
    resolve: async () => [{address: '127.0.0.1', family: 4}],
    request: async url => {
      calls.push(url.href);
      return {status: 200, headers: {'content-type': 'text/plain'}, body: Buffer.from('bad')};
    },
  });
  await expect(blocked.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'POLICY',
  });
  expect(calls).toEqual([]);
  const mixed = new WebFetchRuntime({
    resolve: async () => [
      {address: '1.1.1.1', family: 4},
      {address: '10.1.1.1', family: 4},
    ],
    request: async () => {
      throw new Error('must not run');
    },
  });
  await expect(mixed.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'POLICY',
  });
  const runtime = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async url => {
      calls.push(url.href);
      return {status: 302, headers: {location: 'http://127.0.0.1/private'}, body: new Uint8Array()};
    },
  });
  await expect(
    runtime.fetch('https://public.example/', {
      authorize: async url => {
        authorized.push(url);
        return true;
      },
    }),
  ).rejects.toMatchObject({code: 'POLICY'});
  expect(calls).toEqual(['https://public.example/']);
  expect(authorized).toEqual(['https://public.example/']);
});

test('redirect cross-domain denial prevents second connection; cancellation prevents all network', async () => {
  const calls: string[] = [];
  const auth: string[] = [];
  const runtime = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async url => {
      calls.push(url.href);
      return {status: 302, headers: {location: 'https://other.example/'}, body: new Uint8Array()};
    },
  });
  await expect(
    runtime.fetch('https://public.example/', {
      authorize: async url => {
        auth.push(url);
        return !url.includes('other');
      },
    }),
  ).rejects.toMatchObject({code: 'POLICY'});
  expect(calls).toEqual(['https://public.example/']);
  expect(auth).toEqual(['https://public.example/', 'https://other.example/']);
  const controller = new AbortController();
  controller.abort();
  await expect(
    runtime.fetch('https://public.example/', {authorize: async () => true, signal: controller.signal}),
  ).rejects.toMatchObject({code: 'CANCELLED'});
  expect(calls).toHaveLength(1);
});

test('real pinned HTTP transport connects only to the selected address and retains the URL Host', async () => {
  const hosts: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      hosts.push(request.headers.get('host') ?? '');
      return new Response('fixture content');
    },
  });
  cleanup.push(() => server.stop(true));
  const response = await requestPinned(
    new URL(`http://unresolvable.invalid:${server.port}/`),
    {address: '127.0.0.1', family: 4},
    new AbortController().signal,
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(response.body).toString()).toBe('fixture content');
  expect(hosts).toEqual([`unresolvable.invalid:${server.port}`]);
});

test('bounded fetch converts HTML, removes active content, follows at most five redirects and times out', async () => {
  const runtime = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async () => ({
      status: 200,
      headers: {'content-type': 'text/html'},
      body: Buffer.from(
        '<h1>Reference</h1><script>secret-script()</script><style>.secret{}</style><p>Hello <b>world</b></p>',
      ),
    }),
  });
  const result = await runtime.fetch('https://public.example/', {authorize: async () => true});
  expect(result.content).toContain('# Reference');
  expect(result.content).toContain('**world**');
  expect(result.content).not.toContain('secret');
  const redirects = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async () => ({status: 302, headers: {location: '/again'}, body: new Uint8Array()}),
  });
  await expect(redirects.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'PROTOCOL',
  });
  const huge = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async () => ({
      status: 200,
      headers: {'content-type': 'text/plain'},
      body: new Uint8Array(5 * 1024 * 1024 + 1),
    }),
  });
  await expect(huge.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'PROTOCOL',
  });
  const slow = new WebFetchRuntime({
    resolve: () => new Promise(() => {}),
    request: async () => {
      throw new Error('unreachable');
    },
  });
  await expect(
    slow.fetch('https://public.example/', {authorize: async () => true, timeout: 0.01}),
  ).rejects.toMatchObject({code: 'TIMEOUT'});
});

test('text conversion omits scripts and styles just like markdown; html explicitly returns source', async () => {
  const runtime = new WebFetchRuntime({
    resolve: async () => [{address: '1.1.1.1', family: 4}],
    request: async () => ({
      status: 200,
      headers: {'content-type': 'text/html'},
      body: Buffer.from('<p>Visible</p><script>hidden-script</script><style>hidden-style</style>'),
    }),
  });
  const plain = await runtime.fetch('https://public.example/', {authorize: async () => true, format: 'text'});
  expect(plain.content).toContain('Visible');
  expect(plain.content).not.toContain('hidden-script');
  expect(plain.content).not.toContain('hidden-style');
  const html = await runtime.fetch('https://public.example/', {authorize: async () => true, format: 'html'});
  expect(html.content).toContain('<p>Visible</p>');
});

test('real HTTP transport cancels oversized and aborted streams without waiting for EOF', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/big') return new Response(new Uint8Array(5 * 1024 * 1024 + 1));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('pending'));
          },
        }),
      );
    },
  });
  cleanup.push(() => server.stop(true));
  const address = {address: '127.0.0.1', family: 4};
  await expect(
    requestPinned(new URL(`http://fixture.invalid:${server.port}/big`), address, new AbortController().signal),
  ).rejects.toMatchObject({code: 'PROTOCOL'});
  const signal = AbortSignal.timeout(20);
  await expect(requestPinned(new URL(`http://fixture.invalid:${server.port}/slow`), address, signal)).rejects.toThrow();
});

test('public IPv6 transport failure falls back only to the already validated IPv4 answer', async () => {
  const attempted: string[] = [];
  let resolutions = 0;
  const authorized: string[] = [];
  const runtime = new WebFetchRuntime({
    resolve: async () => {
      resolutions++;
      return [
        {address: '2606:4700:4700::1111', family: 6},
        {address: '1.1.1.1', family: 4},
      ];
    },
    request: async (_url, address) => {
      attempted.push(address.address);
      if (address.family === 6) throw Object.assign(new Error('unreachable'), {code: 'ECONNREFUSED'});
      return {status: 200, headers: {'content-type': 'text/plain'}, body: Buffer.from('reachable through IPv4')};
    },
  });
  const result = await runtime.fetch('https://public.example/', {
    authorize: async url => {
      authorized.push(url);
      return true;
    },
  });
  expect(result.content).toContain('reachable through IPv4');
  expect(attempted).toEqual(['2606:4700:4700::1111', '1.1.1.1']);
  expect(resolutions).toBe(1);
  expect(authorized).toEqual(['https://public.example/']);
});

test('address fallback never tries a private later answer or repeats a response/error at application level', async () => {
  let attempts = 0;
  const mixed = new WebFetchRuntime({
    resolve: async () => [
      {address: '2606:4700:4700::1111', family: 6},
      {address: '127.0.0.1', family: 4},
    ],
    request: async () => {
      attempts++;
      throw new Error('no connection permitted');
    },
  });
  await expect(mixed.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'POLICY',
  });
  expect(attempts).toBe(0);
  const responseFailure = new WebFetchRuntime({
    resolve: async () => [
      {address: '2606:4700:4700::1111', family: 6},
      {address: '1.1.1.1', family: 4},
    ],
    request: async () => {
      attempts++;
      return {status: 403, headers: {}, body: new Uint8Array()};
    },
  });
  await expect(responseFailure.fetch('https://public.example/', {authorize: async () => true})).rejects.toMatchObject({
    code: 'TRANSPORT',
  });
  expect(attempts).toBe(1);
});

test('a black-holed first connection gets a bounded slice so validated IPv4 fits the total deadline', async () => {
  const tried: string[] = [];
  const budgets: number[] = [];
  const runtime = new WebFetchRuntime({
    resolve: async () => [
      {address: '2606:4700:4700::1111', family: 6},
      {address: '1.1.1.1', family: 4},
    ],
    request: async (_url, address, _signal, budget?: number) => {
      tried.push(address.address);
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(50);
      budgets.push(budget!);
      if (address.family === 6) {
        await Bun.sleep(budget!);
        throw Object.assign(new Error('connect timed out'), {code: 'ETIMEDOUT'});
      }
      return {status: 200, headers: {'content-type': 'text/plain'}, body: Buffer.from('fallback')};
    },
  });
  expect(
    (await runtime.fetch('https://public.example/', {timeout: 0.1, authorize: async () => true})).content,
  ).toContain('fallback');
  expect(tried).toHaveLength(2);
  expect(budgets).toHaveLength(2);
});

test('cancellation while trying the first address stops all later address attempts', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const runtime = new WebFetchRuntime({
    resolve: async () => [
      {address: '2606:4700:4700::1111', family: 6},
      {address: '1.1.1.1', family: 4},
    ],
    request: async (_url, _address, signal) => {
      attempts++;
      queueMicrotask(() => controller.abort());
      return await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}),
      );
    },
  });
  await expect(
    runtime.fetch('https://public.example/', {signal: controller.signal, authorize: async () => true}),
  ).rejects.toMatchObject({code: 'CANCELLED'});
  expect(attempts).toBe(1);
});

test('fallback connections remain pinned on real local sockets without re-resolving the URL hostname', async () => {
  const hosts: string[] = [];
  const attempts: string[] = [];
  let resolutions = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      hosts.push(request.headers.get('host') ?? '');
      return new Response('real pinned fallback');
    },
  });
  cleanup.push(() => server.stop(true));
  const runtime = new WebFetchRuntime({
    resolve: async () => {
      resolutions++;
      return [
        {address: '1.1.1.1', family: 4},
        {address: '8.8.8.8', family: 4},
      ];
    },
    request: (url, address, signal, budget) => {
      attempts.push(address.address);
      // Fixture-only adapter maps validated public test identities to two actual loopback sockets.
      return requestPinned(
        url,
        {address: address.address === '1.1.1.1' ? '127.0.0.2' : '127.0.0.1', family: 4},
        signal,
        budget,
      );
    },
  });
  expect(
    (await runtime.fetch(`http://unresolvable.invalid:${server.port}/`, {authorize: async () => true})).content,
  ).toContain('real pinned fallback');
  expect(resolutions).toBe(1);
  expect(attempts).toEqual(['1.1.1.1', '8.8.8.8']);
  expect(hosts).toEqual([`unresolvable.invalid:${server.port}`]);
});
