import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {stripVTControlCharacters} from 'node:util';
import type {FutrynClient} from '@cosmew/sdk';
import {join, resolve} from 'node:path';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

const completedOnboarding = ['theme', 'auth', 'security'];

function finishFixtureOnboarding(client: FutrynClient) {
  for (const step of completedOnboarding) client.completeOnboardingStep(step);
}

test.skipIf(process.platform === 'win32')(
  'Ink diff PTY at 140 columns: Tab, file keys, detail, SGR clicks and wheel keep the prompt usable',
  async () => {
    const server = fixtureServer();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-diff-pty-')));
    const runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-diff-runtime-')));
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // Every Git mutation is confined to this disposable repository. Ignore the
      // fixture's durable state so only the intended files reach the panel.
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(
          [
            'git',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=PTY fixture',
            '-c',
            'user.email=pty@example.invalid',
            ...args,
          ],
          {
            cwd: dir,
            env: {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      };
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, '.git/info/exclude'), 'state/\n');
      writeFileSync(join(dir, 'a.txt'), 'A_BASE\n');
      writeFileSync(join(dir, 'b.txt'), 'B_BASE\n');
      const additional = Array.from({length: 16}, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
      for (const name of additional) writeFileSync(join(dir, name), 'BASE\n');
      git('add', 'a.txt', 'b.txt', ...additional);
      git('commit', '-qm', 'PTY diff baseline');
      for (const file of ['a', 'b'])
        writeFileSync(
          join(dir, `${file}.txt`),
          Array.from({length: 80}, (_, i) => `${file.toUpperCase()}_CHANGE_${String(i).padStart(2, '0')}`).join('\n') +
            '\n',
        );

      for (const name of additional) writeFileSync(join(dir, name), `BODY_${name.slice(0, -4)}\n`);

      app.registry.add(server.provider('chat', {id: 'diff-pty', auth: 'none'}));
      await app.accounts.add('diff-pty', 'Diff fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      finishFixtureOnboarding(client);
      await client.discoverModels();
      client.selectModel('fixture-model');
      client.trustWorkspace();
      client.updateAppearance({animations: {...client.getAppearance().animations, enabled: false}});
      let output = '';
      terminal = new Bun.Terminal({
        cols: 140,
        rows: 40,
        data(_t, bytes) {
          output += Buffer.from(bytes).toString('utf8');
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), 'tui'], {
        cwd: dir,
        terminal,
        env: {
          PATH: process.env.PATH,
          HOME: runtimeDir,
          TMPDIR: runtimeDir,
          BUN_INSTALL_CACHE_DIR: join(runtimeDir, 'bun-cache'),
          XDG_CACHE_HOME: join(runtimeDir, 'cache'),
          COSMEW_HOME: join(dir, 'state'),
          FUTRYN_COMMAND_BACKEND: 'none',
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          NO_COLOR: '1',
        },
      });
      const wait = async (text: string, from = 0) => {
        const deadline = Date.now() + 8000;
        while (!output.slice(from).includes(text) && Date.now() < deadline && child!.exitCode === null)
          await Bun.sleep(5);
        expect(
          output.slice(from).includes(text),
          `waiting for ${text}; tail: ${JSON.stringify(output.slice(-5000))}`,
        ).toBe(true);
        expect(child!.exitCode).toBeNull();
      };
      const send = async (text: string) => {
        const from = output.length;
        terminal!.write(text);
        await Bun.sleep(150);
        return from;
      };
      await wait('manual mode on'); // The fixture client persisted folder consent, so the trust dialog is skipped.
      await send('/diff');
      await send('\r');
      await wait('source: Uncommitted');
      await wait('18 files changed +176 -18');
      await wait('A_CHANGE_00');
      await wait('tab focus');
      let from = await send('draft beside diff');
      await wait('draft beside diff', from);
      await send('\x03'); // Clear the draft before moving focus.
      from = await send('\t');
      await wait('esc prompt', from);
      from = await send('\x1b[B');
      await wait('B_CHANGE_00', from);
      from = await send('\x1b[A');
      await wait('A_CHANGE_00', from);
      from = await send('j');
      await wait('B_CHANGE_00', from);
      from = await send('k');
      await wait('A_CHANGE_00', from);

      from = await send('\x1b[6~');
      // The pointer is repainted as a partial cell update, so only the freshly written body line is a stable raw-stream marker;
      // the highlighted row itself is asserted by the Ink frame tests.
      await wait('BODY_file-06', from);
      from = await send('\x1b[<65;100;7M');
      await wait('BODY_file-09', from);
      from = await send('\x1b[H');
      await wait('A_CHANGE_00', from);

      // SGR uses one-based coordinates. Row 4 is the list hint and rows 5 and 6 are files.
      from = await send('\x1b[<0;100;6M');
      await wait('B_CHANGE_00', from);
      from = await send('\r');
      await wait('esc back', from);
      await send('\x1b[B'); // In detail, arrows scroll instead of selecting a file.
      from = await send('\x1b[<65;100;15M'.repeat(30));
      await wait('B_CHANGE_79', from);
      from = await send('\x1b[<64;100;15M'.repeat(30));
      await wait('B_CHANGE_00', from);
      from = await send('\x1b');
      await wait('esc prompt', from);
      from = await send('\x1b');
      await wait('tab focus', from);

      from = await send('\x1b[<0;125;2M');
      await wait('source: Branch', from);
      await send('\t');
      from = await send('\x1b[D');
      await wait('source: Uncommitted', from);
      from = await send('\x1b[C');
      await wait('source: Branch', from);
      await send('\x1b[<0;139;1M');
      from = await send('prompt after close');
      await wait('prompt after close', from);
      expect(output.slice(from)).not.toContain('source:');
      expect(output).toContain('\x1b[?1006h');
      await send('\x03');
      await send('\x03');
      await wait('Press Ctrl-C again to exit');
      await send('\x03');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);
      expect(await child.exited).toBe(0);
      clearTimeout(timer);
      expect(output).toContain('\x1b[?1006l');
      expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'));
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      await app.shutdownCommands();
      app.db.close();
      server.server.stop(true);
      rmSync(dir, {recursive: true, force: true});
      rmSync(runtimeDir, {recursive: true, force: true});
    }
  },
  30000,
);

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
      finishFixtureOnboarding(client);
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
      finishFixtureOnboarding(client);
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
      finishFixtureOnboarding(client);
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
      finishFixtureOnboarding(client);
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
        const state = join(dir, 'state');
        mkdirSync(state, {mode: 0o700});
        writeFileSync(join(state, 'settings.json'), JSON.stringify({onboardingCompleted: completedOnboarding}));
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
          env: {HOME: dir, TMPDIR: dir, COSMEW_HOME: state, TERM: 'xterm-256color', NO_COLOR: '1'},
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

test.skipIf(process.platform === 'win32')(
  'Ink transcript parity PTY: SGR expands a bash receipt, search and viewer keys keep process alive',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-transcript-pty-')));
    const server = fixtureServer();
    const app = startup(join(dir, 'state'), {vault: memoryVault()});
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      app.registry.add(server.provider('chat', {id: 'transcript-pty', auth: 'none'}));
      await app.accounts.add('transcript-pty', 'Transcript fixture', {kind: 'none'});
      const client = app.createFutrynClient(dir);
      finishFixtureOnboarding(client);
      await client.discoverModels();
      client.selectModel('fixture-model');
      client.trustWorkspace(); // Skip the trust dialog: a key sent before input is ready is lost and Enter would exit.
      const historyId = app.conversations.create(client.status().selection!);
      app.conversations.append(historyId, {role: 'user', content: 'needle first'}, 'committed');
      app.conversations.append(historyId, {role: 'assistant', content: 'needle second'}, 'committed');
      app.conversations.append(historyId, {role: 'user', content: 'Check a stored tool result'}, 'committed');
      app.conversations.append(
        historyId,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{id: 'stored-bash', name: 'exec_command', input: {cmd: 'echo fixture receipt'}}],
        },
        'committed',
      );
      app.conversations.append(
        historyId,
        {
          role: 'tool',
          toolCallId: 'stored-bash',
          toolName: 'exec_command',
          content: 'PTY_BASH_RECEIPT_LINE',
        },
        'committed',
      );
      let output = '';
      terminal = new Bun.Terminal({
        cols: 100,
        rows: 36,
        data(_t, bytes) {
          output += Buffer.from(bytes).toString('utf8');
        },
      });
      child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), '--resume', historyId], {
        cwd: dir,
        terminal,
        // This scenario asserts literal frame text and default keys. Do not inherit
        // host theme/color overrides, state roots, keybindings, or proxy settings.
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          TMPDIR: dir,
          COSMEW_HOME: join(dir, 'state'),
          FUTRYN_COMMAND_BACKEND: 'none',
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          NO_COLOR: '1',
        },
      });
      const wait = async (text: string, from = 0) => {
        const deadline = Date.now() + 8000;
        while (!output.slice(from).includes(text) && Date.now() < deadline) await Bun.sleep(5);
        expect(
          output.slice(from).includes(text),
          `waiting for ${JSON.stringify(text)}; last screen/output: ${JSON.stringify(output.slice(-8000))}`,
        ).toBe(true);
        expect(child!.exitCode).toBeNull();
      };
      const send = async (text: string) => {
        const from = output.length;
        terminal!.write(text);
        await Bun.sleep(150);
        return from;
      };
      await wait('manual mode on');
      await wait('needle second');
      const summary = 'Ran 1 shell command (click or ctrl+o to expand)';
      const footer = '⏸ manual mode on';
      const summaryRow = () => {
        const lines = stripVTControlCharacters(output).split(/\r?\n/);
        const last = lines.findLastIndex(line => line.trim() === footer);
        if (last < 0) return 0;
        const first = lines.findLastIndex((line, index) => index < last && line.trim() === summary);
        return first >= 0 && last - first < 36 ? 36 - (last - first) : 0;
      };
      const readyBy = Date.now() + 8000;
      while (!summaryRow() && Date.now() < readyBy) await Bun.sleep(10);
      expect(summaryRow(), JSON.stringify(output.slice(-5000))).toBeGreaterThan(0);
      expect(output).not.toContain('PTY_BASH_RECEIPT_LINE');
      let from = await send(`\x1b[<0;3;${summaryRow()}M`);
      const receipt = () =>
        stripVTControlCharacters(output.slice(from))
          .split(/\r?\n/)
          .some(line => line.trim() === '⎿  PTY_BASH_RECEIPT_LINE');
      const clickedBy = Date.now() + 8000;
      while (!receipt() && Date.now() < clickedBy && child.exitCode === null) await Bun.sleep(10);
      expect(receipt(), JSON.stringify(output.slice(-5000))).toBe(true);
      from = await send('\x0f');
      await wait('Showing detailed transcript', from);
      from = await send('/');
      await wait('Search transcript…', from);
      from = await send('needle');
      await wait('1 of 2', from);
      from = await send('n'); // n is text until Enter keeps and closes the bar (B3/B4).
      await wait('needlen', from);
      await wait('no matches', from);
      await send('\x7f');
      await send('\r');
      await wait('n/N to navigate');
      from = await send('n');
      await wait('2 of 2', from);
      from = await send('\x05');
      expect(child.exitCode).toBeNull();
      expect(output.slice(from)).not.toContain('ctrl+e to collapse');
      from = await send('?');
      await wait('move half a page', from);
      await wait('print to scrollback', from);
      from = await send('q');
      await wait('manual mode on', from);
      expect(child.exitCode).toBeNull();
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
  'Ink fresh HOME PTY resumes after theme, skips sign-in, and opens Theme and No sandbox without network',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-onboarding-pty-')));
    const home = join(root, 'home');
    const temp = join(root, 'tmp');
    const workspace = join(root, 'project');
    for (const path of [home, temp, workspace]) mkdirSync(path, {mode: 0o700});
    const state = join(home, '.cosmew');
    const settings = join(state, 'settings.json');
    const requests = join(root, 'network-attempts');
    const preload = join(root, 'record-fetch.ts');
    writeFileSync(
      preload,
      `import {appendFileSync} from 'node:fs';
const fetchLocal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol === 'data:' || url.protocol === 'file:') return fetchLocal(input, init);
  appendFileSync(${JSON.stringify(requests)}, url.origin + '\\n');
  throw new Error('Unexpected network request during onboarding');
};
`,
    );

    let output = '';
    let terminal: Bun.Terminal | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const launch = () => {
      output = '';
      const decoder = new TextDecoder();
      terminal = new Bun.Terminal({
        cols: 100,
        rows: 36,
        data(_terminal, bytes) {
          output += decoder.decode(bytes, {stream: true});
        },
      });
      child = Bun.spawn(
        [
          process.execPath,
          '--config=/dev/null',
          '--no-env-file',
          '--preload',
          preload,
          resolve('apps/cli/src/index.ts'),
        ],
        {
          cwd: workspace,
          terminal,
          env: {
            HOME: home,
            TMPDIR: temp,
            COSMEW_HOME: state,
            BUN_INSTALL_CACHE_DIR: join(temp, 'bun-cache'),
            XDG_CACHE_HOME: join(temp, 'cache'),
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            NO_COLOR: '1',
          },
        },
      );
    };
    const waitForPaint = async (markers: readonly string[], from = 0) => {
      const deadline = Date.now() + 6000;
      let length = -1;
      let stableSince = Date.now();
      while (Date.now() < deadline && child?.exitCode === null) {
        if (length !== output.length) {
          length = output.length;
          stableSince = Date.now();
        }
        const fresh = stripVTControlCharacters(output.slice(from));
        if (markers.every(marker => fresh.includes(marker)) && Date.now() - stableSince >= 65) return;
        await Bun.sleep(10);
      }
      throw new Error(`Waiting for ${markers.join(', ')}. Last PTY bytes: ${JSON.stringify(output.slice(-3500))}`);
    };
    const write = (keys: string) => {
      const from = output.length;
      terminal!.write(keys);
      return from;
    };
    const completed = () => JSON.parse(readFileSync(settings, 'utf8')).onboardingCompleted;
    try {
      expect(existsSync(state)).toBe(false);
      launch();
      await waitForPaint(["Let's get started.", 'To change this later, run /theme', 'Enter to select']);
      const auth = ['Connect · provider', 'Skip for now', 'Enter to select · Esc to close'];
      await waitForPaint(auth, write('\r'));
      expect(completed()).toEqual(['theme']);

      write('\x03');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 4000);
      try {
        expect(await child!.exited).toBe(0);
      } finally {
        clearTimeout(timer);
      }
      terminal!.close();
      launch();

      await waitForPaint(auth);
      expect(output).not.toContain("Let's get started.");
      await waitForPaint(['Security notes:', 'Cosmew can make mistakes.', 'Enter to continue'], write('\r'));
      expect(completed()).toEqual(['theme', 'auth']);
      await waitForPaint(['Accessing workspace:', 'Yes, I trust this folder', 'Enter to confirm'], write('\r'));
      expect(completed()).toEqual(completedOnboarding);
      // The cursor move may repaint only the pointer cell.
      await waitForPaint(['❯'], write('\x1b[A'));
      await waitForPaint(['manual mode on'], write('\r'));

      await waitForPaint(['/config'], write('/config'));
      await waitForPaint(['Settings', 'Search settings…', 'Esc to go back'], write('\r'));
      await waitForPaint(['Theme', '(Enter to choose)', 'Esc to go back'], write('Theme'));
      await waitForPaint(['Workspace', 'Esc to go back'], write('\x1b'));
      await waitForPaint(['manual mode on'], write('\x1b'));
      await waitForPaint(['/sandbox'], write('/sandbox'));
      await waitForPaint(['Sandbox', 'Mode', 'No sandbox (active)', 'Enter to apply · Esc to close'], write('\r'));
      expect(child!.exitCode).toBeNull();
      expect(existsSync(requests) ? readFileSync(requests, 'utf8') : '').toBe('');
    } finally {
      child?.kill('SIGKILL');
      if (child) await child.exited;
      terminal?.close();
      rmSync(root, {recursive: true, force: true});
    }
  },
  30000,
);
