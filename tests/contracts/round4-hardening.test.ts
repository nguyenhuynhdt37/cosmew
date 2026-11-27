import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Message, ModelEvent, ModelPort, ModelRequest} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {
  retainedUserBudget,
  retainRecentUserMessages,
  summarizeWithModel,
} from '../../packages/core/src/context/model-compaction';
import {estimateContextTokens} from '../../packages/core/src/context/builder';
import {openPrivateDatabase, SqliteConversations} from '@cosmew/persistence';
import {WorkspaceRoot} from '@cosmew/workspace';
import {runRead} from '../../packages/tools/src/builtin/read';
import {formatGrep} from '../../packages/tools/src/builtin/search';
import {replaceText} from '../../packages/tools/src/handlers/file-edit';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

test('retainedUserBudget scales down on small windows and retainRecentUserMessages respects UTF-8 byte budgets without splitting surrogates', () => {
  expect(retainedUserBudget(128_000)).toBe(20_000);
  expect(retainedUserBudget(8_000)).toBe(2_000);
  expect(retainedUserBudget(500)).toBe(256);

  const vietnamese = 'Tiếng Việt có dấu và biểu tượng 🚀 '.repeat(400);
  const kept = retainRecentUserMessages([{role: 'user', content: vietnamese}], 120);
  expect(kept).toHaveLength(1);
  expect(kept[0]!).toContain('[user message truncated by compaction]');
  // Valid UTF-16 without unpaired surrogates and bounded within the requested token budget.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(kept[0]!)).toBe(false);
  expect(estimateContextTokens(kept[0]!)).toBeLessThanOrEqual(120);
});

test('summarizeWithModel falls back to stripping heavy attachments when text truncation alone cannot fit the window', async () => {
  const seen: ModelRequest[] = [];
  const model: ModelPort = {
    async generate() {
      throw new Error('stream only');
    },
    async *stream(request: ModelRequest) {
      seen.push(request);
      yield {type: 'textDelta', text: 'Compact handoff without media'} as ModelEvent;
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 100, outputTokens: 20, costUSD: null}};
    },
  };
  const fakePng = Buffer.alloc(64, 1).toString('base64');
  // Four images alone account for 6,400 estimated media tokens, exceeding window 4,000 * 0.95 = 3,800.
  const visible: Message[] = [
    {
      role: 'user',
      content: 'Inspect these screenshots and summarize findings.',
      attachments: [
        {mime: 'image/png', data: fakePng, name: 'a.png'},
        {mime: 'image/png', data: fakePng, name: 'b.png'},
        {mime: 'image/png', data: fakePng, name: 'c.png'},
        {mime: 'image/png', data: fakePng, name: 'd.png'},
      ],
    },
  ];
  const result = await summarizeWithModel({
    model,
    selection: {accountId: crypto.randomUUID(), modelId: 'small-model'},
    visible,
    window: 4_000,
  });
  expect(result.text).toBe('Compact handoff without media');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.messages.every(m => !m.attachments?.length)).toBe(true);
  expect(seen[0]!.messages[0]!.content).toContain('4 attachment(s) omitted for compaction');
});

test('deliverSteering retains queued steering when skill loading aborts before delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-steer-abort-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  const db = openPrivateDatabase(dir);
  cleanups.push(() => db.close());
  const store = new SqliteConversations(db);

  const controller = new AbortController();
  let conversation!: Conversation;
  let steered = false;
  const model: ModelPort = {
    async generate() {
      throw new Error('stream only');
    },
    async *stream() {
      if (!steered) {
        steered = true;
        conversation.steer('Follow-up steering instruction');
        await Bun.sleep(20);
      }
      yield {type: 'textDelta', text: 'first'};
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 10, outputTokens: 5, costUSD: null}};
    },
  };

  conversation = new Conversation(
    {accountId: crypto.randomUUID(), modelId: 'test-model'},
    model,
    store,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      skills: {
        instructions: () => '',
        loadPrompt: async text => {
          if (text.includes('Follow-up steering')) {
            controller.abort();
            return [];
          }
          return [];
        },
      },
    },
  );

  await expect(
    (async () => {
      for await (const _event of conversation.send('Initial prompt', controller.signal)) {
        /* drain */
      }
    })(),
  ).rejects.toMatchObject({code: 'CANCELLED'});

  expect(conversation.queuedInput().map(entry => entry.content)).toEqual(['Follow-up steering instruction']);
});

test('listDirectory pages on whole entry boundaries without skipping entries past 50 KiB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-dir-page-'));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  // ~700 entries * ~90 bytes = ~63 KiB > 50 KiB page limit.
  const expectedNames: string[] = [];
  for (let i = 0; i < 700; i++) {
    const name = `entry-${String(i).padStart(4, '0')}-${'x'.repeat(75)}.txt`;
    writeFileSync(join(dir, name), 'ok');
    expectedNames.push(name);
  }
  const workspace = new WorkspaceRoot(dir);
  const root = workspace.resolve('.');
  const seen: string[] = [];
  let offset = 1;
  for (let page = 0; page < 5; page++) {
    const out = runRead(workspace, root, {path: '.', offset});
    expect(out.ok).toBe(true);
    if (!out.ok) break;
    const lines = out.content.split('\n');
    const entries = lines.filter(line => line.startsWith('entry-'));
    seen.push(...entries);
    const nextMatch = /\[continue with offset (\d+)\]/.exec(out.content);
    if (!nextMatch) break;
    offset = Number(nextMatch[1]);
  }
  expect(seen).toEqual(expectedNames);
});

test('formatGrep handles an oversized single-line page without stalling at offset 0 and replaceText preserves CRLF', () => {
  const hugeLine = 'x'.repeat(60_000);
  const formatted = formatGrep(
    [
      {path: 'a.txt', count: 1, lines: [{line: 1, text: hugeLine, match: true}]},
      {path: 'b.txt', count: 1, lines: [{line: 1, text: 'second', match: true}]},
    ],
    {pattern: 'x', output_mode: 'files_with_matches'},
    '.',
    [],
  );
  expect(formatted.content).toContain('a.txt');
  expect(formatted.content).toContain('b.txt');

  // Even when a single synthetic entry exceeds readOutputBytes, offset must advance by at least 1.
  const oversizedPath = 'dir/'.repeat(15_000) + 'file.ts';
  const singlePage = formatGrep(
    [
      {path: oversizedPath, count: 1, lines: []},
      {path: 'next.ts', count: 1, lines: []},
    ],
    {pattern: 'x', output_mode: 'files_with_matches'},
    '.',
    [],
  );
  expect(singlePage.content).toContain('continue with offset 1');
  expect(singlePage.content.length).toBeGreaterThan(100);

  // Pure CRLF file with a single-line old_string and multi-line LF new_string must keep CRLF everywhere.
  const crlfBefore = 'line1\r\ntarget\r\nline3\r\n';
  const crlfAfter = replaceText(crlfBefore, {old_string: 'target', new_string: 'newA\nnewB\nnewC'});
  expect(crlfAfter).toBe('line1\r\nnewA\r\nnewB\r\nnewC\r\nline3\r\n');
});
