import {expect, test} from 'bun:test';
import type {ThemeTokens} from '@cosmew/contracts';
import {mixHex} from '../../../theme/presets';
import {bgHex, fgHex} from '../../../theme/theme';

function capture(theme: string, forceColor = '3') {
  const run = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/colors-fixture.tsx`, theme],
    env: {...process.env, FORCE_COLOR: forceColor, NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return JSON.parse(run.stdout.toString()) as {tokens: ThemeTokens; frame: string; plain: string};
}

for (const mode of ['dark', 'light'] as const) {
  test(`${mode} diff file rows distinguish directory, filename, status, stats and selection`, () => {
    const {tokens: t, frame} = capture(mode);
    const [selected, added, deleted, renamed, untracked, group] = frame.split('\n');
    expect(selected).toContain(bgHex(mixHex(t.selection, t.info, 0.18)));
    expect(selected).toContain(fgHex(t.info) + '❯ ');
    expect(selected).toContain(fgHex(t.warning) + 'M ');
    expect(selected).toContain(fgHex(t.foregroundSubtle) + 'src/');
    expect(selected).toContain('\x1b[1m' + fgHex(t.foreground) + 'example.ts');
    expect(selected).toContain(fgHex(t.diffAdded) + '+2');
    expect(selected).toContain(fgHex(t.diffRemoved) + '-1');
    expect(added).toContain(fgHex(t.diffAdded) + 'A ');
    expect(deleted).toContain(fgHex(t.diffRemoved) + 'D ');
    for (const [row, marker] of [
      [renamed, 'R '],
      [untracked, '? '],
    ] as const) {
      expect(row).toContain(fgHex(t.info) + '\x1b[2m' + marker);
    }
    expect(group).toContain('\x1b[3m' + fgHex(t.foregroundSubtle) + '▾ 14 tests/generated (hide) · t');
  });

  test(`${mode} diff body uses dim gutters, tinted changes and optional syntax`, () => {
    const {tokens: t, frame, plain} = capture(mode);
    const [hunk, removed, added, context] = frame.split('\n').slice(6);
    const weight = mode === 'light' ? 0.12 : 0.16;
    expect(hunk).toContain(fgHex(mixHex(t.syntaxFunction, t.diffAdded, 0.25)) + '\x1b[2m@@ -1,2 +1,2 @@');
    for (const [row, change, sign] of [
      [removed, t.diffRemoved, '-'],
      [added, t.diffAdded, '+'],
    ] as const) {
      const tint = bgHex(mixHex(t.backgroundPanel, change, weight));
      expect(row).toContain(tint + fgHex(t.foregroundSubtle) + ' 1 ' + fgHex(change) + sign);
      expect(row).not.toContain(bgHex(change));
      expect(row).toContain(fgHex(t.syntaxKeyword) + 'const');
    }
    expect(added).toContain(fgHex(t.foreground) + ' next = ');
    expect(added).toContain(fgHex(t.syntaxString) + '"new"');
    expect(context).toContain(fgHex(t.diffContext) + ' 2  context');
    expect(plain).not.toContain(fgHex(t.syntaxKeyword) + 'const');
    expect(plain).toContain(fgHex(t.foreground) + 'const next = "new";');
  });
}

test('daltonized and ANSI themes preserve distinct change markers', () => {
  const {tokens, frame} = capture('dark-daltonized');
  expect(frame).toContain(fgHex(tokens.diffAdded) + 'A ');
  expect(frame).toContain(fgHex(tokens.diffRemoved) + 'D ');
  const [selected, added, removed] = capture('dark-ansi', '1').frame.split('\n');
  expect(selected).toContain('\x1b[7m');
  expect(selected!.indexOf('\x1b[27m')).toBeGreaterThan(selected!.indexOf('-1'));
  const markerStyle = (line: string | undefined, marker: string) => {
    const before = line?.split(marker)[0];
    return before?.match(/\x1b\[(?:3[0-7]|9[0-7])m/g)?.at(-1);
  };
  expect(markerStyle(added, 'A ')).toBeTruthy();
  expect(markerStyle(removed, 'D ')).toBeTruthy();
  expect(markerStyle(added, 'A ')).not.toBe(markerStyle(removed, 'D '));
});
