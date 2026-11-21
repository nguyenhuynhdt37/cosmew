import {expect, test} from 'bun:test';
import {providerSchema, type Account} from '@cosmew/contracts';
import {ProviderAdapter, ProviderTransport} from '@cosmew/models';
import {ConfiguredNetworkPolicy, Redactor, terminalText} from '@cosmew/security';
import {memoryVault} from '../fixtures';

const provider = providerSchema.parse({
  id: 'fixture',
  name: 'Fixture',
  protocol: 'chat',
  baseURL: 'http://127.0.0.1:12345/v1',
  auth: 'none',
  catalog: 'manual',
  metadataVersion: 1,
});
const account: Account = {
  id: 'fixture-account',
  providerId: provider.id,
  alias: 'Fixture',
  credential: {kind: 'none'},
  status: 'unvalidated',
  validatedAt: null,
};

function fixture(status: number, response: unknown, redactor = new Redactor()) {
  const requests: unknown[] = [];
  const fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json(response, {status, headers: {'retry-after': '1', 'x-private': 'fixture-header'}});
  }) as typeof globalThis.fetch;
  const transport = new ProviderTransport(
    provider,
    account,
    memoryVault(),
    new ConfiguredNetworkPolicy(),
    fetch,
    undefined,
    (text: string) => terminalText(redactor.text(text)),
  );
  return {
    requests,
    generate: () =>
      new ProviderAdapter(transport, 'grok-4.7').generate({
        requestId: crypto.randomUUID(),
        modelId: 'grok-4.7',
        messages: [{role: 'user', content: 'Reply with OK.'}],
        maxOutputTokens: 16,
        tools: [],
      }),
  };
}

test('the exact xAI 402 probe response exposes a safe hint and makes one request', async () => {
  const {generate, requests} = fixture(402, {
    code: 'personal-team-blocked:spending-limit',
    error:
      'You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.',
  });
  await expect(generate()).rejects.toMatchObject({
    code: 'PROVIDER_BILLING',
    retryable: false,
    retryAfterMs: null,
    providerHint:
      'You have run out of credits or need a Grok subscription. Add credits at https://grok.com/ or upgrade at https://grok.com/supergrok.',
  });
  expect(requests).toEqual([expect.objectContaining({model: 'grok-4.7', max_tokens: 16})]);
});

test.each([
  [429, {error: {code: 'insufficient_quota', message: 'Please review your plan.'}}, 'PROVIDER_BILLING', false],
  [429, {error: {message: 'Your credit balance is too low.'}}, 'PROVIDER_BILLING', false],
  [403, {error: 'Billing is disabled for this account.'}, 'PROVIDER_BILLING', false],
  [403, {code: 'billing_hard_limit_reached', message: 'Review your plan.'}, 'PROVIDER_BILLING', false],
  [429, {error: 'Request rate limit exceeded.'}, 'RATE_LIMIT', true],
  [403, {error: 'You do not have access to this model.'}, 'FORBIDDEN', false],
  [402, {request: {messages: ['private prompt']}}, 'PROVIDER_BILLING', false],
] as const)('classifies HTTP %s for %j', async (status, body, code, retryable) => {
  const {generate, requests} = fixture(status, body);
  await expect(generate()).rejects.toMatchObject({code, retryable});
  expect(requests).toHaveLength(1);
});

test('bounds and redacts billing hints before serialization', async () => {
  const redactor = new Redactor();
  redactor.register('opaque-fixture-key');
  const {generate} = fixture(
    402,
    {
      error: {
        message:
          'Out of credits. opaque-fixture-key\u0007 https://example.test/billing?hidden-query#hidden-fragment ' +
          'x'.repeat(300),
      },
      request: {messages: ['private prompt']},
    },
    redactor,
  );
  const error = await generate().catch((error: unknown) => error);
  const {providerHint} = error as {providerHint: string};
  expect(providerHint).toMatch(/^Out of credits\. \[REDACTED\] https:\/\/example.test\/billing /);
  expect(providerHint.length).toBeLessThanOrEqual(200);
  expect(JSON.stringify(error)).not.toMatch(
    /opaque-fixture-key|hidden-query|hidden-fragment|private prompt|fixture-header/,
  );
});

test('HTTP 402 keeps its billing code when the provider sends an oversized error body', async () => {
  const {generate} = fixture(402, {message: 'Out of credits. ' + 'x'.repeat(8192)});
  await expect(generate()).rejects.toMatchObject({
    code: 'PROVIDER_BILLING',
    message: 'Provider account is out of credits or needs a subscription.',
  });
});

test('billing errors omit serialized request diagnostics from the provider message', async () => {
  const {generate} = fixture(402, {
    message: 'Out of credits. Request body: {"messages":["private prompt"]}',
  });
  await expect(generate()).rejects.toMatchObject({
    code: 'PROVIDER_BILLING',
    message: 'Provider account is out of credits or needs a subscription.',
  });
});
