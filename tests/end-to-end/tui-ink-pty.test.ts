import {expect, test} from 'bun:test';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

test.skipIf(process.platform === 'win32')(
  'Ink native PTY: consent, prompt, tool/session permission, plan, agents, memory, preset, compact, resize and exit',
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
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'resume', historyId], {
        cwd: dir,
        terminal,
        env: {
          ...process.env,
          HANNES_HOME: join(dir, 'state'),
          NO_COLOR: '1',
          FUTRYN_APPROVAL_POLICY: 'untrusted',
        },
      });
      const wait = async (text: string, from = 0) => {
        const deadline = Date.now() + 8000;
        while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(5);
        expect(output.slice(from).includes(text), `waiting for ${text}; tail: ${output.slice(-1500)}`).toBe(true);
      };
      const send = async (text: string) => {
        terminal!.write(text);
        await Bun.sleep(70);
      };
      await wait('Trust this folder?');
      await Bun.sleep(200);
      expect(output).not.toContain('INK_TURN_DONE');
      await send('\x1b[A');
      await send('\r');
      await wait('Ask anything');
      await wait('Stored 1199');
      const before = output.length,
        start = performance.now();
      terminal.write('inspect note');
      await wait('inspect note', before);
      expect(performance.now() - start).toBeLessThan(250);
      await send('\r');
      await wait('2 Cả phiên');
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
      await wait('read-only');
      await send('/compact');
      await send('\r');
      await wait('compacted');
      terminal.resize(72, 24);
      await Bun.sleep(120);
      await send('\x03');
      const timeout = setTimeout(() => child?.kill('SIGKILL'), 5000);
      expect(await child.exited).toBe(0);
      clearTimeout(timeout);
      expect(output).toContain('\x1b[?2004l');
      expect(output).not.toContain('\x1b[?1049h');
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
  'Ink CLI permission flags retain their presets through startup',
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
        [['--yolo'], 'Full Access: commands run without sandbox'],
        [['--full-auto'], ' · auto · context'],
        [['-s', 'read-only', '-a', 'on-request'], ' · read-only · context'],
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
          await wait('Trust this folder?');
          await Bun.sleep(200);
          terminal.write('\x1b[A');
          await Bun.sleep(60);
          terminal.write('\r');
          await wait(expected);
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
      const {providerSchema} = await import('@futryn/contracts');
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
      await wait('Trust this folder?');
      await Bun.sleep(200);
      terminal.write('\x1b[A');
      await Bun.sleep(60);
      terminal.write('\r');
      await wait('Ask anything');
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
