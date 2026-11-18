import {afterEach, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {providerSchema} from '@futryn/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runExec} from '../../apps/cli/src/exec';
import {memoryVault, scriptedView, type ScriptedView} from '../fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Provider wire fixture through the existing fetch port; no socket or OS execution claim. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fyn-headless-run-'));
  let failure = false;
  let tool = 'read';
  const views: ScriptedView[] = [];
  const fetchFixture = (async (input, init) => {
    const request = new Request(input, init);
    if (failure) return Response.json({error: {message: 'private-provider-error'}}, {status: 401});
    if (request.method === 'GET') return Response.json({data: [{id: 'fixture-model'}]});
    const body = (await request.json()) as {stream?: boolean};
    const view = scriptedView('chat', body);
    views.push(view);
    const base = {id: 'fixture', object: 'chat.completion.chunk', created: 123, model: 'fixture-model'};
    const calls = view.results.length
      ? undefined
      : [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            function: {
              name: tool,
              arguments: JSON.stringify(tool === 'read' ? {path: 'in.txt'} : {url: 'https://example.com'}),
            },
          },
        ];
    if (!body.stream)
      return Response.json({
        id: 'fixture',
        object: 'chat.completion',
        created: 123,
        model: 'fixture-model',
        choices: [{index: 0, message: {role: 'assistant', content: 'hello'}, finish_reason: 'stop'}],
      });
    const packets = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: calls
              ? {role: 'assistant', content: 'intermediate', tool_calls: calls}
              : {role: 'assistant', content: 'FINAL private-output-marker'},
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop'}],
        usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
      },
    ];
    return new Response(packets.map(packet => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });
  }) as typeof fetch;
  const app = startup(join(root, 'state'), {vault: memoryVault(), fetch: fetchFixture});
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
    rmSync(root, {recursive: true, force: true});
  });
  app.redactor.register('private-output-marker');
  app.registry.add(
    providerSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      protocol: 'chat',
      baseURL: 'https://fixture.invalid/v1',
      auth: 'none',
      catalog: 'openai',
      metadataVersion: 1,
    }),
  );
  await app.accounts.add('fixture', 'fixture', {kind: 'none'});
  const client = app.createFutrynClient(root);
  await client.discoverModels();
  client.selectModel('fixture-model');
  writeFileSync(join(root, 'in.txt'), 'real file');
  return {
    app,
    root,
    views,
    set: (options: {failure?: boolean; tool?: string}) => {
      failure = options.failure ?? failure;
      tool = options.tool ?? tool;
    },
  };
}

test('headless runner uses real dispatcher, JSONL order and final response output (0)', async () => {
  const x = await setup();
  const lines: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation(value => {
    lines.push(String(value));
    return true;
  });
  try {
    expect(
      await runExec(x.app, {
        prompt: 'read',
        workspace: x.root,
        approval: 'never',
        json: true,
        outputLastMessage: join(x.root, 'last.txt'),
      }),
    ).toBe(0);
  } finally {
    output.mockRestore();
  }
  const events = lines
    .join('')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
  expect(events.every(e => e.contractVersion === '1.34')).toBe(true);
  expect(events.some(e => e.type === 'toolResult' && e.result.content.includes('real file'))).toBe(true);
  expect(events.at(-1).type).toBe('turn.completed');
  expect(readFileSync(join(x.root, 'last.txt'), 'utf8')).toBe('FINAL [REDACTED]\n');
});

for (const approval of ['never', 'on-request', 'untrusted'] as const) {
  test(`headless ${approval} refuses network and returns the denial to the model without waiting`, async () => {
    const x = await setup();
    x.set({tool: 'web_fetch'});
    const lines: string[] = [];
    const output = spyOn(process.stdout, 'write').mockImplementation(value => {
      lines.push(String(value));
      return true;
    });
    try {
      expect(await runExec(x.app, {prompt: 'fetch', workspace: x.root, approval, json: true})).toBe(0);
    } finally {
      output.mockRestore();
    }
    expect(x.views.at(-1)!.results[0]!.content).toMatch(/denied|denial|approval/i);
    const events = lines
      .join('')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(events.some(e => e.type === 'toolResult' && e.result.status === 'denied')).toBe(true);
    expect(events.some(e => e.type === 'permission.requested')).toBe(approval !== 'never');
  });
}

test('provider errors and cancellation return exit 1 with safe terminal JSONL', async () => {
  const x = await setup();
  x.set({failure: true});
  const lines: string[] = [];
  const output = spyOn(process.stdout, 'write').mockImplementation(value => {
    lines.push(String(value));
    return true;
  });
  try {
    expect(await runExec(x.app, {prompt: 'fail', workspace: x.root, approval: 'never', json: true})).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(
      await runExec(x.app, {prompt: 'cancel', workspace: x.root, approval: 'never', json: true}, controller.signal),
    ).toBe(1);
  } finally {
    output.mockRestore();
  }
  expect(lines.join('')).not.toContain('private-provider-error');
  expect(
    lines
      .map(line => JSON.parse(line))
      .filter(e => e.type === 'turn.failed')
      .map(e => e.error.code),
  ).toEqual(['AUTH', 'CANCELLED']);
});
