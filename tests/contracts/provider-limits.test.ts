import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError} from '@futryn/contracts';
import {parseOpenRouterKeyLimits} from '@futryn/models';
import {FutrynTuiApp, limitItemText, limitRows} from '@futryn/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

test('OpenRouter key credit: capped, uncapped and free-tier keys', () => {
  const capped = parseOpenRouterKeyLimits({data: {usage: 1.25, limit: 10, limit_remaining: 8.75, is_free_tier: false}});
  expect(capped.items[0]).toMatchObject({used: 1.25, limit: 10, remaining: 8.75, unit: 'USD', unlimited: false});
  expect(capped.freeTier).toBe(false);
  const uncapped = parseOpenRouterKeyLimits({data: {usage: 3, limit: null, is_free_tier: true}});
  expect(uncapped.items[0]).toMatchObject({used: 3, limit: null, remaining: null, unlimited: true});
  expect(uncapped.freeTier).toBe(true);
  // remaining is derived only when the provider omits it but reports both numbers
  expect(parseOpenRouterKeyLimits({data: {usage: 4, limit: 5}}).items[0]?.remaining).toBe(1);
});

test('malformed key responses are protocol errors, never zero balances', () => {
  for (const body of [null, {}, {data: null}, {data: {usage: 'lots'}}, {data: {usage: 1, limit: 'ten'}}]) {
    expect(() => parseOpenRouterKeyLimits(body)).toThrow(FutrynError);
  }
});

test('limit rows show provider numbers, failures and providers without a quota API', () => {
  expect(limitItemText({label: 'Key credit', used: 1.2, limit: 10, remaining: 8.8, unit: 'USD'})).toBe(
    '$1.20 of $10.00 · $8.80 left',
  );
  expect(limitItemText({label: 'Key credit', used: 3, limit: null, unit: 'USD', unlimited: true})).toBe(
    '$3.00 used · no spending cap',
  );
  expect(limitItemText({label: 'primary', usedPercent: 42, unit: '%'})).toBe('primary 42% used');
  const rows = limitRows([
    {
      accountId: '1',
      alias: 'main',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      source: 'live',
      observedAt: null,
      items: [{label: 'Key credit', used: 1, limit: 2, remaining: 1, unit: 'USD'}],
    },
    {
      accountId: '2',
      alias: 'work',
      providerId: 'x',
      providerName: 'Anthropic',
      source: 'unavailable',
      observedAt: null,
      items: [],
    },
    {
      accountId: '3',
      alias: 'broken',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      source: 'live',
      observedAt: null,
      items: [],
      error: 'AUTH',
    },
  ]).join('\n');
  expect(rows).toContain('main · $1.00 of $2.00 · $1.00 left');
  expect(rows).toContain('work · not reported by provider');
  expect(rows).toContain('broken · check failed (AUTH)');
  expect(limitRows([]).join('\n')).toContain('No connected accounts');
  const pending = limitRows([
    {
      accountId: '4',
      alias: 'or',
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      source: 'unavailable',
      observedAt: null,
      items: [],
      checking: true,
    },
  ]).join('\n');
  expect(pending).toContain('or · checking…');
});

test('/usage lists every connected account, even before the first message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-limits-'));
  const server = fixtureServer();
  cleanup.push(
    () => rmSync(dir, {recursive: true, force: true}),
    () => server.server.stop(true),
  );
  const app = startup(dir, {vault: memoryVault()});
  cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', {id: 'limits', auth: 'none'}));
  await app.accounts.add('limits', 'first', {kind: 'none'});
  await app.accounts.add('limits', 'second', {kind: 'none'});
  const client = app.createFutrynClient(dir);
  const before = server.requests.length;
  await client.refreshLimits(); // no provider here has a quota API: nothing is requested
  expect(server.requests.length).toBe(before);
  expect(client.limits().map(entry => entry.source)).toEqual(['unavailable', 'unavailable']);
  const tui = new FutrynTuiApp({client, cols: 100, rows: 30});
  await tui.initialize();
  cleanup.push(() => tui.shutdown());
  await tui.executeSlashCommand('/usage');
  expect(tui.computeFrameSnapshot().plainText).not.toContain('checking…'); // no quota API: answered at once
  const until = Date.now() + 2000;
  while (tui.computeFrameSnapshot().plainText.includes('checking…') && Date.now() < until) await Bun.sleep(5);
  const text = tui.computeFrameSnapshot().plainText;
  expect(text).toContain('LIMITS BY PROVIDER');
  expect(text).toContain('first · not reported by provider');
  expect(text).toContain('second · not reported by provider');
});

test('OpenAI and Anthropic rate-limit headers become quota entries; bad values are skipped', async () => {
  const {parseRateLimitHeaders, parseDurationMs} = await import('@futryn/models');
  expect(parseDurationMs('6m0s')).toBe(360000);
  expect(parseDurationMs('1h2m3.5s')).toBe(3723500);
  expect(parseDurationMs('20ms')).toBe(20);
  expect(parseDurationMs('soon')).toBeNull();
  const now = new Date('2026-11-15T10:00:00Z');
  const openai = parseRateLimitHeaders(
    new Headers({
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': '485',
      'x-ratelimit-reset-requests': '1m0s',
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-remaining-tokens': '29000',
      'x-ratelimit-reset-tokens': 'later',
    }),
    now,
  );
  expect(openai).toEqual([
    {name: 'requests', usedPercent: 3, resetAt: '2026-11-15T10:01:00.000Z', observedAt: now.toISOString()},
    {name: 'tokens', usedPercent: 3.3, resetAt: null, observedAt: now.toISOString()},
  ]);
  const anthropic = parseRateLimitHeaders(
    new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-11-15T10:00:30Z',
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-remaining': '150', // inconsistent: skipped
    }),
    now,
  );
  expect(anthropic).toEqual([
    {name: 'requests', usedPercent: 2, resetAt: '2026-11-15T10:00:30.000Z', observedAt: now.toISOString()},
  ]);
  expect(
    parseRateLimitHeaders(new Headers({'x-ratelimit-limit-requests': 'x', 'x-ratelimit-remaining-requests': '1'}), now),
  ).toEqual([]);
});

for (const protocol of ['chat', 'anthropic'] as const)
  test(`${protocol}: rate limits from the reply reach /usage for that account`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'futryn-ratelimit-'));
    const server = fixtureServer();
    cleanup.push(
      () => rmSync(dir, {recursive: true, force: true}),
      () => server.server.stop(true),
    );
    server.set({
      rateLimitHeaders:
        protocol === 'chat'
          ? {
              'x-ratelimit-limit-requests': '100',
              'x-ratelimit-remaining-requests': '75',
              'x-ratelimit-reset-requests': '30s',
            }
          : {
              'anthropic-ratelimit-requests-limit': '100',
              'anthropic-ratelimit-requests-remaining': '75',
              'anthropic-ratelimit-requests-reset': '2030-01-01T00:00:00Z',
            },
    });
    const app = startup(dir, {vault: memoryVault()});
    cleanup.push(() => app.db.close());
    app.registry.add(server.provider(protocol, {id: 'rl', auth: 'none', streamUsage: true}));
    const account = await app.accounts.add('rl', 'main', {kind: 'none'});
    const client = app.createFutrynClient(dir);
    await client.discoverModels();
    client.selectModel('fixture-model');
    for await (const _event of client.sendMessage('hi')) {
      /* drain */
    }
    expect(client.usage().last?.usage?.quota?.[0]).toMatchObject({name: 'requests', usedPercent: 25});
    client.clearSessionView(); // still attributed to the account after starting a new chat
    const limits = client.limits().find(entry => entry.accountId === account.id)!;
    expect(limits.source).toBe('last-turn');
    expect(limitItemText(limits.items[0]!)).toContain('requests 25% used');
  });
