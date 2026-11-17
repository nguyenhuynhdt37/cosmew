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
