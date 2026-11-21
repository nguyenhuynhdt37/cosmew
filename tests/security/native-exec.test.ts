/**
 * ADR 0035 acceptance against the real macOS Seatbelt sandbox (runs on macOS hosts with
 * /usr/bin/sandbox-exec). Every assertion observes the real host filesystem, process table or
 * dispatcher; nothing is a mock runtime. Section letters follow the Task 02 test matrix.
 */
import {test, expect, afterEach} from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {NativeCommandRuntime, ToolDispatcher, type ApprovalRequest, type ApprovalDecision} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {sandboxConfig} from '../sandbox-config';
import {SessionGrants} from '@cosmew/security';
import type {ToolResult} from '@cosmew/contracts';
import {observe, current, waitFor, dispose} from '../process-fixtures/observe';

const nativeTest = test.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'));
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
const git = (root: string, ...args: string[]) =>
  spawnSync(
    'git',
    ['-C', root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    {encoding: 'utf8'},
  );

function harness(
  options: {
    answer?: ApprovalDecision;
    escalation?: 'on-request' | 'never';
    hideSecrets?: boolean;
    proxy?: {ensure(): Promise<string>};
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-native-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-native-outside-')));
  const state = join(root, '.fyn-state');
  mkdirSync(state);
  writeFileSync(join(state, 'credentials.json'), 'STATE_SECRET');
  const runtime = new NativeCommandRuntime({
    workspaceRoot: root,
    stateDirectory: state,
    hideSecrets: options.hideSecrets,
  });
  clean.push(
    () => {
      rmSync(root, {recursive: true, force: true});
      rmSync(outside, {recursive: true, force: true});
    },
    () => runtime.shutdown(),
  );
  const grants = new SessionGrants();
  const prompts: ApprovalRequest[] = [];
  const config = sandboxConfig({allowUnsandboxed: options.escalation !== 'never'});
  let answer: ApprovalDecision | (() => ApprovalDecision) = options.answer ?? 'once';
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    commands: runtime,
    stateDirectory: state,
    sandbox: () => ({...config}),
    ...(options.proxy ? {proxy: options.proxy} : {}),
    redact: s => s,
    approve: async r => {
      prompts.push(r);
      return typeof answer === 'function' ? answer() : answer;
    },
  });
  const call = (name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> =>
    dispatcher.invoke({id: crypto.randomUUID(), name, input}, signal);
  return {
    root,
    outside,
    state,
    runtime,
    grants,
    prompts,
    config,
    setAnswer: (a: typeof answer) => {
      answer = a;
    },
    exec: (input: Record<string, unknown>, signal?: AbortSignal) => call('exec_command', input, signal),
    stdin: (input: Record<string, unknown>) => call('write_stdin', input),
    call,
  };
}
const sessionOf = (r: ToolResult) => /Running session: ([a-f0-9-]{36})/.exec(r.content)?.[1];
async function until(h: ReturnType<typeof harness>, id: string, predicate: (r: ToolResult) => boolean) {
  for (let i = 0; i < 40; i++) {
    const r = await h.stdin({session_id: id, yield_time_ms: 500});
    if (predicate(r)) return r;
  }
  throw new Error('session never reached the expected state');
}

nativeTest(
  'A 1-6: bash writes reach the real workspace; read, bash, apply_patch and git observe the same files; .git is read-only',
  async () => {
    const h = harness();
    expect(h.runtime.availability()).toEqual({ok: true});
    writeFileSync(join(h.root, 'README.md'), '# fixture\n');
    expect(git(h.root, 'init', '-q').status).toBe(0);
    git(h.root, 'add', 'README.md');
    expect(git(h.root, 'commit', '-qm', 'init').status).toBe(0);
    const created = await h.exec({
      cmd: "mkdir -p src/components && printf 'export const value = 42;\\n' > src/value.ts && pwd",
    });
    expect(created.exitCode).toBe(0);
    expect(created.content).toContain(h.root);
    expect(readFileSync(join(h.root, 'src/value.ts'), 'utf8')).toBe('export const value = 42;\n');
    expect((await h.call('read', {path: 'src/value.ts'})).content).toContain('value = 42');
    expect(
      (await h.exec({cmd: "sed -i '' 's/42/43/' src/value.ts && cat src/value.ts && echo '## changed' >> README.md"}))
        .content,
    ).toContain('value = 43');
    expect(
      (
        await h.call('apply_patch', {
          patch:
            '*** Begin Patch\n*** Update File: src/value.ts\n@@\n-export const value = 43;\n+export const value = 44;\n*** End Patch',
        })
      ).status,
    ).toBe('ok');
    expect((await h.exec({cmd: 'cat src/value.ts'})).content).toContain('value = 44');
    const diff = await h.exec({cmd: 'git status --short && git diff'});
    expect(diff.exitCode).toBe(0);
    expect(diff.content).toContain('?? src/');
    expect(diff.content).toContain('+## changed');
    const add = await h.exec({cmd: 'git add src/value.ts'});
    expect(add.code).toBe('SANDBOX_DENIED');
    expect(git(h.root, 'status', '--short').stdout).toContain('?? src/');
    expect((await h.exec({cmd: 'rm src/value.ts && rmdir src/components'})).exitCode).toBe(0);
    expect(existsSync(join(h.root, 'src/value.ts'))).toBe(false);
  },
  60000,
);

nativeTest(
  'B 7-12: outside writes, symlinks, home writes, Futryn state, hidden secrets and the network are enforced by Seatbelt',
  async () => {
    const h = harness({hideSecrets: true});
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(join(h.root, '.env'), 'TOPSECRET=1');
    writeFileSync(join(h.root, '.env.example'), 'TEMPLATE=1');
    mkdirSync(join(h.root, '.futryn'));
    writeFileSync(join(h.root, '.futryn', 'session'), 'FUTRYN_SESSION');
    symlinkSync(h.outside, join(h.root, 'to-outside'));
    symlinkSync(homedir(), join(h.root, 'to-home'));
    const r = await h.exec({
      cmd: String.raw`set +e
  echo x > ../escape-$$.txt 2>/dev/null && echo OUTSIDE_WRITE
  echo x > to-outside/pwned 2>/dev/null && echo SYMLINK_WRITE
  ls to-home/ >/dev/null 2>&1 && echo HOME_READABLE
  echo x > "$(cd to-home && pwd -P 2>/dev/null)/fyn-native-escape" 2>/dev/null && echo HOME_WRITE
  cat .env 2>/dev/null; cat .env.example; rm .env 2>/dev/null && echo SECRET_REMOVED
  cat .fyn-state/credentials.json 2>/dev/null; cat .futryn/session 2>/dev/null; touch .fyn-state/x 2>/dev/null && echo STATE_WRITE
  curl -sS -m 5 -o /dev/null https://example.com 2>/dev/null && echo NETWORK_OPEN || echo NETWORK_DENIED
  exit 0`,
    });
    expect(r.exitCode).toBe(0);
    for (const leak of [
      'OUTSIDE_WRITE',
      'SYMLINK_WRITE',
      'HOME_WRITE',
      'TOPSECRET',
      'SECRET_REMOVED',
      'STATE_SECRET',
      'FUTRYN_SESSION',
      'STATE_WRITE',
      'NETWORK_OPEN',
    ])
      expect(r.content).not.toContain(leak);
    expect(r.content).toContain('TEMPLATE=1');
    // Reads are open (ADR 0061): only credential directories and secrets are hidden; writes are not.
    expect(r.content).toContain('HOME_READABLE');
    expect(r.content).toContain('NETWORK_DENIED');
    expect(existsSync(join(h.outside, 'pwned'))).toBe(false);
    expect(existsSync(join(homedir(), 'fyn-native-escape'))).toBe(false);
    expect(readFileSync(join(h.root, '.env'), 'utf8')).toBe('TOPSECRET=1');
    expect(existsSync(join(h.state, 'x'))).toBe(false);
  },
  60000,
);

nativeTest(
  'B 12-15 / E 32-35: dangerouslyDisableSandbox is a user decision (and refusable); approvals bind the sandbox mode',
  async () => {
    const h = harness({answer: 'deny'});
    expect(h.runtime.availability().ok).toBe(true);
    // The escape hatch always asks; denied means nothing runs.
    const refused = await h.exec({cmd: 'touch RAN', dangerouslyDisableSandbox: true, justification: 'x'});
    expect(refused.status).toBe('denied');
    expect(h.prompts.at(-1)!.unsandboxed).toBe(true);
    expect(existsSync(join(h.root, 'RAN'))).toBe(false);
    // Approved once: that one command runs with no sandbox (a file outside the workspace can be written).
    h.setAnswer('once');
    const target = join(h.outside, 'escaped');
    const allowed = await h.exec({cmd: `touch ${target}`, dangerouslyDisableSandbox: true, justification: 'x'});
    expect(allowed.status).toBe('ok');
    expect(existsSync(target)).toBe(true);
    // allowUnsandboxedCommands false: refused without asking and nothing runs.
    const never = harness({escalation: 'never'});
    const before = never.prompts.length;
    expect((await never.exec({cmd: 'touch RAN', dangerouslyDisableSandbox: true, justification: 'x'})).status).toBe(
      'denied',
    );
    expect(never.prompts).toHaveLength(before);
    h.setAnswer('session');
    await h.exec({cmd: 'touch b'});
    const asked = h.prompts.length;
    await h.exec({cmd: 'touch b'});
    expect(h.prompts.length).toBe(asked);
    h.config.readOnly = true;
    const ro = await h.exec({cmd: 'touch c'});
    expect(h.prompts.length).toBe(asked + 1);
    expect(ro.code).toBe('SANDBOX_DENIED');
    expect(existsSync(join(h.root, 'c'))).toBe(false);
    h.config.readOnly = false;
    h.setAnswer(() => {
      h.config.readOnly = true;
      return 'once';
    });
    const raced = await h.exec({cmd: 'touch d'});
    expect(raced.content).toContain('sandbox policy changed');
    expect(existsSync(join(h.root, 'd'))).toBe(false);
  },
  60000,
);

nativeTest(
  'C 16-24: exit codes, timeout, cancellation, sessions, polling, stdin and SIGINT',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    expect((await h.exec({cmd: 'echo fine'})).exitCode).toBe(0);
    const failed = await h.exec({cmd: 'echo broken >&2; exit 1'});
    expect(failed.exitCode).toBe(1);
    expect(failed.content).toContain('broken');
    const timed = await h.exec({cmd: 'sleep 10', timeout_ms: 1000, yield_time_ms: 5000});
    expect(timed.code).toBe('TIMEOUT');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 800);
    const cancelled = await h.exec({cmd: 'echo STARTED; sleep 20'}, abort.signal);
    expect(cancelled.code).toBe('CANCELLED');
    expect(cancelled.content).toContain('STARTED');
    const running = await h.exec({cmd: 'sleep 1; echo DONE', yield_time_ms: 250});
    const id = sessionOf(running)!;
    expect(id).toBeDefined();
    // Each poll returns only new output: collect until the process has really exited.
    let seen = '';
    const done = await until(h, id, r => {
      seen += r.content;
      return r.exitCode !== undefined;
    });
    expect(done.exitCode).toBe(0);
    expect(seen).toContain('DONE');
    expect((await h.stdin({session_id: id})).code).toBe('SESSION_NOT_FOUND');
    const reader = await h.exec({cmd: 'read v; echo "got:$v"', yield_time_ms: 250});
    const answered = await h.stdin({session_id: sessionOf(reader)!, chars: 'hello\n', yield_time_ms: 2000});
    expect(answered.content).toContain('got:hello');
    const trap = await h.exec({
      cmd: "trap 'echo TRAPPED; exit 3' INT; echo READY; while true; do sleep 0.1; done",
      yield_time_ms: 500,
    });
    const interrupted = await h.stdin({session_id: sessionOf(trap)!, signal: 'SIGINT', yield_time_ms: 2000});
    expect(interrupted.content).toContain('TRAPPED');
    expect(interrupted.exitCode).toBe(3);
  },
  60000,
);

nativeTest(
  'C 20/25: the process group of a timed-out or cancelled command is killed (setsid escapes are a documented limitation)',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const r = await h.exec({cmd: 'sleep 300 & echo CHILD:$!; wait', timeout_ms: 1500, yield_time_ms: 5000});
    const pid = Number(/CHILD:(\d+)/.exec(r.content)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await Bun.sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(r.content).toContain('Descendant termination: unconfirmed.');
  },
  30000,
);

nativeTest('retained cancellation kills a TERM-ignoring ordinary child after the shell exits', async () => {
  const h = harness();
  const token = crypto.randomUUID();
  const running = await h.exec({
    cmd: `/usr/bin/perl -e '$SIG{TERM}="IGNORE";open(F,">ready");close F;sleep 60' ${token} >/dev/null 2>&1 & echo LEADER:$$ CHILD:$!; wait`,
    yield_time_ms: 250,
  });
  const id = sessionOf(running)!;
  expect(id).toBeDefined();
  await waitFor(() => existsSync(join(h.root, 'ready')) || undefined);
  const pid = Number(/CHILD:(\d+)/.exec(running.content)?.[1]);
  const child = observe().find(p => p.pid === pid)!;
  expect(child).toBeDefined();
  clean.push(() => dispose([child]));
  const stopped = await h.stdin({session_id: id, signal: 'SIGTERM', yield_time_ms: 3000});
  expect(stopped.status).toBe('ok');
  await waitFor(() => !current(child) || undefined, 1000);
  expect(stopped.content).toContain('Descendant termination: unconfirmed.');
});

nativeTest('F9: write_stdin SIGTERM ends a long-running session promptly with a normal result', async () => {
  const h = harness();
  const running = await h.exec({cmd: 'echo SERVING; exec sleep 600', yield_time_ms: 500});
  const started = Date.now();
  const stopped = await h.stdin({session_id: sessionOf(running)!, signal: 'SIGTERM', yield_time_ms: 5000});
  expect(Date.now() - started).toBeLessThan(3000);
  expect(stopped.status).toBe('ok');
  expect(stopped.code).toBeUndefined();
  expect(stopped.content).not.toContain('Running session');
  expect(stopped.content).toContain('signal SIGTERM');
});

nativeTest(
  'F9: write_stdin SIGTERM escalates to SIGKILL after the grace period for a TERM-ignoring leader',
  async () => {
    const h = harness();
    const running = await h.exec({
      cmd: `exec /usr/bin/perl -e '$SIG{TERM}="IGNORE";open(F,">ready");close F;sleep 600'`,
      yield_time_ms: 250,
    });
    await waitFor(() => existsSync(join(h.root, 'ready')) || undefined);
    const started = Date.now();
    const stopped = await h.stdin({session_id: sessionOf(running)!, signal: 'SIGTERM', yield_time_ms: 10_000});
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(6000);
    expect(stopped.status).toBe('ok');
    expect(stopped.content).toContain('signal SIGKILL');
  },
);

nativeTest(
  'retained shell sleep cancellation independently observes leader and child, preserving unrelated host process',
  async () => {
    const h = harness();
    const unrelated = spawn('/bin/sleep', ['60']);
    clean.push(() => {
      unrelated.kill('SIGKILL');
    });
    const host = await waitFor(() => observe().find(p => p.pid === unrelated.pid));
    const running = await h.exec({
      cmd: 'echo session-start LEADER:$$; sleep 60 & echo CHILD:$!; wait; echo unexpected-finish',
      yield_time_ms: 250,
    });
    const leaderPid = Number(/LEADER:(\d+)/.exec(running.content)?.[1]);
    const childPid = Number(/CHILD:(\d+)/.exec(running.content)?.[1]);
    const records = observe().filter(p => p.pid === leaderPid || p.pid === childPid);
    expect(records.length).toBe(2);
    expect(records.every(p => p.group === leaderPid)).toBe(true);
    clean.push(() => dispose(records));
    const stopped = await h.stdin({session_id: sessionOf(running)!, signal: 'SIGTERM', yield_time_ms: 3000});
    expect(stopped.status).toBe('ok');
    expect(stopped.content).not.toContain('unexpected-finish');
    await waitFor(() => records.every(p => !current(p)) || undefined);
    expect(current(host)).toBeDefined();
    expect(stopped.content).toContain('Leader exit: exited.');
    expect(stopped.content).toContain('Descendant termination: unconfirmed.');
  },
);

nativeTest('retained cancellation keeps escaped setsid descendants explicitly unconfirmed', async () => {
  const h = harness();
  const running = await h.exec({
    cmd: `/usr/bin/perl -MPOSIX -e '$|=1;$p=fork();if(!$p){POSIX::setsid();open(F,">detached-ready");close F;sleep 60;exit 0;}print qq(CHILD:$p\\n);sleep 60'; echo unexpected-finish`,
    yield_time_ms: 250,
  });
  await waitFor(() => existsSync(join(h.root, 'detached-ready')) || undefined);
  const pid = Number(/CHILD:(\d+)/.exec(running.content)?.[1]);
  const escaped = observe().find(p => p.pid === pid)!;
  expect(escaped).toBeDefined();
  expect(escaped.group).toBe(pid);
  clean.push(() => dispose([escaped]));
  const stopped = await h.stdin({session_id: sessionOf(running)!, signal: 'SIGTERM', yield_time_ms: 3000});
  expect(stopped.status).toBe('ok');
  expect(current(escaped)).toBeDefined();
  expect(stopped.content).toContain('Descendant termination: unconfirmed.');
});

nativeTest(
  'D 26-31: a real PTY: terminal identity, input, Ctrl-C in an interactive shell, resize and cleanup',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const sized = await h.exec({cmd: 'tty; stty size; read a; stty size; sleep 30', tty: true, yield_time_ms: 1000});
    const id = sessionOf(sized)!;
    expect(sized.content).toContain('/dev/ttys');
    expect(sized.content).toContain('40 120');
    h.runtime.resize(id, 100, 30);
    expect((await h.stdin({session_id: id, chars: 'x\n', yield_time_ms: 800})).content).toContain('30 100');
    expect((await h.stdin({session_id: id, signal: 'SIGTERM', yield_time_ms: 2000})).status).toBe('ok');
    const shell = await h.exec({cmd: 'PS1="fyn$ " bash --norc --noprofile -i', tty: true, yield_time_ms: 1000});
    const sid = sessionOf(shell)!;
    await h.stdin({session_id: sid, chars: 'sleep 30\n', yield_time_ms: 500});
    const ctrlc = await h.stdin({session_id: sid, chars: '\u0003', yield_time_ms: 800});
    expect(ctrlc.content).toContain('^C');
    expect((await h.stdin({session_id: sid, chars: 'echo "AFTER:$((6*7))"\n', yield_time_ms: 800})).content).toContain(
      'AFTER:42',
    );
    expect((await h.stdin({session_id: sid, chars: 'exit 5\n', yield_time_ms: 2000})).exitCode).toBe(5);
    const abandoned = await h.exec({cmd: 'sleep 60', tty: true, timeout_ms: 1500, yield_time_ms: 250});
    const aid = sessionOf(abandoned)!;
    await Bun.sleep(2500);
    expect((await h.stdin({session_id: aid})).code).toBe('TIMEOUT');
  },
  60000,
);

nativeTest(
  'E 36-37 and F (server): a restarted runtime never reclaims a session; a dev server runs as a session and is stopped through it',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const r = await h.exec({cmd: 'sleep 60', timeout_ms: 3000, yield_time_ms: 250});
    const id = sessionOf(r)!;
    const restarted = new NativeCommandRuntime({workspaceRoot: h.root, stateDirectory: h.state});
    clean.push(() => restarted.shutdown());
    expect(restarted.session(id)).toBeUndefined();
    await expect(restarted.writeStdin(id, '', 0)).rejects.toThrow();
    writeFileSync(
      join(h.root, 'server.ts'),
      'const s=Bun.serve({port:0,hostname:"127.0.0.1",fetch:()=>new Response("SERVED")});console.log("LISTENING",s.port);process.on("SIGINT",()=>{console.log("SHUTDOWN");process.exit(0);});',
    );
    const started = await h.exec({cmd: 'bun server.ts', yield_time_ms: 2000});
    const sid = sessionOf(started)!;
    expect(started.content).toContain('LISTENING');
    const port = Number(/LISTENING (\d+)/.exec(started.content)![1]);
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('SERVED');
    const stopped = await h.stdin({session_id: sid, signal: 'SIGINT', yield_time_ms: 3000});
    expect(stopped.content).toContain('SHUTDOWN');
  },
  60000,
);

nativeTest(
  'default (Codex parity): project .env stays readable so bun/node toolchains work; Futryn state stays denied',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(join(h.root, '.env'), 'A=from-dotenv');
    writeFileSync(
      join(h.root, 't.test.ts'),
      "import {test,expect} from 'bun:test';test('env',()=>expect(process.env.A).toBe('from-dotenv'));",
    );
    const r = await h.exec({cmd: 'bun test 2>&1; cat .fyn-state/credentials.json 2>/dev/null || echo STATE_DENIED'});
    expect(r.content).toContain('1 pass');
    expect(r.content).toContain('STATE_DENIED');
    expect(r.content).not.toContain('STATE_SECRET');
  },
  60000,
);

nativeTest(
  'git keeps working while URL credentials from .git/config never reach the model or the TUI stream',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(join(h.root, 'f.txt'), 'one\n');
    git(h.root, 'init', '-q');
    git(h.root, 'add', 'f.txt');
    expect(git(h.root, 'commit', '-qm', 'init').status).toBe(0);
    expect(git(h.root, 'remote', 'add', 'origin', 'https://user:ghp_URLTOKEN123@example.invalid/r.git').status).toBe(0);
    writeFileSync(join(h.root, 'f.txt'), 'two\n');
    const r = await h.exec({cmd: 'git status --short; git remote -v; cat .git/config'});
    expect(r.exitCode).toBe(0);
    expect(r.content).toContain('M f.txt');
    expect(r.content).toContain('https://***@example.invalid/r.git');
    expect(r.content).not.toContain('URLTOKEN');
  },
  60000,
);
