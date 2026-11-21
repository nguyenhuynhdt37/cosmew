/** @jsxImportSource react */
import {expect, test} from 'bun:test';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Box, renderToString} from 'ink';
import {renderInk, waitForFrame} from './index';
import {COSMEW_MASCOT_FRAMES} from '../../theme/cosmew-mascot';
import {ThemeEngine} from '../../theme/theme';
import {Header} from '../features/header';
import {Welcome} from '../features/welcome';
import {ThemeProvider} from '../theme';
import {createClientFixture} from './client-fixture';

const status = {
  ...createClientFixture().client.status(),
  workspace: '/Users/test/a-long-workspace/日本語',
};

for (const width of [24, 80]) {
  for (const screen of ['welcome', 'header'] as const) {
    test(`${screen} reduced-motion golden at ${width} columns`, async () => {
      const engine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
      await engine.updateAnimation({reducedMotion: true});
      const tree = (
        <ThemeProvider engine={engine}>
          {screen === 'welcome' ? (
            <Welcome status={status} width={width} />
          ) : (
            <Header status={status} version="0.1.0" width={width} stateLabel="ready" />
          )}
        </ThemeProvider>
      );
      const actual = renderToString(tree, {columns: width}) + '\n';
      const name = `${screen}-${width}.txt`;
      const path = join(import.meta.dir, 'golden-ink', name);
      writeFileSync(join('/tmp', `cosmew-candidate-${name}`), actual);
      const rows = actual.trimEnd().split('\n');
      expect(rows).toHaveLength(width === 80 ? 4 : 3);
      expect(rows.every(row => Bun.stringWidth(row) <= width)).toBe(true);
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, actual);
      expect(actual).toBe(readGolden(path));
    });
  }
}

function readGolden(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

test('the visible mascot returns to the same frame when Reduce motion is enabled live', async () => {
  const themeEngine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  await themeEngine.updateAnimation({enabled: true, reducedMotion: false});
  const width = 80;
  const view = renderInk(
    <Box flexDirection="column">
      <Welcome status={status} width={width} />
      <Header status={status} version="0.1.0" width={width} />
    </Box>,
    {themeEngine},
  );
  const resting = COSMEW_MASCOT_FRAMES[0][2].trim();
  const moving = COSMEW_MASCOT_FRAMES[1][2].trim();
  try {
    await waitForFrame(view, frame => frame.includes(moving));
    await themeEngine.updateAnimation({reducedMotion: true});
    await waitForFrame(view, frame => frame.split(resting).length === 3 && !frame.includes(moving));
  } finally {
    view.unmount();
  }
});
