import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Canvas} from '@futryn/tui';
import {computeWorkspaceGitDiff} from '../../apps/cli/src/bootstrap/startup';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

test('workspace diff strips escape sequences from untrusted file contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'futryn-inject-'));
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {cwd: dir});
  git('init', '-q');
  writeFileSync(join(dir, 'evil.txt'), 'safe\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // OSC 52 clipboard write, window-title change and a BEL, as a hostile repository could contain.
  writeFileSync(join(dir, 'evil.txt'), 'safe\n\x1b]52;c;cHduZWQ=\x07\x1b]0;owned\x07\x9b31mred\r\n');
  const report = computeWorkspaceGitDiff(dir);
  expect(report.files.length).toBe(1);
  for (const file of report.files) {
    expect(CONTROL.test(file.path)).toBe(false);
    for (const line of file.lines) expect(CONTROL.test(line.content)).toBe(false);
  }
  expect(report.files[0]!.lines.some(line => line.content.includes('owned'))).toBe(true); // text kept, bytes removed
});

test('the canvas never stores control characters, whatever the source of a span', () => {
  const canvas = new Canvas(20, 1, '#fff', '#000');
  canvas.spans(0, 0, [{text: 'a\x1b[2Jb\x07c\td\x9be', fg: '#fff'}]);
  const row = canvas.cells[0]!.map(cell => cell.ch).join('');
  expect(CONTROL.test(row)).toBe(false);
  expect(row.startsWith('a [2Jb c d e')).toBe(true); // width preserved: one cell per input character
});
