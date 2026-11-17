/**
 * ADR 0053: Futryn's command sandbox and approvals follow Codex (pinned 090be4df). Profile checks
 * are textual; the `nativeTest` cases run the real macOS Seatbelt sandbox and observe the host.
 */
import {test, expect, describe, afterEach} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {NativeCommandRuntime, ToolDispatcher, type ApprovalRequest} from '@futryn/tools';
import {SeatbeltSandbox} from '../../packages/tools/src/exec/seatbelt-profile';
import type {ApprovalDecision} from '@futryn/tools';
import {SessionGrants, evaluateExec, evaluateStdin} from '@futryn/security';
import {decideApproval, permissionModeDecision} from '@futryn/contracts';
import {WorkspaceRoot} from '@futryn/workspace';

const nativeTest = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});

function profile(sandbox: {mode: 'read-only' | 'workspace-write'; network: boolean}, loopback?: boolean) {
  return new SeatbeltSandbox({
    workspace: '/Users/dev/outer/app',
    scratch: '/var/folders/x/T/fyn-exec-1',
    home: '/Users/dev',
    toolchains: [],
    loopback,
  }).profile(sandbox);
}

describe('seatbelt profile', () => {
  test('loopback bind/connect is allowed without network approval, external network is not', () => {
    const text = profile({mode: 'workspace-write', network: false});
    expect(text).toContain('(deny network*)');
    expect(text).toContain('(allow network-bind (local ip "*:*"))');
    expect(text).toContain('(allow network-inbound (local ip "localhost:*"))');
    expect(text).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(text).not.toContain('(allow network*)');
    expect(text).not.toContain('(allow network-outbound)');
    expect(profile({mode: 'workspace-write', network: true})).toContain('(allow network*)');
  });

  test('helper services (language servers) keep no network at all', () => {
    const text = profile({mode: 'read-only', network: false}, false);
    expect(text).toContain('(deny network*)');
    expect(text).not.toContain('network-bind');
  });

  test('.git of the workspace and of every parent is readable; writing .git stays denied', () => {
    const text = profile({mode: 'workspace-write', network: false});
    expect(text).toContain('(allow file-read* (subpath "/Users/dev/outer/.git"))');
    expect(text).toContain('(allow file-read* (subpath "/Users/dev/.git"))');
    expect(text).toContain('(deny file-write* (regex #"^/Users/dev/outer/app/(.*/)?\\.[gG][iI][tT](/|$)"))');
    // No rule ever denies reading .git (only secrets, Futryn state and the home directory are hidden).
    expect(text).not.toMatch(/deny file-read\*[^\n]*\\\.\[gG\]\[iI\]\[tT\]/);
  });

  test('FSEvents may be looked up so file watchers start', () => {
    expect(profile({mode: 'workspace-write', network: false})).toContain('(global-name "com.apple.FSEvents")');
  });
});

function nested() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-align-')));
  const root = join(outer, 'app');
  mkdirSync(join(outer, '.git'));
  writeFileSync(join(outer, '.git', 'HEAD'), 'ref: refs/heads/outer\n');
  mkdirSync(join(root, '.git'), {recursive: true});
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/inner\n');
  const runtime = new NativeCommandRuntime({workspaceRoot: root});
  clean.push(
    () => rmSync(outer, {recursive: true, force: true}),
    () => runtime.shutdown(),
  );
  const run = (command: string, network = false) =>
    runtime.run({
      command,
      cwd: root,
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
      sandbox: {mode: 'workspace-write', network},
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

  // Seatbelt reports a denied connect as ECONNREFUSED. 192.0.2.1 (TEST-NET-1) never answers, so
  // with network approved the same connect must not be refused instantly: it hangs or has no route.
  nativeTest('an external address is refused at once without a network grant, not with one', async () => {
    const h = nested();
    const probe = (network: boolean) =>
      h.run(
        `bun -e 'const c=require("node:net").connect(443,"192.0.2.1");c.on("connect",()=>{console.log("CONNECTED");process.exit(0)});c.on("error",e=>{console.log("ERR",e.code);process.exit(1)});setTimeout(()=>{console.log("TIMEOUT");process.exit(2)},2000)'`,
        network,
      );
    expect((await probe(false)).output).toContain('ERR ECONNREFUSED');
    expect((await probe(true)).output).not.toContain('ERR ECONNREFUSED');
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

function harness(options: {answer?: ApprovalDecision; escalation?: 'on-request' | 'never'} = {}) {
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
    sandbox: () => ({mode: 'workspace-write', escalation: options.escalation ?? 'on-request'}),
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

describe('escalation (require_escalated)', () => {
  nativeTest('asks first, names the missing sandbox, runs that one command unsandboxed, and never again', async () => {
    const h = harness();
    // Outside the workspace: impossible in the sandbox, so success proves it ran unsandboxed.
    const target = join(tmpdir(), `fyn-escalated-${crypto.randomUUID()}`);
    clean.push(() => rmSync(target, {force: true}));
    const input = {
      cmd: `touch ${target}`,
      sandbox_permissions: 'require_escalated',
      justification: 'write a marker outside the project',
    };
    const sandboxed = await h.exec({cmd: `touch ${target}`});
    expect(sandboxed.code).toBe('SANDBOX_DENIED');
    expect(sandboxed.content).toContain('require_escalated');
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
    // "Allow for session" is not a reusable grant for an escalation: the same call asks again.
    rmSync(target);
    await h.exec(input);
    expect(h.prompts).toHaveLength(2);
    expect(existsSync(target)).toBe(true);
    // And a plain sandboxed run of the same text is still sandboxed.
    rmSync(target);
    expect((await h.exec({cmd: `touch ${target}`})).code).toBe('SANDBOX_DENIED');
  });

  nativeTest('denied runs nothing; the "never" policy refuses without asking', async () => {
    const target = join(tmpdir(), `fyn-escalated-${crypto.randomUUID()}`);
    clean.push(() => rmSync(target, {force: true}));
    const input = {cmd: `touch ${target}`, sandbox_permissions: 'require_escalated', justification: 'x'};
    const denied = harness({answer: 'deny'});
    expect((await denied.exec(input)).status).toBe('denied');
    expect(existsSync(target)).toBe(false);
    const never = harness({escalation: 'never'});
    const refused = await never.exec(input);
    expect(refused.status).toBe('denied');
    expect(refused.content).toContain('never');
    expect(never.prompts).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
    // Under never the model is not told it may retry with escalation.
    const hint = await never.exec({cmd: `touch ${target}`});
    expect(hint.code).toBe('SANDBOX_DENIED');
    expect(hint.content).not.toContain('require_escalated');
  });
});

describe('policy', () => {
  const ws = {mode: 'workspace-write' as const, network: false};
  const ctx = {sandbox: ws, configuredMode: 'workspace-write' as const};

  test('an escalation always asks (even with network granted) and is forbidden under never', () => {
    const escalated = {...ws, unsandboxed: true};
    const classification = {dangerous: null};
    expect(evaluateExec('ls', '.', '/ws', {...ctx, sandbox: escalated, classification})).toEqual({
      effect: 'ask',
      reason: 'unsandboxed-escalation',
    });
    expect(
      evaluateExec('ls', '.', '/ws', {...ctx, sandbox: escalated, classification, networkGranted: true}).effect,
    ).toBe('ask');
    expect(evaluateExec('ls', '.', '/ws', {...ctx, sandbox: escalated, classification, escalation: 'never'})).toEqual({
      effect: 'deny',
      reason: 'escalation-forbidden',
    });
    expect(permissionModeDecision('auto', 'escalation')).toBe('ask');
    expect(permissionModeDecision('bypassPermissions', 'escalation')).toBe('deny');
  });

  test('unparsed scripts and terminal input follow the approval policy: auto-run on-request/never, ask untrusted', () => {
    for (const kind of ['execute', 'stdin'] as const) {
      expect(decideApproval('untrusted', kind)).toBe('ask');
      expect(decideApproval('on-request', kind)).toBe('allow');
      expect(decideApproval('never', kind)).toBe('allow');
    }
    expect(decideApproval('on-request', 'dangerous')).toBe('ask');
    expect(decideApproval('never', 'dangerous')).toBe('deny');
    const complex = evaluateExec('ls -la && (command -v pnpm || true)', '.', '/ws', {
      ...ctx,
      classification: {dangerous: 'other'},
    });
    expect(complex.reason).toBe('unverified-command');
    expect(permissionModeDecision('auto', 'execute')).toBe('allow');
    expect(permissionModeDecision('default', 'execute')).toBe('ask');
    const stdin = evaluateStdin({chars: 'y\n', interrupt: false, tty: true, launch: ws, current: ws});
    expect(stdin.reason).toBe('stdin-input-approval-required');
  });
});
