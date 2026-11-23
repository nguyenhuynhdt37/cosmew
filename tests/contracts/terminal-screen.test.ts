import {expect, test} from 'bun:test';
import {TerminalScreen} from '../fixtures/terminal-screen';

test('PTY screen reconstructs split CSI and UTF-8 updates instead of concatenating repaint history', () => {
  const screen = new TerminalScreen(30, 3);
  const write = (value: string) => screen.write(Buffer.from(value));
  write('\x1b[?1049hBODY_file-06\r\n❯ draft');
  write('\x1b[1A\x1b[12');
  write('G\x1b[K9');
  expect(screen.text()).toBe('BODY_file-09\n❯ draft');
  write('\x1b[E\x1b[8G-one');
  expect(screen.text()).toContain('❯ draft-one');
  const bytes = Buffer.from('é');
  screen.write(bytes.subarray(0, 1));
  screen.write(bytes.subarray(1));
  expect(screen.text()).toContain('draft-oneé');
});

test('PTY screen clears erased rows and bounds scrollback and resize state', () => {
  const screen = new TerminalScreen(20, 2);
  screen.write(Buffer.from('old\r\nnew\r\nlast'));
  expect(screen.text()).toBe('new\nlast');
  screen.write(Buffer.from('\x1b[1G\x1b[2Kfresh'));
  expect(screen.text()).toBe('new\nfresh');
  screen.resize(10, 1);
  screen.write(Buffer.from('resized'));
  expect(screen.text()).toBe('resized');
});
