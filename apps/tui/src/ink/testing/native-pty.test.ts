import {expect, test} from 'bun:test';
import {resolve} from 'node:path';
import {settle, trackFrames, waitForFrame} from './wait';

test.skipIf(process.platform === 'win32')(
  'synthetic native PTY: replay, consent, permission, tasks, resize and confirmed exit in the alternate screen',
  async () => {
    let output = '';
    const frames: string[] = [];
    const outputView = trackFrames({lastFrame: () => output, frames});
    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(_terminal, bytes) {
        const chunk = Buffer.from(bytes).toString('utf8');
        frames.push(chunk);
        output += chunk;
      },
    });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'native-fixture.ts')], {
      terminal,
      env: {...process.env, NO_COLOR: '1'},
    });
    const plain = () => outputView.lastFrame().replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    const wait = async (text: string, from = 0) => {
      const frame = await waitForFrame({lastFrame: () => plain().slice(from)}, value => value.includes(text), 4000);
      expect(frame, `waiting for ${text}`).toContain(text);
    };
    const send = async (keys: string) => {
      terminal.write(keys);
      await settle(0, 2000, {quietMs: 45});
    };
    try {
      await wait('Accessing workspace:');
      await wait('NATIVE_INPUT_READY');
      await settle(0, 2000, {quietMs: 45}); // Wait for raw input effects after the first paint.
      await send('\x1b[A');
      await send('\r');
      await wait('manual mode on');
      await wait('Read 1 file'); // replayed history merges tool calls into one summary line
      expect(output).toContain('\x1b[?1000h\x1b[?1006h');
      await send('\x1b[<64;20;10M'.repeat(10));
      await wait('Jump to bottom');
      await send('\x1b[<65;20;10M'.repeat(10));
      await send('\x0f');
      await wait('Showing detailed transcript');
      const scrollbackStart = output.length;
      await send('[');
      await wait('Conversation written to the terminal scrollback.');
      const dump = output.slice(scrollbackStart);
      const native = dump.indexOf('> SYNTHETIC_HISTORY_ONCE');
      expect(native, dump).toBeGreaterThanOrEqual(0);
      expect(dump.indexOf('\x1b[?1049l')).toBeLessThan(native);
      expect(dump.lastIndexOf('\x1b[?1049h')).toBeGreaterThan(native);
      expect(dump.indexOf('\x1b[?1006l\x1b[?1000l')).toBeLessThan(native);
      expect(dump.lastIndexOf('\x1b[?1000h\x1b[?1006h')).toBeGreaterThan(native);
      await send('q');
      await send('inspect');
      await send('\r');
      await wait('3. No');
      await send('2');
      await wait('NATIVE_STREAM_READY');
      await wait('NATIVE_LIVE_TODO');
      const hiddenFrom = plain().length;
      await send('\x14');
      terminal.resize(36, 24);
      await send('narrow draft');
      await wait('narrow draft', hiddenFrom);
      expect(plain().slice(hiddenFrom)).not.toContain('NATIVE_LIVE_TODO');
      const shownFrom = plain().length;
      await send('\x14');
      await wait('NATIVE_LIVE_TODO', shownFrom);
      await send('\x1b'); // cancel the synthetic stream
      await send('\x03'); // text in the prompt: Ctrl+C clears it
      await wait('ctrl+y to paste deleted text');
      await send('\x03');
      await wait('Press Ctrl-C again to exit');
      expect(child.exitCode).toBeNull();
      await send('\x03');
      expect(await child.exited).toBe(0);
      expect(plain()).toContain('Resume this session with: fyn --resume synthetic-resume');
      // Fullscreen repaints the viewport, so history is not written once; the alternate screen frames the run.
      expect(output).toContain('\x1b[?1049h');
      expect(output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(output.indexOf('\x1b[?1049h'));
      expect(output.lastIndexOf('\x1b[?1049l')).toBeLessThan(output.indexOf('Resume this session with'));
      expect(output.lastIndexOf('\x1b[?1006l\x1b[?1000l')).toBeGreaterThan(
        output.lastIndexOf('\x1b[?1000h\x1b[?1006h'),
      );
      expect(output.lastIndexOf('\x1b[?1006l\x1b[?1000l')).toBeLessThan(output.indexOf('Resume this session with'));
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      terminal.close();
    }
  },
  15000,
);
