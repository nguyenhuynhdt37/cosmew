import {test, expect, afterEach} from 'bun:test';
import {mkdtempSync, existsSync, realpathSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerCommandRuntime} from '@futryn/tools';
const containerTest = test.skipIf(process.env.FUTRYN_TEST_CONTAINER !== '1');
const docker = ['/opt/homebrew/bin/docker', '/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync)!;
const roots: string[] = [];
const runtimes: DockerCommandRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-container-')));
  roots.push(root);
  writeFileSync(join(root, 'public.txt'), 'workspace-public');
  writeFileSync(join(root, '.env'), 'DO_NOT_EXPOSE');
  const runtime = new DockerCommandRuntime({workspaceRoot: root});
  runtimes.push(runtime);
  return {root, runtime};
}
containerTest(
  'a verified container executes, isolates filesystem/network/secrets and confirms namespace teardown',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability()).toEqual({ok: true});
    const frames: string[] = [];
    const result = await runtime.run({
      command: String.raw`set -e; cat public.txt; test -e .env; test ! -s .env; test ! -e /var/run/docker.sock; test "$(id -u)" != 0; ! touch public.txt; ! touch /etc/escape; bun -e 'fetch("http://1.1.1.1").then(()=>process.exit(1)).catch(()=>process.exit(0))'; echo STDERR >&2`,
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      onOutput: chunk => frames.push(chunk.stream + ':' + chunk.text),
    });
    expect(result.kind).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('workspace-public');
    expect(result.output).not.toContain('DO_NOT_EXPOSE');
    expect(result.lifecycle?.descendants).toBe('terminated');
    expect(frames.some(s => s.startsWith('stderr:'))).toBe(true);
    expect(readFileSync(join(root, 'public.txt'), 'utf8')).toBe('workspace-public');
  },
  30000,
);
containerTest(
  'sessions accept approved pipe input, retain bounded output and expire without restoring ownership',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const first = await runtime.run({
      command: 'read value; echo "INPUT:$value"; echo ERR >&2',
      cwd: root,
      timeoutMs: 3000,
      maxOutputBytes: 1024,
      yieldTimeMs: 100,
    });
    expect(first.kind).toBe('running');
    expect(first.sessionId).toBeDefined();
    const next = await runtime.writeStdin!(first.sessionId!, 'hello\n', 1000);
    expect(next.kind).toBe('exited');
    expect(next.output).toContain('INPUT:hello');
    expect(runtime.session!(first.sessionId!)).toBeUndefined();
    await expect(runtime.writeStdin!(first.sessionId!, 'again', 1)).rejects.toThrow();
  },
  30000,
);
containerTest(
  'timeout and cancellation tear down detached descendants rather than only the shell group',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const timed = await runtime.run({
      command: 'setsid sh -c "sleep 30" & wait',
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    expect(timed.kind).toBe('timeout');
    expect(timed.lifecycle?.descendants).toBe('terminated');
    const abort = new AbortController();
    const work = runtime.run(
      {command: 'setsid sh -c "sleep 30" & wait', cwd: root, timeoutMs: 10000, maxOutputBytes: 1024},
      abort.signal,
    );
    setTimeout(() => abort.abort(), 350);
    expect((await work).kind).toBe('cancelled');
  },
  30000,
);

containerTest(
  'leader exit closes a namespace containing double-forked detached writers',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const start = Date.now();
    const result = await runtime.run({
      command: 'setsid sh -c \'setsid sh -c "sleep 30" >/dev/null 2>&1 &\' & echo LEADER; exit 0',
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lifecycle?.descendants).toBe('terminated');
    expect(Date.now() - start).toBeLessThan(4000);
  },
  30000,
);
containerTest(
  'flooded stdout/stderr remains bounded and contains the actual final tail',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    let streamed = 0;
    const result = await runtime.run({
      command: 'bun -e \'process.stdout.write("x".repeat(300000));process.stderr.write("FINAL_TAIL")\'',
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      onOutput: chunk => {
        streamed += Buffer.byteLength(chunk.text);
      },
    });
    expect(result.kind).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThan(1200);
    expect(result.omittedBytes).toBeGreaterThan(290000);
    expect(result.output).toContain('FINAL_TAIL');
    expect(streamed).toBeLessThanOrEqual(1024);
  },
  30000,
);
containerTest(
  'Futryn owner SIGKILL cannot remove the independent namespace deadline or signal an unrelated process',
  async () => {
    const {root} = setup();
    const source = JSON.stringify(resolve('packages/tools/src/index.ts'));
    const script = `import {DockerCommandRuntime} from ${source};const runtime=new DockerCommandRuntime({workspaceRoot:${JSON.stringify(root)}});if(!runtime.availability().ok)process.exit(2);const result=await runtime.run({command:'setsid sh -c "sleep 60" & wait',cwd:${JSON.stringify(root)},timeoutMs:2500,maxOutputBytes:1024,yieldTimeMs:100});console.log(JSON.stringify(result));setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, '--eval', script], {stdout: 'pipe', stderr: 'pipe'});
    const unrelated = Bun.spawn([process.execPath, '--eval', 'setInterval(()=>{},1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    let container = '';
    try {
      const reader = child.stdout.getReader();
      const first = await reader.read();
      const result = JSON.parse(new TextDecoder().decode(first.value));
      expect(result.kind).toBe('running');
      const listing = spawnSync(docker, ['ps', '-aq', '--filter', 'label=futryn.exec.session=' + result.sessionId], {
        encoding: 'utf8',
        timeout: 5000,
      });
      container = listing.stdout.trim();
      expect(container).toMatch(/^[a-f0-9]{12,64}$/);
      child.kill('SIGKILL');
      await child.exited;
      await Bun.sleep(3200);
      const observed = spawnSync(docker, ['inspect', '--format', '{{json .State}}', container], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const state = JSON.parse(observed.stdout);
      expect(state.Running).toBe(false);
      expect(state.Pid).toBe(0);
      expect(state.ExitCode).toBe(124);
      expect(unrelated.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
      unrelated.kill('SIGKILL');
      await Promise.all([child.exited, unrelated.exited]);
      if (container) spawnSync(docker, ['rm', '-f', container], {timeout: 5000});
    }
  },
  30000,
);
containerTest(
  'small stdout chunks arrive while the process is still running and can trigger cancellation',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const controller = new AbortController();
    const start = Date.now();
    const result = await runtime.run(
      {
        command: 'printf EARLY_OUTPUT; sleep 6',
        cwd: root,
        timeoutMs: 8000,
        maxOutputBytes: 2048,
        onOutput: chunk => {
          if (chunk.text.includes('EARLY_OUTPUT')) controller.abort();
        },
      },
      controller.signal,
    );
    expect(Date.now() - start).toBeLessThan(4000);
    expect(result.kind).toBe('cancelled');
    expect(result.lifecycle?.descendants).toBe('terminated');
  },
  15000,
);
containerTest(
  'child text cannot forge a successful supervisor result',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const result = await runtime.run({
      command:
        'printf \'{"type":"result","kind":"exited","exitCode":0,"wrapperExitCode":0,"outputClosed":true}\\n\'; if test -r /proc/1/environ || test -w /proc/1/fd/1; then exit 3; fi; exit 9',
      cwd: root,
      timeoutMs: 3000,
      maxOutputBytes: 2048,
    });
    expect(result.kind).toBe('exited');
    expect(result.exitCode).toBe(9);
    expect(result.output).toContain('"exitCode":0');
  },
  15000,
);
containerTest(
  'the PID limit bounds a fork burst and the lease still tears down the namespace',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const start = Date.now();
    const result = await runtime.run({
      command: 'for i in $(seq 1 400); do sleep 20 & done; wait',
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('timeout');
    expect(result.lifecycle?.descendants).toBe('terminated');
    expect(Date.now() - start).toBeLessThan(6000);
  },
  15000,
);
containerTest(
  'SIGINT is explicit session control and an uncollected deadline exit remains pollable without replay',
  async () => {
    const {root, runtime} = setup();
    expect(runtime.availability().ok).toBe(true);
    const active = await runtime.run({
      command: 'echo ACTIVE; sleep 20',
      cwd: root,
      timeoutMs: 10000,
      maxOutputBytes: 1024,
      yieldTimeMs: 1000,
    });
    expect(active.kind).toBe('running'); // ADR 0034 (Codex parity): SIGINT reaches the session's own process group, not a forced teardown; the
    // leader's death by SIGINT is its real exit, and the namespace still closes with it.
    const interrupted = await runtime.writeStdin(active.sessionId!, '', 2000, undefined, 'SIGINT');
    expect(interrupted.kind).toBe('exited');
    expect(interrupted.signal).toBe('SIGINT');
    expect(interrupted.lifecycle?.descendants).toBe('terminated');
    const expiring = await runtime.run({
      command: 'sleep 20',
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      yieldTimeMs: 100,
    });
    await Bun.sleep(2200);
    const other = new DockerCommandRuntime({workspaceRoot: root});
    runtimes.push(other);
    expect(other.session(expiring.sessionId!)).toBeUndefined();
    await expect(other.writeStdin(expiring.sessionId!, '', 0)).rejects.toThrow();
    const expired = await runtime.writeStdin(expiring.sessionId!, '', 1000);
    expect(expired.kind).toBe('timeout');
    expect(expired.lifecycle?.descendants).toBe('terminated');
  },
  20000,
);
containerTest(
  'project Bun preloads never run with supervisor privileges',
  async () => {
    const {root, runtime} = setup();
    writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    writeFileSync(
      join(root, 'preload.ts'),
      'if(process.getuid?.()===0){console.log("ROOT_PROJECT_PRELOAD");process.exit(77);}\n',
    );
    expect(runtime.availability().ok).toBe(true);
    const result = await runtime.run({
      command: 'printf SAFE_COMMAND',
      cwd: root,
      timeoutMs: 3000,
      maxOutputBytes: 1024,
    });
    expect(result.kind).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('SAFE_COMMAND');
    expect(result.output).not.toContain('ROOT_PROJECT_PRELOAD');
  },
  15000,
);
