/** @jsxImportSource react */
import {expect, test} from 'bun:test';
import {Text} from 'ink';
import {ThemeEngine, ansiCacheSize, fgHex} from '../../theme/theme';
import {renderInk} from '../testing';
import {useUiTheme} from '../ui';
import {ThemePreviewScope, themeView, useTheme} from '.';

function Probe({label}: {label: string}) {
  const theme = useTheme();
  const ui = useUiTheme();
  return <Text>{`${label}:${theme.manifest.id}:${theme.tokens.background}:${ui.mode}`}</Text>;
}

test('themeView returns the same object for the same inputs', () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  const manifest = engine.getTheme('github-dark-dimmed')!;
  const first = themeView(engine, manifest, 'dark');
  expect(themeView(engine, manifest, 'dark')).toBe(first);
  expect(themeView(engine, manifest, 'light')).not.toBe(first);
  expect(first.tokens.background).toBe(manifest.dark.background);
});

test('a preview scope themes only its children and never touches the engine', async () => {
  const engine = new ThemeEngine({env: {FORCE_COLOR: '3'}, systemDarkPreference: true});
  await engine.setTheme('github-dark');
  let notified = 0;
  engine.subscribe(() => notified++);
  const view = renderInk(
    <>
      <Probe label="outside" />
      <ThemePreviewScope themeId="github-light">
        <Probe label="inside" />
      </ThemePreviewScope>
    </>,
    {themeEngine: engine},
  );
  const frame = view.lastFrame() ?? '';
  expect(frame).toContain('outside:github-dark:#0d1117:dark');
  expect(frame).toContain('inside:github-light:#ffffff:light');
  expect(engine.isPreviewing()).toBe(false);
  expect(notified).toBe(0);
});

test('ANSI escape codes are cached per capability and colour', () => {
  const before = ansiCacheSize();
  const first = fgHex('#0a0b0c', '256');
  expect(ansiCacheSize()).toBe(before + 1);
  expect(fgHex('#0a0b0c', '256')).toBe(first);
  expect(ansiCacheSize()).toBe(before + 1);
});
