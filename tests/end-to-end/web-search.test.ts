import {afterEach, expect, test} from 'bun:test';
import {McpClient, WebSearchClient, selectSearchProvider} from '@cosmew/mcp';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

/** Wire-level MCP fixture: production SDK initialization and calls over real HTTP, no live claim. */
function fixture(options: {delay?: number; error?: boolean; huge?: boolean} = {}) {
  const calls: {method: string; params?: Record<string, unknown>}[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method === 'GET' || request.method === 'DELETE') return new Response(null, {status: 405});
      const body = (await request.json()) as {id?: number; method: string; params?: Record<string, unknown>};
      calls.push(body);
      if (body.method === 'notifications/initialized' || body.method.startsWith('notifications/'))
        return new Response(null, {status: 202});
      if (body.method === 'initialize')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {tools: {}},
            serverInfo: {name: 'fixture', version: '1'},
          },
        });
      if (body.method === 'tools/call') {
        if (options.delay) await Bun.sleep(options.delay);
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            ...(options.error ? {isError: true} : {}),
            content: [
              {
                type: 'text',
                text: options.huge
                  ? 'x'.repeat(300_000)
                  : 'Title: Fixture\nURL: https://example.com/reference\nText: fixture sk-secret-fixture',
              },
            ],
          },
        });
      }
      return new Response(null, {status: 501});
    },
  });
  cleanups.push(() => server.stop(true));
  return {url: new URL(`http://127.0.0.1:${server.port}/mcp`), calls};
}

test('MCP HTTP initializes once per endpoint, calls with arguments, bounds and redacts output', async () => {
  const f = fixture();
  const client = new McpClient({endpoint: f.url, redact: t => t.replaceAll('sk-secret-fixture', '[REDACTED]')});
  cleanups.push(() => client.close());
  const first = await client.call('web_search_exa', {query: 'typescript', numResults: 2});
  const second = await client.call('web_search_exa', {query: 'bun', numResults: 1});
  expect(first.text).toContain('[REDACTED]');
  expect(second.text).not.toContain('sk-secret-fixture');
  expect(f.calls.filter(c => c.method === 'initialize')).toHaveLength(1);
  expect(f.calls.filter(c => c.method === 'tools/call').map(c => c.params)).toEqual([
    {name: 'web_search_exa', arguments: {query: 'typescript', numResults: 2}},
    {name: 'web_search_exa', arguments: {query: 'bun', numResults: 1}},
  ]);
});

test('MCP limits response bytes and returns safe upstream errors', async () => {
  for (const options of [{huge: true}, {error: true}]) {
    const f = fixture(options);
    const client = new McpClient({endpoint: f.url, redact: t => t});
    cleanups.push(() => client.close());
    await expect(client.call('web_search_exa', {query: 'test'})).rejects.toThrow();
  }
});

test('MCP timeout and cancellation stop pending calls', async () => {
  const f = fixture({delay: 500});
  const client = new McpClient({endpoint: f.url, redact: t => t, timeoutMs: 40});
  cleanups.push(() => client.close());
  await expect(client.call('web_search_exa', {query: 'slow'})).rejects.toMatchObject({code: 'TIMEOUT'});
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(client.call('web_search_exa', {query: 'abort'}, cancelled.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
});

test('provider keys choose deterministic source and search formats Exa results as untrusted data', async () => {
  expect(selectSearchProvider({})).toBe('exa');
  expect(selectSearchProvider({TAVILY_API_KEY: 'key'})).toBe('tavily');
  expect(selectSearchProvider({EXA_API_KEY: 'key', TAVILY_API_KEY: 'other'})).toBe('exa');
  expect(selectSearchProvider({FIRECRAWL_API_KEY: 'key'})).toBe('firecrawl');
  expect(selectSearchProvider({PARALLEL_API_KEY: 'key'})).toBe('parallel');
  const f = fixture();
  const client = new WebSearchClient({
    keys: {},
    redact: t => t.replaceAll('sk-secret-fixture', '[REDACTED]'),
    fetch: ((_input, init) => fetch(new URL('/mcp', f.url), init)) as typeof fetch,
  });
  cleanups.push(() => client.close());
  const text = await client.search('typescript', 2);
  expect(text).toContain('Untrusted web search results');
  expect(text).toContain('https://example.com/reference');
  expect(text).toContain('[REDACTED]');
  expect(f.calls.find(c => c.method === 'tools/call')?.params).toEqual({
    name: 'web_search_exa',
    arguments: {query: 'typescript', numResults: 2},
  });
});

test('MCP consumes SSE tool results and sanitizes structured content too', async () => {
  const f = fixture();
  const client = new McpClient({
    endpoint: f.url,
    redact: t => t.replaceAll('sk-secret-fixture', '[REDACTED]'),
    fetch: (async (input, init) => {
      const response = await fetch(input, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as {method?: string; id?: number}) : null;
      if (body?.method !== 'tools/call') return response;
      return new Response(
        `event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id: body.id, result: {content: [{type: 'text', text: 'fixture'}], structuredContent: {token: 'sk-secret-fixture'}}})}\n\n`,
        {headers: {'content-type': 'text/event-stream'}},
      );
    }) as typeof fetch,
  });
  cleanups.push(() => client.close());
  const result = await client.call('search', {});
  expect(result.structuredContent).toEqual({token: '[REDACTED]'});
});

test('Firecrawl and Parallel use their MCP schemas; Tavily uses the verified REST contract', async () => {
  for (const [key, expectedTool, expectedArgs] of [
    ['FIRECRAWL_API_KEY', 'firecrawl_search', {query: 'check', limit: 3}],
    ['PARALLEL_API_KEY', 'web_search', {objective: 'check', search_queries: ['check']}],
  ] as const) {
    const f = fixture();
    const requests: RequestInit[] = [];
    const c = new WebSearchClient({
      keys: {[key]: 'fixture-key'},
      redact: t => t,
      fetch: (async (_input, init) => {
        requests.push(init ?? {});
        const body = init?.body ? (JSON.parse(String(init.body)) as {method: string; id?: number}) : null;
        if (body?.method !== 'tools/call') return fetch(f.url, init);
        const result =
          key === 'FIRECRAWL_API_KEY'
            ? {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      data: {web: [{url: 'https://example.com/', title: 'Firecrawl', description: 'Excerpt'}]},
                    }),
                  },
                ],
              }
            : {
                content: [],
                structuredContent: {results: [{url: 'https://example.com/', title: 'Parallel', excerpts: ['Excerpt']}]},
              };
        return Response.json({jsonrpc: '2.0', id: body.id, result});
      }) as typeof fetch,
    });
    cleanups.push(() => c.close());
    expect(await c.search('check', 3)).toContain('https://example.com/');
    const call = requests
      .map(init => (init.body ? JSON.parse(String(init.body)) : {}))
      .find(body => body.method === 'tools/call');
    expect(call.params).toEqual({name: expectedTool, arguments: expectedArgs});
    expect(
      new Headers(requests.find(init => init.body && String(init.body).includes('tools/call'))?.headers).get(
        'Authorization',
      ),
    ).toBe('Bearer fixture-key');
  }
  let observed: {url: string; body: unknown; authorization: string | null} | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      observed = {url: request.url, body: await request.json(), authorization: request.headers.get('authorization')};
      return Response.json({results: [{title: 'Tavily', url: 'https://example.com/', content: 'Result'}]});
    },
  });
  cleanups.push(() => server.stop(true));
  const tavily = new WebSearchClient({
    keys: {TAVILY_API_KEY: 'fixture-key'},
    redact: t => t,
    fetch: ((_input, init) => fetch(`http://127.0.0.1:${server.port}/search`, init)) as typeof fetch,
  });
  expect(await tavily.search('check', 3)).toContain('Tavily');
  expect(observed?.body).toEqual({query: 'check', search_depth: 'basic', chunks_per_source: 3, max_results: 3});
  expect(observed?.authorization).toBe('Bearer fixture-key');
});

test('a transient initialize failure is retried by a fresh SDK connection on the next call', async () => {
  const f = fixture();
  let initializeCount = 0;
  const client = new McpClient({
    endpoint: f.url,
    redact: t => t,
    fetch: (async (input, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as {method?: string}) : null;
      if (body?.method === 'initialize' && ++initializeCount === 1)
        return new Response('temporary upstream outage', {status: 500});
      return fetch(input, init);
    }) as typeof fetch,
  });
  cleanups.push(() => client.close());
  await expect(client.call('web_search_exa', {query: 'first'})).rejects.toThrow();
  const recovered = await client.call('web_search_exa', {query: 'second'});
  expect(recovered.text).toContain('Fixture');
  expect(initializeCount).toBe(2);
});

test('closing during initialization aborts the network attempt and never sends initialized or tool calls', async () => {
  const f = fixture();
  let began = false;
  let stopped = false;
  const client = new McpClient({
    endpoint: f.url,
    redact: t => t,
    fetch: (async (_input, init) => {
      began = true;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          stopped = true;
          reject(new Error('aborted'));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, {once: true});
      });
    }) as typeof fetch,
  });
  const call = client.call('web_search_exa', {query: 'first'});
  const outcome = call.catch(error => error);
  while (!began) await Bun.sleep(1);
  await client.close();
  expect((await outcome).code).toBe('CANCELLED');
  expect(stopped).toBe(true);
  expect(f.calls).toEqual([]);
});
