/** @jsxImportSource react */
import {expect, jest, test} from 'bun:test';
import {render} from 'ink-testing-library';
import {useTextInput} from '../ink/hooks/input-scope';

test('Escape followed by Ctrl+G reaches the key handler without an input-filter delay', async () => {
  const keys: string[] = [];
  function Probe() {
    useTextInput((input, key) => {
      keys.push(key.escape ? 'Escape' : key.ctrl && input === 'g' ? 'Ctrl+G' : input);
    });
    return null;
  }
  const view = render(<Probe />);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    jest.useFakeTimers();
    view.stdin.write('\x1b');
    // Ink itself disambiguates Escape for 20 ms; there must be no extra 25 ms filter timer.
    jest.advanceTimersByTime(20);
    expect(keys).toEqual(['Escape']);
    view.stdin.write('\x07');
    expect(keys).toEqual(['Escape', 'Ctrl+G']);
    view.stdin.write('\x1b');
    jest.advanceTimersByTime(20);
    view.stdin.write('x');
    view.stdin.write('\x1b[A');
    expect(keys.slice(2)).toEqual(['Escape', 'x', '']);
  } finally {
    jest.useRealTimers();
    view.unmount();
    view.cleanup();
  }
});
