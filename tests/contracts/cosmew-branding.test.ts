import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = join(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('active project documentation and CLI help use Cosmew as the product name', () => {
  expect(read('README.md')).toMatch(/^# Cosmew CLI/m);
  expect(read('CLAUDE.md')).toContain('Cosmew');
  expect(read('AGENTS.md')).toContain('Cosmew');
  expect(read('docs/README.md')).toContain('Cosmew');
  expect(read('apps/cli/src/index.ts')).toContain('Cosmew (cosmew)');
  expect(read('apps/tui/src/ink/features/header/index.tsx')).toContain('COSMEW');
});

test('rename ADR documents the canonical name and compatibility boundary', () => {
  const adr = read('docs/adr/0076-cosmew-project-rename.md');
  expect(adr).toContain('Cosmew');
  expect(adr).toContain('1.40');
  expect(adr).toContain('~/.cosmew');
  expect(adr).toContain('FUTRYN_HOME');
});
