import {providerSchema, type CredentialVault} from '@cosmew/contracts';

export const memoryVault = (): CredentialVault & {values: Map<string, string>} => ({
  values: new Map(),
  async get(ref) {
    return ref.kind === 'keyring' ? this.values.get(ref.key) : ref.kind === 'env' ? process.env[ref.name] : undefined;
  },
  async set(key, value) {
    this.values.set(key, value);
  },
  async delete(ref) {
    if (ref.kind === 'keyring') this.values.delete(ref.key);
  },
});
/** What a scripted fixture model sees: the request as it arrived on the wire, protocol-neutral. */
export interface ScriptedView {
  protocol: 'chat' | 'anthropic' | 'responses' | 'gemini';
  /** System/developer channel text. */
  system: string;
  /** Tool names offered in this request. */
  tools: string[];
  /** Tool results in order, each joined to its call through the wire call id. */
  results: {callId: string; name: string; input: any; content: string}[];
  /** Results whose id matches no assistant tool call, and calls that never got a result. */
  orphanResults: number;
  unansweredCalls: number;
}
/** A scripted model answers with text or with tool calls, decided only from the view. */
export type ScriptedReply = {
  text?: string;
  calls?: {name: string; input: unknown}[];
  /** Anthropic only: stop with `pause_turn`. */ endTurn?: false;
};
const blockText = (content: any): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
export function scriptedView(protocol: ScriptedView['protocol'], body: any): ScriptedView {
  const calls = new Map<string, {name: string; input: any}>();
  const results: ScriptedView['results'] = [];
  let orphanResults = 0;
  const result = (id: string, content: any) => {
    const call = calls.get(id);
    if (!call) orphanResults++;
    else
      results.push({
        callId: id,
        ...call,
        content: typeof content === 'string' || Array.isArray(content) ? blockText(content) : JSON.stringify(content),
      });
  };
  if (protocol === 'responses') {
    for (const item of body.input ?? []) {
      if (item.type === 'function_call') calls.set(item.call_id, {name: item.name, input: JSON.parse(item.arguments)});
      if (item.type === 'function_call_output') result(item.call_id, item.output);
    }
    const system =
      (body.input ?? [])
        .filter((m: any) => m.role === 'system' || m.role === 'developer')
        .map((m: any) => blockText(m.content))
        .join('\n') + (body.instructions ?? '');
    return {
      protocol,
      system,
      tools: (body.tools ?? []).map((t: any) => t.name),
      results,
      orphanResults,
      unansweredCalls: calls.size - new Set(results.map(r => r.callId)).size,
    };
  }
  if (protocol === 'gemini') {
    // Gemini has no call ids on the wire: a response answers the oldest unanswered call of its name.
    let n = 0;
    const open: string[] = [];
    for (const content of body.contents ?? [])
      for (const part of content.parts ?? []) {
        if (part.functionCall) {
          const id = `g${n++}`;
          calls.set(id, {name: part.functionCall.name, input: part.functionCall.args});
          open.push(id);
        }
        if (part.functionResponse) {
          const at = open.findIndex(id => calls.get(id)!.name === part.functionResponse.name);
          if (at < 0) orphanResults++;
          else
            result(open.splice(at, 1)[0]!, part.functionResponse.response?.content ?? part.functionResponse.response);
        }
      }
    const tools = (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((d: any) => d.name));
    return {
      protocol,
      system: blockText(body.systemInstruction?.parts ?? ''),
      tools,
      results,
      orphanResults,
      unansweredCalls: open.length,
    };
  }
  for (const m of body.messages ?? []) {
    if (protocol === 'chat') {
      if (m.role === 'assistant')
        for (const c of m.tool_calls ?? [])
          calls.set(c.id, {name: c.function.name, input: JSON.parse(c.function.arguments)});
      if (m.role === 'tool') result(m.tool_call_id, m.content);
    } else if (Array.isArray(m.content))
      for (const part of m.content) {
        if (m.role === 'assistant' && part.type === 'tool_use')
          calls.set(part.id, {name: part.name, input: part.input});
        if (m.role === 'user' && part.type === 'tool_result') result(part.tool_use_id, part.content);
      }
  }
  const system =
    protocol === 'chat'
      ? (body.messages ?? [])
          .filter((m: any) => m.role === 'system' || m.role === 'developer')
          .map((m: any) => blockText(m.content))
          .join('\n')
      : blockText(body.system);
  const tools = (body.tools ?? []).map((t: any) => (protocol === 'chat' ? t.function.name : t.name));
  return {
    protocol,
    system,
    tools,
    results,
    orphanResults,
    unansweredCalls: calls.size - new Set(results.map(r => r.callId)).size,
  };
}
export function fixtureServer() {
  const requests: {
    path: string;
    body: any;
    authorization: string | null;
    apiKey: string | null;
    /** Every request header, lower-cased (host-config header tests, ADR 0046). */
    headers: Record<string, string>;
    search: string;
  }[] = [];
  let cacheTokens: number | undefined;
  let reasoning = false;
  /** Chat protocol: stream this as `reasoning_content` before each scripted reply (DeepSeek style). */
  let chatReasoning: string | undefined;
  /** Chat protocol: report DeepSeek cache counters in usage. */
  let deepseekCache: {hit: number; miss: number} | undefined;
  let status = 200;
  let delay = 0;
  let cutToolArgs = false;
  let malformed = false;
  let dropped = false;
  let tools = false;
  let includeUsage = true;
  let modelName = 'fixture-model';
  let chatgpt = false;
  let pages = false;
  let streamDelay = 0;
  let invalidTool = false;
  let rateLimitHeaders: Record<string, string> = {};
  /** Chat protocol: call this tool until a tool result comes back, then answer with that result. */
  let toolCall: {name: string; args: string} | undefined;
  /** Chat and Anthropic protocols: a deterministic model that decides from the request it received. */
  let script: ((view: ScriptedView) => ScriptedReply) | undefined;
  const sse = (items: unknown[], anthropic = false) => {
    const chunks = items.map(x =>
      anthropic ? `event: ${(x as any).type}\ndata: ${JSON.stringify(x)}\n\n` : `data: ${JSON.stringify(x)}\n\n`,
    );
    if (!anthropic) chunks.push('data: [DONE]\n\n');
    if (!streamDelay)
      return new Response(chunks.join(''), {headers: {'content-type': 'text/event-stream', ...rateLimitHeaders}});
    let timer: ReturnType<typeof setInterval>;
    return new Response(
      new ReadableStream({
        start(controller) {
          let index = 0;
          controller.enqueue(new TextEncoder().encode(chunks[index++]!));
          timer = setInterval(() => {
            if (index >= chunks.length) {
              clearInterval(timer);
              controller.close();
            } else controller.enqueue(new TextEncoder().encode(chunks[index++]!));
          }, streamDelay);
        },
        cancel() {
          clearInterval(timer);
        },
      }),
      {headers: {'content-type': 'text/event-stream', ...rateLimitHeaders}},
    );
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === 'POST' ? ((await req.json()) as any) : undefined;
      requests.push({
        path,
        body,
        authorization: req.headers.get('authorization'),
        apiKey: req.headers.get('x-api-key') ?? req.headers.get('x-goog-api-key'),
        headers: Object.fromEntries(req.headers),
        search: url.search,
      });
      if (delay) await Bun.sleep(delay);
      if (status !== 200)
        return Response.json(
          {error: {message: 'RAW-SENSITIVE-PROVIDER-ERROR', type: 'fixture'}},
          {status, headers: {'retry-after': '0'}},
        );
      if (malformed) return Response.json({unexpected: true});
      if (
        chatgpt &&
        req.method === 'POST' &&
        (body.stream !== true || body.store !== false || body.model !== modelName)
      )
        return Response.json({error: {code: 'invalid_request_error'}}, {status: 400});
      if (req.method === 'GET') {
        if (chatgpt)
          return Response.json({
            models: [
              {slug: modelName, display_name: 'Available ChatGPT model', visibility: 'list'},
              {slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden'},
            ],
          });
        if (path === '/api/tags') return Response.json({models: [{name: modelName}]});
        if (path.startsWith('/gemini'))
          return Response.json({
            models: [
              {name: 'models/' + modelName, displayName: 'Fixture', supportedGenerationMethods: ['generateContent']},
              {name: 'models/embedding-only', supportedGenerationMethods: ['embedContent']},
            ],
          });
        return Response.json({
          data: [{id: pages && url.searchParams.has('after_id') ? 'page-two' : modelName}],
          ...(pages ? {has_more: !url.searchParams.has('after_id'), last_id: 'cursor-one'} : {}),
        });
      }
      if (script && path.includes('streamGenerateContent')) {
        const reply = script(scriptedView('gemini', body));
        const parts = [
          ...(reply.text ? [{text: reply.text}] : []),
          ...(reply.calls ?? []).map(call => ({functionCall: {name: call.name, args: call.input}})),
        ];
        return sse([
          {
            candidates: [{content: {role: 'model', parts}, finishReason: 'STOP', index: 0}],
            usageMetadata: {promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6},
            modelVersion: 'fixture',
          },
        ]);
      }
      if (path.includes('generateContent') || path.includes('streamGenerateContent')) {
        const response = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: tools ? [{functionCall: {name: 'lookup', args: {query: 'hello'}}}] : [{text: 'Hello fixture'}],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          ...(includeUsage ? {usageMetadata: {promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6}} : {}),
          modelVersion: 'fixture',
        };
        return path.includes('streamGenerateContent') ? sse([response]) : Response.json(response);
      }
      if (path.includes('messages')) {
        if (script && body.stream) {
          const reply = script(scriptedView('anthropic', body));
          let index = 0;
          const blocks: unknown[] = [];
          if (reply.text)
            blocks.push(
              {type: 'content_block_start', index, content_block: {type: 'text', text: ''}},
              {type: 'content_block_delta', index, delta: {type: 'text_delta', text: reply.text}},
              {type: 'content_block_stop', index: index++},
            );
          for (const call of reply.calls ?? [])
            blocks.push(
              {
                type: 'content_block_start',
                index,
                content_block: {type: 'tool_use', id: `toolu_${requests.length}_${index}`, name: call.name, input: {}},
              },
              {
                type: 'content_block_delta',
                index,
                delta: {type: 'input_json_delta', partial_json: JSON.stringify(call.input)},
              },
              {type: 'content_block_stop', index: index++},
            );
          return sse(
            [
              {
                type: 'message_start',
                message: {
                  id: 'msg_fixture',
                  type: 'message',
                  role: 'assistant',
                  model: modelName,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {input_tokens: 4, output_tokens: 0},
                },
              },
              ...blocks,
              {
                type: 'message_delta',
                delta: {
                  stop_reason: reply.calls?.length ? 'tool_use' : reply.endTurn === false ? 'pause_turn' : 'end_turn',
                  stop_sequence: null,
                },
                usage: {output_tokens: 2},
              },
              {type: 'message_stop'},
            ],
            true,
          );
        }
        if (!body.stream)
          return Response.json({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: modelName,
            content: [{type: 'text', text: 'Hello fixture'}],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {input_tokens: 4, output_tokens: 2},
          });
        const events: unknown[] = [
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: modelName,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {input_tokens: 4, output_tokens: 0},
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: tools
              ? {type: 'tool_use', id: 'call_fixture', name: 'lookup', input: {}}
              : {type: 'text', text: ''},
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: tools
              ? {type: 'input_json_delta', partial_json: invalidTool ? '{"query":7}' : '{"query":"hello"}'}
              : {type: 'text_delta', text: 'Hello fixture'},
          },
          {type: 'content_block_stop', index: 0},
        ];
        if (!dropped)
          events.push(
            {
              type: 'message_delta',
              delta: {stop_reason: tools ? 'tool_use' : 'end_turn', stop_sequence: null},
              usage: {output_tokens: 2},
            },
            {type: 'message_stop'},
          );
        return sse(events, true);
      }
      if (script && path.includes('responses') && body.stream) {
        const reply = script(scriptedView('responses', body));
        const output: any[] = [
          ...(reply.text
            ? [
                {
                  type: 'message',
                  id: `msg_${requests.length}`,
                  role: 'assistant',
                  status: 'completed',
                  content: [{type: 'output_text', text: reply.text, annotations: []}],
                },
              ]
            : []),
          ...(reply.calls ?? []).map((call, index) => ({
            type: 'function_call',
            id: `fc_${requests.length}_${index}`,
            call_id: `call_${requests.length}_${index}`,
            name: call.name,
            arguments: JSON.stringify(call.input),
            status: 'completed',
          })),
        ];
        const response = {
          id: `resp_${requests.length}`,
          object: 'response',
          created_at: 1234567890,
          model: modelName,
          status: 'completed',
          output,
          error: null,
          incomplete_details: null,
          usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6},
        };
        return sse([
          {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
          ...output.flatMap((item, index) =>
            item.type === 'message'
              ? [
                  {type: 'response.output_item.added', output_index: index, item: {...item, content: []}},
                  {
                    type: 'response.content_part.added',
                    item_id: item.id,
                    output_index: index,
                    content_index: 0,
                    part: {type: 'output_text', text: '', annotations: []},
                  },
                  {
                    type: 'response.output_text.delta',
                    item_id: item.id,
                    output_index: index,
                    content_index: 0,
                    delta: reply.text,
                  },
                  {type: 'response.output_item.done', output_index: index, item},
                ]
              : [
                  {type: 'response.output_item.added', output_index: index, item: {...item, arguments: ''}},
                  {
                    type: 'response.function_call_arguments.delta',
                    item_id: item.id,
                    output_index: index,
                    delta: item.arguments,
                  },
                  {type: 'response.output_item.done', output_index: index, item},
                ],
          ),
          {type: 'response.completed', response},
        ]);
      }
      if (path.includes('responses')) {
        const output = tools
          ? [
              {
                type: 'function_call',
                id: 'fc_fixture',
                call_id: 'call_fixture',
                name: 'lookup',
                arguments: '{"query":"hello"}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'msg_fixture',
                role: 'assistant',
                status: 'completed',
                content: [{type: 'output_text', text: 'Hello fixture', annotations: []}],
              },
            ];
        const response = {
          id: 'resp_fixture',
          object: 'response',
          created_at: 1234567890,
          model: modelName,
          status: 'completed',
          output,
          error: null,
          incomplete_details: null,
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            total_tokens: 6,
            ...(cacheTokens !== undefined ? {input_tokens_details: {cached_tokens: cacheTokens}} : {}),
          },
        };
        if (!body.stream) return Response.json(response);
        return sse([
          {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
          ...(reasoning
            ? [
                {
                  type: 'response.output_item.added',
                  output_index: 1,
                  item: {type: 'reasoning', id: 'rs_fixture', summary: []},
                },
                {
                  type: 'response.reasoning_summary_part.added',
                  item_id: 'rs_fixture',
                  output_index: 1,
                  summary_index: 0,
                },
                {
                  type: 'response.reasoning_summary_text.delta',
                  item_id: 'rs_fixture',
                  output_index: 1,
                  summary_index: 0,
                  delta: 'Provider HTTP ',
                },
                {
                  type: 'response.reasoning_summary_text.delta',
                  item_id: 'rs_fixture',
                  output_index: 1,
                  summary_index: 0,
                  delta: 'summary',
                },
                {
                  type: 'response.reasoning_summary_part.done',
                  item_id: 'rs_fixture',
                  output_index: 1,
                  summary_index: 0,
                },
                {
                  type: 'response.output_item.done',
                  output_index: 1,
                  item: {
                    type: 'reasoning',
                    id: 'rs_fixture',
                    summary: [{type: 'summary_text', text: 'Provider HTTP summary'}],
                  },
                },
              ]
            : []),
          {type: 'response.output_item.added', output_index: 0, item: output[0]},
          ...(tools
            ? [
                {
                  type: 'response.function_call_arguments.delta',
                  item_id: 'fc_fixture',
                  output_index: 0,
                  delta: '{"query":"hello"}',
                },
                {type: 'response.output_item.done', output_index: 0, item: output[0]},
              ]
            : [
                {
                  type: 'response.content_part.added',
                  item_id: 'msg_fixture',
                  output_index: 0,
                  content_index: 0,
                  part: {type: 'output_text', text: '', annotations: []},
                },
                {
                  type: 'response.output_text.delta',
                  item_id: 'msg_fixture',
                  output_index: 0,
                  content_index: 0,
                  delta: 'Hello fixture',
                },
              ]),
          ...(!dropped ? [{type: 'response.completed', response}] : []),
        ]);
      }
      const usage = includeUsage
        ? {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
            ...(deepseekCache
              ? {prompt_cache_hit_tokens: deepseekCache.hit, prompt_cache_miss_tokens: deepseekCache.miss}
              : {}),
          }
        : undefined;
      if (!body.stream)
        return Response.json({
          id: 'fixture',
          object: 'chat.completion',
          created: 1234567890,
          model: modelName,
          choices: [{index: 0, message: {role: 'assistant', content: 'Hello fixture'}, finish_reason: 'stop'}],
          usage,
        });
      const base = {id: 'fixture', object: 'chat.completion.chunk', created: 1234567890, model: modelName};
      if (script) {
        const reply = script(scriptedView('chat', body));
        const delta = {
          ...(chatReasoning ? {role: 'assistant', reasoning_content: chatReasoning} : {}),
          ...(reply.text ? {role: 'assistant', content: reply.text} : {}),
          ...(reply.calls?.length
            ? {
                tool_calls: reply.calls.map((call, index) => ({
                  index,
                  id: `call_${requests.length}_${index}`,
                  type: 'function',
                  function: {name: call.name, arguments: JSON.stringify(call.input)},
                })),
              }
            : {}),
        };
        return sse([
          {...base, choices: [{index: 0, delta, finish_reason: null}]},
          {
            ...base,
            choices: [{index: 0, delta: {}, finish_reason: reply.calls?.length ? 'tool_calls' : 'stop'}],
            usage,
          },
        ]);
      }
      if (toolCall) {
        const results = (body.messages ?? []).filter((m: any) => m.role === 'tool');
        if (!results.length)
          return sse([
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${requests.length}`,
                        type: 'function',
                        function: {name: toolCall.name, arguments: toolCall.args},
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {...base, choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}], usage},
          ]);
        const seen = results
          .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join(' | ');
        return sse([
          {...base, choices: [{index: 0, delta: {role: 'assistant', content: `Saw: ${seen}`}, finish_reason: null}]},
          {...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage},
        ]);
      }
      return sse(
        [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: tools
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_fixture',
                          type: 'function',
                          function: {name: 'lookup', arguments: '{"query":'},
                        },
                      ],
                    }
                  : {role: 'assistant', content: 'Hello '},
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: tools
                  ? {tool_calls: [{index: 0, function: {arguments: invalidTool ? '7}' : '"hello"}'}}]}
                  : {content: 'fixture'},
                finish_reason: null,
              },
            ],
          },
          ...(!dropped
            ? [{...base, choices: [{index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop'}], usage}]
            : []),
        ].slice(0, cutToolArgs ? 1 : undefined),
      );
    },
  });
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.port}`,
    provider(protocol: 'chat' | 'responses' | 'anthropic' | 'gemini' = 'chat', overrides = {}) {
      return providerSchema.parse({
        id: 'fixture',
        name: 'Fixture',
        protocol,
        baseURL: `http://127.0.0.1:${server.port}/${protocol === 'gemini' ? 'gemini' : 'v1'}`,
        auth: 'api-key',
        catalog: protocol === 'gemini' ? 'gemini' : protocol === 'anthropic' ? 'anthropic' : 'openai',
        metadataVersion: 1,
        timeoutMs: 1000,
        ...overrides,
      });
    },
    set(options: {
      chatgpt?: boolean;
      cacheTokens?: number;
      reasoning?: boolean;
      status?: number;
      delay?: number;
      malformed?: boolean;
      dropped?: boolean;
      tools?: boolean;
      includeUsage?: boolean;
      modelName?: string;
      pages?: boolean;
      streamDelay?: number;
      invalidTool?: boolean;
      rateLimitHeaders?: Record<string, string>;
      toolCall?: {name: string; args: string} | null;
      script?: ((view: ScriptedView) => ScriptedReply) | null;
      chatReasoning?: string | null;
      deepseekCache?: {hit: number; miss: number} | null;
      cutToolArgs?: boolean;
    }) {
      cutToolArgs = options.cutToolArgs ?? cutToolArgs;
      chatReasoning = options.chatReasoning === null ? undefined : (options.chatReasoning ?? chatReasoning);
      deepseekCache = options.deepseekCache === null ? undefined : (options.deepseekCache ?? deepseekCache);
      cacheTokens = options.cacheTokens ?? cacheTokens;
      reasoning = options.reasoning ?? reasoning;
      status = options.status ?? status;
      delay = options.delay ?? delay;
      malformed = options.malformed ?? malformed;
      dropped = options.dropped ?? dropped;
      tools = options.tools ?? tools;
      includeUsage = options.includeUsage ?? includeUsage;
      modelName = options.modelName ?? modelName;
      chatgpt = options.chatgpt ?? chatgpt;
      pages = options.pages ?? pages;
      streamDelay = options.streamDelay ?? streamDelay;
      invalidTool = options.invalidTool ?? invalidTool;
      rateLimitHeaders = options.rateLimitHeaders ?? rateLimitHeaders;
      toolCall = options.toolCall === null ? undefined : (options.toolCall ?? toolCall);
      script = options.script === null ? undefined : (options.script ?? script);
    },
  };
}

/** The Ink startup gate verifies the account with one small non-streaming generation; in-process fetch fixtures answer it with this. */
export function probeResponse(): Response {
  return Response.json({
    id: 'probe',
    object: 'chat.completion',
    created: 123,
    model: 'fixture-model',
    choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
  });
}
