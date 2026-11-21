import {expect, test} from 'bun:test';

test('FORCE_COLOR=3 frames carry semantic foregrounds and diff/prompt backgrounds', () => {
  const run = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/phase-f-color-fixture.tsx`],
    env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const frames = JSON.parse(new TextDecoder().decode(run.stdout)) as Record<string, string>;
  const fg = (rgb: string) => `\x1b[38;2;${rgb}m`;
  const bg = (rgb: string) => `\x1b[48;2;${rgb}m`;
  // Brand colour on the logo glyph; measured spinner (rule) and selection colours elsewhere (spec 9).
  expect(frames.welcome).toContain(fg('215;163;141') + ' █▄   ▄█');
  expect(frames.activity).toContain(fg('129;162;190'));
  expect(frames.picker).toContain(fg('138;190;183'));
  expect(frames.welcome).toContain(fg('169;171;174'));
  for (const rgb of ['167;201;171', '216;167;175', '223;194;144']) expect(frames.activity).toContain(fg(rgb));
  // Accept edits uses the warning token; plan mode the selection colour; bypass the error colour.
  for (const rgb of ['223;194;144', '138;190;183', '216;167;175']) expect(frames.modes).toContain(fg(rgb));
  // The title is the rule colour (not the path colour).
  expect(frames.permission).toContain('\x1b[1m' + fg('129;162;190') + 'Read file');
  expect(frames.permission).toContain(fg('129;162;190') + '─');
  expect(frames.diff).toContain(bg('58;64;59'));
  expect(frames.diff).toContain(bg('66;59;60'));
  expect(frames.user).toContain(bg('53;57;64'));
});
