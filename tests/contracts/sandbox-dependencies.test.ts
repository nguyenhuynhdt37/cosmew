import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {NativeCommandRuntime, sandboxDependencies} from '@cosmew/tools';

test('macOS probes seatbelt and ripgrep; Linux probes ripgrep, bwrap and socat', async () => {
  const darwin = await sandboxDependencies({platform: 'darwin', probe: name => name === 'seatbelt'});
  expect(darwin).toEqual({
    platform: 'darwin',
    items: [
      {name: 'seatbelt', ok: true},
      {name: 'ripgrep', ok: false},
    ],
  });
  const linux = await sandboxDependencies({platform: 'linux', probe: name => name !== 'socat'});
  expect(linux.items).toEqual([
    {name: 'ripgrep', ok: true},
    {name: 'bwrap', ok: true},
    {name: 'socat', ok: false},
  ]);
});

test('unsandboxed failing commands never report a sandbox denial', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-denial-')));
  const runtime = new NativeCommandRuntime({workspaceRoot: root, platform: 'win32'});
  try {
    const outcome = await runtime.run({
      command: "printf 'permission denied'; exit 1",
      cwd: root,
      shell: 'bash',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      sandbox: {mode: 'danger-full-access', network: true, unsandboxed: true},
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.sandboxDenied).toBeUndefined();
  } finally {
    await runtime.shutdown();
    rmSync(root, {recursive: true, force: true});
  }
});
