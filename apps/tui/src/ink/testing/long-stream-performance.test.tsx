import {expect, test} from 'bun:test';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';
import {wrapText} from '../ui/text-line';

test('large streaming paragraphs keep typing and cancellation responsive', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  let update!: () => void;
  const nextDelta = new Promise<void>(resolve => {
    update = resolve;
  });
  let streaming = false;
  let aborted = false;
  const {client} = dialogFixture({
    validateAccount: async () => ({models: 1, validation: 'synthetic'}),
    startSession: () => ({
      id: 'long-stream',
      selection,
      messages: Array.from({length: 1000}, (_, n) => ({
        role: n % 2 ? ('assistant' as const) : ('user' as const),
        content: `history ${n} ${'earlier conversation '.repeat(30)}`,
      })),
    }),
    async *sendTurn(_id, _text, signal) {
      await ready;
      streaming = true;
      yield {type: 'textDelta', text: 'Streaming paragraph '.repeat(60000)};
      await nextDelta;
      yield {type: 'textDelta', text: ' LIVE_TAIL_MARKER'};
      await new Promise<void>(resolve => {
        if (signal?.aborted) {
          aborted = true;
          resolve();
        } else
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            {once: true},
          );
      });
    },
  });
  client.trustWorkspace();
  client.createSession();
  const ui = await openInk(client, {width: 100, rows: 36});
  try {
    await ui.press('continue');
    await ui.press('\r');
    const start = performance.now();
    release();
    await ui.waitFor('Streaming paragraph');
    const paint = performance.now() - start;
    const typing = await ui.pressToFrame('Z', frame => frame.includes('❯ Z'));
    const updateStart = performance.now();
    update();
    await ui.waitFor('LIVE_TAIL_MARKER');
    const deltaPaint = performance.now() - updateStart;
    const cancelStart = performance.now();
    await ui.press('\x1b');
    await ui.idle();
    const cancel = performance.now() - cancelStart;
    console.info('long-stream latency ms', {paint, typing, deltaPaint, cancel});
    expect(streaming).toBe(true);
    expect(aborted).toBe(true);
    expect(paint, 'painting a long stream must not monopolize input').toBeLessThan(150);
    expect(typing).toBeLessThan(150);
    expect(deltaPaint).toBeLessThan(150);
    expect(cancel).toBeLessThan(300);
  } finally {
    release();
    update();
    await ui.close();
  }
}, 30000);

test('completed long Markdown paragraphs remain scrollable from newest text to the beginning', async () => {
  const content = '**HEAD_MARKER** ' + 'wrapped paragraph 🚀 世界 '.repeat(3000) + ' **TAIL_MARKER**';
  const {client} = dialogFixture({
    startSession: () => ({id: 'long-paragraph', selection, messages: [{role: 'assistant', content}]}),
  });
  client.trustWorkspace();
  client.createSession();
  const ui = await openInk(client, {width: 100, rows: 36});
  try {
    expect(ui.frame()).toContain('TAIL_MARKER');
    await ui.pressToFrame('\x1b[1;5H', frame => frame.includes('HEAD_MARKER'));
    expect(ui.frame()).not.toContain('TAIL_MARKER');
    await ui.pressToFrame('\x1b[1;5F', frame => frame.includes('TAIL_MARKER'));
    expect(client.activeSession()?.messages[0]?.content).toBe(content);
  } finally {
    await ui.close();
  }
});

test('large prompt wrapping preserves text within the input latency budget', () => {
  const text = 'Streaming paragraph '.repeat(60000);
  const started = performance.now();
  const lines = wrapText(text, 98);
  const elapsed = performance.now() - started;
  console.info('large prompt wrap ms', elapsed);
  expect(lines.length).toBeGreaterThan(10000);
  expect(lines.every(line => Bun.stringWidth(line) <= 98)).toBe(true);
  expect(lines.join(' ').trim()).toBe(text.trim());
  expect(elapsed).toBeLessThan(150);
});
