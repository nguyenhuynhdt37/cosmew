import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {CONTRACT_VERSION, CosmewError, FutrynError, HannesError} from '@cosmew/contracts';
import {defaultStateDirectory} from '../../apps/cli/src/bootstrap/paths';
import {FilePermissionSettings} from '../../apps/cli/src/bootstrap/permission-settings';
import {SENSITIVE_HOME_PATHS} from '@cosmew/security';

test('Cosmew state override wins over legacy environment overrides', () => {
  expect(
    defaultStateDirectory(
      {COSMEW_HOME: '/tmp/cosmew', FUTRYN_HOME: '/tmp/futryn', HANNES_HOME: '/tmp/hannes'},
      '/tmp/home',
    ),
  ).toBe('/tmp/cosmew');
  expect(defaultStateDirectory({FUTRYN_HOME: '/tmp/futryn', HANNES_HOME: '/tmp/hannes'}, '/tmp/home')).toBe(
    '/tmp/futryn',
  );
  expect(defaultStateDirectory({HANNES_HOME: '/tmp/hannes'}, '/tmp/home')).toBe('/tmp/hannes');
});

test('default state discovery reuses one existing legacy root without copying it', () => {
  const home = mkdtempSync(join(homedir(), 'cosmew-state-test-'));
  const cosmew = join(home, '.cosmew');
  const futryn = join(home, '.futryn');
  const hannes = join(home, '.hannes');
  mkdirSync(futryn);
  mkdirSync(hannes);
  try {
    expect(defaultStateDirectory({}, home)).toBe(futryn);
    expect(defaultStateDirectory({}, home)).not.toBe(cosmew);
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test('CosmewError and legacy error names are the same constructor', () => {
  expect(FutrynError).toBe(CosmewError);
  expect(HannesError).toBe(CosmewError);
  const error = new CosmewError('AUTH');
  expect(error).toBeInstanceOf(FutrynError);
  expect(error.name).toBe('CosmewError');
});

test('headless contract version is 1.40', () => {
  expect(CONTRACT_VERSION).toBe('1.40');
});

test('project permission settings prefer Cosmew root and fall back to legacy roots', () => {
  const workspace = mkdtempSync(join(homedir(), 'cosmew-settings-test-'));
  const store = {read: () => ({}) as never, update: () => {}};
  try {
    const current = new FilePermissionSettings({workspace, stateDirectory: workspace, store});
    expect(current.pathOf('project')).toBe(join(workspace, '.cosmew', 'settings.json'));
    mkdirSync(join(workspace, '.futryn'));
    const legacy = new FilePermissionSettings({workspace, stateDirectory: workspace, store});
    expect(legacy.pathOf('project')).toBe(join(workspace, '.futryn', 'settings.json'));
    mkdirSync(join(workspace, '.cosmew'));
    const preferred = new FilePermissionSettings({workspace, stateDirectory: workspace, store});
    expect(preferred.pathOf('project')).toBe(join(workspace, '.cosmew', 'settings.json'));
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
});

test('Cosmew state is protected by the built-in sensitive home paths', () => {
  expect(SENSITIVE_HOME_PATHS).toContain('.cosmew');
});
