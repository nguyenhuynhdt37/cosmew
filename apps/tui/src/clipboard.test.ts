import {expect, test} from 'bun:test';
import {readMacClipboardImage} from './clipboard';
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
