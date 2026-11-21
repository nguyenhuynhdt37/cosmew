import {afterAll, describe, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {locateWriteTarget, WorkspaceDenied, WorkspaceRoot} from '@cosmew/workspace';

const scratch = mkdtempSync(join(tmpdir(), 'futryn-roots-'));
const project = realpathSync(mkdtempSync(join(scratch, 'project-')));
const granted = realpathSync(mkdtempSync(join(scratch, 'granted-')));
const third = realpathSync(mkdtempSync(join(scratch, 'third-')));

writeFileSync(join(project, 'notes.md'), 'project\n');
writeFileSync(join(granted, 'only-here.txt'), 'granted-marker\n');
writeFileSync(join(third, 'nope.txt'), 'nope\n');
mkdirSync(join(granted, '.git'));
writeFileSync(join(granted, '.git', 'config'), 'git\n');
symlinkSync(join(granted, 'only-here.txt'), join(project, 'via-grant'));
symlinkSync(join(third, 'nope.txt'), join(project, 'via-out'));

const workspace = new WorkspaceRoot(project);

describe('working directories', () => {
  test('project-relative paths stay on the project', () => {
    const file = workspace.resolve('notes.md', [granted]);
    expect(file.root).toBe(project);
    expect(file.relative).toBe('notes.md');
    const located = locateWriteTarget(workspace, 'notes.md', [granted]);
    expect(located).toEqual({
      base: project,
      relative: 'notes.md',
      key: 'notes.md',
      absolute: join(project, 'notes.md'),
    });
  });

  test('a granted directory is readable and writable by absolute path', () => {
    const file = workspace.resolve(join(granted, 'only-here.txt'), [granted]);
    expect(file.root).toBe(granted);
    expect(file.absolute).toBe(realpathSync(join(granted, 'only-here.txt')));
    expect(file.relative).toBe(file.absolute);
    const located = locateWriteTarget(workspace, join(granted, 'fresh.txt'), [granted]);
    expect(located.base).toBe(granted);
    expect(located.relative).toBe('fresh.txt');
    expect(located.key).toBe(join(granted, 'fresh.txt'));
    expect(located.absolute).toBe(located.key);
  });

  test('a relative path that lands in a granted directory resolves there', () => {
    const file = workspace.resolve(relative(project, join(granted, 'only-here.txt')), [granted]);
    expect(file.root).toBe(granted);
    expect(file.relative).toBe(realpathSync(join(granted, 'only-here.txt')));
  });

  test('a third directory is refused, and a project symlink into it is refused', () => {
    expect(() => workspace.resolve(join(third, 'nope.txt'), [granted])).toThrow(WorkspaceDenied);
    expect(() => workspace.resolve('via-out', [granted])).toThrow(WorkspaceDenied);
    expect(() => locateWriteTarget(workspace, join(third, 'new.txt'), [granted])).toThrow(WorkspaceDenied);
  });

  test('a project symlink into a granted directory resolves to that file', () => {
    const file = workspace.resolve('via-grant', [granted]);
    expect(file.root).toBe(granted);
    expect(file.absolute).toBe(realpathSync(join(granted, 'only-here.txt')));
    expect(() => workspace.resolve('via-grant')).toThrow(WorkspaceDenied);
  });

  test('without a grant, the extra directory stays outside the project', () => {
    expect(() => workspace.resolve(join(granted, 'only-here.txt'))).toThrow(WorkspaceDenied);
  });
});

afterAll(() => {
  rmSync(scratch, {recursive: true, force: true});
});
