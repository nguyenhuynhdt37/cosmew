import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {defaultStateDirectory} from '../../apps/cli/src/bootstrap/paths';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault} from '../fixtures';
import {defaultAppearance} from '@cosmew/contracts';

test('legacy state database opens in place and preserves durable settings across the Cosmew rename', () => {
  const home = mkdtempSync(join(homedir(), 'cosmew-legacy-migration-'));
  const legacy = join(home, '.futryn');
  mkdirSync(legacy, {mode: 0o700});
  let app = startup(legacy, {vault: memoryVault()});
  app.settings.update(settings => {
    settings.appearance = {...(settings.appearance ?? defaultAppearance()), theme: 'dark'};
  });
  app.db.close();
  try {
    expect(defaultStateDirectory({}, home)).toBe(legacy);
    app = startup(defaultStateDirectory({}, home), {vault: memoryVault()});
    expect(app.settings.read().appearance?.theme).toBe('dark');
    expect(app.settings.read().accounts).toEqual([]);
  } finally {
    app.db.close();
    rmSync(home, {recursive: true, force: true});
  }
});
