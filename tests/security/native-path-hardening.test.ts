import {afterEach, expect, test} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCommandRuntime} from '@futryn/tools';
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const native = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
function paths() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-native-paths-')));
  clean.push(() => rmSync(base, {recursive: true, force: true}));
  const root = join(base, 'workspace');
  mkdirSync(root);
  return {base, root};
}

native('native runtime canonicalizes a symlink workspace before granting its actual writable root', async () => {
  const s = paths();
  const alias = join(s.base, 'workspace-link');
  symlinkSync(s.root, alias);
  const runtime = new NativeCommandRuntime({workspaceRoot: alias});
  clean.push(() => runtime.shutdown());
  expect(runtime.availability().ok).toBe(true);
  const outcome = await runtime.run({
    command: 'printf canonical > created.txt',
    cwd: s.root,
    timeoutMs: 3000,
    maxOutputBytes: 1000,
    sandbox: {mode: 'workspace-write', network: false},
  });
  expect(outcome.exitCode).toBe(0);
  expect(readFileSync(join(s.root, 'created.txt'), 'utf8')).toBe('canonical');
});

native('a symlink state directory cannot expose its canonical contents to commands or helpers', async () => {
  const s = paths();
  const state = join(s.root, 'private-state');
  mkdirSync(state);
  writeFileSync(join(state, 'marker'), 'STATE_CANONICAL_MARKER');
  const alias = join(s.root, 'state-link');
  symlinkSync(state, alias);
  const runtime = new NativeCommandRuntime({workspaceRoot: s.root, stateDirectory: alias});
  clean.push(() => runtime.shutdown());
  expect(runtime.availability().ok).toBe(true);
  const result = await runtime.run({
    command: 'cat private-state/marker',
    cwd: s.root,
    timeoutMs: 3000,
    maxOutputBytes: 1000,
    sandbox: {mode: 'read-only', network: false},
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.output).not.toContain('STATE_CANONICAL_MARKER');
  const child = runtime.spawnService!(['/bin/cat', join(state, 'marker')], s.root);
  let text = '';
  child.onData(data => {
    text += Buffer.from(data).toString();
  });
  await new Promise<void>(resolve => child.onExit(() => resolve()));
  expect(text).not.toContain('STATE_CANONICAL_MARKER');
});

native(
  'retargeting a configured workspace alias closes admission instead of silently following a different root',
  async () => {
    const s = paths();
    const other = join(s.base, 'other');
    mkdirSync(other);
    const alias = join(s.base, 'workspace-link');
    symlinkSync(s.root, alias);
    const runtime = new NativeCommandRuntime({workspaceRoot: alias});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    unlinkSync(alias);
    symlinkSync(other, alias);
    expect(runtime.availability().ok).toBe(false);
    await expect(
      runtime.run({command: 'touch escaped', cwd: other, timeoutMs: 1000, maxOutputBytes: 1000}),
    ).rejects.toThrow();
    expect(existsSync(join(other, 'escaped'))).toBe(false);
  },
);

const rustupReady =
  process.platform === 'darwin' &&
  existsSync('/usr/bin/sandbox-exec') &&
  existsSync(join(homedir(), '.cargo', 'bin', 'rustup')) &&
  existsSync(join(homedir(), '.rustup'));

test.skipIf(!rustupReady)(
  'rustup toolchain shims run inside Seatbelt read-only while the rest of home remains denied',
  async () => {
    const s = paths();
    const runtime = new NativeCommandRuntime({
      workspaceRoot: s.root,
      hostPath: `${join(homedir(), '.cargo', 'bin')}:/usr/bin:/bin`,
    });
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const rustc = await runtime.run({
      command: 'rustc --version',
      cwd: '.',
      timeoutMs: 5000,
      maxOutputBytes: 2000,
      sandbox: {mode: 'read-only', network: false},
    });
    expect(rustc.exitCode).toBe(0);
    expect(rustc.output).toContain('rustc ');
    const privateHome = await runtime.run({
      command: `ls -la ${JSON.stringify(homedir())}`,
      cwd: '.',
      timeoutMs: 3000,
      maxOutputBytes: 2000,
      sandbox: {mode: 'read-only', network: false},
    });
    expect(privateHome.exitCode).not.toBe(0);
  },
);

function fakeRustHome(base: string, cargoRoot = '.cargo') {
  const home = join(base, 'home');
  const cargo = join(home, cargoRoot);
  for (const dir of [
    join(cargo, 'bin'),
    join(cargo, 'registry'),
    join(home, '.rustup', 'toolchains', 't'),
    join(home, '.ssh'),
  ])
    mkdirSync(dir, {recursive: true});
  for (const name of ['cargo', 'rustup']) {
    writeFileSync(join(cargo, 'bin', name), '#!/bin/sh\necho fake-' + name + '\n', {mode: 0o755});
  }
  for (const name of ['credentials', 'credentials.toml', 'config', 'config.toml'])
    writeFileSync(join(cargo, name), 'CARGO_SECRET_' + name);
  writeFileSync(join(cargo, 'registry', 'index'), 'REGISTRY_OK');
  writeFileSync(join(home, '.rustup', 'toolchains', 't', 'marker'), 'TOOLCHAIN_OK');
  writeFileSync(join(home, '.rustup', 'settings.toml'), 'SETTINGS_OK');
  writeFileSync(join(home, '.ssh', 'id'), 'SSH_SECRET');
  writeFileSync(join(home, '.gitconfig'), 'GITCONFIG_SECRET');
  return {home, cargo};
}

async function sh(runtime: NativeCommandRuntime, command: string) {
  return runtime.run({
    command,
    cwd: '.',
    timeoutMs: 5000,
    maxOutputBytes: 4000,
    sandbox: {mode: 'read-only', network: false},
  });
}

native(
  'cargo credentials and config are unreadable while toolchain binaries, toolchains and registry resolve',
  async () => {
    const s = paths();
    const {home, cargo} = fakeRustHome(s.base);
    for (const hideSecrets of [false, true]) {
      const runtime = new NativeCommandRuntime({
        workspaceRoot: s.root,
        home,
        hostPath: `${join(cargo, 'bin')}:/usr/bin:/bin`,
        hideSecrets,
      });
      clean.push(() => runtime.shutdown());
      expect(runtime.availability().ok).toBe(true);
      expect((await sh(runtime, 'cargo')).output).toContain('fake-cargo');
      expect(
        (
          await sh(
            runtime,
            `cat ${cargo}/registry/index ${home}/.rustup/toolchains/t/marker ${home}/.rustup/settings.toml`,
          )
        ).output,
      ).toContain('REGISTRY_OK');
      for (const name of ['credentials', 'credentials.toml', 'config', 'config.toml']) {
        const out = await sh(runtime, `cat ${cargo}/${name}`);
        expect(out.exitCode).not.toBe(0);
        expect(out.output).not.toContain('CARGO_SECRET');
        const viaHome = await sh(runtime, `cat "$CARGO_HOME/${name}"`);
        expect(viaHome.exitCode).not.toBe(0);
        expect(viaHome.output).not.toContain('CARGO_SECRET');
      }
      // Other private home contents stay hidden.
      for (const hidden of ['.ssh/id', '.gitconfig', '.rustup/nothing', '.cargo/.crates.toml'])
        expect((await sh(runtime, `cat ${home}/${hidden}`)).exitCode).not.toBe(0);
      expect((await sh(runtime, `ls ${home}/.ssh`)).exitCode).not.toBe(0);
      const ids = (await sh(runtime, 'echo $CARGO_HOME $RUSTUP_HOME')).output;
      expect(ids).toContain(home + '/.rustup');
      await runtime.shutdown();
    }
  },
  // Two runtime probes and 32 separate Seatbelt launches share this test's total budget.
  30000,
);

native('a PATH-exposed cargo root still cannot reveal its credentials or config', async () => {
  const s = paths();
  const {home, cargo} = fakeRustHome(s.base, 'cargohome');
  const runtime = new NativeCommandRuntime({
    workspaceRoot: s.root,
    home,
    hostPath: `${join(cargo, 'bin')}:/usr/bin:/bin`,
  });
  clean.push(() => runtime.shutdown());
  expect(runtime.availability().ok).toBe(true);
  expect((await sh(runtime, 'cargo')).output).toContain('fake-cargo');
  for (const name of ['credentials', 'credentials.toml', 'config', 'config.toml']) {
    const out = await sh(runtime, `cat ${cargo}/${name}`);
    expect(out.exitCode).not.toBe(0);
    expect(out.output).not.toContain('CARGO_SECRET');
  }
});

native('cargo secrets are denied for roots outside home, via CARGO_HOME and via a PATH bin directory', async () => {
  const s = paths();
  const {home} = fakeRustHome(s.base);
  const outside = join(s.base, 'opt-cargo');
  mkdirSync(join(outside, 'bin'), {recursive: true});
  writeFileSync(join(outside, 'bin', 'cargo'), '#!/bin/sh\necho fake-cargo\n', {mode: 0o755});
  for (const name of ['credentials', 'credentials.toml', 'config', 'config.toml'])
    writeFileSync(join(outside, name), 'CARGO_SECRET_' + name);
  const saved = process.env.CARGO_HOME;
  try {
    for (const viaEnv of [false, true]) {
      if (viaEnv) process.env.CARGO_HOME = outside;
      else delete process.env.CARGO_HOME;
      const runtime = new NativeCommandRuntime({
        workspaceRoot: s.root,
        home,
        hostPath: viaEnv ? '/usr/bin:/bin' : `${join(outside, 'bin')}:/usr/bin:/bin`,
      });
      clean.push(() => runtime.shutdown());
      expect(runtime.availability().ok).toBe(true);
      if (!viaEnv) expect((await sh(runtime, 'cargo')).output).toContain('fake-cargo');
      for (const name of ['credentials', 'credentials.toml', 'config', 'config.toml']) {
        const out = await sh(runtime, `cat ${outside}/${name}`);
        expect(out.exitCode).not.toBe(0);
        expect(out.output).not.toContain('CARGO_SECRET');
      }
    }
  } finally {
    if (saved === undefined) delete process.env.CARGO_HOME;
    else process.env.CARGO_HOME = saved;
  }
});
