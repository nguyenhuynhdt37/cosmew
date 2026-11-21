import {expect, test} from 'bun:test';
import {TerminalStringFilter} from './terminal-input';

for (const sequence of [
  '\x1b]11;rgb:ffff/ffff/ffff\x07',
  '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
  '\x1bPpayload\x1b\\',
  '\x1b_payload\x1b\\',
]) {
  test(`terminal string ${JSON.stringify(sequence)} is ignored at every chunk boundary`, () => {
    for (let split = 0; split <= sequence.length; split++) {
      const filter = new TerminalStringFilter();
      expect(filter.feed('a' + sequence.slice(0, split)) + filter.feed(sequence.slice(split) + 'b')).toBe('ab');
    }
  });
}
test('startup parser preserves ordinary keys, BEL, standalone ST and flushes a trailing Escape', () => {
  const filter = new TerminalStringFilter();
  const keys = 'a\x07\x1b[A\x1bx\x1b\\';
  expect(filter.feed(keys + '\x1b') + filter.flushEscape()).toBe(keys + '\x1b');
});
test('startup parser swallows orphaned ST only after a swallowed string', () => {
  const filter = new TerminalStringFilter();
  expect(filter.feed('\x1b]reply\x07\x1b\\')).toBe('');
  expect(filter.feed('x\x1b\\')).toBe('x\x1b\\');
});
