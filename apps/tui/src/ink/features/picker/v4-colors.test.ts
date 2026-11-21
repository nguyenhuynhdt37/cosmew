import {expect, test} from 'bun:test';

test('FORCE_COLOR=3 dialogs and panels use the measured colour roles (spec 9, dark variant)', () => {
  const run = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/v4-colors-fixture.tsx`],
    env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const frames = JSON.parse(new TextDecoder().decode(run.stdout)) as Record<string, string>;
  const fg = (rgb: string) => `\x1b[38;2;${rgb}m`;
  const RULE = '129;162;190';
  const SELECTED = '138;190;183';
  const MUTED = '169;171;174';
  const WARNING = '255;193;7';
  // Trust frame: top rule and "Accessing workspace:" in the warning colour, choices in the selection colour.
  expect(frames.trust).toContain(fg(WARNING) + '─');
  expect(frames.trust).toContain('Accessing workspace:');
  expect(frames.trust).toContain(fg(SELECTED) + '❯ No, exit');
  expect(frames.trust).toContain(fg(MUTED) + 'Security guide');
  expect(frames.trust).toContain(fg(MUTED) + 'Enter to confirm · Esc to cancel');
  // Permission dialog: rule colour title, muted path and rules, selected option, muted footer.
  expect(frames.permission).toContain(fg(RULE) + '─');
  expect(frames.permission).toContain(fg(RULE) + 'Edit file');
  expect(frames.permission).toContain(fg(MUTED) + 'a.txt');
  expect(frames.permission).toContain(fg(MUTED) + '╌');
  expect(frames.permission).toContain(fg(SELECTED) + '❯ ');
  expect(frames.permission).toContain(fg(MUTED) + 'Esc to cancel · Tab to amend');
  // Diff rows carry a tinted background across the line (added 3d423c, removed 7a2936).
  expect(frames.permission).toContain('\x1b[48;2;61;66;60m');
  expect(frames.permission).toContain('\x1b[48;2;122;41;54m');
  // Question: the frame rule is muted (not the rule colour), the chip is reversed in the rule colour.
  expect(frames.question).toContain(fg(MUTED) + '─');
  expect(frames.question).toContain('\x1b[7m');
  expect(frames.question).toContain(fg(MUTED) + '2. Type something.');
  expect(frames.question).toContain(fg(SELECTED) + '❯ ');
  // Panels: ▔ rule and the title in the rule colour; the selected tab is reversed.
  for (const name of ['help', 'settings', 'rewind']) expect(frames[name], name).toContain(fg(RULE) + '▔');
  expect(frames.help).toContain('\x1b[7m');
  expect(frames.help).toContain(fg(MUTED) + '←/→ to switch · Esc to close');
  expect(frames.settings).toContain(fg(SELECTED) + '╭');
  expect(frames.rewind).toContain(fg(MUTED) + 'Enter to continue · Esc to cancel');
});
