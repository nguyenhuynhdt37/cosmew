import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Conversation} from '@cosmew/core';
import {FutrynError, type ModelEvent, type ModelRequest} from '@cosmew/contracts';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test('a request without tools states action limits and completes without retries or background work', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-no-tools-'));
  const app = startup(home, {vault: memoryVault()});
  cleanups.push(() => {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  });
  const requests: ModelRequest[] = [];
  let generated = 0;
  const usage = {inputTokens: 7, outputTokens: 5, costUSD: null};
  const conversation = new Conversation(
    {accountId: crypto.randomUUID(), modelId: 'fixture'},
    {
      async *stream(request): AsyncGenerator<ModelEvent> {
        requests.push(request);
        yield {type: 'textDelta', text: 'Project tools are unavailable in this request.'};
        yield {type: 'completed', finishReason: 'stop', usage};
      },
      generate: async () => {
        generated++;
        throw new Error('No extra generation is expected');
      },
    },
    app.conversations,
  );
  const events: ModelEvent[] = [];
  for await (const event of conversation.send('Inspect the project and install an MCP server')) events.push(event);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.tools).toEqual([]);
  expect(requests[0]!.instructions).toContain(
    'No project tools are available in this request. You can answer questions, but cannot inspect files, run commands, install MCP servers, or start background work. State this limitation for action requests; do not claim work is running or promise to continue after this response ends.',
  );
  expect(generated).toBe(0);
  expect(events.some(event => event.type === 'toolCallComplete' || event.type.startsWith('subagent.'))).toBe(false);
  expect(events.at(-1)?.type).toBe('completed');
  expect(conversation.history().at(-1)?.content).toBe('Project tools are unavailable in this request.');
});

for (const code of ['INVALID_INPUT', 'UNSUPPORTED'] as const)
  test(`${code} with offered tools preserves the error and never disables tools on subsequent turns`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'cosmew-tool-capability-'));
    const app = startup(home, {vault: memoryVault()});
    cleanups.push(() => {
      app.db.close();
      rmSync(home, {recursive: true, force: true});
    });
    const original = new FutrynError(code, false, null, code === 'UNSUPPORTED' ? 'gemini' : undefined);
    const requests: ModelRequest[] = [];
    let rejected = 0;
    const descriptor = {
      name: 'read',
      description: 'Read a file',
      capability: 'fs.read' as const,
      inputSchema: {type: 'object', properties: {path: {type: 'string'}}},
    };
    const usage = {inputTokens: 7, outputTokens: 0, costUSD: null};
    const conversation = new Conversation(
      {accountId: crypto.randomUUID(), modelId: 'fixture'},
      {
        async *stream(request): AsyncGenerator<ModelEvent> {
          requests.push(request);
          if (requests.length === 1) {
            // A local request validation error or unsupported reasoning setting is not
            // evidence that the provider rejected the offered tool definitions.
            yield {type: 'usage', usage};
            throw original;
          }
          yield {type: 'textDelta', text: 'Recovered with tools still available.'};
          yield {type: 'completed', finishReason: 'stop', usage};
        },
        generate: async () => {
          throw new FutrynError('UNSUPPORTED');
        },
      },
      app.conversations,
      undefined,
      {
        descriptors: () => (rejected ? [] : [descriptor]),
        invoke: async () => {
          throw new Error('No tool call was requested');
        },
      },
      () => {
        rejected++;
      },
    );
    const send = async (text: string) => {
      for await (const _ of conversation.send(text)) {
        /* drain the real turn */
      }
    };
    await expect(send('Explain the project')).rejects.toBe(original);
    if (code === 'UNSUPPORTED') expect(original.message).toContain('Reasoning effort is unsupported');
    expect(requests).toHaveLength(1); // No hidden retry without tools.
    expect(rejected).toBe(0);
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(['read']);
    const receipt = app.db.query('select data from turn_receipts where conversation = ?').get(conversation.id) as {
      data: string;
    };
    expect(JSON.parse(receipt.data)).toMatchObject({outcome: 'failed', errorCode: code, usage});
    await send('Try again');
    expect(rejected).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.tools.map(tool => tool.name)).toEqual(['read']);
    expect(conversation.history().at(-1)?.content).toBe('Recovered with tools still available.');
  });
