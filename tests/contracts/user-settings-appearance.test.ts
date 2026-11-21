import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPrivateDatabase, SqliteSettings, importLegacyAppearance} from '@cosmew/persistence';
import {parseSettings} from '@cosmew/security';
import {defaultAppearance} from '@cosmew/contracts';
import {FileAppearanceStore} from '../../apps/cli/src/bootstrap/user-settings';
import {createClientFixture} from '../../apps/tui/src/ink/testing/client-fixture';
const roots: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cosmew-appearance-home-'));
  roots.push(home);
  process.env.HOME = home;
  const directory = join(home, '.cosmew');
  mkdirSync(directory, {mode: 0o700});
  return {home, directory, path: join(directory, 'settings.json')};
}
test('user appearance round-trips and preserves permission, sandbox and unknown keys', () => {
  const f = fixture();
  const other = {
    permissions: {deny: ['Read(secret)'], future: 1},
    sandbox: {enabled: true, network: {allowedDomains: ['example.com']}},
    future: {answer: 42},
  };
  writeFileSync(f.path, JSON.stringify(other));
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  store.write({theme: 'light', mode: 'light', syntaxHighlighting: false, animations: {reducedMotion: true}});
  const restarted = new FileAppearanceStore({stateDirectory: f.directory});
  expect(restarted.read()).toEqual(store.read());
  expect(restarted.read().animations.reducedMotion).toBe(true);
  const raw = JSON.parse(readFileSync(f.path, 'utf8'));
  expect(raw).toMatchObject({
    ...other,
    theme: 'light',
    themeMode: 'light',
    reducedMotion: true,
    syntaxHighlighting: false,
  });
});
test('legacy appearance imports once; SQLite source remains untouched', () => {
  const f = fixture();
  let calls = 0;
  const legacy = {...defaultAppearance(), theme: 'dark', mode: 'dark' as const};
  const options = {
    stateDirectory: f.directory,
    importLegacy: () => {
      calls++;
      return legacy;
    },
  };
  const store = new FileAppearanceStore(options);
  expect(store.read().theme).toBe('dark');
  store.write({theme: 'light', mode: 'light'});
  expect(new FileAppearanceStore(options).read().theme).toBe('light');
  expect(calls).toBe(1);
  expect(legacy.theme).toBe('dark');
});
test('corrupt JSON defaults without a write, backs up and recovers complete keys on successful write', () => {
  const f = fixture();
  const corrupt = '{"permissions":{"deny":["Bash(rm:*)"]},"sandbox":{"enabled":true},"future":42,"theme":';
  writeFileSync(f.path, corrupt);
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  expect(store.read()).toEqual(defaultAppearance());
  expect(readFileSync(f.path, 'utf8')).toBe(corrupt);
  expect(existsSync(f.path + '.bak')).toBe(false);
  store.write({theme: 'light', mode: 'light'});
  expect(readFileSync(f.path + '.bak', 'utf8')).toBe(corrupt);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
    permissions: {deny: ['Bash(rm:*)']},
    sandbox: {enabled: true},
    future: 42,
    theme: 'light',
  });
});
test('read-only file keeps in-memory appearance and returns a notice without throwing', () => {
  const f = fixture();
  writeFileSync(f.path, '{"permissions":{"deny":["Bash"]}}');
  chmodSync(f.path, 0o400);
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  expect(() => store.write({theme: 'light', mode: 'light'})).not.toThrow();
  expect(store.read().theme).toBe('light');
  expect(store.notices().join(' ')).toContain('session');
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({permissions: {deny: ['Bash']}});
});
test('SDK uses injected user store, ignores repository and legacy workspace appearance, and keeps project edits session-only', () => {
  const f = fixture();
  const project = join(f.home, 'project', '.cosmew');
  mkdirSync(project, {recursive: true});
  writeFileSync(join(project, 'settings.json'), '{"theme":"light","themeMode":"light"}');
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  const {client, settings} = createClientFixture({workspace: join(f.home, 'project'), appearanceStore: store});
  settings.projectAppearances = {[join(f.home, 'project')]: {theme: 'light', mode: 'light'}};
  expect(client.getAppearance().theme).toBe('auto');
  const before = structuredClone(settings);
  client.updateAppearance({theme: 'dark', mode: 'dark'});
  client.updateAppearance({theme: 'light', mode: 'light'}, 'project');
  expect(client.getAppearance().theme).toBe('light');
  expect(client.getAppearance(false).theme).toBe('dark');
  expect(settings).toEqual(before);
  expect(
    createClientFixture({
      appearanceStore: new FileAppearanceStore({stateDirectory: f.directory}),
    }).client.getAppearance().theme,
  ).toBe('dark');
});

test('invalid appearance fields default independently and external edits invalidate the cache', () => {
  const f = fixture();
  writeFileSync(
    f.path,
    JSON.stringify({theme: 42, themeMode: 'light', reducedMotion: true, permissions: {deny: ['Bash']}}),
  );
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  expect(store.read()).toMatchObject({theme: 'auto', mode: 'light', animations: {reducedMotion: true}});
  writeFileSync(f.path, '{"theme":"dark","themeMode":"dark","future":123}');
  expect(store.read()).toMatchObject({theme: 'dark', mode: 'dark'});
  store.write({sidebar: true});
  expect(JSON.parse(readFileSync(f.path, 'utf8')).future).toBe(123);
});

test('unsafe or unreadable paths never get replaced; session edits still work', () => {
  const f = fixture();
  mkdirSync(f.path);
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  expect(store.read()).toEqual(defaultAppearance());
  store.write({theme: 'light', mode: 'light'});
  expect(store.read().theme).toBe('light');
  expect(store.notices().length).toBeGreaterThan(0);
  expect(existsSync(f.path + '.bak')).toBe(false);
});

test('real SQLite import is read-only and the permission parser retains unknown top-level keys', () => {
  const f = fixture();
  const db = openPrivateDatabase(f.directory);
  try {
    const sqlite = new SqliteSettings(db);
    sqlite.update(state => {
      state.appearance = {...defaultAppearance(), theme: 'light', mode: 'light'};
    });
    const before = sqlite.read();
    const store = new FileAppearanceStore({
      stateDirectory: f.directory,
      importLegacy: () => importLegacyAppearance(sqlite),
    });
    expect(store.read().theme).toBe('light');
    store.write({theme: 'dark', mode: 'dark'});
    expect(sqlite.read()).toEqual(before);
    const raw = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(parseSettings(JSON.stringify({...raw, future: {version: 2}})).raw).toMatchObject({
      ...raw,
      future: {version: 2},
    });
  } finally {
    db.close();
  }
});

test('user preferences default for existing settings and round-trip independently of appearance', () => {
  const f = fixture();
  const other = {theme: 'light', permissions: {deny: ['Read(secret)']}, verbose: 'invalid'};
  writeFileSync(f.path, JSON.stringify(other));
  const store = new FileAppearanceStore({stateDirectory: f.directory});
  const {client} = createClientFixture({userPreferencesStore: store});
  expect(client.userPreferences()).toEqual({autoCompact: true, verbose: false, showTurnDuration: true});
  client.updateUserPreferences({autoCompact: false, verbose: true});
  client.updateUserPreferences({showTurnDuration: false});
  const restarted = new FileAppearanceStore({stateDirectory: f.directory});
  expect(restarted.readPreferences()).toEqual({autoCompact: false, verbose: true, showTurnDuration: false});
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toMatchObject({
    ...other,
    autoCompact: false,
    verbose: true,
    showTurnDuration: false,
  });
});

test('editor mode defaults, cycles live and persists independently of appearance and permissions', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({editorMode: 'invalid', permissions: {deny: ['Bash(*)']}}));
  const {client} = createClientFixture({appearanceStore: new FileAppearanceStore({stateDirectory: f.directory})});
  const changes: string[] = [];
  const unsubscribe = client.subscribeEditorMode(() => changes.push(client.editorMode()));
  expect(client.editorMode()).toBe('normal');
  client.setEditorMode('vim');
  expect(changes).toEqual(['vim']);
  const restored = new FileAppearanceStore({stateDirectory: f.directory});
  expect(restored.readEditorMode()).toBe('vim');
  expect(JSON.parse(readFileSync(f.path, 'utf8')).permissions).toEqual({deny: ['Bash(*)']});
  client.setEditorMode('normal');
  expect(restored.readEditorMode()).toBe('normal');
  unsubscribe();
});
