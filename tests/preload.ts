/**
 * Hermetic test environment (ADR 0034, 0062). Fixture tests must not run the developer's shell.
 * Suites that need the OS sandbox pass `COSMEW_COMMAND_BACKEND=native` themselves.
 */
import {afterAll, afterEach} from 'bun:test';
import {mkdtempSync, rmSync, writeSync} from 'node:fs';
import {tmpdir, userInfo} from 'node:os';
import {join} from 'node:path';
import {watchUserState} from './user-state-guard';

const check = watchUserState(userInfo().homedir);
const home = mkdtempSync(join(tmpdir(), 'cosmew-test-home-'));
function teardown() {
  try {
    check();
  } finally {
    rmSync(home, {recursive: true, force: true});
  }
}
// Bun names the first test whose metadata check fails. Hash the files again at teardown.
afterEach(() => check(true));
// Bun's test runner uses the global afterAll hook on normal completion.
afterAll(teardown);
process.on('exit', () => {
  try {
    teardown();
  } catch (error) {
    writeSync(2, `${error}\n`);
    process.exitCode = 1;
  }
});
process.env.HOME = home;
process.env.COSMEW_HOME = join(home, 'state');
delete process.env.FUTRYN_HOME;
delete process.env.HANNES_HOME;
process.env.COSMEW_COMMAND_BACKEND ??= 'none';
