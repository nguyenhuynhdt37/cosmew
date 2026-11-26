import {expect, test} from 'bun:test';
import {
  MAX_NATIVE_CLIPBOARD_BYTES,
  MAX_OSC52_CLIPBOARD_BYTES,
  copyToClipboard,
  readMacClipboardImage,
  writeLinuxClipboard,
  writeMacClipboard,
} from './clipboard';
const encoder = new TextEncoder();
const processFor = (output: string | Uint8Array, exitCode = 0) => ({
  stdout: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(typeof output === 'string' ? encoder.encode(output) : output);
      controller.close();
    },
  }),
  exited: Promise.resolve(exitCode),
  kill() {},
});
const writerFor = (captured: string[], exitCode = 0) => ({
  stdin: {
    write(text: string) {
      captured.push(text);
    },
    end() {},
  },
  exited: Promise.resolve(exitCode),
  kill() {},
});

test('image clipboard bridge parses only PNG data, bounds output, and rejects process errors', async () => {
  expect(await readMacClipboardImage(100, () => processFor('«data PNGf89504E47»\n'))).toEqual({
    mediaType: 'image/png',
    data: 'iVBORw==',
  });
  for (const output of ['plain text', '«data PNGfABC»', '«data JPEG89504E47»'])
    await expect(readMacClipboardImage(100, () => processFor(output))).rejects.toThrow('does not contain');
  await expect(readMacClipboardImage(100, () => processFor('«data PNGf89504E47»', 1))).rejects.toThrow(
    'does not contain',
  );
  await expect(readMacClipboardImage(100, () => processFor(new Uint8Array(40 * 1024 * 1024 + 257)))).rejects.toThrow(
    'exceeds',
  );
});
test('image clipboard deadline kills a hung reader', async () => {
  let killed = 0;
  await expect(
    readMacClipboardImage(5, () => ({
      stdout: new ReadableStream<Uint8Array>(),
      exited: new Promise<number>(() => {}),
      kill() {
        killed++;
      },
    })),
  ).rejects.toThrow('timed out');
  expect(killed).toBeGreaterThan(0);
});

test('writeMacClipboard accepts payloads above 64 KiB up to 4 MiB and rejects oversized text', async () => {
  const written: string[] = [];
  const large = 'x'.repeat(200 * 1024);
  expect(await writeMacClipboard(large, () => writerFor(written))).toBe(true);
  expect(written).toEqual([large]);

  const atLimit = 'y'.repeat(MAX_NATIVE_CLIPBOARD_BYTES);
  const limitWritten: string[] = [];
  expect(await writeMacClipboard(atLimit, () => writerFor(limitWritten))).toBe(true);
  expect(limitWritten).toHaveLength(1);

  let spawned = 0;
  expect(
    await writeMacClipboard('z'.repeat(MAX_NATIVE_CLIPBOARD_BYTES + 1), () => {
      spawned++;
      return writerFor([]);
    }),
  ).toBe(false);
  expect(await writeMacClipboard('', () => writerFor([]))).toBe(false);
  expect(spawned).toBe(0);
});

test('writeLinuxClipboard uses fixed absolute Wayland and X11 binaries without a shell', async () => {
  const waylandCmds: (readonly string[])[] = [];
  const waylandText: string[] = [];
  expect(
    await writeLinuxClipboard('hello wayland', 100, {
      env: {WAYLAND_DISPLAY: 'wayland-0'},
      exists: path => path === '/usr/bin/wl-copy',
      launch: cmd => {
        waylandCmds.push(cmd);
        return writerFor(waylandText);
      },
    }),
  ).toBe(true);
  expect(waylandCmds).toEqual([['/usr/bin/wl-copy']]);
  expect(waylandText).toEqual(['hello wayland']);

  const x11Cmds: (readonly string[])[] = [];
  const x11Text: string[] = [];
  expect(
    await writeLinuxClipboard('hello x11', 100, {
      env: {DISPLAY: ':0'},
      exists: path => path === '/usr/bin/xclip' || path === '/usr/bin/xsel',
      launch: cmd => {
        x11Cmds.push(cmd);
        return writerFor(x11Text, cmd[0] === '/usr/bin/xclip' ? 1 : 0);
      },
    }),
  ).toBe(true);
  expect(x11Cmds).toEqual([
    ['/usr/bin/xclip', '-selection', 'clipboard'],
    ['/usr/bin/xsel', '--clipboard', '--input'],
  ]);
  expect(x11Text).toEqual(['hello x11', 'hello x11']);

  expect(
    await writeLinuxClipboard('no display', 100, {
      env: {},
      exists: () => true,
      launch: () => writerFor([]),
    }),
  ).toBe(false);
});

test('copyToClipboard copies > 64 KiB via native writer, rejects > 4 MiB, and falls back to OSC 52 only within 64 KiB', async () => {
  const large = 'a'.repeat(200 * 1024);
  const nativeSeen: string[] = [];
  const terminalSeen: string[] = [];
  const oldSshConnection = process.env.SSH_CONNECTION;
  const oldSshTty = process.env.SSH_TTY;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  try {
    expect(
      await copyToClipboard(large, {
        native: async text => {
          nativeSeen.push(text);
          return true;
        },
        terminal: sequence => terminalSeen.push(sequence),
      }),
    ).toBe(true);
    expect(nativeSeen).toEqual([large]);
    expect(terminalSeen).toEqual([]);
  } finally {
    if (oldSshConnection !== undefined) process.env.SSH_CONNECTION = oldSshConnection;
    if (oldSshTty !== undefined) process.env.SSH_TTY = oldSshTty;
  }

  // Rejects payloads > 4 MiB even when native writer and terminal callback are supplied.
  let nativeCalls = 0;
  const oversizedTerminal: string[] = [];
  expect(
    await copyToClipboard('b'.repeat(MAX_NATIVE_CLIPBOARD_BYTES + 1), {
      native: async () => {
        nativeCalls++;
        return true;
      },
      terminal: sequence => oversizedTerminal.push(sequence),
    }),
  ).toBe(false);
  expect(nativeCalls).toBe(0);
  expect(oversizedTerminal).toEqual([]);

  // Falls back to OSC 52 when <= 64 KiB and native writer returns false.
  const osc52: string[] = [];
  expect(
    await copyToClipboard('small text', {
      native: async () => false,
      terminal: sequence => osc52.push(sequence),
    }),
  ).toBe(true);
  expect(osc52).toEqual([`\x1b]52;c;${Buffer.from('small text').toString('base64')}\x07`]);

  // Refuses OSC 52 fallback when payload exceeds 64 KiB without an active native writer.
  const rejectedOsc52: string[] = [];
  expect(
    await copyToClipboard('c'.repeat(MAX_OSC52_CLIPBOARD_BYTES + 1), {
      native: async () => false,
      terminal: sequence => rejectedOsc52.push(sequence),
    }),
  ).toBe(false);
  expect(
    await copyToClipboard('c'.repeat(MAX_OSC52_CLIPBOARD_BYTES + 1), {
      platform: 'win32',
      terminal: sequence => rejectedOsc52.push(sequence),
    }),
  ).toBe(false);
  expect(rejectedOsc52).toEqual([]);
});
