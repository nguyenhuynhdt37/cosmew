import {expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {FileAppearanceStore} from '../../apps/cli/src/bootstrap/user-settings';

test('onboarding checkpoints survive reopening the isolated user settings file', () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-onboarding-'));
  const options = {stateDirectory: join(home, '.cosmew')};
  try {
    let store = new FileAppearanceStore(options);
    expect(store.onboardingState()).toEqual({completed: [], hasStoredTheme: false});
    store.write({theme: 'dark', mode: 'dark'});
    store.completeOnboardingStep('theme');
    store = new FileAppearanceStore(options);
    expect(store.onboardingState()).toEqual({completed: ['theme'], hasStoredTheme: true});
    writeFileSync(
      store.path,
      JSON.stringify({...JSON.parse(readFileSync(store.path, 'utf8')), sandbox: {enabled: true}}),
    );
    store.completeOnboardingStep('auth');
    store.completeOnboardingStep('auth');
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toMatchObject({
      theme: 'dark',
      sandbox: {enabled: true},
      onboardingCompleted: ['theme', 'auth'],
    });
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test('help, piped TUI, and exec do not display onboarding', () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-onboarding-headless-'));
  const workspace = join(home, 'project');
  mkdirSync(workspace);
  try {
    for (const args of [['--help'], ['tui'], ['exec', 'test prompt']]) {
      const run = Bun.spawnSync([process.execPath, resolve('apps/cli/src/index.ts'), ...args], {
        cwd: workspace,
        env: {HOME: home, TMPDIR: home, COSMEW_HOME: join(home, 'state'), NO_COLOR: '1'},
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = run.stdout.toString() + run.stderr.toString();
      expect(output.length).toBeGreaterThan(0);
      if (args[0] !== 'exec') expect(run.exitCode, output).toBe(0);
      expect(output).not.toMatch(/Let's get started|Skip for now|Security notes:/);
    }
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});

test('read-only user settings keep step progress in memory without persisting a partial checkpoint', () => {
  const home = mkdtempSync(join(tmpdir(), 'fyn-onboarding-readonly-'));
  const options = {stateDirectory: home};
  try {
    writeFileSync(join(home, 'settings.json'), '{"permissions":{"deny":["Bash"]}}', {mode: 0o400});
    const store = new FileAppearanceStore(options);
    store.completeOnboardingStep('theme');
    expect(store.onboardingState().completed).toEqual(['theme']);
    expect(new FileAppearanceStore(options).onboardingState().completed).toEqual([]);
    expect(readFileSync(store.path, 'utf8')).toBe('{"permissions":{"deny":["Bash"]}}');
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
});
