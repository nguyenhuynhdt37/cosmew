import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynError, type Account, type SessionRecord, type Usage, type UsageQuota} from '@cosmew/contracts';
import {parseRateLimitHeaders} from '@cosmew/models';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {FutrynClient, quotaItems, type FutrynBackendPorts, type FetchAccountLimits} from '@cosmew/sdk';

const account = (providerId = 'openai'): Account => ({
  id: crypto.randomUUID(),
  providerId,
  alias: providerId,
  status: 'valid',
  credential: {kind: 'none'},
  validatedAt: null,
});
const quota = (usedPercent: number, observedAt = '2026-01-01T00:00:00.000Z'): UsageQuota => ({
  kind: 'subscription-quota',
  name: 'primary',
  usedPercent,
  observedAt,
  resetAt: '2026-02-01T00:00:00.000Z',
});
const usage = (snapshot: UsageQuota): Usage => ({
  inputTokens: null,
  outputTokens: null,
  costUSD: null,
  quota: [snapshot],
});
function session(selected: Account, owner: Account, used: Usage): SessionRecord {
  return {
    id: crypto.randomUUID(),
    title: '',
    selection: {accountId: selected.id, modelId: 'model'},
    revision: 1,
    messageCount: 1,
    lastState: 'committed',
    preview: '',
    messages: [],
    turns: [
      {
        requestId: crypto.randomUUID(),
        accountId: owner.id,
        modelId: 'model',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: null,
        outcome: 'completed',
        usage: used,
        context: null,
      },
    ],
  };
}
function client(accounts: Account[], sessions: SessionRecord[] = [], fetchAccountLimits?: FetchAccountLimits) {
  // Only backend ports needed by this SDK operation. These fixtures assert account attribution and
  // cancellation semantics, not compatibility with any provider's live authenticated endpoint.
  return new FutrynClient({
    settings: {read: () => ({})},
    listAccounts: () => accounts,
    listProviders: () => [],
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find(s => s.id === id),
    resolveSelection: () => null,
    fetchAccountLimits,
  } as unknown as FutrynBackendPorts);
}

test('Codex response windows are typed provider snapshots; timestamps are Unix seconds, never guessed', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const parsed = parseRateLimitHeaders(
    new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1767229200',
      'x-codex-secondary-used-percent': '110',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': 'invalid',
    }),
    now,
  );
  expect(parsed).toEqual([
    {...quota(12.5), name: 'Codex primary', windowMinutes: 300, resetAt: '2026-01-01T01:00:00.000Z'},
    {...quota(110), name: 'Codex secondary', windowMinutes: 10080, resetAt: null},
  ]);
  for (const value of ['', ' ', 'NaN', 'Infinity', '-1', '0']) {
    expect(parseRateLimitHeaders(new Headers({'x-codex-primary-used-percent': value}), now)).toEqual([]);
  }
  expect(
    parseRateLimitHeaders(
      new Headers({'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '300'}),
      now,
    )[0]?.usedPercent,
  ).toBe(0);
  expect(quotaItems([{...quota(4), kind: undefined}])[0]?.kind).toBe('unknown');
});

test('all sessions and source accounts contribute newest quota regardless of selection and summary order', () => {
  const a = account();
  const b = account('anthropic');
  const records = Array.from({length: 25}, () => session(a, a, {inputTokens: 1, outputTokens: 1, costUSD: 0}));
  // A was selected at save time; B actually made this request. It lies outside the old first-20 cap.
  records.push(
    session(a, b, {
      ...usage(quota(70)),
      breakdown: [{...usage(quota(70, '2026-01-04T00:00:00.000Z')), accountId: b.id}],
    }),
  );
  records.push(
    session(a, b, {
      ...usage(quota(20)),
      breakdown: [{...usage(quota(20, '2026-01-02T00:00:00.000Z')), accountId: b.id}],
    }),
  );
  expect(client([a, b], records).limits()[1]?.items[0]?.usedPercent).toBe(70);
  const child = {...usage(quota(95, '2026-01-05T00:00:00.000Z')), accountId: b.id, providerId: b.providerId};
  records.push(session(a, a, {...usage(quota(95)), breakdown: [child]}));
  const limits = client([a, b], records).limits();
  expect(limits[0]?.items).toEqual([]); // aggregate/child quota never attributed to parent A
  expect(limits[1]).toMatchObject({
    accountId: b.id,
    source: 'last-turn',
    status: 'available',
    stale: true,
    observedAt: '2026-01-05T00:00:00.000Z',
    items: [{usedPercent: 95, kind: 'subscription-quota'}],
  });
});

test('unknown source identity and mismatched provider identity never lend quota to a parent account', () => {
  const a = account();
  const records = [
    session(a, a, {
      ...usage(quota(95)),
      breakdown: [usage(quota(95)), {...usage(quota(70)), accountId: a.id, providerId: 'anthropic'}],
    }),
  ];
  expect(client([a], records).limits()[0]?.items).toEqual([]);
});

test('SQLite quota projection reads receipts and standalone usage without opening session history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-quota-'));
  const db = openPrivateDatabase(dir);
  try {
    const a = account('xai');
    const selection = {accountId: a.id, modelId: 'model'};
    const store = new SqliteConversations(db);
    const quotaUsage = (percent: number, at: string): Usage => ({
      ...usage(quota(percent, at)),
      breakdown: [{...usage(quota(percent, at)), ...selection, providerId: a.providerId}],
    });
    const receipt = session(a, a, quotaUsage(25, '2026-01-01T00:00:00Z')).turns![0]!;
    const turn = store.create(selection);
    store.bindWorkspace(turn, '/first');
    store.append(turn, {role: 'user', content: 'unneeded transcript'}, 'committed', receipt);
    const standalone = store.create(selection);
    store.bindWorkspace(standalone, '/first');
    store.addUsage(standalone, quotaUsage(55, '2026-01-02T00:00:00Z'));
    const other = store.create(selection);
    store.bindWorkspace(other, '/other');
    store.addUsage(other, quotaUsage(95, '2026-01-03T00:00:00Z'));
    expect(
      store
        .listQuotaSources('/first')
        .map(row => row.quota?.[0]?.usedPercent)
        .sort(),
    ).toEqual([25, 55]);

    const c = new FutrynClient({
      settings: {read: () => ({})},
      listAccounts: () => [a],
      listProviders: () => [],
      listQuotaSources: () => store.listQuotaSources('/first'),
      listSessions: () => {
        throw new Error('Quota must not load session summaries');
      },
      getSession: () => {
        throw new Error('Quota must not load transcripts');
      },
    } as unknown as FutrynBackendPorts);
    expect(c.limits()[0]?.items[0]?.usedPercent).toBe(55);
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('unsupported refresh stays explicit and unknown; OAuth does not imply plan allowance', async () => {
  const a = account('gemini');
  const c = client([a], [], () => null);
  await c.refreshLimits();
  expect(c.limits()[0]).toMatchObject({source: 'unavailable', status: 'unsupported', items: [], observedAt: null});
  expect(c.limits()[0]?.note).toContain('unsupported');
  expect(client([account('chatgpt-api')]).limits()[0]).toMatchObject({status: 'unavailable', items: []});
});

test('refresh errors retain last good credit values and timestamp; cancellation never replaces them', async () => {
  const a = account('openrouter');
  let mode: 'success' | 'error' | 'cancel' = 'success';
  const controller = new AbortController();
  const c = client([a], [], async () => {
    if (mode === 'error') throw new FutrynError('AUTH');
    if (mode === 'cancel') {
      controller.abort();
      throw new DOMException('cancel', 'AbortError');
    }
    return {items: [{kind: 'api-credits', label: 'Key credit', used: 2, remaining: 8, limit: 10, unit: 'USD'}]};
  });
  await c.refreshLimits();
  const original = c.limits()[0]!;
  mode = 'error';
  await c.refreshLimits();
  expect(c.limits()[0]).toMatchObject({
    status: 'error',
    stale: true,
    error: 'AUTH',
    items: original.items,
    observedAt: original.observedAt,
  });
  mode = 'cancel';
  await c.refreshLimits(controller.signal);
  expect(c.limits()[0]).toMatchObject({error: 'AUTH', items: original.items, observedAt: original.observedAt});
  expect(c.limits()[0]?.checking).toBeUndefined();
});

test('concurrent refreshes share requests; pre-aborted refresh sends none', async () => {
  const a = account('openrouter');
  let calls = 0;
  let resolve!: (value: {items: []}) => void;
  const c = client([a], [], () => {
    calls++;
    return new Promise(r => {
      resolve = r;
    });
  });
  const abort = new AbortController();
  abort.abort();
  await c.refreshLimits(abort.signal);
  expect(calls).toBe(0);
  const first = c.refreshLimits();
  const second = c.refreshLimits();
  expect(calls).toBe(1);
  expect(c.limits()[0]?.checking).toBe(true);
  resolve({items: []});
  await Promise.all([first, second]);
  expect(c.limits()[0]?.checking).toBeUndefined();
});

test('legacy aggregate snapshots without source provenance never claim a parent account allowance', () => {
  const a = account();
  expect(client([a], [session(a, a, usage(quota(50)))]).limits()[0]?.items).toEqual([]);
});

test('rate limits preserve request model scope alongside distinct account subscription windows', () => {
  const a = account();
  const records = [
    session(a, a, {
      ...usage(quota(0)),
      breakdown: [
        {...usage(quota(20)), accountId: a.id, modelId: 'first'},
        {...usage({...quota(40), kind: 'rate-limit', name: 'tokens'}), accountId: a.id, modelId: 'first'},
        {
          ...usage({...quota(70, '2026-01-04T00:00:00.000Z'), kind: 'rate-limit', name: 'tokens'}),
          accountId: a.id,
          modelId: 'second',
        },
      ],
    }),
  ];
  expect(client([a], records).limits()[0]?.items).toMatchObject([
    {kind: 'subscription-quota', label: 'primary', usedPercent: 20},
    {kind: 'rate-limit', label: 'tokens (first)', modelId: 'first', usedPercent: 40},
    {kind: 'rate-limit', label: 'tokens (second)', modelId: 'second', usedPercent: 70},
  ]);
});

test('mixed live credits and reply snapshots retain separate observation sources', async () => {
  const a = account('openrouter');
  const snapshot = quota(25);
  const records = [
    session(a, a, {
      ...usage(snapshot),
      breakdown: [{...usage(snapshot), accountId: a.id, providerId: a.providerId, modelId: 'model'}],
    }),
  ];
  const c = client([a], records, () =>
    Promise.resolve({items: [{label: 'Key credit', kind: 'api-credits', unit: 'USD', used: 1, limit: 10}]}),
  );
  await c.refreshLimits();
  const mixed = c.limits()[0]!;
  expect(mixed.source).toBe('mixed');
  expect(mixed.items[0]).toMatchObject({source: 'live', kind: 'api-credits'});
  expect(mixed.items[0]!.observedAt).not.toBe(snapshot.observedAt);
  expect(mixed.items[1]).toMatchObject({source: 'last-turn', observedAt: snapshot.observedAt});
});
