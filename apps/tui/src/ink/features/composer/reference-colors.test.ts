import {expect, test} from 'bun:test';

const run = (mode: 'light' | 'dark') => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/reference-colors-fixture.tsx`, mode],
    env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, string> & {slash: string; bash: string};
};
const fg = (rgb: string) => `\x1b[38;2;${rgb}m`;
const hex = (value: string) => [1, 3, 5].map(i => Number.parseInt(value.slice(i, i + 2), 16)).join(';');

test('light theme: rules, mode colours, dim text and selection use the measured reference colours (spec 9)', () => {
  const frames = run('light');
  expect(frames.mode).toBe('light');
  // Reference 01-ready: rule 3465a4, effort/footer dim 6e7171.
  expect(frames.idle).toContain(fg(hex('#3465a4')) + '─'.repeat(100));
  expect(frames.idle).toContain(fg(hex('#6e7171')) + '⏸ manual mode on');
  // Reference 05-mode-2 plan: 05727e label, dim hint; 05-mode-1 accept edits: 8e7700 label.
  expect(frames.plan).toContain(fg(hex('#05727e')) + '⏸ plan mode on' + fg(hex('#6e7171')) + ' (shift+tab to cycle)');
  expect(frames.accept).toContain(
    fg(hex('#8e7700')) + '⏵⏵ accept edits on' + fg(hex('#6e7171')) + ' (shift+tab to cycle)',
  );
  // Bash mode paints prompt, both rules and footer in one colour that is not the rule or dim colour.
  const bash = /\x1b\[38;2;(\d+;\d+;\d+)m! for shell mode/.exec(frames.bash)?.[1];
  expect(bash).toBeDefined();
  expect(bash).not.toBe(hex('#3465a4'));
  expect(bash).not.toBe(hex('#6e7171'));
  expect(frames.bash).toContain(fg(bash!) + '─'.repeat(100));
  expect(frames.bash).toContain(fg(bash!) + '! ');
  expect(frames.bash).not.toContain(fg(hex('#3465a4')) + '─');
  // Reference 03-slash: the selected row is accent, the rest dim.
  const all = frames.slash.split('\n');
  const rows = all
    .slice(
      0,
      all.findIndex(line => line.includes('─')),
    )
    .filter(line => /^\s*(?:\S\s)?\/\w/.test(line.replace(/\x1b\[[0-9;]*m/g, '')));
  expect(rows.length).toBeGreaterThan(1);
  expect(rows[0]).toContain(fg(hex('#05727e')));
  expect(rows.slice(1).every(row => !row.includes(fg(hex('#05727e'))) && row.includes(fg(hex('#6e7171'))))).toBe(true);
  // Running (live L05): the prompt marker is dim.
  expect(frames.busy).toContain(fg(hex('#6e7171')) + '❯ ');
});

test('dark theme uses the dark measurements for rule, dim and selection', () => {
  const frames = run('dark');
  expect(frames.mode).toBe('dark');
  expect(frames.idle).toContain(fg(hex('#81a2be')) + '─'.repeat(100));
  expect(frames.idle).toContain(fg(hex('#a9abae')) + '⏸ manual mode on');
  expect(frames.plan).toContain(fg(hex('#8abeb7')) + '⏸ plan mode on');
});
