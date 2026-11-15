import { providerSchema, type CredentialVault } from '@hannes/contracts';

export const memoryVault = (): CredentialVault & { values: Map<string, string> } => ({
  values: new Map(),
  async get(ref) { return ref.kind === 'keyring' ? this.values.get(ref.key) : ref.kind === 'env' ? process.env[ref.name] : undefined; },
  async set(key, value) { this.values.set(key, value); },
  async setRuntime(key, value) { this.values.set(key, value); },
  async getRuntime(ref) { return this.values.get(ref.key); },
  async delete(ref) { if (ref.kind === 'keyring' || ref.kind === 'runtime') this.values.delete(ref.key); },
});
export function fixtureServer() {
  const requests: { path: string; body: any; authorization: string | null; apiKey: string | null }[] = [];
  let cacheTokens: number | undefined; let reasoning = false; let status = 200; let delay = 0; let malformed = false; let dropped = false;
  let tools = false; let includeUsage = true; let modelName = 'fixture-model'; let pages = false; let streamDelay = 0; let invalidTool = false;
  let rateLimitHeaders: Record<string, string> = {};
  /** Chat protocol: call this tool until a tool result comes back, then answer with that result. */
  let toolCall: { name: string; args: string } | undefined;
  const sse = (items: unknown[], anthropic = false) => {
    const chunks = items.map(x => anthropic ? `event: ${(x as any).type}\ndata: ${JSON.stringify(x)}\n\n` : `data: ${JSON.stringify(x)}\n\n`);
    if (!anthropic) chunks.push('data: [DONE]\n\n');
    if (!streamDelay) return new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream', ...rateLimitHeaders } });
    let timer: ReturnType<typeof setInterval>;
    return new Response(new ReadableStream({ start(controller) {
      let index = 0; controller.enqueue(new TextEncoder().encode(chunks[index++]!));
      timer = setInterval(() => { if (index >= chunks.length) { clearInterval(timer); controller.close(); } else controller.enqueue(new TextEncoder().encode(chunks[index++]!)); }, streamDelay);
    }, cancel() { clearInterval(timer); } }), { headers: { 'content-type': 'text/event-stream', ...rateLimitHeaders } });
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url); const path = url.pathname;
    const body = req.method === 'POST' ? await req.json() as any : undefined;
    requests.push({ path, body, authorization: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key') ?? req.headers.get('x-goog-api-key') });
    if (delay) await Bun.sleep(delay);
    if (status !== 200) return Response.json({ error: { message: 'RAW-SENSITIVE-PROVIDER-ERROR', type: 'fixture' } }, { status, headers: { 'retry-after': '0' } });
    if (malformed) return Response.json({ unexpected: true });
    if (req.method === 'GET') {
      if (path === '/api/tags') return Response.json({ models: [{ name: modelName }] });
      if (path.startsWith('/gemini')) return Response.json({ models: [{ name: 'models/' + modelName, displayName: 'Fixture', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] }] });
      return Response.json({ data: [{ id: pages && url.searchParams.has('after_id') ? 'page-two' : modelName }], ...(pages ? { has_more: !url.searchParams.has('after_id'), last_id: 'cursor-one' } : {}) });
    }
    if (path.includes('generateContent') || path.includes('streamGenerateContent')) {
      const response = { candidates: [{ content: { role: 'model', parts: tools ? [{ functionCall: { name: 'lookup', args: { query: 'hello' } } }] : [{ text: 'Hello fixture' }] }, finishReason: 'STOP', index: 0 }], ...(includeUsage ? { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } } : {}), modelVersion: 'fixture' };
      return path.includes('streamGenerateContent') ? sse([response]) : Response.json(response);
    }
    if (path.includes('messages')) {
      if (!body.stream) return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: modelName, content: [{ type: 'text', text: 'Hello fixture' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4, output_tokens: 2 } });
      const events: unknown[] = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: modelName, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: tools ? { type: 'tool_use', id: 'call_fixture', name: 'lookup', input: {} } : { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: tools ? { type: 'input_json_delta', partial_json: invalidTool ? '{"query":7}' : '{"query":"hello"}' } : { type: 'text_delta', text: 'Hello fixture' } },
        { type: 'content_block_stop', index: 0 },
      ];
      if (!dropped) events.push({ type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
      return sse(events, true);
    }
    if (path.includes('responses')) {
      const output = tools ? [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup', arguments: '{"query":"hello"}', status: 'completed' }] : [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello fixture', annotations: [] }] }];
      const response = { id: 'resp_fixture', object: 'response', created_at: 1234567890, model: modelName, status: 'completed', output, error: null, incomplete_details: null, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, ...(cacheTokens !== undefined ? {input_tokens_details: {cached_tokens: cacheTokens}} : {}) } };
      if (!body.stream) return Response.json(response);
      return sse([
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        ...(reasoning ? [
          { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_fixture', summary: [] } },
          { type: 'response.reasoning_summary_part.added', item_id: 'rs_fixture', output_index: 1, summary_index: 0 },
          { type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', output_index: 1, summary_index: 0, delta: 'Provider HTTP ' },
          { type: 'response.reasoning_summary_text.delta', item_id: 'rs_fixture', output_index: 1, summary_index: 0, delta: 'summary' },
          { type: 'response.reasoning_summary_part.done', item_id: 'rs_fixture', output_index: 1, summary_index: 0 },
          { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'Provider HTTP summary' }] } },
        ] : []),
        { type: 'response.output_item.added', output_index: 0, item: output[0] },
        ...(tools ? [{ type: 'response.function_call_arguments.delta', item_id: 'fc_fixture', output_index: 0, delta: '{"query":"hello"}' }, { type: 'response.output_item.done', output_index: 0, item: output[0] }] : [
          { type: 'response.content_part.added', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Hello fixture' },
        ]),
        ...(!dropped ? [{ type: 'response.completed', response }] : []),
      ]);
    }
    const usage = includeUsage ? { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } : undefined;
    if (!body.stream) return Response.json({ id: 'fixture', object: 'chat.completion', created: 1234567890, model: modelName, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello fixture' }, finish_reason: 'stop' }], usage });
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1234567890, model: modelName };
    if (toolCall) {
      const results = (body.messages ?? []).filter((m: any) => m.role === 'tool');
      if (!results.length) return sse([
        { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
      ]);
      const seen = results.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' | ');
      return sse([
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `Saw: ${seen}` }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
      ]);
    }
    return sse([
      { ...base, choices: [{ index: 0, delta: tools ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }] } : { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: tools ? { tool_calls: [{ index: 0, function: { arguments: invalidTool ? '7}' : '"hello"}' } }] } : { content: 'fixture' }, finish_reason: null }] },
      ...(!dropped ? [{ ...base, choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage }] : []),
    ]);
  } });
  return { server, requests, url: `http://127.0.0.1:${server.port}`,
    provider(protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat', overrides = {}) {
      return providerSchema.parse({ id: 'fixture', name: 'Fixture', protocol, baseURL: `http://127.0.0.1:${server.port}/${protocol === 'gemini' ? 'gemini' : 'v1'}`, auth: 'api-key', catalog: protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai', metadataVersion: 1, timeoutMs: 1000, ...overrides });
    },
    set(options: { cacheTokens?: number; reasoning?: boolean; status?: number; delay?: number; malformed?: boolean; dropped?: boolean; tools?: boolean; includeUsage?: boolean; modelName?: string; pages?: boolean; streamDelay?: number; invalidTool?: boolean; rateLimitHeaders?: Record<string, string>; toolCall?: { name: string; args: string } | null }) {
      cacheTokens = options.cacheTokens ?? cacheTokens; reasoning = options.reasoning ?? reasoning; status = options.status ?? status; delay = options.delay ?? delay; malformed = options.malformed ?? malformed; dropped = options.dropped ?? dropped; tools = options.tools ?? tools; includeUsage = options.includeUsage ?? includeUsage; modelName = options.modelName ?? modelName; pages = options.pages ?? pages; streamDelay = options.streamDelay ?? streamDelay; invalidTool = options.invalidTool ?? invalidTool; rateLimitHeaders = options.rateLimitHeaders ?? rateLimitHeaders; toolCall = options.toolCall === null ? undefined : options.toolCall ?? toolCall;
    },
  };
}
