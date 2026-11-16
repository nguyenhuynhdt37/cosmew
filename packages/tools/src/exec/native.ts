import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {homedir, tmpdir} from 'node:os';
import {delimiter, dirname, isAbsolute, join, relative} from 'node:path';
import {
  FutrynError,
  type CommandOutcome,
  type CommandOutputChunk,
  type CommandRequest,
  type CommandRuntime,
  type CommandRuntimeCapabilities,
  type CommandSandbox,
  type CommandSessionInfo,
  type RuntimeAvailability,
} from '@futryn/contracts';
import {WorkspaceRoot} from '@futryn/workspace';
import {BubblewrapSandbox} from './bubblewrap';
import type {NativeSandbox} from './native-sandbox';
import {HeadTailBuffer} from './output';
import {likelySandboxDenied} from './sandbox-denial';
import {SeatbeltSandbox, secretPatterns} from './seatbelt-profile';

export const NATIVE_LIMITS = {
  minLeaseMs: 1000,
  maxLeaseMs: 1_800_000,
  maxSessions: 16,
  maxStdinChars: 8000,
} as const;

/** After the leader exits, wait at most this long for pipes held open by descendants. */
const OUTPUT_DRAIN_MS = 1000;
/** A PTY master keeps delivering output briefly after the leader exits. */
const PTY_DRAIN_MS = 100;
/** SIGTERM first, then SIGKILL after this grace period. */
const KILL_GRACE_MS = 500;
/** Give up waiting for a stopped process after this long and report the outcome as unconfirmed. */
const STOP_TIMEOUT_MS = 2500;

const READ_ONLY: CommandSandbox = {mode: 'read-only', network: false};

/**
 * Codex `UNIFIED_EXEC_ENV` (unified_exec/process_manager.rs, pinned 75fc67e8). Apart from PATH,
 * nothing is inherited from Futryn's own environment, so credentials in it never reach commands.
 */
const EXEC_ENV = {
  NO_COLOR: '1',
  TERM: 'dumb',
  LANG: 'C.UTF-8',
  LC_CTYPE: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  COLORTERM: '',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GH_PAGER: 'cat',
  CODEX_CI: '1',
  GIT_OPTIONAL_LOCKS: '0',
  FUTRYN_SANDBOX: '1',
};

export interface NativeRuntimeOptions {
  workspaceRoot: string;
  stateDirectory?: string;
  platform?: NodeJS.Platform;
  hostPath?: string;
  home?: string;
  /**
   * Hide secret-named project files from commands (FUTRYN_SANDBOX_HIDE_SECRETS=1). Off by default
   * like Codex: bun, node and vite read `.env` themselves and fail with EPERM when it is denied.
   */
  hideSecrets?: boolean;
}

type Stream = 'stdout' | 'stderr';

interface NativeSession {
  id: string;
  request: CommandRequest;
  sandbox: CommandSandbox;
  tty: boolean;
  start: number;
  /** Resolves when the session has ended (leader exited and output settled, or it was stopped). */
  done: Promise<void>;
  markDone: () => void;
  ended: boolean;
  exitCode: number | null;
  signal: string | null;
  /** True while a run/writeStdin call owns the session; concurrent calls are refused. */
  busy: boolean;
  observer?: (chunk: CommandOutputChunk) => void;
  /** Output since the previous call, bounded per stream. */
  buffers: Record<Stream, HeadTailBuffer>;
  budgets: Record<Stream, number>;
  streamed: Record<Stream, number>;
  outputClosed: boolean;
  exitObserved?: boolean;
  spawnFailed?: boolean;
  /** The process did not end within STOP_TIMEOUT_MS after SIGKILL. */
  unconfirmed?: boolean;
  stop?: 'cancelled' | 'timeout';
  lease?: ReturnType<typeof setTimeout>;
  releaseAbort?: () => void;
  pid?: number;
  pipeChild?: ChildProcess;
  ptyChild?: ReturnType<typeof Bun.spawn>;
}

/**
 * Native unified-exec runtime (ADR 0035), the Codex model: each command runs on the host inside
 * the OS sandbox (macOS Seatbelt, Linux bubblewrap). Readable: the system, PATH toolchains and the
 * workspace — never other user files or Futryn state. Writable in workspace-write: the workspace
 * except `.git`, plus a private temp directory. No network unless approved for the command.
 */
export class NativeCommandRuntime implements CommandRuntime {
  readonly id: string;
  readonly label: string;

  private readonly sandbox: NativeSandbox | undefined;
  private readonly unavailableReason: string | undefined;
  private readonly sessions = new Map<string, NativeSession>();
  /** Private directory with the command's HOME and TMPDIR; removed on shutdown. */
  private readonly scratch: string;
  private readonly path: string;
  private proven?: RuntimeAvailability;
  private closed = false;

  constructor(private readonly options: NativeRuntimeOptions) {
    const os = options.platform ?? process.platform;
    const home = realPath(options.home ?? homedir());

    this.scratch = mkdtempSync(join(tmpdir(), 'fyn-exec-'));
    mkdirSync(join(this.scratch, 'home'));
    mkdirSync(join(this.scratch, 'tmp'));

    const pathDirectories = [...new Set((options.hostPath ?? process.env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir) && existsSync(dir)))];
    this.path = [...new Set([...pathDirectories, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
    const toolchains = toolchainDirectories(pathDirectories, home);

    if (os === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      this.sandbox = new SeatbeltSandbox({
        workspace: options.workspaceRoot,
        state: options.stateDirectory,
        scratch: this.scratch,
        home,
        toolchains,
        secrets: options.hideSecrets ? secretPatterns() : undefined,
      });
    } else if (os === 'linux' && findExecutable('bwrap', this.path)) {
      this.sandbox = new BubblewrapSandbox({
        bwrap: findExecutable('bwrap', this.path)!,
        workspace: options.workspaceRoot,
        state: options.stateDirectory,
        scratch: this.scratch,
        home,
        hideSecrets: options.hideSecrets === true,
      });
    } else {
      this.unavailableReason = unavailableReason(os);
    }

    this.label = this.sandbox?.name === 'macos-seatbelt' ? 'macOS Seatbelt'
      : this.sandbox?.name === 'linux-bubblewrap' ? 'Linux bubblewrap'
      : 'no sandbox';
    // Approvals are bound to this id, so any change of the effective policy invalidates them.
    const policy = [options.workspaceRoot, options.stateDirectory, this.path, toolchains, options.hideSecrets === true, 'v1'];
    this.id = `native-${this.sandbox?.name ?? 'none'}:` + createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 24);
  }

  capabilities(): CommandRuntimeCapabilities {
    return {modes: ['read-only', 'workspace-write'], network: true, tty: true, shells: ['bash', 'sh'], tools: []};
  }

  /**
   * One real self-test per runtime instance: inside a throwaway workspace a write lands, while a
   * secret read, a `.git` write, a write outside, a home listing, signalling an outside process and
   * launching an app through LaunchServices all fail.
   */
  availability(): RuntimeAvailability {
    if (this.closed) return {ok: false, reason: 'Command runtime is closed.'};
    if (!this.sandbox) return {ok: false, reason: this.unavailableReason!};
    if (this.proven) return this.proven;

    const probe = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-probe-')));
    try {
      const result = this.runSelfTest(probe);
      if (result) return this.proven = {ok: true};
      return {ok: false, reason: 'The native sandbox self-test failed.'};
    } catch (error) {
      return {ok: false, reason: 'The native sandbox self-test failed: ' + (error instanceof Error ? error.message : 'unknown')};
    } finally {
      rmSync(probe, {recursive: true, force: true});
    }
  }

  private runSelfTest(probe: string): boolean {
    writeFileSync(join(probe, '.env'), 'PROBE_SECRET');
    mkdirSync(join(probe, '.git'));
    const outside = join(dirname(probe), 'fyn-probe-outside-' + randomUUID());
    const home = this.options.home ?? homedir();

    // The probe always enables the secret rule so a hide-secrets configuration is proven as well.
    const sandbox = this.sandbox!.name === 'macos-seatbelt'
      ? new SeatbeltSandbox({workspace: probe, scratch: this.scratch, home: realPath(home), toolchains: [], secrets: secretPatterns()})
      : this.sandbox!;
    const script = [
      'echo ok > made',
      '! cat .env 2>/dev/null | grep -q PROBE',
      '! touch .git/x 2>/dev/null',
      `! touch ${JSON.stringify(outside)} 2>/dev/null`,
      `! ls ${JSON.stringify(home)} >/dev/null 2>&1`,
      `! kill -0 ${process.pid} 2>/dev/null`,
      '! /usr/bin/open -g -j -a /System/Applications/Calculator.app 2>/dev/null',
    ].join(' && ');
    const argv = sandbox.wrap(['/bin/bash', '--noprofile', '--norc', '-c', script], {mode: 'workspace-write', network: false}, probe);
    const result = spawnSync(argv[0]!, argv.slice(1), {cwd: probe, env: this.env(false), timeout: 10_000, encoding: 'utf8'});

    return result.status === 0
      && readFileSync(join(probe, 'made'), 'utf8') === 'ok\n'
      && !existsSync(outside)
      && !existsSync(join(probe, '.git', 'x'));
  }

  private env(tty: boolean): Record<string, string> {
    return {
      ...EXEC_ENV,
      ...(tty ? {TERM: 'xterm-256color', NO_COLOR: ''} : {}),
      PATH: this.path,
      HOME: join(this.scratch, 'home'),
      TMPDIR: join(this.scratch, 'tmp'),
      BUN_INSTALL_CACHE_DIR: join(this.scratch, 'tmp', 'bun-cache'),
    };
  }

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome> {
    if (!this.availability().ok) throw new FutrynError('UNSUPPORTED');
    signal?.throwIfAborted();
    if (this.sessions.size >= NATIVE_LIMITS.maxSessions) throw new FutrynError('BUDGET');
    validateRequest(request);

    const workspace = new WorkspaceRoot(this.options.workspaceRoot);
    const cwd = workspace.resolve(request.cwd);
    if (cwd.kind !== 'directory') throw new FutrynError('POLICY');
    const relativeCwd = relative(workspace.root, cwd.absolute);
    if (relativeCwd.startsWith('..') || isAbsolute(relativeCwd)) throw new FutrynError('POLICY');

    const sandbox = request.sandbox ?? READ_ONLY;
    const argv = this.sandbox!.wrap(shellArgv(request), sandbox, cwd.absolute);
    const session = createSession(request, sandbox);

    try {
      if (session.tty) this.startPty(session, argv, cwd.absolute);
      else this.startPipes(session, argv, cwd.absolute);
    } catch {
      throw new FutrynError('UNSUPPORTED');
    }

    // The lease is the hard deadline for the command and everything it started.
    session.lease = setTimeout(() => { void this.stop(session, 'timeout'); }, request.timeoutMs);
    this.sessions.set(session.id, session);

    const abort = () => { void this.stop(session, 'cancelled'); };
    signal?.addEventListener('abort', abort, {once: true});
    session.releaseAbort = () => signal?.removeEventListener('abort', abort);

    try {
      return await this.collect(session, request.yieldTimeMs ?? request.timeoutMs + 2500, signal);
    } finally {
      session.busy = false;
    }
  }

  /** PTY session: Bun allocates the terminal; the child becomes its session leader. */
  private startPty(session: NativeSession, argv: string[], cwd: string): void {
    const child = Bun.spawn(argv, {
      cwd,
      env: this.env(true),
      terminal: {cols: 120, rows: 40, data: (_terminal, data) => recordOutput(session, 'stdout', Buffer.from(data))},
    });
    session.ptyChild = child;
    session.pid = child.pid;
    void child.exited.then(() => {
      setTimeout(() => {
        session.outputClosed = true;
        const signal = typeof child.signalCode === 'string' ? child.signalCode : null;
        onLeaderExit(session, child.exitCode, signal);
      }, PTY_DRAIN_MS);
    });
  }

  /** Pipe session: a detached process group so the whole group can be signalled. */
  private startPipes(session: NativeSession, argv: string[], cwd: string): void {
    const child = spawn(argv[0]!, argv.slice(1), {cwd, env: this.env(false), stdio: ['pipe', 'pipe', 'pipe'], detached: true});
    session.pipeChild = child;
    session.pid = child.pid;

    child.stdin!.on('error', () => {});
    child.stdout!.on('data', bytes => recordOutput(session, 'stdout', bytes));
    child.stderr!.on('data', bytes => recordOutput(session, 'stderr', bytes));
    child.once('error', () => {
      session.spawnFailed = true;
      session.outputClosed = true;
      onLeaderExit(session, null, null);
    });
    child.once('exit', (code, signal) => onLeaderExit(session, code, signal));
    child.once('close', () => {
      session.outputClosed = true;
      if (session.exitObserved) finishSession(session);
    });
  }

  /** Stop the whole process group (pipes: detached group; PTY: its session), escalating to SIGKILL. */
  private async stop(session: NativeSession, reason: 'cancelled' | 'timeout'): Promise<void> {
    if (session.ended || session.stop) return session.done;
    session.stop = reason;

    signalGroup(session, 'SIGTERM');
    const escalate = setTimeout(() => signalGroup(session, 'SIGKILL'), KILL_GRACE_MS);
    await Promise.race([session.done, sleep(STOP_TIMEOUT_MS)]);
    clearTimeout(escalate);

    if (!session.ended) {
      signalGroup(session, 'SIGKILL');
      session.unconfirmed = true;
      finishSession(session);
    }
    return session.done;
  }

  /** Wait up to `yieldMs`, then report the session's state and the output since the previous call. */
  private async collect(session: NativeSession, yieldMs: number, signal?: AbortSignal): Promise<CommandOutcome> {
    const abort = () => { void this.stop(session, 'cancelled'); };
    if (signal?.aborted) await this.stop(session, 'cancelled');
    else signal?.addEventListener('abort', abort, {once: true});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!session.ended) await Promise.race([session.done, new Promise<void>(resolve => { timer = setTimeout(resolve, yieldMs); })]);
      if (signal?.aborted) await this.stop(session, 'cancelled');

      const result = this.outcome(session);
      resetOutputWindow(session);
      if (session.ended) {
        session.releaseAbort?.();
        this.sessions.delete(session.id);
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      session.observer = undefined;
    }
  }

  private outcome(session: NativeSession): CommandOutcome {
    const kind = outcomeKind(session);
    const stdout = session.buffers.stdout, stderr = session.buffers.stderr;
    const output = stdout.text() + (stderr.totalBytes ? '\n[stderr]\n' + stderr.text() : '');
    const exitCode = kind === 'exited' ? session.exitCode : null;
    // Seatbelt cannot prove that a setsid descendant died; bubblewrap's PID namespace can.
    const descendants = session.ended && this.sandbox?.containsDescendants ? 'terminated' : 'unconfirmed';

    return {
      kind,
      ...(session.ended ? {} : {sessionId: session.id}),
      ...(kind === 'spawn-failed' ? {sandboxFailed: true} : {}),
      ...(kind === 'exited' && likelySandboxDenied(exitCode, output) ? {sandboxDenied: true} : {}),
      exitCode,
      signal: kind === 'exited' ? session.signal : session.stop ? 'SIGTERM' : null,
      output,
      omittedBytes: stdout.omittedBytes + stderr.omittedBytes,
      durationMs: Date.now() - session.start,
      lifecycle: {
        leader: session.spawnFailed ? 'not-started' : session.ended ? 'exited' : 'unconfirmed',
        stopRequested: !!session.stop,
        output: session.outputClosed ? 'closed' : 'cut-off',
        descendants: session.spawnFailed ? 'not-started' : descendants,
      },
    };
  }

  session(id: string): CommandSessionInfo | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {cwd: session.request.cwd, command: session.request.command, tty: session.tty, sandbox: {...session.sandbox}};
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    const validSize = Number.isInteger(cols) && cols >= 10 && cols <= 1000 && Number.isInteger(rows) && rows >= 5 && rows <= 500;
    if (!session || !session.tty || session.ended || !validSize) throw new FutrynError('POLICY');
    session.ptyChild?.terminal?.resize(cols, rows);
  }

  /**
   * Codex write_stdin: empty input polls; other input goes to the session's pipe or PTY. SIGINT (or
   * `\x03` on a pipe session) interrupts the foreground job, which may survive it; SIGTERM ends the
   * whole session. The original lease never extends.
   */
  async writeStdin(id: string, chars: string, yieldTimeMs: number, signal?: AbortSignal, interrupt?: 'SIGINT' | 'SIGTERM', onOutput?: (chunk: CommandOutputChunk) => void): Promise<CommandOutcome> {
    const session = this.sessions.get(id);
    const validInput = chars.length <= NATIVE_LIMITS.maxStdinChars && !chars.includes('\u0000');
    const validYield = Number.isInteger(yieldTimeMs) && yieldTimeMs >= 0 && yieldTimeMs <= 30_000;
    if (!session || session.busy || this.closed || !validInput || !validYield) throw new FutrynError('POLICY');
    if (session.ended && (chars || interrupt)) throw new FutrynError('POLICY');

    session.busy = true;
    session.observer = onOutput;
    try {
      signal?.throwIfAborted();
      if (interrupt === 'SIGTERM') await this.stop(session, 'cancelled');
      else if (interrupt === 'SIGINT' || (!session.tty && chars === '\u0003')) interruptForeground(session);
      else if (chars && !session.ended) sendInput(session, chars);
      return await this.collect(session, yieldTimeMs, signal);
    } finally {
      session.busy = false;
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => this.stop(session, 'cancelled')));
    this.sessions.clear();
    rmSync(this.scratch, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------------------------
// Session helpers

function createSession(request: CommandRequest, sandbox: CommandSandbox): NativeSession {
  const tty = request.tty === true;
  // A PTY merges stdout and stderr, so it gets the whole budget.
  const stdoutBudget = tty ? request.maxOutputBytes : Math.max(1, Math.ceil(request.maxOutputBytes / 2));
  const stderrBudget = Math.max(1, Math.floor(request.maxOutputBytes / 2));
  let markDone!: () => void;
  const done = new Promise<void>(resolve => { markDone = resolve; });
  return {
    id: randomUUID(),
    request,
    sandbox,
    tty,
    start: Date.now(),
    done,
    markDone,
    ended: false,
    exitCode: null,
    signal: null,
    busy: true,
    observer: request.onOutput,
    budgets: {stdout: stdoutBudget, stderr: stderrBudget},
    buffers: {stdout: new HeadTailBuffer(stdoutBudget), stderr: new HeadTailBuffer(stderrBudget)},
    streamed: {stdout: 0, stderr: 0},
    outputClosed: false,
  };
}

/** Keep bounded output for the result and stream a bounded prefix live to the observer. */
function recordOutput(session: NativeSession, stream: Stream, bytes: Buffer): void {
  session.buffers[stream].push(bytes);
  const limit = session.tty ? session.request.maxOutputBytes : session.budgets.stderr;
  if (session.streamed[stream] >= limit) return;

  const text = new TextDecoder().decode(bytes.subarray(0, limit - session.streamed[stream]));
  session.streamed[stream] += bytes.length;
  try { session.observer?.({stream, text}); } catch { session.observer = undefined; }
}

/** Codex: each call reports only the output produced since the previous call on this session. */
function resetOutputWindow(session: NativeSession): void {
  session.buffers = {stdout: new HeadTailBuffer(session.budgets.stdout), stderr: new HeadTailBuffer(session.budgets.stderr)};
  session.streamed = {stdout: 0, stderr: 0};
}

/** Output held open by a descendant must not hold the result forever. */
function onLeaderExit(session: NativeSession, code: number | null, signal: string | null): void {
  if (session.exitObserved) return;
  session.exitObserved = true;
  session.exitCode = code;
  session.signal = signal;
  if (session.outputClosed) finishSession(session);
  else setTimeout(() => finishSession(session), OUTPUT_DRAIN_MS);
}

function finishSession(session: NativeSession): void {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.lease);
  session.markDone();
}

function outcomeKind(session: NativeSession): CommandOutcome['kind'] {
  if (!session.ended) return 'running';
  if (session.spawnFailed) return 'spawn-failed';
  if (session.unconfirmed) return 'unconfirmed';
  if (session.stop === 'timeout') return 'timeout';
  if (session.stop === 'cancelled') return 'cancelled';
  return 'exited';
}

function signalGroup(session: NativeSession, signal: NodeJS.Signals): void {
  try {
    if (session.pid) process.kill(-session.pid, signal);
  } catch {
    try {
      session.pipeChild?.kill(signal);
      session.ptyChild?.kill(signal);
    } catch { /* already gone */ }
  }
}

function interruptForeground(session: NativeSession): void {
  if (session.tty) {
    session.ptyChild?.terminal?.write('\u0003');
    return;
  }
  try { process.kill(-session.pid!, 'SIGINT'); } catch { /* already gone */ }
}

function sendInput(session: NativeSession, chars: string): void {
  if (session.tty) session.ptyChild?.terminal?.write(chars);
  else session.pipeChild?.stdin?.write(chars);
}

// ---------------------------------------------------------------------------------------------
// Launch helpers

function validateRequest(request: CommandRequest): void {
  const shell = request.shell ?? 'bash';
  const validLease = Number.isInteger(request.timeoutMs) && request.timeoutMs >= NATIVE_LIMITS.minLeaseMs && request.timeoutMs <= NATIVE_LIMITS.maxLeaseMs;
  const validCommand = request.command.length <= 1024 && !request.command.includes('\u0000');
  const validOutput = Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes >= 1 && request.maxOutputBytes <= 60_000;
  if (!validLease || !validCommand || !validOutput || !['bash', 'sh'].includes(shell)) throw new FutrynError('INVALID_INPUT');
}

/** The shell never reads project startup files unless a login shell was requested. */
function shellArgv(request: CommandRequest): string[] {
  if (request.shell === 'sh') return ['/bin/sh', ...(request.login ? ['-l'] : []), '-c', request.command];
  return ['/bin/bash', ...(request.login ? ['--login'] : ['--noprofile', '--norc']), '-c', request.command];
}

/** Toolchains installed under home (bun, nvm, cargo…): each PATH directory below home and its parent. */
function toolchainDirectories(pathDirectories: string[], home: string): string[] {
  const candidates = pathDirectories.flatMap(dir => [dir, dirname(dir)]).map(realPath);
  return [...new Set(candidates.filter(dir => dir.startsWith(home + '/')))];
}

function unavailableReason(os: NodeJS.Platform): string {
  if (os === 'win32') return 'Native Windows command sandboxing is not implemented. Nothing can run.';
  if (os === 'linux') return 'bubblewrap (bwrap) is not installed; install it to run commands.';
  return `No native command sandbox for ${os}.`;
}

function findExecutable(name: string, path: string): string | undefined {
  for (const dir of path.split(':')) {
    const candidate = join(dir, name);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* try the next directory */ }
  }
  return undefined;
}

function realPath(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
