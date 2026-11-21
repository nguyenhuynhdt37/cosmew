import {afterEach, expect, test} from 'bun:test';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {LspManager, SERVERS, toUtf16Character, toCodePointColumn, type ServerSpec} from '@cosmew/code-intel';
import type {ServiceProcess} from '@cosmew/contracts';
import {SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher, NativeCommandRuntime, type ApprovalRequest} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const fixture = resolve('tests/process-fixtures/fake-lsp.ts');
function setup(mode = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-lsp-')));
  clean.push(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'state'));
  writeFileSync(
    join(root, 'a.ts'),
    'function target() {}\nfunction caller() { target(); }\nfunction callee() {}\nsecretRef();\n',
  );
  writeFileSync(join(root, '.env.ts'), 'SECRET_VALUE');
  writeFileSync(join(root, 'hidden.ts'), 'PROJECT_DENIED_MARKER');
  writeFileSync(join(root, '.git', 'hidden.ts'), 'SECRET_GIT');
  const workspace = new WorkspaceRoot(root);
  const asked: ApprovalRequest[] = [];
  let starts = 0;
  const launch = (): ServiceProcess => {
    starts++;
    const child = spawn(process.execPath, [fixture], {
      cwd: root,
      env: {...process.env, FAKE_LSP_MODE: mode},
      stdio: 'pipe',
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    clean.push(() => {
      child.kill('SIGKILL');
    });
    return {
      pid: child.pid,
      write: data => {
        child.stdin.write(data);
      },
      onData: f => {
        child.stdout.on('data', f);
      },
      onExit: f => {
        child.once('exit', f);
      },
      kill: () => {
        child.kill('SIGKILL');
      },
    };
  };
  const spec: ServerSpec = {
    id: 'typescript',
    extensions: ['.ts'],
    roots: [],
    languageId: () => 'typescript',
    commands: () => [[process.execPath, fixture]],
    install: 'test fixture',
  };
  const manager = new LspManager({workspace, launch, servers: [spec], canRead: () => true, requestTimeoutMs: 100});
  clean.push(() => manager.shutdown());
  const dispatcher = new ToolDispatcher({
    workspace,
    grants: new SessionGrants(),
    stateDirectory: join(root, 'state'),
    readPolicy: path => (path === 'hidden.ts' ? 'deny' : undefined),
    codeIntel: manager,
    redact: t => t,
    approve: async r => {
      asked.push(r);
      return 'deny';
    },
  });
  const call = (name: string, input: unknown, signal?: AbortSignal) =>
    dispatcher.invoke({id: crypto.randomUUID(), name, input}, signal);
  const lsp = (operation: string, extra: Record<string, unknown> = {}) =>
    call('lsp', {operation, path: 'a.ts', line: 1, character: 10, ...extra});
  return {root, workspace, manager, call, lsp, asked, starts: () => starts};
}

test('LSP fixture supports all nine operations through the dispatcher', async () => {
  const s = setup();
  for (const op of [
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
    'goToImplementation',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
  ]) {
    const result = await s.lsp(op, op === 'workspaceSymbol' ? {query: 'target'} : {});
    expect({op, status: result.status}).toEqual({op, status: 'ok'});
    expect(result.content).toContain(op === 'incomingCalls' ? 'caller' : op === 'outgoingCalls' ? 'callee' : 'target');
  }
  expect(s.starts()).toBe(1);
});

test('LSP rename authorizes its source read before starting a server', async () => {
  const s = setup();
  const denied = await s.call('lsp_rename', {path: '.git/hidden.ts', line: 1, character: 1, newName: 'renamed'});
  expect(denied.status).toBe('denied');
  expect(s.starts()).toBe(0);
  const secret = await s.call('lsp_rename', {path: '.env.ts', line: 1, character: 1, newName: 'renamed'});
  expect(secret.status).toBe('denied');
  expect(s.starts()).toBe(0);
  expect(s.asked).toHaveLength(1);
});

test('LSP rename uses patch approval and denial leaves files intact', async () => {
  const s = setup();
  const before = readFileSync(join(s.root, 'a.ts'), 'utf8');
  const result = await s.call('lsp_rename', {path: 'a.ts', line: 1, character: 10, newName: 'renamed'});
  expect(result.status).toBe('denied');
  expect(s.asked.at(-1)?.capability).toBe('fs.write');
  expect(s.asked.at(-1)?.diffPreview).toContain('renamed');
  expect(readFileSync(join(s.root, 'a.ts'), 'utf8')).toBe(before);
});

test('LSP references omit Git internals and never quote secrets or outside files', async () => {
  const s = setup();
  const result = await s.lsp('findReferences', {line: 4, character: 1});
  expect(result.status).toBe('ok');
  expect(result.content).not.toContain('SECRET');
  expect(result.content).not.toContain('PROJECT_DENIED_MARKER');
  expect(result.content).not.toContain('hidden.ts');
  expect(result.content).not.toContain('.git');
  expect(result.content).toContain('outside the workspace');
});

test('LSP cancellation and timeout settle requests, and crashed servers restart with a cap', async () => {
  const s = setup('slow');
  expect((await s.lsp('hover')).status).toBe('error');
  const ac = new AbortController();
  const pending = s.call('lsp', {operation: 'hover', path: 'a.ts', line: 1, character: 10}, ac.signal);
  setTimeout(() => ac.abort(), 20);
  await expect(pending).rejects.toMatchObject({code: 'CANCELLED'});
  const crashed = setup('crash');
  for (let i = 0; i < 5; i++) expect((await crashed.lsp('hover')).status).toBe('error');
  expect(crashed.starts()).toBe(4);
});

test('LSP new diagnostics exclude existing errors after line movement and warnings', async () => {
  const s = setup();
  const file = s.workspace.resolve('a.ts');
  writeFileSync(join(s.root, 'a.ts'), 'ERR: old\n');
  const first = await s.manager.newErrors(file, undefined);
  expect(first?.errors).toHaveLength(1);
  const old = s.manager.knownErrors(file);
  writeFileSync(join(s.root, 'a.ts'), '\nERR: old\nERR: new\nWARN: notice\n');
  const next = await s.manager.newErrors(file, old);
  expect(next?.errors.map(e => e.message)).toEqual(['bad new']);
});

test('LSP positions convert code points to UTF-16 and back', () => {
  expect(toUtf16Character('🌱target', 2)).toBe(2);
  expect(toCodePointColumn('🌱target', 2)).toBe(2);
});

test.skipIf(process.platform !== 'darwin')(
  'real Seatbelt helper is read-only and shuts down with its runtime',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-lsp-sandbox-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    const runtime = new NativeCommandRuntime({workspaceRoot: root});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const localFixture = join(root, 'server.ts');
    writeFileSync(localFixture, readFileSync(fixture));
    const child = runtime.spawnService!([process.execPath, '--config=/dev/null', '--no-env-file', localFixture], root);
    const {LspClient} = await import('@cosmew/code-intel');
    const client = new LspClient(child, root);
    clean.push(() => client.shutdown());
    await client.initialize();
    expect(existsSync(join(root, 'lsp-write-probe'))).toBe(false);
  },
);

test('LSP rename rejects invalid server ranges before presenting a patch', async () => {
  const s = setup('invalid-rename');
  const result = await s.call('lsp_rename', {path: 'a.ts', line: 1, character: 10, newName: 'renamed'});
  expect(result.code).toBe('INVALID_PATCH');
  expect(s.asked).toHaveLength(0);
});

test.skipIf(process.platform !== 'darwin')(
  'LSP helpers cannot read secret files even when commands normally can',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-lsp-secret-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    writeFileSync(join(root, '.env'), 'SERVICE_SECRET');
    const runtime = new NativeCommandRuntime({workspaceRoot: root});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const child = runtime.spawnService!(['/bin/sh', '-c', 'cat .env'], root);
    let output = '';
    child.onData(data => {
      output += Buffer.from(data).toString();
    });
    await new Promise<void>(resolve => child.onExit(() => resolve()));
    expect(output).not.toContain('SERVICE_SECRET');
  },
);

test('watcher re-syncs only opened authorized files after user edits and closes removed documents', async () => {
  const s = setup();
  await s.manager.newErrors(s.workspace.resolve('a.ts'), undefined);
  writeFileSync(join(s.root, 'a.ts'), 'ERR: changed-by-user\n');
  const until = Date.now() + 2500;
  while (
    !s.manager.knownErrors(s.workspace.resolve('a.ts'))?.some(d => d.message === 'bad changed-by-user') &&
    Date.now() < until
  )
    await Bun.sleep(20);
  expect(s.manager.knownErrors(s.workspace.resolve('a.ts'))?.map(d => d.message)).toEqual(['bad changed-by-user']);
});

test.skipIf(process.platform !== 'darwin')(
  'helper supervisor kills same-group descendants when its language-server leader exits',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-lsp-descendants-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    const runtime = new NativeCommandRuntime({workspaceRoot: root});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const child = runtime.spawnService!(['/bin/sh', '-c', 'sleep 90 & echo $!'], root);
    let output = '';
    child.onData(data => {
      output += Buffer.from(data).toString();
    });
    await new Promise<void>(resolve => child.onExit(() => resolve()));
    const pid = Number(output.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    clean.push(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    });
    await runtime.shutdown();
    const until = Date.now() + 2000;
    let alive = true;
    while (Date.now() < until) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  },
);

test.skipIf(process.env.FUTRYN_TEST_REAL_LSP !== '1')(
  'real installed TypeScript LSP handshakes, resolves a definition and applies rename in native sandbox',
  async () => {
    const repository = process.cwd();
    const root = realpathSync(mkdtempSync(join(repository, '.fyn-live-lsp-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({compilerOptions: {target: 'ES2022', module: 'ESNext'}, include: ['a.ts']}),
    );
    writeFileSync(join(root, 'a.ts'), 'export const target = 1;\ntarget;\n');
    const candidates = SERVERS[0]!.commands(repository, repository);
    expect(candidates.length).toBeGreaterThan(0);
    const runtime = new NativeCommandRuntime({workspaceRoot: repository});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const workspace = new WorkspaceRoot(root);
    const spec: ServerSpec = {...SERVERS[0]!, commands: () => candidates};
    const manager = new LspManager({
      workspace,
      servers: [spec],
      launch: (argv, cwd) => runtime.spawnService!(argv, cwd),
    });
    clean.push(() => manager.shutdown());
    const tools = new ToolDispatcher({
      workspace,
      codeIntel: manager,
      grants: new SessionGrants(),
      approve: async () => 'once',
      redact: t => t,
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, readOnly: false}),
    });
    const definition = await tools.invoke({
      id: crypto.randomUUID(),
      name: 'lsp',
      input: {operation: 'goToDefinition', path: 'a.ts', line: 2, character: 1},
    });
    expect(definition.status).toBe('ok');
    expect(definition.content).toContain('a.ts:1:');
    const renamed = await tools.invoke({
      id: crypto.randomUUID(),
      name: 'lsp_rename',
      input: {path: 'a.ts', line: 2, character: 1, newName: 'renamed'},
    });
    expect(renamed.status).toBe('ok');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('export const renamed = 1;\nrenamed;\n');
  },
  30000,
);

test.skipIf(process.env.FUTRYN_TEST_REAL_LSP !== '1')(
  'real TypeScript LSP uses nested Bun project config and retains genuine type errors',
  async () => {
    const repository = process.cwd();
    // This directory is outside the repository tsconfig's include patterns, like generated UAT projects.
    const root = realpathSync(mkdtempSync(join(repository, '.fyn-live-lsp-bun-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({extends: '../tsconfig.json', include: ['a.ts']}));
    const valid = [
      "import {expect} from 'bun:test';",
      "import {existsSync} from 'node:fs';",
      'expect(existsSync(import.meta.dir)).toBe(true);',
      'const result: number = Bun.spawnSync([process.execPath, "--version"]).exitCode;',
      'export {result};',
      '',
    ].join('\n');
    writeFileSync(join(root, 'a.ts'), valid + 'const invalid: number = "wrong";\n');
    const candidates = SERVERS[0]!.commands(repository, repository);
    expect(candidates.length).toBeGreaterThan(0);
    const runtime = new NativeCommandRuntime({workspaceRoot: repository});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const workspace = new WorkspaceRoot(root);
    const manager = new LspManager({
      workspace,
      servers: [{...SERVERS[0]!, commands: () => candidates}],
      launch: (argv, cwd) => runtime.spawnService!(argv, cwd),
    });
    clean.push(() => manager.shutdown());
    const file = workspace.resolve('a.ts');
    const first = await manager.newErrors(file, undefined);
    expect(first).toBeDefined();
    expect(first!.errors.map(d => d.code)).toEqual([2322]);
    const before = manager.knownErrors(file);
    expect(before).toHaveLength(1);
    writeFileSync(join(root, 'a.ts'), valid);
    const corrected = await manager.newErrors(file, before);
    expect(corrected).toBeDefined();
    expect(corrected!.errors).toEqual([]);
    expect(manager.knownErrors(file)).toEqual([]);
  },
  30000,
);

test.skipIf(process.platform !== 'darwin')(
  'killing a helper also kills descendants that ignore TERM',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-lsp-stubborn-')));
    clean.push(() => rmSync(root, {recursive: true, force: true}));
    const runtime = new NativeCommandRuntime({workspaceRoot: root});
    clean.push(() => runtime.shutdown());
    expect(runtime.availability().ok).toBe(true);
    const child = runtime.spawnService!(['/bin/sh', '-c', `sh -c 'trap "" TERM; echo $$; sleep 90' & wait`], root);
    let output = '';
    child.onData(data => {
      output += Buffer.from(data).toString();
    });
    const until = Date.now() + 2000;
    while (!output.trim() && Date.now() < until) await Bun.sleep(10);
    const pid = Number(output.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    clean.push(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    });
    child.kill();
    let alive = true;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await Bun.sleep(20);
    }
    expect(alive).toBe(false);
  },
  6000,
);
