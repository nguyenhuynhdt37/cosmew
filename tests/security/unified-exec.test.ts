/**
 * Task 02 / ADR 0034 acceptance against the actual Docker engine (opt-in: FUTRYN_TEST_CONTAINER=1).
 * Every assertion observes the real host filesystem, the real container state or the real dispatcher;
 * nothing here is a mock runtime. Section letters follow the Task 02 test matrix.
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
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerCommandRuntime, ToolDispatcher, type ApprovalRequest, type ApprovalDecision} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
import {SessionGrants} from '@futryn/security';
import type {ToolResult} from '@futryn/contracts';

const containerTest = test.skipIf(process.env.FUTRYN_TEST_CONTAINER !== '1');
const docker = ['/opt/homebrew/bin/docker', '/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync)!;
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
    answer?: ApprovalDecision | ((r: ApprovalRequest) => ApprovalDecision);
    escalation?: 'on-request' | 'never';
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-unified-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-outside-')));
  const state = join(root, '.fyn-state');
  mkdirSync(state);
  writeFileSync(join(state, 'credentials.json'), 'STATE_SECRET');
  const runtime = new DockerCommandRuntime({workspaceRoot: root, stateDirectory: state});
  clean.push(
    () => {
      rmSync(root, {recursive: true, force: true});
      rmSync(outside, {recursive: true, force: true});
    },
    () => runtime.shutdown(),
  );
  const grants = new SessionGrants();
  const prompts: ApprovalRequest[] = [];
  const config = {
    mode: 'workspace-write' as 'read-only' | 'workspace-write',
    escalation: options.escalation ?? ('on-request' as 'on-request' | 'never'),
  };
  let answer = options.answer ?? 'once';
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    commands: runtime,
    stateDirectory: state,
    sandbox: () => ({...config}),
    redact: s => s,
    approve: async r => {
      prompts.push(r);
      return typeof answer === 'function' ? answer(r) : answer;
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
    dispatcher,
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

containerTest(
  'A 1-6: bash writes reach the real workspace; read, bash, apply_patch and git all observe the same files',
  async () => {
    const h = harness();
    expect(h.runtime.availability()).toEqual({ok: true});
    writeFileSync(join(h.root, 'README.md'), '# fixture\n');
    expect(git(h.root, 'init', '-q').status).toBe(0);
    expect(git(h.root, 'add', 'README.md').status).toBe(0);
    expect(git(h.root, 'commit', '-qm', 'init').status).toBe(0);
    const created = await h.exec({
      cmd: "mkdir -p src/components && printf 'export const value = 42;\\n' > src/value.ts && pwd && ls -la src",
    });
    expect(created.status).toBe('ok');
    expect(created.exitCode).toBe(0);
    expect(created.content).toContain('/workspace');
    expect(readFileSync(join(h.root, 'src/value.ts'), 'utf8')).toBe('export const value = 42;\n');
    const read = await h.call('read', {path: 'src/value.ts'});
    expect(read.status).toBe('ok');
    expect(read.content).toContain('value = 42');
    expect(
      (await h.exec({cmd: "sed -i 's/42/43/' src/value.ts && cat src/value.ts && echo '## changed' >> README.md"}))
        .content,
    ).toContain('value = 43');
    const patched = await h.call('apply_patch', {
      patch:
        '*** Begin Patch\n*** Update File: src/value.ts\n@@\n-export const value = 43;\n+export const value = 44;\n*** End Patch',
    });
    expect(patched.status).toBe('ok');
    expect((await h.exec({cmd: 'cat src/value.ts'})).content).toContain('value = 44');
    // git reads the read-only metadata; the diff matches the host's own git.
    const diff = await h.exec({cmd: 'git status --short && git diff'});
    expect(diff.status).toBe('ok');
    expect(diff.content).toContain('?? src/');
    expect(diff.content).toContain('+## changed');
    expect(git(h.root, 'diff').stdout).toContain('+## changed');
    // .git is read-only: a git write is a sandbox denial, not a silent success.
    const add = await h.exec({cmd: 'git add src/value.ts'});
    expect(add.status).toBe('error');
    expect(add.code).toBe('SANDBOX_DENIED');
    expect(git(h.root, 'status', '--short').stdout).toContain('?? src/');
    expect((await h.exec({cmd: 'rm src/value.ts && rmdir src/components'})).exitCode).toBe(0);
    expect(existsSync(join(h.root, 'src/value.ts'))).toBe(false);
  },
  90000,
);

containerTest(
  'B 7-12: outside roots, symlink and hardlink escapes, Futryn state, secrets, the engine socket and the network are enforced by mounts',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(join(h.root, '.env'), 'TOPSECRET=1');
    writeFileSync(join(h.root, '.env.example'), 'TEMPLATE=1');
    mkdirSync(join(h.root, '.futryn'));
    writeFileSync(join(h.root, '.futryn', 'session'), 'FUTRYN_SESSION');
    symlinkSync(h.outside, join(h.root, 'to-outside'));
    symlinkSync('..', join(h.root, 'up'));
    const r = await h.exec({
      cmd: String.raw`set +e
  echo x > ../escape.txt 2>/dev/null && echo OUTSIDE_WRITE
  echo x > to-outside/pwned 2>/dev/null && echo SYMLINK_WRITE
  echo x > up/escape 2>/dev/null && echo UP_WRITE
  ln /etc/hostname hard 2>/dev/null && echo HARDLINK
  test -s .env && echo SECRET_VISIBLE; cat .env.example; rm .env 2>/dev/null && echo SECRET_REMOVED
  ls -A .fyn-state; cat .futryn/session 2>/dev/null; touch .fyn-state/x 2>/dev/null && echo STATE_WRITE
  test -e /var/run/docker.sock && echo SOCKET; ls /run 2>/dev/null | grep -i docker
  bun -e 'fetch("http://1.1.1.1").then(()=>console.log("NETWORK_OPEN")).catch(()=>console.log("NETWORK_DENIED"))'
  exit 0`,
    });
    expect(r.status).toBe('ok');
    for (const leak of [
      'OUTSIDE_WRITE',
      'SYMLINK_WRITE',
      'UP_WRITE',
      'HARDLINK',
      'SECRET_VISIBLE',
      'SECRET_REMOVED',
      'credentials.json',
      'STATE_SECRET',
      'FUTRYN_SESSION',
      'STATE_WRITE',
      'SOCKET',
      'NETWORK_OPEN',
    ])
      expect(r.content).not.toContain(leak);
    expect(r.content).toContain('TEMPLATE=1');
    expect(r.content).toContain('NETWORK_DENIED');
    expect(existsSync(join(h.outside, 'pwned'))).toBe(false);
    expect(existsSync(join(h.root, 'hard'))).toBe(false);
    expect(readFileSync(join(h.root, '.env'), 'utf8')).toBe('TOPSECRET=1');
    expect(readFileSync(join(h.state, 'credentials.json'), 'utf8')).toBe('STATE_SECRET');
    expect(existsSync(join(h.state, 'x'))).toBe(false);
  },
  60000,
);

containerTest(
  'B 12-14: network is a separately approved escalation; refusal, require_escalated and a forbidding policy run nothing',
  async () => {
    const h = harness({answer: 'deny'});
    expect(h.runtime.availability().ok).toBe(true);
    const network = {
      sandbox_permissions: 'with_additional_permissions',
      additional_permissions: {network: {enabled: true}},
      justification: 'Install dependencies',
    };
    const denied = await h.exec({cmd: 'touch RAN && ls /sys/class/net', ...network});
    expect(denied.status).toBe('denied');
    expect(existsSync(join(h.root, 'RAN'))).toBe(false);
    expect(h.prompts.at(-1)!.network).toBe(true);
    expect(h.prompts.at(-1)!.justification).toBe('Install dependencies');
    expect(h.prompts.at(-1)!.reason).toBe('network-escalation');
    const escalated = await h.exec({cmd: 'touch RAN', sandbox_permissions: 'require_escalated', justification: 'x'});
    expect(escalated.code).toBe('UNSUPPORTED');
    expect(existsSync(join(h.root, 'RAN'))).toBe(false);
    h.setAnswer('once');
    const allowed = await h.exec({cmd: 'ls /sys/class/net', ...network});
    expect(allowed.exitCode).toBe(0);
    expect(allowed.content).toContain('eth0');
    // Without approval the same command sees only loopback.
    expect((await h.exec({cmd: 'ls /sys/class/net'})).content).not.toContain('eth0');
    const never = harness({escalation: 'never'});
    const forbidden = await never.exec({cmd: 'touch RAN', ...network});
    expect(forbidden.status).toBe('denied');
    expect(never.prompts).toHaveLength(0);
    expect(existsSync(join(never.root, 'RAN'))).toBe(false);
  },
  90000,
);

containerTest(
  'B 15 / E 32-35: approvals bind the sandbox; once is single-use, session reuses, a policy change voids pending and stale approvals',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    await h.exec({cmd: 'touch a'});
    await h.exec({cmd: 'touch a'});
    expect(h.prompts).toHaveLength(2);
    h.setAnswer('session');
    await h.exec({cmd: 'touch b'});
    await h.exec({cmd: 'touch b'});
    expect(h.prompts).toHaveLength(3);
    expect(existsSync(join(h.root, 'b'))).toBe(true);
    // A stale session grant does not cover the read-only policy; the effective sandbox really is read-only.
    h.config.mode = 'read-only';
    const ro = await h.exec({cmd: 'touch c'});
    expect(h.prompts).toHaveLength(4);
    expect(h.prompts.at(-1)!.sandbox).toContain('read-only');
    expect(ro.code).toBe('SANDBOX_DENIED');
    expect(existsSync(join(h.root, 'c'))).toBe(false);
    // Policy change while the approval is pending: the approval is void and nothing runs.
    h.config.mode = 'workspace-write';
    h.setAnswer(() => {
      h.config.mode = 'read-only';
      return 'once';
    });
    const raced = await h.exec({cmd: 'touch d'});
    expect(raced.status).toBe('denied');
    expect(raced.content).toContain('sandbox policy changed');
    expect(existsSync(join(h.root, 'd'))).toBe(false);
    // Revocation before execution: a cleared grant prompts again and a denial runs nothing.
    h.config.mode = 'workspace-write';
    h.setAnswer('session');
    await h.exec({cmd: 'touch e'});
    h.grants.clear();
    h.setAnswer('deny');
    const revoked = await h.exec({cmd: 'touch e2'});
    expect(revoked.status).toBe('denied');
    expect(existsSync(join(h.root, 'e2'))).toBe(false);
  },
  90000,
);

containerTest(
  'C 16-25: exit codes, timeout, cancellation, detached children, sessions, polling, stdin, SIGINT and no orphaned containers',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const sessions: string[] = [];
    const ok = await h.exec({cmd: 'echo fine'});
    expect(ok.exitCode).toBe(0);
    const failed = await h.exec({cmd: 'echo broken >&2; exit 1'});
    expect(failed.status).toBe('ok');
    expect(failed.exitCode).toBe(1);
    expect(failed.content).toContain('Exit code: 1');
    expect(failed.content).toContain('broken');
    const timed = await h.exec({cmd: 'sleep 10', timeout_ms: 1000, yield_time_ms: 5000});
    expect(timed.code).toBe('TIMEOUT');
    expect(timed.content).toContain('Descendant termination: terminated.');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 1500);
    const cancelled = await h.exec({cmd: 'echo STARTED; sleep 20'}, abort.signal);
    expect(cancelled.code).toBe('CANCELLED');
    expect(cancelled.content).toContain('STARTED');
    expect(cancelled.content).toContain('Descendant termination: terminated.');
    const detached = await h.exec({cmd: 'setsid sh -c "sleep 60" >/dev/null 2>&1 & echo LEADER'});
    expect(detached.exitCode).toBe(0);
    expect(detached.content).toContain('Descendant termination: terminated.');
    const running = await h.exec({cmd: 'sleep 1; echo DONE', yield_time_ms: 250});
    const id = sessionOf(running)!;
    expect(id).toBeDefined();
    sessions.push(id);
    expect(running.content).not.toContain('Timed out');
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
    const rid = sessionOf(reader)!;
    sessions.push(rid);
    const answered = await h.stdin({session_id: rid, chars: 'hello\n', yield_time_ms: 2000});
    expect(answered.content).toContain('got:hello');
    const trap = await h.exec({
      cmd: "trap 'echo TRAPPED; exit 3' INT; echo READY; while true; do sleep 0.1; done",
      yield_time_ms: 500,
    });
    const tid = sessionOf(trap)!;
    sessions.push(tid);
    expect(trap.content).toContain('READY');
    const interrupted = await h.stdin({session_id: tid, signal: 'SIGINT', yield_time_ms: 2000});
    expect(interrupted.content).toContain('TRAPPED');
    expect(interrupted.exitCode).toBe(3);
    // Input asked once (hello); polls and SIGINT never prompt.
    expect(h.prompts.filter(p => p.tool === 'write_stdin')).toHaveLength(1);
    await h.runtime.shutdown();
    for (const session of sessions)
      expect(
        spawnSync(docker, ['ps', '-aq', '--filter', 'label=futryn.exec.session=' + session], {
          encoding: 'utf8',
        }).stdout.trim(),
      ).toBe('');
  },
  120000,
);

containerTest(
  'D 26-31: a real PTY: terminal identity, interactive input, Ctrl-C in an interactive shell, resize and abnormal termination cleanup',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const sized = await h.exec({cmd: 'tty; stty size; read a; stty size; sleep 30', tty: true, yield_time_ms: 1000});
    const id = sessionOf(sized)!;
    expect(sized.content).toContain('/dev/pts/');
    expect(sized.content).toContain('40 120');
    h.runtime.resize(id, 100, 30);
    const resized = await h.stdin({session_id: id, chars: 'x\n', yield_time_ms: 800});
    expect(resized.content).toContain('30 100');
    const ended = await h.stdin({session_id: id, signal: 'SIGTERM', yield_time_ms: 2000});
    expect(ended.status).toBe('ok');
    expect(ended.content).toContain('Descendant termination: terminated.');
    // An interactive shell: Ctrl-C stops the foreground job only; the shell keeps running and accepts input.
    const shell = await h.exec({cmd: 'PS1="fyn$ " bash --norc --noprofile -i', tty: true, yield_time_ms: 1000});
    const sid = sessionOf(shell)!;
    await h.stdin({session_id: sid, chars: 'sleep 30\n', yield_time_ms: 500});
    const ctrlc = await h.stdin({session_id: sid, chars: '\u0003', yield_time_ms: 800});
    expect(ctrlc.content).toContain('^C');
    expect(ctrlc.content).not.toContain('Exit code');
    const after = await h.stdin({session_id: sid, chars: 'echo "AFTER:$((6*7))"\n', yield_time_ms: 800});
    expect(after.content).toContain('AFTER:42');
    const exited = await h.stdin({session_id: sid, chars: 'exit 5\n', yield_time_ms: 2000});
    expect(exited.exitCode).toBe(5);
    // Lease expiry of an abandoned PTY session tears down the namespace.
    const abandoned = await h.exec({cmd: 'sleep 60', tty: true, timeout_ms: 1500, yield_time_ms: 250});
    const aid = sessionOf(abandoned)!;
    await Bun.sleep(2500);
    const expired = await h.stdin({session_id: aid});
    expect(expired.code).toBe('TIMEOUT');
    expect(expired.content).toContain('Descendant termination: terminated.');
    expect(
      spawnSync(docker, ['ps', '-aq', '--filter', 'label=futryn.exec.session=' + aid], {
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('');
  },
  120000,
);

containerTest(
  'E 36-37: a restarted runtime never reclaims an earlier session, and the earlier namespace still ends at its lease',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    const r = await h.exec({cmd: 'sleep 60', timeout_ms: 3000, yield_time_ms: 250});
    const id = sessionOf(r)!;
    const restarted = new DockerCommandRuntime({workspaceRoot: h.root, stateDirectory: h.state});
    clean.push(() => restarted.shutdown());
    expect(restarted.session(id)).toBeUndefined();
    await expect(restarted.writeStdin(id, '', 0)).rejects.toThrow();
    await Bun.sleep(4000);
    const state = spawnSync(docker, ['ps', '-q', '--filter', 'label=futryn.exec.session=' + id], {encoding: 'utf8'});
    expect(state.stdout.trim()).toBe('');
  },
  60000,
);

containerTest(
  'F (server): a background development server runs as an owned session and is stopped through it',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(
      join(h.root, 'server.ts'),
      'const s=Bun.serve({port:3000,fetch:()=>new Response("SERVED")});console.log("LISTENING",s.port);process.on("SIGINT",()=>{console.log("SHUTDOWN");process.exit(0);});',
    );
    const started = await h.exec({
      cmd: 'bun server.ts & sleep 0.5; bun -e \'console.log(await (await fetch("http://127.0.0.1:3000")).text())\'; wait',
      yield_time_ms: 3000,
    });
    const id = sessionOf(started)!;
    expect(started.content).toContain('LISTENING');
    expect(started.content).toContain('SERVED');
    const stopped = await h.stdin({session_id: id, signal: 'SIGINT', yield_time_ms: 3000});
    expect(stopped.content).toContain('SHUTDOWN');
    expect(stopped.content).toContain('Descendant termination: terminated.');
  },
  60000,
);

containerTest(
  'B (mount sources): nested and symlinked .git are never bind sources, and .git is hidden while an unpinned write session could swap it',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    mkdirSync(join(h.root, 'vendor/lib/.git'), {recursive: true});
    writeFileSync(join(h.root, 'vendor/lib/.git/config'), 'NESTED_GIT');
    writeFileSync(join(h.outside, 'HEAD'), 'OUTSIDE_HEAD');
    symlinkSync(h.outside, join(h.root, '.git'));
    const linked = await h.exec({
      cmd: 'cat .git/HEAD 2>/dev/null; cat vendor/lib/.git/config 2>/dev/null; ls -A vendor/lib/.git; echo END',
    });
    expect(linked.content).not.toContain('OUTSIDE_HEAD');
    expect(linked.content).not.toContain('NESTED_GIT');
    expect(linked.content).toContain('END');
    rmSync(join(h.root, '.git'));
    // A write session launched without .git cannot have .git pinned; while it runs, a new .git is hidden.
    const writer = await h.exec({cmd: 'sleep 30', yield_time_ms: 250});
    const wid = sessionOf(writer)!;
    expect(wid).toBeDefined();
    expect(git(h.root, 'init', '-q').status).toBe(0);
    const hidden = await h.exec({cmd: 'ls -A .git | wc -l'});
    expect(hidden.content).toMatch(/\n0\n/);
    await h.stdin({session_id: wid, signal: 'SIGTERM'});
    const visible = await h.exec({cmd: 'test -f .git/HEAD && echo PINNED'});
    expect(visible.content).toContain('PINNED');
    // A session that pinned .git cannot rename or replace it.
    const pinned = await h.exec({cmd: 'mv .git moved 2>&1; rm -rf .git 2>&1; test -f .git/HEAD && echo STILL'});
    expect(pinned.content).toContain('STILL');
    expect(existsSync(join(h.root, '.git', 'HEAD'))).toBe(true);
  },
  90000,
);

containerTest(
  'B (git credentials): .git/config is masked while git status/diff/log keep working',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    writeFileSync(join(h.root, 'f.txt'), 'one\n');
    expect(git(h.root, 'init', '-q').status).toBe(0);
    git(h.root, 'add', 'f.txt');
    expect(git(h.root, 'commit', '-qm', 'init').status).toBe(0);
    expect(git(h.root, 'remote', 'add', 'origin', 'https://user:GIT_TOKEN_SECRET@example.invalid/r.git').status).toBe(
      0,
    );
    writeFileSync(join(h.root, 'f.txt'), 'two\n');
    const r = await h.exec({
      cmd: 'cat .git/config; git remote -v; git status --short; git diff --stat; git log --oneline | wc -l',
    });
    expect(r.exitCode).toBe(0);
    expect(r.content).not.toContain('GIT_TOKEN_SECRET');
    expect(r.content).not.toContain('example.invalid');
    expect(r.content).toContain('M f.txt');
    expect(r.content).toContain('1 file changed');
    expect(readFileSync(join(h.root, '.git/config'), 'utf8')).toContain('GIT_TOKEN_SECRET');
  },
  60000,
);

containerTest(
  'B (concurrent writer): a running session moving a directory that holds a masked secret never exposes it to later launches',
  async () => {
    const h = harness();
    expect(h.runtime.availability().ok).toBe(true);
    mkdirSync(join(h.root, 'a'));
    writeFileSync(join(h.root, 'a', '.env'), 'RACE_SECRET');
    // Session A flips a <-> b as fast as it can; its own mask follows the file, so it never reads the secret.
    const flipper = await h.exec({
      cmd: 'while true; do mv a b 2>/dev/null; mv b a 2>/dev/null; done',
      yield_time_ms: 250,
      timeout_ms: 60000,
    });
    const fid = sessionOf(flipper)!;
    expect(fid).toBeDefined();
    let launched = 0,
      refused = 0;
    for (let i = 0; i < 12; i++) {
      const r = await h.exec({cmd: 'cat a/.env b/.env 2>/dev/null; echo END'});
      expect(r.content).not.toContain('RACE_SECRET');
      if (r.code === 'SANDBOX_FAILED') refused++;
      else {
        expect(r.content).toContain('END');
        launched++;
      }
    }
    expect(launched + refused).toBe(12);
    await h.stdin({session_id: fid, signal: 'SIGTERM'});
    // The secret still exists on the host (wherever the flipper left it) and was never shown above.
    expect(spawnSync('grep', ['-rl', 'RACE_SECRET', h.root], {encoding: 'utf8'}).stdout.trim()).not.toBe('');
  },
  180000,
);
