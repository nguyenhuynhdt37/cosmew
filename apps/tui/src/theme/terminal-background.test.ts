import {expect, test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {parseOsc11, queryTerminalBackground} from './terminal-background';

for (const end of ['\x07', '\x1b\\']) {
  test(`OSC 11 requires the complete ${JSON.stringify(end)} terminator`, () => {
    const body = '\x1b]11;rgb:ffff/ffff/ffff';
    expect(parseOsc11(body)).toBeUndefined();
    expect(parseOsc11(body + '\x1b')).toBeUndefined();
    expect(parseOsc11(body + end)).toEqual([255, 255, 255]);
    expect(parseOsc11('\x1b]11;#123456' + end)).toEqual([18, 52, 86]);
    expect(parseOsc11(body + 'f' + end)).toBeUndefined();
  });
  test(`query consumes split ${JSON.stringify(end)} and drains late replies`, async () => {
    const stdin = Object.assign(new PassThrough(), {isTTY: true, isRaw: false, setRawMode() {}});
    const stdout = Object.assign(new PassThrough(), {isTTY: true});
    const pending = queryTerminalBackground({stdin, stdout}, 20);
    stdin.write('\x1b]11;rgb:ffff/ffff/ffff');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    stdin.write(end);
    // Replies during the grace period are drained before the query hands stdin to Ink.
    stdin.write('\x1b]11;rgb:0000/0000/0000' + end);
    expect(await pending).toEqual([255, 255, 255]);
    expect(stdin.read()).toBeNull();
    stdin.destroy();
  });
  test(`timeout drains a late split ${JSON.stringify(end)} reply`, async () => {
    const stdin = Object.assign(new PassThrough(), {isTTY: true, isRaw: false, setRawMode() {}});
    const stdout = Object.assign(new PassThrough(), {isTTY: true});
    const pending = queryTerminalBackground({stdin, stdout}, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    stdin.write('\x1b]11;rgb:ffff/ffff/ffff');
    for (const part of end) {
      stdin.write(part);
    }
    stdin.write('x');
    expect(await pending).toBeUndefined();
    expect(stdin.read()?.toString()).toBe('x');
    stdin.destroy();
  });
}

test('a reply begun before timeout stays suppressed through a split ST after timeout', async () => {
  const stdin = Object.assign(new PassThrough(), {isTTY: true, isRaw: false, setRawMode() {}});
  const stdout = Object.assign(new PassThrough(), {isTTY: true});
  const pending = queryTerminalBackground({stdin, stdout}, 10);
  stdin.write('\x1b]11;rgb:ffff/ffff/ffff\x1b');
  await new Promise(resolve => setTimeout(resolve, 20));
  stdin.write('\\');
  stdin.write('y');
  expect(await pending).toBeUndefined();
  expect(stdin.read()?.toString()).toBe('y');
  stdin.destroy();
});

test('startup drain restores the original reader and preserves Escape, Ctrl+G and ordinary input', async () => {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      raw.push(mode);
    },
  });
  const stdout = Object.assign(new PassThrough(), {isTTY: true});
  const read = stdin.read;
  const pending = queryTerminalBackground({stdin, stdout}, 1);
  const keys = '\x07\x1bx\x1b[A\x1b';
  stdin.write(keys);
  expect(await pending).toBeUndefined();
  expect(stdin.read).toBe(read);
  expect(stdin.listenerCount('readable')).toBe(0);
  expect(raw).toEqual([true, false]);
  expect(stdin.read()?.toString()).toBe(keys);
  // After the handoff, every byte is immediately available through the original reader.
  stdin.write('\x1b');
  expect(stdin.read()?.toString()).toBe('\x1b');
  stdin.write('\x07');
  expect(stdin.read()?.toString()).toBe('\x07');
  stdin.destroy();
});
