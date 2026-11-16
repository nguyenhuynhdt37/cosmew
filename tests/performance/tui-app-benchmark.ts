import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir, cpus} from 'node:os';
import {join} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {FutrynTuiApp} from '../../apps/tui/src/app';
import {ChatController} from '../../apps/tui/src/features/chat/controller';
import {fixtureServer, memoryVault} from '../fixtures';
import {transcriptFixture} from './tui-fixture';
import {renderMarkdownBody} from '../../apps/tui/src/features/transcript/view';
import {deriveTokensFromTriplet} from '../../apps/tui/src/theme/presets';

const stats = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
};
const results: unknown[] = [];
const dir = mkdtempSync(join(tmpdir(), 'futryn-v2-bench-'));
const server = fixtureServer();
const ctx = startup(join(dir, 'state'), {vault: memoryVault()});
try {
  ctx.registry.add(server.provider('chat', {id: 'bench', auth: 'none'}));
  const account = await ctx.accounts.add('bench', 'bench', {kind: 'none'});
  const client = ctx.createFutrynClient(dir);
  await client.discoverModels();
  client.selectModel('fixture-model');
  await client.updateAppearance({
    sidebar: false,
    wallpaper: null,
    animations: {...client.getAppearance().animations, enabled: false},
  });
  for (const count of [100, 1000, 5000]) {
    const items = transcriptFixture(count);
    const id = ctx.conversations.create({accountId: account.id, modelId: 'fixture-model'});
    ctx.db.transaction(() => {
      for (const item of items) {
        ctx.conversations.append(id, {role: item.role, content: item.content}, 'committed');
      }
    })();
    const restoreStart = performance.now();
    client.resumeSession(id);
    const tui = new FutrynTuiApp({client, cols: 120, rows: 40, env: {COLORTERM: 'truecolor'}});
    await tui.initialize();
    const restoreMs = performance.now() - restoreStart;
    const chat = (tui as unknown as {chat: ChatController}).chat;
    // Real persisted history drives context/status; mixed tool fixtures drive viewport stress.
    chat.transcript = items;
    const coldStart = performance.now();
    tui.renderAnsiFrame();
    const coldFrameMs = performance.now() - coldStart;
    const typing: number[] = [],
      scrolling: number[] = [],
      streaming: number[] = [],
      queued: number[] = [],
      resize: number[] = [];
    let bytes = 0,
      rowsPainted = 0;
    const cpu = process.cpuUsage(),
      heapBefore = process.memoryUsage().heapUsed;
    const laidOut = chat.layout?.metrics.messagesLaidOut;
    for (let i = 0; i < 24; i++) {
      const queuedAt = performance.now();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const start = performance.now();
      queued.push(start - queuedAt);
      await tui.handleKey('x');
      const ansi = tui.renderAnsiFrame();
      typing.push(performance.now() - start);
      bytes += Buffer.byteLength(ansi);
      rowsPainted += ansi.match(/\x1b\[\d+;1H/g)?.length ?? 0;
    }
    const typingLayouts = laidOut === undefined ? null : chat.layout.metrics.messagesLaidOut - laidOut;
    for (let i = 0; i < 24; i++) {
      const start = performance.now();
      await tui.handleKey(i < 12 ? 'PageUp' : 'PageDown');
      tui.renderAnsiFrame();
      scrolling.push(performance.now() - start);
    }
    for (let i = 0; i < 24; i++) {
      const start = performance.now(),
        tail = items.at(-1)!;
      tail.content += ' delta';
      chat.layout?.invalidate(tail.id);
      if (i % 2 === 0) await tui.handleKey('WheelUp');
      await tui.handleKey('x');
      tui.renderAnsiFrame();
      streaming.push(performance.now() - start);
    }
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      tui.resize(i % 2 ? 120 : 100, 40);
      tui.renderAnsiFrame();
      resize.push(performance.now() - start);
    }
    const pasteStart = performance.now();
    await tui.handleKey('Paste:' + 'large prompt line 日本語\n'.repeat(10000));
    tui.renderAnsiFrame();
    const pasteMs = performance.now() - pasteStart;
    const afterPaste: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await tui.handleKey('z');
      tui.renderAnsiFrame();
      afterPaste.push(performance.now() - start);
    }
    const heapAfter = process.memoryUsage().heapUsed;
    const gcStart = performance.now();
    Bun.gc(true);
    const forcedGcMs = performance.now() - gcStart;
    results.push({
      count,
      restoreMs,
      coldFrameMs,
      typingMs: stats(typing),
      typingLayouts,
      scrollMs: stats(scrolling),
      streamAndScrollMs: stats(streaming),
      resizeMs: stats(resize),
      eventQueueDelayMs: stats(queued),
      ansiBytes: bytes,
      rowsPainted,
      cpuMicros: process.cpuUsage(cpu),
      heapBefore,
      heapAfter,
      heapAfterForcedGc: process.memoryUsage().heapUsed,
      forcedGcMs,
      cache: chat.layout?.cacheStats,
      pasteMs,
      typingAfterPasteMs: stats(afterPaste),
    });
    await tui.shutdown();
  }
  const tokens = deriveTokensFromTriplet('#faf9f5', '#262624', '#a85236');
  const content = transcriptFixture(2)[1]!.content;
  const markdown: Record<string, unknown> = {};
  for (const syntaxHighlighting of [false, true]) {
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      renderMarkdownBody({content, width: 116, tokens, bg: tokens.background, syntaxHighlighting});
      samples.push(performance.now() - start);
    }
    markdown[syntaxHighlighting ? 'markdownWithSyntaxMs' : 'markdownWithoutSyntaxMs'] = stats(samples);
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          bun: Bun.version,
          platform: process.platform,
          cpu: cpus()[0]?.model,
          dimensions: '120x40',
          measurement: 'input handler through ANSI generation, excludes terminal emulator paint',
        },
        results,
        markdown,
      },
      null,
      2,
    ),
  );
} finally {
  await ctx.shutdownCommands();
  await ctx.subscriptions.shutdown();
  ctx.db.close();
  server.server.stop(true);
  rmSync(dir, {recursive: true, force: true});
}
