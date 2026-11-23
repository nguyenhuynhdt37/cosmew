import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelEvent, ModelPort, ModelRequest, PermissionMode, ToolResult} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher, type ToolAuditRecord} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';

async function writes(first: 'revoked' | 'denied' | 'plan') {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-approval-latch-'));
  const db = openPrivateDatabase(root);
  try {
    const grants = new SessionGrants();
    let mode: PermissionMode = 'default';
    const prompts: string[] = [];
    const audit: ToolAuditRecord[] = [];
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants,
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, enabled: false, readOnly: false, permissionMode: mode}),
      approve: async request => {
        prompts.push(request.target);
        if (prompts.length === 1) {
          if (first === 'denied') return 'deny';
          if (first === 'plan') mode = 'plan';
          grants.clear();
        }
        return 'once';
      },
      audit: entry => audit.push(entry),
      redact: text => text,
    });
    const requests: ModelRequest[] = [];
    const usage = {inputTokens: 10, outputTokens: 2, costUSD: null};
    const model: ModelPort = {
      async *stream(request): AsyncGenerator<ModelEvent> {
        requests.push(request);
        const round = requests.length;
        if (round <= 2)
          yield {
            type: 'toolCallComplete',
            call: {id: `write-${round}`, name: 'write', input: {path: `${round}.txt`, content: `content ${round}`}},
          };
        else yield {type: 'textDelta', text: 'Finished after observing both results.'};
        yield {type: 'completed', finishReason: round <= 2 ? 'tool-calls' : 'stop', usage};
      },
      generate: async () => {
        throw new Error('No automatic regeneration is expected');
      },
    };
    const store = new SqliteConversations(db);
    const conversation = new Conversation(
      {accountId: crypto.randomUUID(), modelId: 'fixture'},
      model,
      store,
      undefined,
      dispatcher,
    );
    const results: ToolResult[] = [];
    for await (const event of conversation.send('Write two separate files after checking each result'))
      if (event.type === 'toolResult') results.push(event.result);

    expect(requests).toHaveLength(3);
    expect(results.map(result => result.callId)).toEqual(['write-1', 'write-2']);
    expect(existsSync(join(root, '1.txt'))).toBe(false);
    const receipt = store.get(conversation.id)!.turns![0]!;
    expect(receipt.usage).toMatchObject({inputTokens: 30, outputTokens: 6});
    expect(conversation.history().filter(message => message.role === 'tool')).toHaveLength(2);
    expect(requests[1]!.messages.some(message => message.role === 'tool' && message.toolCallId === 'write-1')).toBe(
      true,
    );
    return {
      results,
      prompts,
      audit,
      secondContent: existsSync(join(root, '2.txt')) ? readFileSync(join(root, '2.txt'), 'utf8') : null,
    };
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
}

test('revoked approval never replays the call; a new model write needs fresh approval and can execute', async () => {
  const result = await writes('revoked');
  expect(result.results[0]).toMatchObject({status: 'denied', code: 'APPROVAL_REVOKED'});
  expect(result.results[1]).toMatchObject({status: 'ok'});
  expect(result.prompts).toEqual(['1.txt', '2.txt']);
  expect(result.secondContent).toBe('content 2');
  expect(result.audit.filter(entry => entry.phase === 'requested').map(entry => entry.callId)).toEqual([
    'write-1',
    'write-2',
  ]);
});

test('an explicit user denial latches subsequent writes without any extra prompt or execution', async () => {
  const result = await writes('denied');
  expect(result.results.map(item => ({status: item.status, code: item.code}))).toEqual([
    {status: 'denied', code: 'DENIED'},
    {status: 'denied', code: 'DENIED'},
  ]);
  expect(result.prompts).toEqual(['1.txt']);
  expect(result.secondContent).toBeNull();
  expect(result.audit.filter(entry => entry.phase === 'requested').map(entry => entry.callId)).toEqual(['write-1']);
});

test('a new call after revocation still obeys a changed plan policy and cannot write', async () => {
  const result = await writes('plan');
  expect(result.results[0]).toMatchObject({status: 'denied', code: 'APPROVAL_REVOKED'});
  expect(result.results[1]).toMatchObject({status: 'denied', code: 'MODE_RESTRICTED'});
  expect(result.prompts).toEqual(['1.txt']);
  expect(result.secondContent).toBeNull();
  expect(result.audit.filter(entry => entry.phase === 'requested').map(entry => entry.callId)).toEqual([
    'write-1',
    'write-2',
  ]);
});
