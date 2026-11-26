import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {CONTRACT_VERSION} from '@cosmew/contracts';
import {SLASH_COMMANDS, acceptSlashSelection, parseSlashCommand} from '@cosmew/sdk';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer, memoryVault} from '../fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

test('/tasks and /bashes expose the background task overlay during a running response', () => {
  for (const name of ['/tasks', '/bashes']) {
    const parsed = parseSlashCommand(name);
    expect(parsed.error).toBeUndefined();
    expect(parsed.definition).toMatchObject({
      command: '/tasks',
      handler: 'overlay',
      overlay: 'background-tasks',
      duringRequest: true,
    });
    expect(parsed.definition?.unavailable).toBeUndefined();
    expect(parsed.definition?.autocomplete).not.toBe(false);
    expect(parsed.definition?.help).not.toBe(false);
  }
});

test('/config accepts key=value arguments for the interactive settings route', () => {
  const parsed = parseSlashCommand('/config theme=dark');
  expect(parsed.error).toBeUndefined();
  expect(parsed.definition?.command).toBe('/config');
  expect(parsed.args).toBe('theme=dark');
});

test('a typo stays literal when autocomplete has a nearby command', () => {
  const usage = SLASH_COMMANDS.find(command => command.command === '/usage')!;
  expect(acceptSlashSelection('/usege', usage)).toBe('/usege');
  expect(acceptSlashSelection('/us', usage)).toBe('/usage');
});

test('Claude command aliases and canonical review name share one parser', () => {
  expect(parseSlashCommand('/review high --fix').definition?.command).toBe('/code-review');
  expect(parseSlashCommand('/checkup').definition?.command).toBe('/doctor');
  expect(parseSlashCommand('/allowed-tools').definition?.command).toBe('/permissions');
  expect(parseSlashCommand('/checkpoint').definition?.command).toBe('/rewind');
  expect(parseSlashCommand('/undo').definition?.command).toBe('/rewind');
  expect(parseSlashCommand('/bg').definition?.command).toBe('/background');
  expect(parseSlashCommand('/share').definition?.command).toBe('/bug');
  expect(parseSlashCommand('/clear release-notes').args).toBe('release-notes');
});

test('separator-insensitive command completion only canonicalizes a selected match', () => {
  const permissions = SLASH_COMMANDS.find(command => command.command === '/permissions')!;
  expect(acceptSlashSelection('/allowedtools', permissions)).toBe('/permissions');
  expect(acceptSlashSelection('/permssions', permissions)).toBe('/permssions');
});

test('command help does not advertise stale shortcuts that collide with the central keymap', () => {
  for (const name of ['/theme', '/model', '/resume', '/diff', '/clear', '/exit']) {
    expect(SLASH_COMMANDS.find(command => command.command === name)?.shortcut).toBeUndefined();
  }
});

test('project and session commands are discoverable and resolve to their real handlers', () => {
  for (const name of ['init', 'export', 'copy', 'rename'] as const) {
    const parsed = parseSlashCommand(`/${name}`);
    expect(parsed.error).toBeUndefined();
    expect(parsed.definition?.handler).toBe(name);
    expect(parsed.definition?.autocomplete).not.toBe(false);
    expect(parsed.definition?.help).not.toBe(false);
  }
});

test('Claude uses editor shortcuts and the rewind picker instead of /editor and /redo', () => {
  expect(parseSlashCommand('/editor').error).toBeDefined();
  expect(parseSlashCommand('/redo').error).toBeDefined();
  expect(parseSlashCommand('/copy 2').args).toBe('2');
});

test('implemented MCP and rewind panels expose usable canonical overlay routes', () => {
  for (const [command, overlay] of [
    ['/mcp', 'mcp'],
    ['/rewind', 'rewind'],
    ['/checkpoint', 'rewind'],
    ['/undo', 'rewind'],
  ]) {
    const parsed = parseSlashCommand(command!);
    expect(parsed.error).toBeUndefined();
    expect(parsed.definition).toMatchObject({handler: 'overlay', overlay});
    expect(parsed.definition?.unavailable).toBeUndefined();
  }
});

test('CLI --version, -v, -V, version, --version --json and -h exit 0 before startup()', () => {
  const tuiPkg = JSON.parse(readFileSync(resolve('apps/tui/package.json'), 'utf8')) as {version: string};
  const entry = resolve('apps/cli/src/index.ts');
  const runCli = (args: string[], home: string) =>
    Bun.spawnSync([process.execPath, '--config=/dev/null', '--no-env-file', entry, ...args], {
      env: {...process.env, COSMEW_HOME: home},
      stdout: 'pipe',
      stderr: 'pipe',
    });

  for (const flag of ['--version', '-v', '-V', 'version']) {
    const dir = mkdtempSync(join(tmpdir(), 'cosmew-cli-ver-'));
    const home = join(dir, 'unused-state');
    cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
    const child = runCli([flag], home);
    expect(child.exitCode, flag).toBe(0);
    expect(child.stdout.toString()).toBe(`cosmew ${tuiPkg.version}\n`);
    expect(existsSync(home)).toBe(false);

    const jsonChild = runCli([flag, '--json'], home);
    expect(jsonChild.exitCode, `${flag} --json`).toBe(0);
    expect(JSON.parse(jsonChild.stdout.toString())).toEqual({
      name: 'cosmew',
      version: tuiPkg.version,
      contractVersion: CONTRACT_VERSION,
    });
    expect(existsSync(home)).toBe(false);
  }

  const dir = mkdtempSync(join(tmpdir(), 'cosmew-cli-help-'));
  const home = join(dir, 'unused-state');
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}));
  const longHelp = runCli(['--help'], home);
  const shortHelp = runCli(['-h'], home);
  expect(longHelp.exitCode).toBe(0);
  expect(shortHelp.exitCode).toBe(0);
  expect(shortHelp.stdout.toString()).toBe(longHelp.stdout.toString());
  expect(existsSync(home)).toBe(false);
});

test('CLI -c/--continue and --account/--model apply cleanly before entering TUI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cosmew-cli-continue-'));
  const home = join(dir, 'state');
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, {recursive: true});
  const server = fixtureServer();
  cleanup.push(() => {
    server.server.stop(true);
    rmSync(dir, {recursive: true, force: true});
  });
  const entry = resolve('apps/cli/src/index.ts');
  const runCli = (args: string[]) =>
    Bun.spawnSync([process.execPath, '--config=/dev/null', '--no-env-file', entry, ...args], {
      cwd: workspace,
      env: {...process.env, COSMEW_HOME: home},
      stdout: 'pipe',
      stderr: 'pipe',
    });

  const app = startup(home, {vault: memoryVault()});
  app.registry.add(server.provider('chat', {id: 'cli-test-provider', auth: 'none'}));
  await app.accounts.add('cli-test-provider', 'personal', {kind: 'none'});
  const client = app.createFutrynClient(workspace);
  await client.discoverModels();
  client.selectModel('fixture-model');
  await app.shutdownCommands();
  app.db.close();

  // No sessions yet: `tui -c` starts cleanly with no initial /resume command.
  const emptyContinue = runCli(['tui', '-c']);
  expect(emptyContinue.exitCode).toBe(0);
  expect(emptyContinue.stdout.toString()).toContain('Cosmew · Ink preview');
  expect(emptyContinue.stdout.toString()).not.toContain('Initial command skipped');

  // Create a session and ensure `-c` / `tui -c` resolves it as `/resume <id>` (reported via non-TTY notice).
  const app2 = startup(home, {vault: memoryVault()});
  const session = app2.createFutrynClient(workspace).createSession();
  app2.conversations.append(session.id, {role: 'user', content: 'hello'}, 'committed');
  await app2.shutdownCommands();
  app2.db.close();

  for (const args of [['tui', '-c'], ['tui', '--continue'], ['-c'], ['tui', '--resume', session.id, '-c']]) {
    const res = runCli(args);
    expect(res.exitCode, args.join(' ')).toBe(0);
    expect(res.stdout.toString()).toContain('Initial command skipped');
  }

  // Valid --account and --model flags succeed before launching TUI; unknown ones fail cleanly.
  const validSel = runCli(['tui', '--account', 'personal', '--model', 'fixture-model']);
  expect(validSel.exitCode).toBe(0);
  expect(runCli(['tui', '--account', 'missing-account']).exitCode).toBe(1);
  expect(runCli(['tui', '--account', 'personal', '--model', 'missing-model']).exitCode).toBe(1);
});

test('ScrollViewport hides Jump to bottom while drag-selecting and resets cleanly on capture/raw disable', () => {
  const script = `
    import {PassThrough} from 'node:stream';
    import React from 'react';
    import {Box, Text, render, useInput} from 'ink';
    import {ThemeEngine} from './src/theme/theme';
    import {ThemeProvider} from './src/ink/theme';
    import {createTerminalMouseInput} from './src/input/mouse-input';
    import {TerminalMouseProvider} from './src/ink/hooks/use-terminal-wheel';
    import {ScrollViewport, useScrollback} from './src/ink/screen';

    class InputStream extends PassThrough {
      isTTY = true;
      setRawMode() { return this; }
    }
    class OutputStream extends PassThrough {
      isTTY = true;
      columns = 60;
      rows = 10;
      frames = [];
      write(chunk, cb, cb2) {
        const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        if (s.replace(/\\u001b\\[[0-9;?]*[ -/]*[@-~]/g, '').trim()) {
          this.frames.push(s);
        }
        return super.write(chunk, cb, cb2);
      }
    }
    const stdin = new InputStream();
    const stdout = new OutputStream();
    const mouse = createTerminalMouseInput(stdin, stdout);
    const themeEngine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
    let scrollRef;
    function Harness() {
      useInput(() => {});
      const scroll = useScrollback();
      scrollRef = scroll;
      const rows = Array.from({length: 20}, (_, idx) => React.createElement(Text, {key: idx}, 'line ' + (idx + 1)));
      return React.createElement(
        Box,
        {height: 6, width: 60, flexDirection: 'column'},
        React.createElement(ScrollViewport, {scroll}, ...rows),
      );
    }
    const instance = render(
      React.createElement(
        TerminalMouseProvider,
        {value: mouse},
        React.createElement(ThemeProvider, {engine: themeEngine}, React.createElement(Harness)),
      ),
      {stdout, stdin: mouse.stdin, debug: true, exitOnCtrlC: false, patchConsole: false},
    );
    const strip = v => v.replace(/\\u001b\\[[0-9;?]*[ -/]*[@-~]/g, '');
    const latest = () => strip(stdout.frames.at(-1) ?? '');
    const wait = async pred => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (pred(latest())) return;
        await Bun.sleep(10);
      }
      throw new Error('Timeout waiting for condition. Latest:\\n' + latest());
    };
    try {
      await wait(f => f.includes('line 20'));
      scrollRef.scrollBy(3);
      await wait(f => f.includes('Jump to bottom · fn+↓ to scroll'));
      stdin.write('\\x1b[<0;5;2M\\x1b[<32;5;2M');
      await Bun.sleep(20);
      if (!latest().includes('Jump to bottom · fn+↓ to scroll')) throw new Error('Should stay visible on stationary press');
      stdin.write('\\x1b[<32;12;2M');
      await wait(f => !f.includes('Jump to bottom'));
      stdin.write('\\x1b[<0;12;2m');
      await wait(f => f.includes('Jump to bottom · fn+↓ to scroll'));
      stdin.write('\\x1b[<0;5;2M\\x1b[<32;12;2M');
      await wait(f => !f.includes('Jump to bottom'));
      mouse.setCaptureEnabled(false);
      await wait(f => f.includes('Jump to bottom · fn+↓ to scroll'));
      mouse.setCaptureEnabled(true);
      stdin.write('\\x1b[<0;5;2M\\x1b[<32;12;2M');
      await wait(f => !f.includes('Jump to bottom'));
      mouse.stdin.setRawMode(false);
      await wait(f => f.includes('Jump to bottom · fn+↓ to scroll'));
    } finally {
      instance.unmount();
      mouse.dispose();
      stdin.destroy();
      stdout.destroy();
    }
  `;
  const child = Bun.spawnSync([process.execPath, '--config=/dev/null', '--no-env-file', '-e', script], {
    cwd: resolve('apps/tui'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
});
