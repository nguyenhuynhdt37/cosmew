import {expect, test} from 'bun:test';
import {
  MAX_NATIVE_CLIPBOARD_BYTES,
  MAX_OSC52_CLIPBOARD_BYTES,
  copyToClipboard,
  readClipboardImage,
  readLinuxClipboardImage,
  readMacClipboardImage,
  readWindowsClipboardImage,
  writeLinuxClipboard,
  writeMacClipboard,
  writeWindowsClipboard,
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

test('readLinuxClipboardImage supports Wayland wl-paste and X11 xclip with magic-byte validation', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const webpBytes = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1');

  const waylandCalls: (readonly string[])[] = [];
  const waylandImg = await readLinuxClipboardImage(200, {
    env: {WAYLAND_DISPLAY: 'wayland-0'},
    exists: p => p === '/usr/bin/wl-paste',
    launch: cmd => {
      waylandCalls.push(cmd);
      if (cmd.includes('--list-types')) return processFor('text/plain\nimage/png\nimage/jpeg\n');
      return processFor(pngBytes);
    },
  });
  expect(waylandCalls).toEqual([
    ['/usr/bin/wl-paste', '--list-types'],
    ['/usr/bin/wl-paste', '--no-newline', '--type', 'image/png'],
  ]);
  expect(waylandImg).toEqual({mediaType: 'image/png', data: pngBytes.toString('base64')});

  const x11Calls: (readonly string[])[] = [];
  const x11Img = await readLinuxClipboardImage(200, {
    env: {DISPLAY: ':0'},
    exists: p => p === '/usr/bin/xclip',
    launch: cmd => {
      x11Calls.push(cmd);
      if (cmd.includes('TARGETS')) return processFor('UTF8_STRING\nimage/webp\n');
      return processFor(webpBytes);
    },
  });
  expect(x11Calls).toEqual([
    ['/usr/bin/xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'],
    ['/usr/bin/xclip', '-selection', 'clipboard', '-t', 'image/webp', '-o'],
  ]);
  expect(x11Img).toEqual({mediaType: 'image/webp', data: webpBytes.toString('base64')});

  // Rejects fake non-PNG bytes advertised as image/png
  await expect(
    readLinuxClipboardImage(200, {
      env: {WAYLAND_DISPLAY: 'wayland-0'},
      exists: p => p === '/usr/bin/wl-paste',
      launch: cmd => (cmd.includes('--list-types') ? processFor('image/png\n') : processFor('not a png')),
    }),
  ).rejects.toThrow('does not contain');

  // Reports missing display/tool clearly
  await expect(
    readLinuxClipboardImage(200, {env: {}, exists: () => true, launch: () => processFor('')}),
  ).rejects.toThrow('wl-paste');
});

test('Windows text and image clipboard helpers use fixed PowerShell executable without shell or argv text', async () => {
  const winCmds: (readonly string[])[] = [];
  const written: string[] = [];
  expect(
    await writeWindowsClipboard('hello việt nam', 200, {
      env: {SystemRoot: 'C:\\Windows'},
      exists: p => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      launch: cmd => {
        winCmds.push(cmd);
        return writerFor(written);
      },
    }),
  ).toBe(true);
  expect(winCmds[0]?.[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  expect(winCmds[0]).toContain('-STA');
  expect(winCmds[0]?.join(' ')).not.toContain('hello việt nam');
  expect(written).toEqual(['hello việt nam']);

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const winImg = await readWindowsClipboardImage(200, {
    env: {SystemRoot: 'C:\\Windows'},
    exists: p => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    launch: () => processFor(pngBytes.toString('base64') + '\r\n'),
  });
  expect(winImg).toEqual({mediaType: 'image/png', data: pngBytes.toString('base64')});

  // Dispatcher routes platform=linux / win32 cleanly
  const dispatched = await readClipboardImage({
    platform: 'win32',
    timeoutMs: 200,
    windows: {
      env: {SystemRoot: 'C:\\Windows'},
      exists: p => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      launch: () => processFor(pngBytes.toString('base64')),
    },
  });
  expect(dispatched?.mediaType).toBe('image/png');

  await expect(
    readWindowsClipboardImage(200, {
      env: {SystemRoot: 'C:\\Windows'},
      exists: p => p === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      launch: () => processFor(Buffer.from('fake-data').toString('base64')),
    }),
  ).rejects.toThrow('does not contain');
});
