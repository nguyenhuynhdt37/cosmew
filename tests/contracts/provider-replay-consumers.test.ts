import {expect, test} from 'bun:test';
import {prepareForkedParentMessages} from '@cosmew/agents';
import {messageSchema, type Message} from '@cosmew/contracts';

test('forked context drops signed continuation when removing an unanswered call', () => {
  const assistant: Message = {
    role: 'assistant',
    content: '',
    toolCalls: [
      {id: 'answered', name: 'read', input: {path: 'a'}},
      {id: 'unfinished', name: 'read', input: {path: 'b'}},
    ],
    providerReplay: {
      version: 1,
      providerId: 'fixture',
      accountId: '11111111-1111-4111-8111-111111111111',
      protocol: 'gemini',
      modelId: 'fixture-model',
      endpointHash: 'b'.repeat(64),
      parts: [
        {type: 'tool-call', callId: 'answered', metadata: {thoughtSignature: 'signed-pair'}},
        {type: 'tool-call', callId: 'unfinished'},
      ],
    },
  };
  const result: Message = {role: 'tool', content: 'source', toolCallId: 'answered', toolName: 'read'};
  const forked = prepareForkedParentMessages([assistant, result]);
  expect(forked[0]?.toolCalls?.map(call => call.id)).toEqual(['answered']);
  expect(forked[0]?.providerReplay).toBeUndefined();
  expect(forked.every(message => messageSchema.safeParse(message).success)).toBe(true);
  expect(assistant.providerReplay).toBeDefined();

  const complete = prepareForkedParentMessages([
    assistant,
    result,
    {role: 'tool', content: 'second', toolCallId: 'unfinished', toolName: 'read'},
  ]);
  expect(complete[0]?.providerReplay).toEqual(assistant.providerReplay);
});
