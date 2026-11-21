/** F12: commands approved to run without the sandbox use the user's real environment; sandboxed ones keep scratch. */
import {test, expect, afterEach} from 'bun:test';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime} from '@cosmew/tools';

const nativeTest = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});

function runtime() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-hostenv-')));
  const rt = new NativeCommandRuntime({workspaceRoot: root});
  clean.push(
    () => rmSync(root, {recursive: true, force: true}),
    () => rt.shutdown(),
  );
  return rt;
}
const run = (rt: NativeCommandRuntime, command: string, unsandboxed: boolean, mode = 'workspace-write' as const) =>
  rt.run({
    command,
    cwd: '.',
    timeoutMs: 15_000,
    maxOutputBytes: 10_000,
    sandbox: {mode, network: false, ...(unsandboxed ? {unsandboxed: true} : {})},
  });

nativeTest('an unsandboxed command sees the real HOME and environment, a sandboxed one the scratch HOME', async () => {
  const rt = runtime();
  process.env.FYN_TEST_HOST_VISIBLE = 'visible';
  process.env.FYN_TEST_SECRET_TOKEN = 'must-not-pass';
  process.env.FUTRYN_TEST_STATE = 'must-not-pass';
  clean.push(() => {
    delete process.env.FYN_TEST_HOST_VISIBLE;
    delete process.env.FYN_TEST_SECRET_TOKEN;
    delete process.env.FUTRYN_TEST_STATE;
  });
  const real = (process.env.HOME ?? homedir()).replace(/\/$/, '');

  const escalated = await run(
    rt,
    'echo "H=$HOME"; echo "X=$XDG_CACHE_HOME"; echo "V=$FYN_TEST_HOST_VISIBLE"; env',
    true,
  );
  expect(escalated.output).toContain(`H=${real}\n`);
  expect(escalated.output).toContain('X=\n');
  expect(escalated.output).toContain('V=visible');
  expect(escalated.output).not.toContain('must-not-pass');
  expect(escalated.output).not.toContain('FUTRYN_SANDBOX');
  expect(escalated.output).not.toContain('fyn-exec-');

  const fullAccess = await run(rt, 'echo "H=$HOME"', true, 'danger-full-access' as never);
  expect(fullAccess.output).toContain(`H=${real}\n`);

  const sandboxed = await run(rt, 'echo "H=$HOME"; echo "S=$FUTRYN_SANDBOX"', false);
  expect(sandboxed.output).not.toContain(`H=${real}\n`);
  expect(sandboxed.output).toContain('fyn-exec-');
  expect(sandboxed.output).toContain('S=1');
});
