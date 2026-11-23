import {expect, test} from 'bun:test';
import type {Message} from '@cosmew/contracts';
import {dialogFixture, selection} from '../features/picker/test-fixture';
import {openInk} from './ink-session';
import {settle} from './wait';

function history(count: number): Message[] {
  return Array.from({length: count / 2}, (_, turn): Message[] => {
    const name = ['exec_command', 'read', 'grep', 'edit'][turn % 4]!;
    const id = `tool-${turn}`;
    const output = Array.from({length: [5000, 1200, 500, 500][turn % 4]!}, (_, row) =>
      name === 'edit' ? `+${row} added` : `${row}\tfixture-${turn}.ts: ${'output '.repeat(5)}`,
    ).join('\n');
    return [
      {role: 'user', content: `prompt ${turn}`},
      {
        role: 'assistant',
        content: '',
        toolCalls: [{id, name, input: {cmd: 'fixture command', path: 'fixture.ts', pattern: 'output'}}],
      },
      {
        role: 'tool',
        toolCallId: id,
        toolName: name,
        content:
          name === 'edit'
            ? JSON.stringify({changes: [{path: 'fixture.ts', action: 'update', diff: `@@ -0,0 +1,500 @@\n${output}`}]})
            : output,
      },
      {
        role: 'assistant',
        content:
          Array.from({length: 105}, (_, row) => `**answer ${turn} row ${row}**\n\n`).join('') +
          '```ts\nconst result = 42;\n```',
      },
    ];
  }).flat();
}

for (const count of process.env.TRANSCRIPT_BENCH ? [300, 1000, 3000] : [3000]) {
  test(`long transcript paint timings with ${count} items`, async () => {
    const messages = history(count);
    const limitations = Array.from({length: 350}, (_, n) => `Status detail row ${n}`);
    const {client} = dialogFixture({
      startSession: () => ({id: 'perf', selection, messages}),
      getWorkspaceDiff: () => ({
        workspace: '/fixture',
        gitAvailable: false,
        state: 'not-repository',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      }),
      terminalRuntime: () => ({
        label: 'Fixture runtime',
        available: true,
        sandbox: 'disabled',
        unsandboxedAllowed: true,
        limitations,
      }),
    });
    client.trustWorkspace();
    client.createSession();
    const status = client.status.bind(client);
    let statusReads = 0;
    client.status = (...args) => {
      statusReads++;
      return status(...args);
    };
    const context = client.context.bind(client);
    let contextMs = 0;
    let contextCalls = 0;
    client.context = (...args) => {
      const start = performance.now();
      try {
        return context(...args);
      } finally {
        contextMs += performance.now() - start;
        contextCalls++;
      }
    };
    const ui = await openInk(client, {width: 100, rows: 36});
    try {
      const timings: Record<string, number> = {};
      const measure = async (name: string, keys: string, matches: (frame: string) => boolean) => {
        contextMs = 0;
        contextCalls = 0;
        timings[name] = await ui.pressToFrame(keys, matches);
        if (process.env.TRANSCRIPT_BENCH)
          console.info(count, name, timings[name].toFixed(1), {contextMs: Math.round(contextMs), contextCalls});
        await settle(0, 30000);
      };
      await measure('enter', '\x0f', frame => frame.includes('detailed transcript'));
      let previous = ui.frame();
      await measure('detail scroll', '\x1b[5~', frame => frame !== previous && frame.includes('Jump to bottom'));
      await measure('leave', '\x0f', frame => !frame.includes('detailed transcript'));
      previous = ui.frame();
      await measure('normal scroll', '\x1b[5~', frame => frame !== previous && frame.includes('Jump to bottom'));
      statusReads = 0;
      await measure('typing', 'Z', frame => frame.includes('❯ Z'));
      expect(statusReads, 'editing the draft should reuse the SDK status snapshot').toBe(0);
      await ui.press('\x15');
      await ui.press('\x1b[1;5F');
      await ui.press('/context');
      await measure('context', '\r', frame => frame.includes('Context window:'));
      await ui.press('/status');
      await measure('status', '\r', frame => frame.includes('Status') && frame.includes('Usage'));
      await measure('status details', 'd', frame => frame.includes('Status detail row 0'));
      console.info(count, JSON.stringify(timings));
      if (process.env.TRANSCRIPT_BENCH && count === 3000) {
        await ui.press('\x1b');
        await ui.press('\x0f');
        const sweep = async () => {
          for (const key of ['\x1b[5~', '\x1b[6~']) {
            for (let n = 0; n < 24; n++) {
              await ui.press(key);
              ui.discardCapturedFrames();
            }
          }
          Bun.gc(true);
          return Math.round(process.memoryUsage().heapUsed / 1024 ** 2);
        };
        console.info(
          'Retained JS heap (MiB) after three identical scroll sweeps',
          await sweep(),
          await sweep(),
          await sweep(),
        );
      }
      if (!process.env.TRANSCRIPT_BENCH) {
        const budgets: Record<string, number> = {
          enter: 280,
          'detail scroll': 160,
          leave: 240,
          'normal scroll': 160,
          typing: 150,
          context: 480,
          status: 400,
          'status details': 400,
        };
        for (const [name, ms] of Object.entries(timings)) expect(ms, name).toBeLessThan(budgets[name]!);
      }
    } finally {
      await ui.close();
    }
  }, 120000);
}

test('cached SDK context bytes match the whole serialized request for Unicode and draft input', () => {
  const messages: Message[] = [
    {role: 'user', content: 'Hello 🚀\n世界'},
    {role: 'assistant', content: 'Escapes \\ and "'},
  ];
  const {client} = dialogFixture({startSession: () => ({id: 'bytes', selection, messages})});
  client.createSession();
  for (const draft of ['', 'draft 🧪', '/context', 'draft 🧪']) {
    const components = draft.startsWith('/') || !draft ? messages : [...messages, {role: 'user', content: draft}];
    const bytes = Buffer.byteLength(JSON.stringify(components), 'utf8');
    expect(client.context(draft).estimateTokens).toBe(Math.ceil(bytes / 4) + components.length * 16 + 64);
  }
});
