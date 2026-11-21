import {expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

test.skipIf(process.platform === 'win32')(
  'Ink native PTY: consent, prompt, tool/session permission, plan, agents, memory, permission mode, compact, resize and exit',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-ink-pty-')));
    const server = fixtureServer();
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      writeFileSync(join(dir, 'note.txt'), 'INK_TOOL_RECEIPT');
      app.registry.add(server.provider('chat', {id: 'ink-pty', auth: 'none'}));
      await app.accounts.add('ink-pty', 'Ink fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      await client.discoverModels();
      client.selectModel('fixture-model');
      client.addPermissionRule('ask', 'Read(note.txt)');
      client.updateAppearance({animations: {...client.getAppearance().animations, enabled: false}});
      server.set({
        script: view => {
          if (!view.tools.length) return {text: 'Verified fixture. Summary: inspected note and plan.'};
          if (!view.results.some(r => r.name === 'read')) return {calls: [{name: 'read', input: {path: 'note.txt'}}]};
          if (!view.results.some(r => r.name === 'update_plan'))
            return {
              calls: [{name: 'update_plan', input: {plan: [{step: 'Inspect Ink integration', status: 'in_progress'}]}}],
            };
          return {text: 'INK_TURN_DONE'};
        },
      });
      const historyId = app.conversations.create(client.status().selection!);
      app.db.transaction(() => {
        for (let n = 0; n < 1200; n++)
          app.conversations.append(
            historyId,
            {role: n % 2 ? 'assistant' : 'user', content: `Stored ${n}\nHistorical content for Ink scrollback.`},
            'committed',
          );
      })();
      let output = '';
      terminal = new Bun.Terminal({
        cols: 110,
        rows: 40,
        data(_t, bytes) {
          output += Buffer.from(bytes).toString('utf8');
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), '--resume', historyId], {
        cwd: dir,
        terminal,
        env: {
          ...process.env,
          HANNES_HOME: join(dir, 'state'),
          NO_COLOR: '1',
        },
      });
      const wait = async (text: string, from = 0) => {
        const deadline = Date.now() + 8000;
        while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(5);
        expect(output.slice(from).includes(text), `waiting for ${text}; tail: ${output.slice(-1500)}`).toBe(true);
      };
      const send = async (text: string) => {
        terminal!.write(text);
        await Bun.sleep(150);
      };
      await wait('Accessing workspace:');
      await Bun.sleep(200);
      expect(output).not.toContain('INK_TURN_DONE');
      await send('\x1b[A');
      await send('\r');
      await wait('manual mode on');
      await wait('Stored 1199');
      const before = output.length,
        start = performance.now();
      terminal.write('inspect note');
      await wait('inspect note', before);
      expect(performance.now() - start).toBeLessThan(250);
      await send('\r');
      await wait('2. Yes, and');
      await send('2');
      await wait('INK_TURN_DONE');
      await wait('Inspect Ink integration');
      await Bun.sleep(180);
      await send('/plan');
      await send('\r');
      await wait('Plan mode');
      await send('/agents');
      await send('\r');
      await wait('Agents');
      await send('\x1b');
      await send('/memory');
      await send('\r');
      await wait('Memor');
      await send('\x1b');
      await send('\x1b[Z');
      await wait('accept edits');
      await send('/compact');
      await send('\r');
      await wait('compacted');
      terminal.resize(72, 24);
      await Bun.sleep(120);
      await send('\x03');
      await wait('Press Ctrl-C again to exit');
      await send('\x03');
      const timeout = setTimeout(() => child?.kill('SIGKILL'), 5000);
      expect(await child.exited).toBe(0);
      clearTimeout(timeout);
      expect(output).toContain('\x1b[?2004l');
      // Fullscreen (ADR 0066): the alternate screen is entered once and left before the process exits.
      expect(output).toContain('\x1b[?1049h');
      expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'));
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    }
  },
  30000,
);

test.skipIf(process.platform === 'win32')(
  'Ink fullscreen PTY follows resize, keeps narrow input, and leaves the alternate screen on exit',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-ink-screen-')));
    const server = fixtureServer();
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      app.registry.add(server.provider('chat', {id: 'screen-ink', auth: 'none'}));
      await app.accounts.add('screen-ink', 'Screen fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      await client.discoverModels();
      client.selectModel('fixture-model');
      let output = '';
      terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(_t, bytes) {
          output += Buffer.from(bytes).toString('utf8');
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
        cwd: dir,
        terminal,
        env: {...process.env, HANNES_HOME: join(dir, 'state'), NO_COLOR: '1'},
      });
      const wait = async (text: string) => {
        const deadline = Date.now() + 8000;
        while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(5);
        expect(output.includes(text), `waiting for ${text}; tail: ${output.slice(-800)}`).toBe(true);
      };
      await wait('Accessing workspace:');
      await Bun.sleep(200);
      terminal.write('\x1b[A');
      await Bun.sleep(60);
      terminal.write('\r');
      await wait('manual mode on');
      terminal.resize(120, 40);
      await Bun.sleep(120);
      terminal.write('wide');
      await wait('wide');
      terminal.resize(20, 8);
      await Bun.sleep(120);
      terminal.write('n');
      await wait('widen');
      expect(output).not.toContain('undefined');
      terminal.write('\x03'); // text in the prompt: Ctrl+C clears it first
      await wait('ctrl+y to paste deleted text');
      terminal.write('\x03');
      await wait('Press Ctrl-C again to exit');
      terminal.write('\x03');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      expect(await child.exited).toBe(0);
      clearTimeout(timer);
      // Fullscreen (ADR 0066): the alternate screen is entered once and left before the process exits.
      expect(output).toContain('\x1b[?1049h');
      expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'));
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    }
  },
  30000,
);

test.skipIf(process.platform === 'win32')(
  'Ink CLI permission flags retain their modes through startup',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-ink-flags-')));
    const server = fixtureServer();
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    try {
      app.registry.add(server.provider('chat', {id: 'flags-ink', auth: 'none'}));
      await app.accounts.add('flags-ink', 'Flags fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      await client.discoverModels();
      client.selectModel('fixture-model');
      for (const [args, expected] of [
        [['--dangerously-skip-permissions'], 'bypass permissions on (shift+tab to cycle)'],
        [['--permission-mode', 'acceptEdits'], 'accept edits on'],
        [['--permission-mode', 'plan'], 'plan mode on'],
      ] as const) {
        let output = '';
        const terminal = new Bun.Terminal({
          cols: 110,
          rows: 30,
          data(_t, b) {
            output += Buffer.from(b).toString('utf8');
          },
        });
        const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui', ...args], {
          cwd: dir,
          terminal,
          env: {...process.env, HANNES_HOME: join(dir, 'state'), NO_COLOR: '1'},
        });
        try {
          const wait = async (text: string) => {
            const deadline = Date.now() + 7000;
            while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(5);
            expect(output.includes(text), text).toBe(true);
          };
          if (!client.workspaceTrusted()) {
            await wait('Accessing workspace:');
            await Bun.sleep(200);
            terminal.write('\x1b[A');
            await Bun.sleep(60);
            terminal.write('\r');
          }
          await wait(expected);
          terminal.write('\x03');
          await wait('Press Ctrl-C again to exit');
          terminal.write('\x03');
          const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
          expect(await child.exited).toBe(0);
          clearTimeout(timer);
        } finally {
          child.kill('SIGKILL');
          await child.exited;
          terminal.close();
        }
      }
    } finally {
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    }
  },
  30000,
);

test.skipIf(process.platform === 'win32')(
  'Ink native PTY stays responsive during a continuous 2000-line provider stream',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-ink-stream-')));
    let emitted = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        if (request.method === 'GET') return Response.json({data: [{id: 'stream-model'}]});
        const body = (await request.json()) as {stream?: boolean};
        const base = {id: 'stream-fixture', object: 'chat.completion.chunk', created: 123, model: 'stream-model'};
        if (!body.stream)
          return Response.json({
            id: 'probe',
            object: 'chat.completion',
            created: 123,
            model: 'stream-model',
            choices: [{index: 0, message: {role: 'assistant', content: 'Verified'}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
          });
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
            try {
              for (let n = 0; n < 250 && !cancelled; n++) {
                controller.enqueue(
                  encode({
                    ...base,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: Array.from(
                            {length: 8},
                            (_, row) => `LIVE_LINE_${n * 8 + row} streamed content\n`,
                          ).join(''),
                        },
                        finish_reason: null,
                      },
                    ],
                  }),
                );
                emitted = n + 1;
                await Bun.sleep(25);
              }
              if (cancelled) return;
              controller.enqueue(
                encode({...base, choices: [{index: 0, delta: {content: 'LIVE_STREAM_DONE'}, finish_reason: null}]}),
              );
              controller.enqueue(
                encode({
                  ...base,
                  choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
                  usage: {prompt_tokens: 10, completion_tokens: 2000, total_tokens: 2010},
                }),
              );
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
            } catch {
              /* Cancellation may close the transport while enqueueing. */
            }
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {headers: {'content-type': 'text/event-stream'}});
      },
    });
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const {providerSchema} = await import('@cosmew/contracts');
      app.registry.add(
        providerSchema.parse({
          id: 'ink-stream',
          name: 'Ink stream fixture',
          protocol: 'chat',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          auth: 'none',
          catalog: 'openai',
          metadataVersion: 1,
          timeoutMs: 30000,
        }),
      );
      await app.accounts.add('ink-stream', 'Stream fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      await client.discoverModels();
      client.selectModel('stream-model');
      let output = '';
      terminal = new Bun.Terminal({
        cols: 100,
        rows: 35,
        data(_t, bytes) {
          output = (output + Buffer.from(bytes).toString('utf8')).slice(-250000);
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
        cwd: dir,
        terminal,
        env: {...process.env, HANNES_HOME: join(dir, 'state'), NO_COLOR: '1'},
      });
      const wait = async (text: string, timeout = 10000) => {
        const deadline = Date.now() + timeout;
        while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(3);
        expect(output.includes(text), `waiting for ${text}`).toBe(true);
      };
      await wait('Accessing workspace:');
      await Bun.sleep(200);
      terminal.write('\x1b[A');
      await Bun.sleep(60);
      terminal.write('\r');
      await wait('manual mode on');
      await Bun.sleep(100);
      terminal.write('stream test');
      await Bun.sleep(80);
      terminal.write('\r');
      await wait('LIVE_LINE_'); // streaming started (the live view shows a bounded tail)
      const latency: number[] = [];
      let draft = '';
      for (const part of ['draft', '-one', '-two', '-three', '-four']) {
        expect(emitted).toBeLessThan(250);
        draft += part;
        const start = performance.now();
        terminal.write(part);
        await wait(draft);
        latency.push(performance.now() - start);
        await Bun.sleep(50);
      }
      expect(Math.max(...latency)).toBeLessThan(250);
      await wait('LIVE_STREAM_DONE', 20000);
      expect(emitted).toBe(250);
      expect(output).toContain(draft);
      terminal.write('\x03'); // text in the prompt: Ctrl+C clears it first
      await wait('ctrl+y to paste deleted text');
      terminal.write('\x03');
      await wait('Press Ctrl-C again to exit');
      terminal.write('\x03');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      expect(await child.exited).toBe(0);
      clearTimeout(timer);
      console.log('Ink continuous stream input-to-output ms', JSON.stringify(latency));
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      await app.shutdownCommands();
      app.db.close();
      server.stop(true);
      rmSync(dir, {recursive: true, force: true});
    }
  },
  30000,
);

test.skipIf(process.platform === 'win32')(
  'Ink PTY keeps workspace consent alive after immediate, split and late OSC 11 replies',
  async () => {
    for (const delay of [0, 50, 400])
      for (const end of ['\x07', '\x1b\\']) {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-osc-pty-')));
        let output = '';
        let queried = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const terminal = new Bun.Terminal({
          cols: 100,
          rows: 30,
          data(t, bytes) {
            output += Buffer.from(bytes).toString('utf8');
            if (!queried && output.includes('\x1b]11;?\x07')) {
              queried = true;
              timers.push(
                setTimeout(() => {
                  t.write('\x1b]11;rgb:ffff/ffff/ffff');
                  timers.push(setTimeout(() => t.write(end.slice(0, 1)), 10));
                  if (end.length > 1) timers.push(setTimeout(() => t.write(end.slice(1)), 20));
                }, delay),
              );
            }
          },
        });
        const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts')], {
          cwd: dir,
          terminal,
          env: {...process.env, HANNES_HOME: join(dir, 'state'), NO_COLOR: '1', FUTRYN_THEME_MODE: 'system'},
        });
        try {
          const wait = async (text: string, from = 0) => {
            const deadline = Date.now() + 8000;
            while (!output.slice(from).includes(text) && Date.now() < deadline && child.exitCode === null)
              await Bun.sleep(5);
            expect(
              output.slice(from).includes(text),
              `delay=${delay} end=${JSON.stringify(end)}; tail=${output.slice(-800)}`,
            ).toBe(true);
          };
          await wait('Accessing workspace:');
          expect(queried).toBe(true);
          await Bun.sleep(600);
          expect(
            child.exitCode,
            `delay=${delay} end=${JSON.stringify(end)} tail=${JSON.stringify(output.slice(-1400))}`,
          ).toBeNull();
          const before = output.length;
          terminal.write('\x1b[A');
          await wait('❯ Yes, I trust this folder', before); // Still handles real input after the reply.
          expect(child.exitCode).toBeNull();
        } finally {
          for (const timer of timers) clearTimeout(timer);
          child.kill('SIGKILL');
          await child.exited;
          terminal.close();
          rmSync(dir, {recursive: true, force: true});
        }
      }
  },
  30000,
);
