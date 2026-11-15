import { spawn, spawnSync } from 'node:child_process';
import { HeadTailBuffer } from './output';

/** What one bounded, one-shot process run produced (ADR 0022). */
export interface ProcessOutcome {
  kind: 'exited' | 'timeout' | 'cancelled' | 'spawn-failed';
  /** Exit code of the launched program; null when it was killed or never started. */
  exitCode: number | null;
  signal: string | null;
  /** Raw combined stdout+stderr in arrival order, bounded. */
  output: HeadTailBuffer;
  durationMs: number;
}

export interface ProcessSpec {
  argv: [string, ...string[]];
  cwd: string;
  /** The complete environment; nothing is inherited. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Every live descendant of `root` (by parent pid), deepest last. */
function descendants(root: number): number[] {
  const listed = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  if (listed.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    children.set(ppid, [...children.get(ppid) ?? [], pid]);
  }
  const found: number[] = []; const queue = [root];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) { found.push(child); queue.push(child); }
  return found;
}

/**
 * Kill the process group and every descendant still parented below it. A process that detaches
 * itself (new session and re-parenting to launchd) can escape both; ADR 0022 records the limit.
 */
export function killTree(pid: number): void {
  const tree = descendants(pid);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  for (const child of [pid, ...tree]) { try { process.kill(child, 'SIGKILL'); } catch { /* exited */ } }
}

/**
 * Launch `argv` in its own process group with an explicit environment, capture bounded output,
 * and stop the whole tree on timeout or cancellation. One-shot semantics: anything the command
 * left running in the background is killed once the main process exits.
 */
export function runProcess(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessOutcome> {
  const started = performance.now();
  const output = new HeadTailBuffer(spec.maxOutputBytes);
  const done = (kind: ProcessOutcome['kind'], exitCode: number | null, sig: string | null): ProcessOutcome =>
    ({ kind, exitCode, signal: sig, output, durationMs: Math.round(performance.now() - started) });
  if (signal?.aborted) return Promise.resolve(done('cancelled', null, null));
  return new Promise(resolvePromise => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolvePromise(done('spawn-failed', null, null)); return; }
    let settled = false; let reason: 'timeout' | 'cancelled' | null = null;
    let exit: { code: number | null; signal: string | null } | null = null;
    let linger: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ProcessOutcome) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(linger); signal?.removeEventListener('abort', onAbort);
      if (child.pid) killTree(child.pid); // nothing outlives a one-shot command
      child.stdout?.destroy(); child.stderr?.destroy();
      resolvePromise(outcome);
    };
    const stop = (why: 'timeout' | 'cancelled') => {
      if (settled || reason) return; reason = why;
      if (child.pid) killTree(child.pid);
      // Pipes held by an escaped process must not keep the turn waiting.
      linger = setTimeout(() => finish(done(why, null, exit?.signal ?? 'SIGKILL')), 1000);
    };
    const onAbort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), spec.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => output.push(chunk));
    child.once('error', () => finish(done('spawn-failed', null, null)));
    child.once('exit', (code, sig) => {
      exit = { code, signal: sig };
      if (reason) return;
      // Give the pipes a moment to drain, then end the run even if a background child holds them.
      linger = setTimeout(() => finish(done('exited', code, sig)), 250);
    });
    child.once('close', (code, sig) => {
      if (reason) finish(done(reason, null, sig ?? exit?.signal ?? 'SIGKILL'));
      else finish(done('exited', exit?.code ?? code, exit?.signal ?? sig));
    });
  });
}
