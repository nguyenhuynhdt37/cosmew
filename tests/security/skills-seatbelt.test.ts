import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SeatbeltSandbox} from '../../packages/tools/src/exec/seatbelt-profile';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

test('empty skill directories leave the complete Seatbelt profile unchanged', () => {
  const options = {
    workspace: '/Users/dev/project',
    home: '/Users/dev',
    scratch: '/private/tmp/scratch',
    state: '/Users/dev/.futryn',
    denied: ['/Users/dev/.cargo/credentials.toml', '/Users/dev/.cargo/config.toml'],
  };
  for (const mode of ['read-only', 'workspace-write'] as const) {
    const sandbox = {mode, network: false};
    expect(new SeatbeltSandbox({...options, skillDirectories: [], readOnlySkillDirectories: []}).profile(sandbox)).toBe(
      new SeatbeltSandbox(options).profile(sandbox),
    );
  }
});

test('profile exposes only discovered directories read-only, without overriding state denial', () => {
  const text = new SeatbeltSandbox({
    workspace: '/Users/dev/project',
    home: '/Users/dev',
    scratch: '/private/tmp/scratch',
    state: '/Users/dev/.futryn/state',
    skillDirectories: ['/Users/dev/.agents/skills/demo', '/Users/dev/project/.futryn/skills/local'],
  }).profile({mode: 'workspace-write', network: false});
  expect(text).toContain('(allow file-read* (subpath "/Users/dev/.agents/skills/demo"))');
  expect(text).toContain('(deny file-write* (subpath "/Users/dev/.agents/skills/demo"))');
  expect(text).not.toContain('(allow file-read* (subpath "/Users/dev/.agents/skills"))');
  expect(text.indexOf('(allow file-read* (subpath "/Users/dev/project/.futryn/skills/local"))')).toBeGreaterThan(
    text.indexOf('(deny file-read* file-write* (regex'),
  );
  expect(text.indexOf('(deny file-read* file-write* (subpath "/Users/dev/.futryn/state"))')).toBeGreaterThan(
    text.indexOf('(allow file-read* (subpath "/Users/dev/.agents/skills/demo"))'),
  );
});

// Nested macOS sandboxes may refuse sandbox_apply; that is unavailable live evidence, never a pass.
const canApply =
  process.platform === 'darwin' &&
  existsSync('/usr/bin/sandbox-exec') &&
  Bun.spawnSync(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true']).exitCode === 0;
test.skipIf(!canApply)(
  'real Seatbelt runs discovered user scripts, denies writes and hides credential directories next to them',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-skill-seatbelt-')));
    cleanup.push(() => rmSync(root, {recursive: true, force: true}));
    const workspace = join(root, 'project'),
      home = join(root, 'home'),
      skill = join(home, '.agents/skills/demo');
    mkdirSync(workspace);
    mkdirSync(skill, {recursive: true});
    const script = join(skill, 'run.sh'),
      privateFile = join(home, '.ssh', 'id_probe');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(script, 'echo SKILL_SCRIPT_OK\n');
    writeFileSync(privateFile, 'PRIVATE_MARKER');
    writeFileSync(join(home, 'notes.txt'), 'PLAIN_HOME_FILE');
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const profile = new SeatbeltSandbox({workspace, home, scratch, skillDirectories: [skill]}).profile({
      mode: 'workspace-write',
      network: false,
    });
    const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const run = async (command: string) => {
      const result = Bun.spawnSync(['/usr/bin/sandbox-exec', '-p', profile, '/bin/sh', '-c', command], {
        cwd: workspace,
      });
      return {
        output: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(),
        exitCode: result.exitCode,
      };
    };
    expect((await run(`/bin/sh ${q(script)}`)).output).toContain('SKILL_SCRIPT_OK');
    expect((await run(`echo CHANGED > ${q(script)}`)).exitCode).not.toBe(0);
    expect(readFileSync(script, 'utf8')).toBe('echo SKILL_SCRIPT_OK\n');
    const hidden = await run(`/bin/cat ${q(privateFile)}`);
    expect(hidden.exitCode).not.toBe(0);
    expect(hidden.output).not.toContain('PRIVATE_MARKER');
    // Everything else under home stays readable (ADR 0061): only the sensitive list is hidden.
    expect((await run(`/bin/cat ${q(join(home, 'notes.txt'))}`)).output).toContain('PLAIN_HOME_FILE');
  },
  20000,
);

test('default state profile excludes only discovered skill resources from the read deny, never the write deny', () => {
  const state = '/Users/dev/.futryn',
    directory = state + '/skills/demo';
  const profile = new SeatbeltSandbox({
    workspace: '/Users/dev/project',
    home: '/Users/dev',
    scratch: '/private/tmp/scratch',
    state,
    skillDirectories: [directory],
  }).profile({mode: 'workspace-write', network: false});
  expect(profile).toContain(`(deny file-write* (subpath "${state}"))`);
  expect(profile).toContain(
    `(deny file-read* (require-all (subpath "${state}") (require-not (subpath "${directory}"))))`,
  );
  expect(profile).not.toContain(`(allow file-read* (subpath "${state}"))`);
});

test('user skill directories remain read-only when home itself is the workspace', () => {
  const directory = '/Users/dev/.agents/skills/demo';
  const text = new SeatbeltSandbox({
    workspace: '/Users/dev',
    home: '/Users/dev',
    scratch: '/private/tmp/scratch',
    skillDirectories: [directory],
    readOnlySkillDirectories: [directory],
  }).profile({mode: 'workspace-write', network: false});
  expect(text).toContain(`(allow file-read* (subpath "${directory}"))`);
  expect(text).toContain(`(deny file-write* (subpath "${directory}"))`);
});
