import {expect, test} from 'bun:test';
import {ProviderAdapter, ProviderTransport} from '@cosmew/models';
import {providerSchema, type Message, type ModelRequest, type ModelEvent} from '@cosmew/contracts';
import {memoryVault} from '../fixtures';

function fixture(
  protocol: 'gemini' | 'responses' | 'anthropic' | 'chat',
  response: unknown,
  modelId = 'gemini-3-pro-preview',
  auth: 'none' | 'oauth' = 'none',
) {
  const requests: any[] = [];
  const provider = providerSchema.parse({
    id: 'replay-fixture',
    name: 'Fixture',
    protocol,
    baseURL: 'https://fixture.invalid/v1',
    auth,
    catalog: 'manual',
    metadataVersion: 1,
    ...(protocol === 'chat' ? {replayReasoning: true} : {}),
  });
  const transport = new ProviderTransport(
    provider,
    {
      id: crypto.randomUUID(),
      providerId: provider.id,
      alias: 'fixture',
      credential: {kind: 'none'},
      status: 'valid',
      validatedAt: null,
    } as any,
    memoryVault(),
    {authorize() {}},
    undefined,
    async () => 'fixture-oauth-token',
  );
  transport.request = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const data = typeof response === 'function' ? response(requests.at(-1)) : response;
    if (data instanceof Response) return data;
    if (requests.at(-1).stream || String(_url).includes('streamGenerateContent'))
      return new Response(`data: ${JSON.stringify(data)}\n\n`, {headers: {'content-type': 'text/event-stream'}});
    return Response.json(data);
  };
  const adapter = new ProviderAdapter(transport, modelId);
  const request: ModelRequest = {
    requestId: crypto.randomUUID(),
    modelId,
    messages: [{role: 'user', content: 'read'}],
    tools: [{name: 'read', description: 'read', inputSchema: {type: 'object'}}],
  };
  return {adapter, request, requests, provider, account: transport.account};
}

test('Gemini parallel signatures retain original ordered parts in the real serializer', async () => {
  const x = fixture('gemini', {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {text: 'thinking', thought: true, thoughtSignature: 'signed-thought'},
            {functionCall: {name: 'read', args: {path: 'a'}}, thoughtSignature: 'signed-first'},
            {functionCall: {name: 'read', args: {path: 'b'}}},
          ],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {promptTokenCount: 1, candidatesTokenCount: 1},
  });
  const first = (await x.adapter.generate(x.request)) as any;
  expect(first.providerReplay).toBeDefined();
  const assistant: Message = {
    role: 'assistant',
    content: '',
    toolCalls: first.calls,
    providerReplay: first.providerReplay,
  } as any;
  await x.adapter.generate({
    ...x.request,
    messages: [
      ...x.request.messages,
      assistant,
      ...first.calls.map((c: any) => ({role: 'tool', content: 'ok', toolCallId: c.id, toolName: c.name})),
    ],
  });
  const parts = x.requests[1].contents.find((m: any) => m.role === 'model').parts;
  expect(parts.map((p: any) => p.thoughtSignature)).toEqual(['signed-thought', 'signed-first', undefined]);
  expect(JSON.stringify(parts)).not.toContain('skip_thought_signature_validator');
});

test('Responses encrypted-only reasoning is requested and replayed without a summary', async () => {
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    model: 'gpt-5',
    status: 'completed',
    output: [
      {type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-encrypted'},
      {
        type: 'function_call',
        id: 'fc_fixture',
        call_id: 'call_fixture',
        name: 'read',
        arguments: '{}',
        status: 'completed',
      },
    ],
    error: null,
    incomplete_details: null,
    usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
  };
  const x = fixture('responses', response, 'gpt-5');
  const first = (await x.adapter.generate(x.request)) as any;
  expect(first.providerReplay).toBeDefined();
  await x.adapter.generate({
    ...x.request,
    messages: [
      ...x.request.messages,
      {role: 'assistant', content: '', toolCalls: first.calls, providerReplay: first.providerReplay} as any,
      {role: 'tool', content: 'ok', toolCallId: 'call_fixture', toolName: 'read'},
    ],
  });
  expect(x.requests[0].include).toContain('reasoning.encrypted_content');
  expect(x.requests[1].input.find((i: any) => i.type === 'reasoning')).toMatchObject({
    encrypted_content: 'opaque-encrypted',
    summary: [],
  });
});

import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteConversations, CheckpointStore} from '@cosmew/persistence';

test('opaque signatures survive actual database close/reopen and checkpoints; signed secret plaintext is dropped', async () => {
  const x = fixture('gemini', {
    candidates: [
      {
        content: {role: 'model', parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'opaque-SECRET'}]},
        finishReason: 'STOP',
        index: 0,
      },
    ],
  });
  const first = (await x.adapter.generate(x.request)) as any;
  const message: Message = {
    role: 'assistant',
    content: '',
    toolCalls: first.calls,
    providerReplay: first.providerReplay,
  };
  const directory = mkdtempSync(join(tmpdir(), 'cosmew-replay-'));
  const redact = (text: string) => text.replaceAll('SECRET', '[redacted]');
  let db = openPrivateDatabase(directory);
  try {
    let store = new SqliteConversations(db, redact);
    const id = store.create({accountId: crypto.randomUUID(), modelId: x.request.modelId});
    store.append(id, message, 'committed');
    const checkpoint = new CheckpointStore(db, redact).begin(id, '/fixture', 'read', [message]);
    db.close();
    db = openPrivateDatabase(directory);
    store = new SqliteConversations(db, redact);
    expect(store.get(id)!.messages[0]!.providerReplay).toEqual(first.providerReplay);
    expect(new CheckpointStore(db, redact).get(checkpoint)!.messages[0]!.providerReplay).toEqual(first.providerReplay);
    await x.adapter.generate({
      ...x.request,
      messages: [
        ...x.request.messages,
        ...store.get(id)!.messages.map(({revision: _revision, state: _state, ...message}) => message),
        ...first.calls.map((c: any) => ({role: 'tool', content: 'ok', toolCallId: c.id, toolName: c.name})),
      ],
    });
    expect(x.requests[1].contents.find((m: any) => m.role === 'model').parts[0].thoughtSignature).toBe('opaque-SECRET');
    const secret = {
      ...message,
      content: 'SECRET',
      providerReplay: {...first.providerReplay, parts: [{type: 'text', text: 'SECRET'}, ...first.providerReplay.parts]},
    };
    store.append(id, secret, 'committed');
    expect(store.get(id)!.messages.at(-1)!.providerReplay).toBeUndefined();
    expect((db.query('SELECT content,parts FROM messages WHERE revision=2').get() as any).parts).not.toContain(
      'SECRET',
    );
    const hidden = new CheckpointStore(db, redact).begin(id, '/fixture', 'read', [secret]);
    expect(JSON.stringify(new CheckpointStore(db, redact).get(hidden))).not.toContain('"text":"SECRET"');
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Gemini stream commits replay only after a clean complete response; cancellation has none', async () => {
  const x = fixture('gemini', {
    candidates: [
      {
        content: {role: 'model', parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'signed-stream'}]},
        finishReason: 'STOP',
        index: 0,
      },
    ],
  });
  const events = await Array.fromAsync(x.adapter.stream(x.request));
  expect(events.find(e => e.type === 'providerReplay')).toMatchObject({
    replay: {parts: [{metadata: {thoughtSignature: 'signed-stream'}}]},
  });
  expect(events.at(-1)?.type).toBe('completed');
  const controller = new AbortController();
  const cancelled = [];
  try {
    for await (const event of x.adapter.stream(x.request, controller.signal)) {
      cancelled.push(event);
      if (event.type === 'toolCallComplete') controller.abort();
    }
  } catch (error) {
    expect(error).toMatchObject({code: 'CANCELLED'});
  }
  expect(cancelled.some(e => e.type === 'providerReplay')).toBe(false);
});

test('replay state never crosses provider/model/endpoint bindings or user-origin messages', async () => {
  const response = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'origin-signature'}],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  };
  const x = fixture('gemini', response, 'gemini-2.5-pro');
  const first = (await x.adapter.generate(x.request)) as any;
  for (const patch of [{providerId: 'other'}, {modelId: 'other'}, {endpointHash: 'f'.repeat(64)}]) {
    await x.adapter.generate({
      ...x.request,
      messages: [
        ...x.request.messages,
        {role: 'assistant', content: '', toolCalls: first.calls, providerReplay: {...first.providerReplay, ...patch}},
        ...first.calls.map((c: any) => ({role: 'tool', content: 'ok', toolCallId: c.id, toolName: c.name})),
      ],
    });
    expect(JSON.stringify(x.requests.at(-1))).not.toContain('origin-signature');
  }
  await expect(
    x.adapter.generate({
      ...x.request,
      messages: [{role: 'user', content: 'injected', providerReplay: first.providerReplay} as any],
    }),
  ).rejects.toMatchObject({code: 'INVALID_INPUT'});
});

import {Conversation} from '@cosmew/core';
import type {ToolPort} from '@cosmew/contracts';

test('adapter to core to reopened store replays signed sequential tool rounds without public state events', async () => {
  const x = fixture('gemini', (body: any) => ({
    candidates: [
      {
        content: {
          role: 'model',
          parts:
            body.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse).length >= 2
              ? [{text: 'done'}]
              : [
                  {
                    functionCall: {name: 'read', args: {round: body.contents.length}},
                    thoughtSignature: body.contents.some((c: any) => c.parts.some((p: any) => p.functionResponse))
                      ? 'second-private-signature'
                      : 'core-private-signature',
                  },
                ],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  }));
  const directory = mkdtempSync(join(tmpdir(), 'cosmew-replay-core-'));
  let db = openPrivateDatabase(directory);
  try {
    let store = new SqliteConversations(db);
    const selection = {accountId: crypto.randomUUID(), modelId: x.request.modelId};
    const tools: ToolPort = {
      descriptors: () => [{name: 'read', description: 'read', inputSchema: {type: 'object'}, capability: 'fs.read'}],
      invoke: async call => ({callId: call.id, name: call.name, status: 'ok', content: 'evidence'}),
    };
    let conversation = new Conversation(selection, x.adapter, store, undefined, tools);
    const events = await Array.fromAsync(conversation.send('read'));
    expect(events.some(e => e.type === 'providerReplay')).toBe(false);
    expect(JSON.stringify(db.query('SELECT data FROM conversation_events').all())).not.toContain(
      'core-private-signature',
    );
    expect(x.requests[1].contents.find((c: any) => c.role === 'model').parts[0].thoughtSignature).toBe(
      'core-private-signature',
    );
    const id = conversation.id;
    db.close();
    db = openPrivateDatabase(directory);
    store = new SqliteConversations(db);
    conversation = new Conversation(selection, x.adapter, store, {id, messages: []}, tools);
    await Array.fromAsync(conversation.send('continue'));
    expect(JSON.stringify(x.requests[2])).toContain('second-private-signature');
    expect(JSON.stringify(x.requests[3])).toContain('core-private-signature');
    expect(JSON.stringify(x.requests[3])).toContain('second-private-signature');
    expect(JSON.stringify(db.query('SELECT data FROM conversation_events').all())).not.toContain(
      'core-private-signature',
    );
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

function responsesStream(output: any[]): Response {
  const response = {
    id: 'resp_stream',
    object: 'response',
    created_at: 1,
    model: 'gpt-5',
    status: 'completed',
    output,
    error: null,
    incomplete_details: null,
    usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
  };
  const events = [
    {type: 'response.created', response: {...response, status: 'in_progress', output: []}},
    ...output.flatMap((item, output_index) => [
      {
        type: 'response.output_item.added',
        output_index,
        item: {...item, ...(item.type === 'function_call' ? {arguments: ''} : {})},
      },
      ...(item.type === 'function_call'
        ? [{type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments}]
        : item.type === 'message'
          ? [
              {
                type: 'response.content_part.added',
                output_index,
                item_id: item.id,
                content_index: 0,
                part: {type: 'output_text', text: '', annotations: []},
              },
              {
                type: 'response.output_text.delta',
                output_index,
                item_id: item.id,
                content_index: 0,
                delta: item.content[0].text,
              },
            ]
          : []),
      {type: 'response.output_item.done', output_index, item},
    ]),
    {type: 'response.completed', response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: {'content-type': 'text/event-stream'},
  });
}

test('Responses streaming encrypted-only items survive core and actual reopen with empty summaries', async () => {
  const x = fixture(
    'responses',
    (body: any) =>
      responsesStream(
        body.input.some((i: any) => i.type === 'function_call_output')
          ? [
              {
                type: 'message',
                id: 'msg_final',
                role: 'assistant',
                status: 'completed',
                content: [{type: 'output_text', text: 'done', annotations: []}],
              },
            ]
          : [
              {type: 'reasoning', id: 'rs_opaque', summary: [], encrypted_content: 'private-encrypted-state'},
              {
                type: 'function_call',
                id: 'fc_stream',
                call_id: 'call_stream',
                name: 'read',
                arguments: '{}',
                status: 'completed',
              },
            ],
      ),
    'gpt-5',
  );
  const directory = mkdtempSync(join(tmpdir(), 'cosmew-responses-core-'));
  let db = openPrivateDatabase(directory);
  try {
    let store = new SqliteConversations(db);
    const selection = {accountId: crypto.randomUUID(), modelId: x.request.modelId};
    const tools: ToolPort = {
      descriptors: () => [{name: 'read', description: 'read', inputSchema: {type: 'object'}, capability: 'fs.read'}],
      invoke: async call => ({callId: call.id, name: call.name, status: 'ok', content: 'evidence'}),
    };
    let conversation = new Conversation(selection, x.adapter, store, undefined, tools);
    const events = await Array.fromAsync(conversation.send('read'));
    expect(events.some(e => e.type === 'providerReplay')).toBe(false);
    expect(x.requests[1].input.find((i: any) => i.type === 'reasoning')).toMatchObject({
      summary: [],
      encrypted_content: 'private-encrypted-state',
    });
    const id = conversation.id;
    db.close();
    db = openPrivateDatabase(directory);
    store = new SqliteConversations(db);
    conversation = new Conversation(selection, x.adapter, store, {id, messages: []}, tools);
    await Array.fromAsync(conversation.send('continue'));
    expect(x.requests[2].input.find((i: any) => i.type === 'reasoning')).toMatchObject({
      summary: [],
      encrypted_content: 'private-encrypted-state',
    });
    expect(JSON.stringify(db.query('SELECT data FROM conversation_events').all())).not.toContain(
      'private-encrypted-state',
    );
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

import {providerReplaySchema, messageSchema} from '@cosmew/contracts';

test('replay envelopes reject oversized UTF-8 state, unexpected options, tool reordering and protocol metadata', async () => {
  const x = fixture('gemini', {
    candidates: [
      {
        content: {role: 'model', parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'signature'}]},
        finishReason: 'STOP',
        index: 0,
      },
    ],
  });
  const first = (await x.adapter.generate(x.request)) as any;
  expect(
    providerReplaySchema.safeParse({...first.providerReplay, parts: [{type: 'reasoning', text: '😀'.repeat(270000)}]})
      .success,
  ).toBe(false);
  expect(
    providerReplaySchema.safeParse({...first.providerReplay, providerOptions: {google: {arbitrary: true}}}).success,
  ).toBe(false);
  expect(
    providerReplaySchema.safeParse({
      ...first.providerReplay,
      parts: [{type: 'reasoning', text: '', metadata: {reasoningEncryptedContent: 'foreign'}}],
    }).success,
  ).toBe(false);
  expect(
    messageSchema.safeParse({
      role: 'assistant',
      content: '',
      toolCalls: [{...first.calls[0], id: 'different'}],
      providerReplay: first.providerReplay,
    }).success,
  ).toBe(false);
});

test('Anthropic signed and redacted-only thinking survives actual serializer without enabling thinking controls', async () => {
  const x = fixture(
    'anthropic',
    {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-fixture',
      content: [
        {type: 'thinking', thinking: 'visible thinking', signature: 'signed-thinking'},
        {type: 'redacted_thinking', data: 'redacted-opaque'},
        {type: 'tool_use', id: 'call_anthropic', name: 'read', input: {}},
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1},
    },
    'claude-fixture',
  );
  const first = (await x.adapter.generate(x.request)) as any;
  await x.adapter.generate({
    ...x.request,
    messages: [
      ...x.request.messages,
      {role: 'assistant', content: '', toolCalls: first.calls, providerReplay: first.providerReplay},
      {role: 'tool', content: 'ok', toolCallId: 'call_anthropic', toolName: 'read'},
    ],
  });
  expect(x.requests[1].messages.find((m: any) => m.role === 'assistant').content.slice(0, 2)).toEqual([
    {type: 'thinking', thinking: 'visible thinking', signature: 'signed-thinking'},
    {type: 'redacted_thinking', data: 'redacted-opaque'},
  ]);
  expect(x.requests[1].thinking).toBeUndefined();
});

test('opt-in Chat reasoning is bound to its original model rather than crossing a model switch', async () => {
  const x = fixture(
    'chat',
    {
      id: 'chat_fixture',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-fixture',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'private-chat-thought',
            tool_calls: [{id: 'chat_call', type: 'function', function: {name: 'read', arguments: '{}'}}],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
    },
    'deepseek-fixture',
  );
  const first = (await x.adapter.generate(x.request)) as any;
  expect(first.providerReplay).toBeDefined();
  const assistant: Message = {
    role: 'assistant',
    content: '',
    reasoning: 'private-chat-thought',
    toolCalls: first.calls,
    providerReplay: {...first.providerReplay, modelId: 'other-model'},
  };
  await x.adapter.generate({
    ...x.request,
    messages: [
      ...x.request.messages,
      assistant,
      {role: 'tool', content: 'ok', toolCallId: 'chat_call', toolName: 'read'},
    ],
  });
  expect(JSON.stringify(x.requests[1])).not.toContain('private-chat-thought');
});

import type {ModelPort, ProviderReplay} from '@cosmew/contracts';

test('a private reasoning-only provider continuation survives endTurn=false without becoming an empty final answer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cosmew-replay-pause-'));
  const db = openPrivateDatabase(directory);
  const replay: ProviderReplay = {
    version: 1,
    providerId: 'fixture',
    accountId: crypto.randomUUID(),
    protocol: 'responses',
    modelId: 'fixture',
    endpointHash: 'a'.repeat(64),
    parts: [{type: 'reasoning', text: '', metadata: {itemId: 'rs_pause', reasoningEncryptedContent: 'pause-state'}}],
  };
  try {
    let requests = 0;
    const model: ModelPort = {
      async *stream(request) {
        if (requests++ === 0) {
          yield {type: 'providerReplay', replay};
          yield {
            type: 'completed',
            finishReason: 'stop',
            endTurn: false,
            usage: {inputTokens: 1, outputTokens: 1, costUSD: null},
          };
        } else {
          expect(
            request.messages.some(m =>
              m.providerReplay?.parts.some(p => p.metadata?.reasoningEncryptedContent === 'pause-state'),
            ),
          ).toBe(true);
          yield {type: 'textDelta', text: 'done'};
          yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1, costUSD: null}};
        }
      },
      generate: async () => {
        throw new Error('unused');
      },
    };
    const conversation = new Conversation(
      {accountId: crypto.randomUUID(), modelId: 'fixture'},
      model,
      new SqliteConversations(db),
    );
    await Array.fromAsync(conversation.send('continue'));
    expect(requests).toBe(2);
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('recovery never attaches stored private state to a journal response that did not complete', async () => {
  const x = fixture('gemini', {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'incomplete-state'}],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  });
  const generated = (await x.adapter.generate(x.request)) as any;
  const directory = mkdtempSync(join(tmpdir(), 'cosmew-replay-incomplete-'));
  const db = openPrivateDatabase(directory);
  try {
    const store = new SqliteConversations(db);
    const model: ModelPort = {
      async *stream() {
        yield {type: 'toolCallComplete', call: generated.calls[0]};
        yield {type: 'providerReplay', replay: generated.providerReplay};
        throw new Error('interrupted before completion');
      },
      generate: async () => {
        throw new Error('unused');
      },
    };
    const tools: ToolPort = {
      descriptors: () => [{name: 'read', description: 'read', inputSchema: {type: 'object'}, capability: 'fs.read'}],
      invoke: async call => ({callId: call.id, name: call.name, status: 'ok', content: 'evidence'}),
    };
    const conversation = new Conversation(
      {accountId: crypto.randomUUID(), modelId: x.request.modelId},
      model,
      store,
      undefined,
      tools,
    );
    await expect(Array.fromAsync(conversation.send('read'))).rejects.toMatchObject({code: 'PROTOCOL'});
    expect(store.get(conversation.id)!.messages.some(m => m.providerReplay)).toBe(false);
    // Even a private parts row that appears to match the calls cannot override the journal's
    // missing model.completed proof (simulates stale persisted state, without running any tools).
    const revision = store.appendContext(conversation.id, {
      role: 'assistant',
      content: '',
      toolCalls: generated.calls,
      providerReplay: generated.providerReplay,
    });
    db.query('UPDATE execution_turns SET end_revision=? WHERE conversation=?').run(revision, conversation.id);
    expect(store.recover(conversation.id).messages.some(m => m.providerReplay)).toBe(false);
  } finally {
    db.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('same provider/model/endpoint account switches drop prior account signatures', async () => {
  const response = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'read', args: {}}, thoughtSignature: 'first-account-private-signature'}],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
  };
  const firstAccount = fixture('gemini', response, 'gemini-2.5-pro');
  const secondAccount = fixture('gemini', response, 'gemini-2.5-pro');
  const generated = await firstAccount.adapter.generate(firstAccount.request);
  expect(generated.providerReplay).toBeDefined();
  await secondAccount.adapter.generate({
    ...secondAccount.request,
    messages: [
      ...secondAccount.request.messages,
      {role: 'assistant', content: '', toolCalls: generated.calls, providerReplay: generated.providerReplay},
      ...generated.calls.map(call => ({
        role: 'tool' as const,
        content: 'ok',
        toolCallId: call.id,
        toolName: call.name,
      })),
    ],
  });
  expect(JSON.stringify(secondAccount.requests[0])).not.toContain('first-account-private-signature');
});

function encryptedRequest(x: ReturnType<typeof fixture>): ModelRequest {
  return {
    ...x.request,
    messages: [
      ...x.request.messages,
      {
        role: 'assistant',
        content: 'old answer',
        providerReplay: {
          version: 1,
          providerId: x.provider.id,
          accountId: x.account.id,
          protocol: 'responses',
          modelId: x.request.modelId,
          endpointHash: new Bun.CryptoHasher('sha256').update(x.provider.baseURL).digest('hex'),
          parts: [
            {
              type: 'reasoning',
              text: '',
              metadata: {itemId: 'item_1', reasoningEncryptedContent: 'expired-encrypted-content'},
            },
            {type: 'text', text: 'old answer'},
          ],
        },
      },
      {role: 'user', content: 'new question'},
    ],
  };
}

const encryptedError = () =>
  new Response(
    JSON.stringify({
      error: {
        message: 'This conversation contains encrypted history for the original account.',
        type: 'invalid_request_error',
      },
    }),
    {status: 400, headers: {'content-type': 'application/json'}},
  );

test('an encrypted-history rejection retries once with canonical history without changing the original bound replay', async () => {
  const x = fixture(
    'responses',
    (req: any) =>
      JSON.stringify(req).includes('expired-encrypted-content')
        ? encryptedError()
        : responsesStream([
            {
              type: 'message',
              id: 'msg_recovered',
              role: 'assistant',
              status: 'completed',
              content: [{type: 'output_text', text: 'recovered answer', annotations: []}],
            },
          ]),
    'gpt-5',
  );
  const request = encryptedRequest(x);
  const original = JSON.stringify(request);
  const events: ModelEvent[] = await Array.fromAsync(x.adapter.stream(request));
  expect(x.requests).toHaveLength(2);
  expect(JSON.stringify(x.requests[0])).toContain('expired-encrypted-content');
  expect(JSON.stringify(x.requests[1])).not.toContain('expired-encrypted-content');
  expect(JSON.stringify(x.requests[1])).toContain('old answer');
  expect(JSON.stringify(x.requests[1])).toContain('new question');
  expect(
    events
      .filter(e => e.type === 'textDelta')
      .map(e => e.text)
      .join(''),
  ).toBe('recovered answer');
  expect(events.filter(e => e.type === 'started')).toHaveLength(1);
  expect(events.filter(e => e.type === 'completed')).toHaveLength(1);
  expect(JSON.stringify(request)).toBe(original);
});

test('an encrypted-history rejection is retried at most once', async () => {
  const x = fixture('responses', () => encryptedError(), 'gpt-5');
  const request = encryptedRequest(x);
  await expect(Array.fromAsync(x.adapter.stream(request))).rejects.toMatchObject({code: 'INVALID_INPUT'});
  expect(x.requests).toHaveLength(2);
  expect(request.messages[1]?.providerReplay).toBeDefined();
});

for (const kind of ['text', 'tool'] as const) {
  test(`encrypted-history errors after a streamed ${kind} do not silently retry observed work`, async () => {
    const message = {type: 'message', id: 'msg_partial', role: 'assistant', status: 'in_progress', content: []};
    const call = {
      type: 'function_call',
      id: 'fc_partial',
      call_id: 'read_partial',
      name: 'read',
      arguments: '{}',
      status: 'completed',
    };
    const prefix = [
      {
        type: 'response.created',
        response: {
          id: 'resp_partial',
          object: 'response',
          created_at: 1,
          model: 'gpt-5',
          status: 'in_progress',
          output: [],
        },
      },
      {type: 'response.output_item.added', output_index: 0, item: kind === 'text' ? message : {...call, arguments: ''}},
      ...(kind === 'text'
        ? [
            {
              type: 'response.content_part.added',
              output_index: 0,
              item_id: message.id,
              content_index: 0,
              part: {type: 'output_text', text: '', annotations: []},
            },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: message.id,
              content_index: 0,
              delta: 'partial answer',
            },
          ]
        : [
            {type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments},
            {type: 'response.output_item.done', output_index: 0, item: call},
          ]),
    ];
    const x = fixture(
      'responses',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(prefix.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({type: 'error', sequence_number: 10, code: 'invalid_encrypted_content', message: 'encrypted history mismatch', param: null})}\n\n`,
                  ),
                );
                controller.close();
              }, 15);
            },
          }),
          {headers: {'content-type': 'text/event-stream'}},
        ),
      'gpt-5',
    );
    const request = encryptedRequest(x);
    const original = JSON.stringify(request);
    const events: ModelEvent[] = [];
    await expect(
      (async () => {
        for await (const event of x.adapter.stream(request)) events.push(event);
      })(),
    ).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(events.some(event => event.type === (kind === 'text' ? 'textDelta' : 'toolCallComplete'))).toBe(true);
    expect(x.requests).toHaveLength(1);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    expect(JSON.stringify(request)).toBe(original);
  });
}

test('cancelling an encrypted-history stream after observed text never triggers recovery', async () => {
  const x = fixture(
    'responses',
    responsesStream([
      {
        type: 'message',
        id: 'msg_cancel',
        role: 'assistant',
        status: 'completed',
        content: [{type: 'output_text', text: 'partial answer', annotations: []}],
      },
    ]),
    'gpt-5',
  );
  const request = encryptedRequest(x);
  const original = JSON.stringify(request);
  const abort = new AbortController();
  await expect(
    (async () => {
      for await (const event of x.adapter.stream(request, abort.signal)) {
        if (event.type === 'textDelta') abort.abort();
      }
    })(),
  ).rejects.toMatchObject({code: 'CANCELLED'});
  expect(x.requests).toHaveLength(1);
  expect(JSON.stringify(request)).toBe(original);
});

for (const auth of ['none', 'oauth'] as const) {
  test(`generate ${auth} bounds encrypted-history recovery to two requests and preserves the original request`, async () => {
    const x = fixture('responses', () => encryptedError(), 'gpt-5', auth);
    const request = encryptedRequest(x);
    const original = JSON.stringify(request);
    await expect(x.adapter.generate(request)).rejects.toMatchObject({code: 'INVALID_INPUT'});
    expect(x.requests).toHaveLength(2);
    expect(JSON.stringify(x.requests[0])).toContain('expired-encrypted-content');
    expect(JSON.stringify(x.requests[1])).not.toContain('expired-encrypted-content');
    expect(JSON.stringify(request)).toBe(original);
  });

  test(`generate ${auth} cancellation at the first encrypted rejection never starts another request`, async () => {
    const abort = new AbortController();
    const x = fixture(
      'responses',
      () => {
        abort.abort();
        return encryptedError();
      },
      'gpt-5',
      auth,
    );
    const request = encryptedRequest(x);
    const original = JSON.stringify(request);
    await expect(x.adapter.generate(request, abort.signal)).rejects.toMatchObject({code: 'CANCELLED'});
    expect(x.requests).toHaveLength(1);
    expect(JSON.stringify(request)).toBe(original);
  });
}

test('OAuth generate keeps the stream-owned successful encrypted-history recovery', async () => {
  const x = fixture(
    'responses',
    (req: any) =>
      JSON.stringify(req).includes('expired-encrypted-content')
        ? encryptedError()
        : responsesStream([
            {
              type: 'message',
              id: 'msg_generated',
              role: 'assistant',
              status: 'completed',
              content: [{type: 'output_text', text: 'recovered generation', annotations: []}],
            },
          ]),
    'gpt-5',
    'oauth',
  );
  const request = encryptedRequest(x);
  const original = JSON.stringify(request);
  expect((await x.adapter.generate(request)).text).toBe('recovered generation');
  expect(x.requests).toHaveLength(2);
  expect(JSON.stringify(request)).toBe(original);
});
