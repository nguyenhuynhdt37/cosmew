/**
 * ADR 0061: the command sandbox follows Claude Code's `/sandbox`: writes only in the working
 * directory and `additionalDirectories`, reads everywhere except deny rules and a default
 * sensitive list, network only through the proxy. Profile checks are textual; the `nativeTest`
 * cases run the real macOS Seatbelt sandbox and observe the host.
 */
import {test, expect, describe, afterEach} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeCommandRuntime, ToolDispatcher, type ApprovalRequest, type ApprovalDecision} from '@cosmew/tools';
import {SeatbeltSandbox} from '../../packages/tools/src/exec/seatbelt-profile';
import {SessionGrants, evaluateExec, evaluateStdin, APPROVAL_KIND_FOR_REASON} from '@cosmew/security';
import {permissionModeDecision, type PermissionKind, type PermissionMode} from '@cosmew/contracts';
import {WorkspaceRoot} from '@cosmew/workspace';
import {sandboxConfig} from '../sandbox-config';

const nativeTest = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});

function profile(sandbox: Parameters<SeatbeltSandbox['profile']>[0], loopback?: boolean) {
  return new SeatbeltSandbox({
    workspace: '/Users/dev/outer/app',
    scratch: '/var/folders/x/T/fyn-exec-1',
    home: '/Users/dev',
    state: '/Users/dev/.futryn',
    loopback,
  }).profile(sandbox);
}

describe('seatbelt profile', () => {
  test('loopback bind/connect is the only network; there is no rule that opens the network', () => {
    const text = profile({mode: 'workspace-write', network: false});
    expect(text).toContain('(deny network*)');
    expect(text).toContain('(allow network-bind (local ip "*:*"))');
    expect(text).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(text).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(text).not.toContain('(allow network*)');
    expect(text).not.toContain('(allow network-outbound)');
    // Even a sandbox flagged `network` (only meaningful for unsandboxed commands) opens nothing.
    expect(profile({mode: 'workspace-write', network: true})).not.toContain('(allow network*)');
    const proxied = profile({mode: 'workspace-write', network: false, proxyUrl: 'http://127.0.0.1:5555'});
    expect(proxied).not.toContain('(allow network*)');
    expect(proxied).toContain('com.apple.trustd.agent');
    expect(text).not.toContain('com.apple.trustd.agent');
  });

  test('helper services (language servers) keep no network at all', () => {
    const text = profile({mode: 'read-only', network: false}, false);
    expect(text).toContain('(deny network*)');
    expect(text).not.toContain('network-bind');
  });

  test('reads are open, the sensitive list and secret names under home are denied, writes only in roots', () => {
    const text = profile({
      mode: 'workspace-write',
      network: false,
      writableRoots: ['/Users/dev/extra'],
      denyRead: ['/Users/dev/outer/app/private/**'],
      denyWrite: ['/Users/dev/outer/app/dist/**'],
    });
    expect(text).toContain('(allow file-read*)');
    expect(text).not.toContain('(deny file-read* (subpath "/Users")');
    expect(text).toContain('(subpath "/Users/dev/.ssh")');
    expect(text).toContain('(subpath "/Users/dev/.aws")');
    expect(text).toContain('(subpath "/Users/dev/.gnupg")');
    expect(text).toContain('(subpath "/Users/dev/Library/Keychains")');
    expect(text).toContain('(subpath "/Users/dev/Library/Application Support/Google/Chrome")');
    expect(text).toContain('(subpath "/Users/dev/.futryn")');
    expect(text).toContain('(allow file-write* (subpath "/Users/dev/outer/app") (subpath "/Users/dev/extra"))');
    expect(text).not.toContain('(subpath "/private/tmp")');
    // `.git` and Futryn state are protected in every writable root.
    expect(text).toContain('(deny file-write* (regex #"^/Users/dev/extra/(.*/)?\\.[gG][iI][tT](/|$)"))');
    expect(text).toContain('(regex #"^/Users/dev/extra/(.*/)?\\.(futryn|hannes)(/|$)")');
    expect(text).toContain('(deny file-read* file-write* (regex #"^/Users/dev/outer/app/private/');
    expect(text).toContain('(deny file-write* (regex #"^/Users/dev/outer/app/dist/');
    // The workspace itself is exempt from the home secret-name rule (dev tools read their own `.env`).
    expect(text).toContain('(require-not (subpath "/Users/dev/outer/app"))');
    const readOnly = profile({mode: 'read-only', network: false, writableRoots: ['/Users/dev/extra']});
    expect(readOnly).not.toContain('(subpath "/Users/dev/extra")');
  });

  test('FSEvents may be looked up so file watchers start', () => {
    expect(profile({mode: 'workspace-write', network: false})).toContain('(global-name "com.apple.FSEvents")');
  });
});

function nested(home?: string) {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-align-')));
  const root = join(outer, 'app');
  mkdirSync(join(outer, '.git'));
  writeFileSync(join(outer, '.git', 'HEAD'), 'ref: refs/heads/outer\n');
  mkdirSync(join(root, '.git'), {recursive: true});
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/inner\n');
  const runtime = new NativeCommandRuntime({workspaceRoot: root, ...(home ? {home} : {})});
  clean.push(
    () => rmSync(outer, {recursive: true, force: true}),
    () => runtime.shutdown(),
  );
  const run = (command: string, sandbox: Partial<Parameters<typeof runtime.run>[0]['sandbox'] & {}> = {}) =>
    runtime.run({
      command,
      cwd: root,
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
      sandbox: {mode: 'workspace-write', network: false, ...sandbox},
    });
  return {outer, root, runtime, run};
}

describe('real Seatbelt', () => {
  nativeTest('.git (own and parent) is readable but never writable', async () => {
    const h = nested();
    expect(h.runtime.availability()).toEqual({ok: true});
    const read = await h.run('cat .git/HEAD ../.git/HEAD');
    expect(read.exitCode).toBe(0);
    expect(read.output).toContain('refs/heads/inner');
    expect(read.output).toContain('refs/heads/outer');
    const write = await h.run('touch .git/x; touch ../.git/y; echo done');
    expect(existsSync(join(h.root, '.git', 'x'))).toBe(false);
    expect(existsSync(join(h.outer, '.git', 'y'))).toBe(false);
    expect(write.output).toContain('done');
  });

  nativeTest('~/.ssh and friends are unreadable while other home files and the system stay readable', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-home-')));
    clean.push(() => rmSync(home, {recursive: true, force: true}));
    mkdirSync(join(home, '.ssh'));
    mkdirSync(join(home, '.aws'));
    mkdirSync(join(home, 'Library', 'Keychains'), {recursive: true});
    mkdirSync(join(home, 'documents'));
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE_KEY_MARKER');
    writeFileSync(join(home, '.aws', 'credentials'), 'AWS_MARKER');
    writeFileSync(join(home, 'Library', 'Keychains', 'login.keychain'), 'KEYCHAIN_MARKER');
    writeFileSync(join(home, 'documents', 'notes.txt'), 'PLAIN_NOTES');
    writeFileSync(join(home, 'documents', '.env'), 'HOME_ENV_MARKER');
    writeFileSync(join(home, '.npmrc'), 'NPM_TOKEN_MARKER');
    const h = nested(home);
    expect(h.runtime.availability()).toEqual({ok: true});
    const hidden = await h.run(
      `cat ${home}/.ssh/id_ed25519 ${home}/.aws/credentials ${home}/Library/Keychains/login.keychain ${home}/documents/.env ${home}/.npmrc 2>&1`,
    );
    expect(hidden.output).not.toContain('PRIVATE_KEY_MARKER');
    expect(hidden.output).not.toContain('AWS_MARKER');
    expect(hidden.output).not.toContain('KEYCHAIN_MARKER');
    expect(hidden.output).not.toContain('HOME_ENV_MARKER');
    expect(hidden.output).not.toContain('NPM_TOKEN_MARKER');
    const visible = await h.run(`cat ${home}/documents/notes.txt; ls /usr/bin | head -1`);
    expect(visible.output).toContain('PLAIN_NOTES');
    expect(visible.exitCode).toBe(0);
  });

  nativeTest('writes land only in the working directory and additionalDirectories', async () => {
    const extra = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-extra-')));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-elsewhere-')));
    clean.push(
      () => rmSync(extra, {recursive: true, force: true}),
      () => rmSync(elsewhere, {recursive: true, force: true}),
    );
    mkdirSync(join(extra, '.git'));
    const h = nested();
    await h.run(
      `echo a > inside.txt; echo b > ${extra}/extra.txt; echo c > ${elsewhere}/outside.txt; touch ${extra}/.git/x`,
      {
        writableRoots: [extra],
      },
    );
    expect(readFileSync(join(h.root, 'inside.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(extra, 'extra.txt'), 'utf8')).toBe('b\n');
    expect(existsSync(join(elsewhere, 'outside.txt'))).toBe(false);
    expect(existsSync(join(extra, '.git', 'x'))).toBe(false);
    // Without the extra root the same write is refused.
    const refused = await h.run(`echo b > ${extra}/second.txt`);
    expect(existsSync(join(extra, 'second.txt'))).toBe(false);
    expect(refused.output).toContain('Operation not permitted');
    // Nor can a command write /tmp: the only temp directory is its private TMPDIR.
    const tmp = await h.run('echo t > /tmp/fyn-claude-sandbox-probe 2>&1; echo $TMPDIR');
    expect(existsSync('/tmp/fyn-claude-sandbox-probe')).toBe(false);
    expect(tmp.output).toMatch(/fyn-exec-/);
  });

  nativeTest('Read(...) and Edit(...) deny rules reach commands through denyRead/denyWrite', async () => {
    const h = nested();
    mkdirSync(join(h.root, 'private'));
    mkdirSync(join(h.root, 'dist'));
    writeFileSync(join(h.root, 'private', 'plan.txt'), 'SECRET_PLAN');
    writeFileSync(join(h.root, 'public.txt'), 'PUBLIC');
    const out = await h.run('cat private/plan.txt public.txt 2>&1; echo x > dist/a.js 2>&1; echo y > fine.js', {
      denyRead: [join(h.root, 'private/**')],
      denyWrite: [join(h.root, 'dist/**')],
    });
    expect(out.output).not.toContain('SECRET_PLAN');
    expect(out.output).toContain('PUBLIC');
    expect(existsSync(join(h.root, 'dist', 'a.js'))).toBe(false);
    expect(readFileSync(join(h.root, 'fine.js'), 'utf8')).toBe('y\n');
  });

  nativeTest('a dev server may listen on 0.0.0.0 and be reached on localhost', async () => {
    const h = nested();
    const script = `
      const net = require('node:net');
      const s = net.createServer(c => c.end('pong')).listen(0, '0.0.0.0', () => {
        const c = net.connect(s.address().port, '127.0.0.1');
        c.on('data', d => { console.log('LOOPBACK', String(d)); process.exit(0); });
        c.on('error', e => { console.log('LOOPBACK_ERR', e.code); process.exit(1); });
      });
      s.on('error', e => { console.log('LISTEN_ERR', e.code); process.exit(1); });`;
    const outcome = await h.run(`bun -e '${script.replace(/'/g, "'\\''")}'`);
    expect(outcome.output).toContain('LOOPBACK pong');
  });

  // Seatbelt reports a denied connect as ECONNREFUSED. 192.0.2.1 (TEST-NET-1) never answers.
  nativeTest('direct egress to an external address is refused at once, with or without proxy variables', async () => {
    const h = nested();
    const probe = (extra: Partial<Parameters<typeof h.run>[1] & {}> = {}) =>
      h.run(
        `bun -e 'const c=require("node:net").connect(443,"192.0.2.1");c.on("connect",()=>{console.log("CONNECTED");process.exit(0)});c.on("error",e=>{console.log("ERR",e.code);process.exit(1)});setTimeout(()=>{console.log("TIMEOUT");process.exit(2)},2000)'`,
        extra,
      );
    expect((await probe()).output).toContain('ERR ECONNREFUSED');
    expect((await probe({proxyUrl: 'http://127.0.0.1:9'})).output).toContain('ERR ECONNREFUSED');
  });

  // Node's recursive watcher is FSEvents on macOS (like Turbopack's); without the mach service it
  // falls over with EMFILE. Bun's own watcher does not use it, so the probe needs node.
  nativeTest.skipIf(!Bun.which('node'))('a recursive file watcher starts (FSEvents)', async () => {
    const h = nested();
    const outcome = await h.run(
      `node -e 'const w=require("node:fs").watch(".",{recursive:true},()=>{});setTimeout(()=>{w.close();console.log("WATCH_OK")},300)'`,
    );
    expect(outcome.output).toContain('WATCH_OK');
  });

  nativeTest('package-manager caches live in the private scratch directory, not in the real home', async () => {
    const h = nested();
    const outcome = await h.run(
      'for v in npm_config_cache YARN_CACHE_FOLDER XDG_CACHE_HOME npm_config_store_dir; do eval d=\\$$v; mkdir -p "$d/probe" && echo "$v=$d"; done; echo HOME=$HOME',
    );
    expect(outcome.exitCode).toBe(0);
    const real = process.env.HOME ?? '/nonexistent';
    expect(outcome.output).not.toContain(`=${real}/`);
    expect(outcome.output).toMatch(/npm_config_cache=.*fyn-exec-/);
    expect(outcome.output).toMatch(/XDG_CACHE_HOME=.*fyn-exec-/);
  });
});

function harness(options: {answer?: ApprovalDecision; allowUnsandboxed?: boolean; enabled?: boolean} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-escal-')));
  const runtime = new NativeCommandRuntime({workspaceRoot: root});
  clean.push(
    () => rmSync(root, {recursive: true, force: true}),
    () => runtime.shutdown(),
  );
  const prompts: ApprovalRequest[] = [];
  const grants = new SessionGrants();
  let answer: ApprovalDecision = options.answer ?? 'once';
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    commands: runtime,
    sandbox: () =>
      sandboxConfig({allowUnsandboxed: options.allowUnsandboxed !== false, enabled: options.enabled !== false}),
    redact: s => s,
    approve: async r => {
      prompts.push(r);
      return answer;
    },
  });
  return {
    root,
    prompts,
    grants,
    setAnswer: (a: ApprovalDecision) => {
      answer = a;
    },
    exec: (input: Record<string, unknown>) => dispatcher.invoke({id: crypto.randomUUID(), name: 'exec_command', input}),
  };
}

describe('escape hatch (dangerouslyDisableSandbox)', () => {
  nativeTest(
    'asks first, names the missing sandbox, runs that command unsandboxed; a session answer covers exactly that command',
    async () => {
      const h = harness();
      // Outside the workspace: impossible in the sandbox, so success proves it ran unsandboxed.
      const target = join(tmpdir(), `fyn-escalated-${crypto.randomUUID()}`);
      clean.push(() => rmSync(target, {force: true}));
      const input = {
        cmd: `touch ${target}`,
        dangerouslyDisableSandbox: true,
        justification: 'write a marker outside the project',
      };
      const sandboxed = await h.exec({cmd: `touch ${target}`});
      expect(sandboxed.code).toBe('SANDBOX_DENIED');
      expect(sandboxed.content).toContain('dangerouslyDisableSandbox');
      expect(existsSync(target)).toBe(false);

      h.prompts.length = 0;
      h.setAnswer('session');
      const done = await h.exec(input);
      expect(done.status).toBe('ok');
      expect(existsSync(target)).toBe(true);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toMatchObject({
        unsandboxed: true,
        reason: 'unsandboxed-escalation',
        sandbox: 'NO SANDBOX',
        justification: 'write a marker outside the project',
      });
      // "for session" is remembered for exactly this command, directory and sandbox.
      rmSync(target);
      await h.exec(input);
      expect(h.prompts).toHaveLength(1);
      expect(existsSync(target)).toBe(true);
      // A different escalated command is a different key and asks again.
      await h.exec({...input, cmd: `touch ${target}.other`});
      clean.push(() => rmSync(`${target}.other`, {force: true}));
      expect(h.prompts).toHaveLength(2);
      // And a plain sandboxed run of the same text is still sandboxed.
      rmSync(target);
      expect((await h.exec({cmd: `touch ${target}`})).code).toBe('SANDBOX_DENIED');
    },
  );

  nativeTest(
    'a justification is required; denied runs nothing; allowUnsandboxedCommands=false refuses without asking',
    async () => {
      const target = join(tmpdir(), `fyn-escalated-${crypto.randomUUID()}`);
      clean.push(() => rmSync(target, {force: true}));
      const input = {cmd: `touch ${target}`, dangerouslyDisableSandbox: true, justification: 'x'};
      const denied = harness({answer: 'deny'});
      expect((await denied.exec(input)).status).toBe('denied');
      expect((await denied.exec({cmd: `touch ${target}`, dangerouslyDisableSandbox: true})).code).toBe('INVALID_INPUT');
      expect(existsSync(target)).toBe(false);
      const never = harness({allowUnsandboxed: false});
      const refused = await never.exec(input);
      expect(refused.status).toBe('denied');
      expect(refused.content).toContain('allowUnsandboxedCommands');
      expect(never.prompts).toHaveLength(0);
      expect(existsSync(target)).toBe(false);
      // When the setting forbids it the model is not told it may retry with the escape hatch.
      const hint = await never.exec({cmd: `touch ${target}`});
      expect(hint.code).toBe('SANDBOX_DENIED');
      expect(hint.content).not.toContain('dangerouslyDisableSandbox true');
    },
  );

  nativeTest(
    'sandbox.enabled=false runs commands outside the OS sandbox through the normal permission flow',
    async () => {
      const h = harness({enabled: false});
      const outside = join(tmpdir(), `fyn-disabled-${crypto.randomUUID()}`);
      clean.push(() => rmSync(outside, {force: true}));
      const result = await h.exec({cmd: `touch ${outside}`});
      expect(result.status).toBe('ok');
      expect(existsSync(outside)).toBe(true);
      expect(h.prompts[0]).toMatchObject({reason: 'unsandboxed-session', sandbox: 'NO SANDBOX'});
    },
  );
});

describe('policy', () => {
  const ws = {mode: 'workspace-write' as const};
  const sandboxed = {sandbox: ws, classification: {dangerous: null}};

  test('exec decisions name their kind: sandboxed commands auto-allow, everything else asks', () => {
    expect(evaluateExec('ls', '.', '/ws', sandboxed)).toEqual({effect: 'ask', reason: 'sandboxed-command'});
    expect(evaluateExec('ls', '.', '/ws', {...sandboxed, autoAllow: false})).toEqual({
      effect: 'ask',
      reason: 'process-execute',
    });
    expect(evaluateExec('ls', '.', '/ws', {sandbox: {...ws, unsandboxed: true}}).reason).toBe('unsandboxed-session');
    expect(evaluateExec('ls', '.', '/ws', {sandbox: {...ws, unsandboxed: true}, excluded: true}).reason).toBe(
      'excluded-command',
    );
    expect(evaluateExec('ls', '.', '/ws', {...sandboxed, escalation: true})).toEqual({
      effect: 'ask',
      reason: 'unsandboxed-escalation',
    });
    expect(evaluateExec('ls', '.', '/ws', {...sandboxed, escalation: true, unsandboxedAllowed: false})).toEqual({
      effect: 'deny',
      reason: 'unsandboxed-forbidden',
    });
    // The dangerous heuristic does not change the kind: the sandbox is the boundary.
    expect(evaluateExec('rm -rf x', '.', '/ws', {...sandboxed, classification: {dangerous: 'forced-rm'}}).reason).toBe(
      'sandboxed-command',
    );
    expect(APPROVAL_KIND_FOR_REASON['sandboxed-command']).toBe('sandboxed-command');
    expect(APPROVAL_KIND_FOR_REASON['unsandboxed-escalation']).toBe('escalation');
  });

  test('terminal input follows the launch sandbox; a tightened sandbox refuses it', () => {
    const input = {chars: 'y\n', interrupt: false, tty: true};
    expect(evaluateStdin({...input, launch: ws, current: ws}).reason).toBe('stdin-sandboxed');
    expect(
      evaluateStdin({
        ...input,
        launch: {mode: 'danger-full-access', unsandboxed: true},
        current: {mode: 'danger-full-access'},
      }).reason,
    ).toBe('stdin-unsandboxed');
    expect(evaluateStdin({...input, launch: ws, current: {mode: 'read-only'}}).reason).toBe('stdin-policy-tightened');
    expect(evaluateStdin({chars: '', interrupt: false, tty: true, launch: ws, current: ws}).effect).toBe('allow');
  });

  test('the mode matrix: kinds x modes', () => {
    const table: Record<PermissionMode, Record<PermissionKind, 'allow' | 'ask' | 'deny'>> = {
      default: {
        read: 'allow',
        secret: 'ask',
        edit: 'ask',
        'sandboxed-command': 'allow',
        command: 'ask',
        escalation: 'ask',
        network: 'ask',
        other: 'ask',
      },
      acceptEdits: {
        read: 'allow',
        secret: 'ask',
        edit: 'allow',
        'sandboxed-command': 'allow',
        command: 'ask',
        escalation: 'ask',
        network: 'ask',
        other: 'ask',
      },
      plan: {
        read: 'allow',
        secret: 'ask',
        edit: 'deny',
        'sandboxed-command': 'deny',
        command: 'deny',
        escalation: 'deny',
        network: 'deny',
        other: 'ask',
      },
      bypassPermissions: {
        read: 'allow',
        secret: 'allow',
        edit: 'allow',
        'sandboxed-command': 'allow',
        command: 'allow',
        escalation: 'allow',
        network: 'allow',
        other: 'allow',
      },
    };
    for (const mode of Object.keys(table) as PermissionMode[])
      for (const kind of Object.keys(table[mode]) as PermissionKind[])
        expect({mode, kind, decision: permissionModeDecision(mode, kind)}).toEqual({
          mode,
          kind,
          decision: table[mode][kind],
        });
  });
});
