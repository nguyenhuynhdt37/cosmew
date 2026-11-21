import {createHash, randomUUID} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {homedir, tmpdir} from 'node:os';
import {delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {
  FutrynError,
  type BackgroundTask,
  type BackgroundTaskEvent,
  type CommandOutcome,
  type CommandOutputChunk,
  type CommandRequest,
  type CommandRuntime,
  type CommandRuntimeCapabilities,
  type CommandSandbox,
  type CommandSessionInfo,
  type RuntimeAvailability,
  type ServiceProcess,
} from '@cosmew/contracts';
import {WorkspaceRoot} from '@cosmew/workspace';
import {BubblewrapSandbox} from './bubblewrap';
import type {NativeSandbox} from './native-sandbox';
import {HeadTailBuffer} from './output';
import {proxyEnvironment} from './proxy';
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
const KILL_GRACE_MS = 2000;
/** Give up waiting for a stopped process after this long and report the outcome as unconfirmed. */
const STOP_TIMEOUT_MS = 4000;

const READ_ONLY: CommandSandbox = {mode: 'read-only', network: false};

/**
 * Codex `UNIFIED_EXEC_ENV` (unified_exec/process_manager.rs, pinned 75fc67e8). Apart from PATH,
 * nothing is inherited from Cosmew's own environment, so credentials in it never reach commands.
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

/** Codex `shell_environment_policy` default excludes: names that look like credentials. */
const HOST_ENV_EXCLUDED = /KEY|SECRET|TOKEN/i;

export interface NativeRuntimeOptions {
  /** Canonical discovered skill directories; outside-workspace resources are read-only. */
  skillDirectories?: readonly string[];
  /** User skill resources stay read-only even when home is the workspace. */
  readOnlySkillDirectories?: readonly string[];
  workspaceRoot: string;
  stateDirectory?: string;
  platform?: NodeJS.Platform;
  hostPath?: string;
  home?: string;
  /**
   * Hide secret-named project files from commands (COSMEW_SANDBOX_HIDE_SECRETS=1). Off by default
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
  stop?: 'cancelled' | 'timeout' | 'signalled';
  lease?: ReturnType<typeof setTimeout>;
  releaseAbort?: () => void;
  background?: boolean;
  yieldForeground?: () => void;
  taskTail: string;
  taskChanged?: () => void;
  pid?: number;
  pipeChild?: ChildProcess;
  ptyChild?: ReturnType<typeof Bun.spawn>;
}

/**
 * Native unified-exec runtime (ADR 0035), the Codex model: each command runs on the host inside
 * the OS sandbox (macOS Seatbelt, Linux bubblewrap). Readable: the system, PATH toolchains and the
 * workspace — never other user files or Cosmew state. Writable in workspace-write: the workspace
 * except `.git`, plus a private temp directory. No network unless approved for the command.
 */
export class NativeCommandRuntime implements CommandRuntime {
  readonly id: string;
  readonly label: string;

  private readonly sandbox: NativeSandbox | undefined;
  private readonly unavailableReason: string | undefined;
  private readonly sessions = new Map<string, NativeSession>();
  private readonly taskSnapshots = new Map<string, BackgroundTask>();
  private readonly taskListeners = new Set<(event: BackgroundTaskEvent) => void>();

  backgroundTasks(): BackgroundTask[] {
    return [...this.taskSnapshots.values()].map(task => ({...task}));
  }

  observeBackgroundTasks(listener: (event: BackgroundTaskEvent) => void): () => void {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  private publishTask(session: NativeSession): void {
    if (!session.background) return;
    const previous = this.taskSnapshots.get(session.id);
    const task: BackgroundTask = {
      id: session.id,
      kind: 'shell',
      description: session.request.command,
      status: !session.ended
        ? 'running'
        : session.stop === 'cancelled' || session.stop === 'signalled'
          ? 'stopped'
          : session.exitCode === 0 && !session.stop && !session.spawnFailed
            ? 'done'
            : 'failed',
      startedAt: new Date(session.start).toISOString(),
      ...(session.ended && session.exitCode !== null ? {exitCode: session.exitCode} : {}),
      outputTail: session.taskTail,
    };
    this.taskSnapshots.set(task.id, task);
    // Keep live executions and a bounded recent completion history.
    for (const [id, value] of this.taskSnapshots) {
      if (this.taskSnapshots.size <= 200) break;
      if (value.status !== 'running') this.taskSnapshots.delete(id);
    }
    const type = !previous ? 'task.started' : task.status !== 'running' ? 'task.finished' : 'task.updated';
    if (previous && previous.status !== 'running') return;
    for (const listener of [...this.taskListeners]) {
      try {
        listener({type, task: {...task}, parentSessionId: session.request.taskSessionId});
      } catch {
        /* observers never affect execution */
      }
    }
  }

  private moveToBackground(session: NativeSession): void {
    if (session.background || session.ended) return;
    session.background = true;
    session.releaseAbort?.();
    session.yieldForeground?.();
    this.publishTask(session);
  }

  backgroundCurrentTask(sessionId?: string): BackgroundTask | undefined {
    const session = [...this.sessions.values()].find(
      value =>
        value.busy && !value.ended && !value.background && (!sessionId || value.request.taskSessionId === sessionId),
    );
    if (!session) return undefined;
    this.moveToBackground(session);
    return {...this.taskSnapshots.get(session.id)!};
  }

  async stopBackgroundTask(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session?.background || session.ended || session.stop) return false;
    await this.stop(session, 'signalled');
    return true;
  }

  /** Private directory with the command's HOME and TMPDIR; removed on shutdown. */
  private readonly scratch: string;
  private readonly path: string;
  private readonly configuredWorkspaceRoot: string;
  private readonly canonicalWorkspaceRoot: string;
  private readonly canonicalStateDirectory: string | undefined;
  private readonly rustupHome: string | undefined;
  private readonly cargoHome: string | undefined;
  /** Registry credentials and cargo config: never readable, whatever else a toolchain directory exposes. */
  private readonly deniedFiles: string[];
  private readonly invalidWorkspaceReason: string | undefined;
  private proven?: RuntimeAvailability;
  private closed = false;

  private readonly serviceSandbox?: NativeSandbox;

  constructor(private readonly options: NativeRuntimeOptions) {
    const os = options.platform ?? process.platform;
    const home = realPath(options.home ?? homedir());
    this.configuredWorkspaceRoot = resolve(options.workspaceRoot);
    let resolvedWorkspace = this.configuredWorkspaceRoot;
    try {
      resolvedWorkspace = realpathSync.native(this.configuredWorkspaceRoot);
    } catch {
      this.invalidWorkspaceReason = 'Workspace root does not exist or cannot be resolved.';
    }
    this.canonicalWorkspaceRoot = resolvedWorkspace;
    this.canonicalStateDirectory = options.stateDirectory ? realPath(resolve(options.stateDirectory)) : undefined;

    // Canonical: Seatbelt matches real paths, and macOS temp directories live behind the /var symlink.
    this.scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'fyn-exec-')));
    mkdirSync(join(this.scratch, 'home'));
    mkdirSync(join(this.scratch, 'tmp'));

    const pathDirectories = [
      ...new Set(
        (options.hostPath ?? process.env.PATH ?? '').split(delimiter).filter(dir => isAbsolute(dir) && existsSync(dir)),
      ),
    ];
    this.path = [...new Set([...pathDirectories, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
    const rustup = rustToolchainDirectories(pathDirectories, this.path, home, this.scratch);
    this.rustupHome = rustup.rustupHome;
    this.cargoHome = rustup.cargoHome;
    const toolchains = [...new Set([...toolchainDirectories(pathDirectories, home), ...rustup.readable])];
    this.deniedFiles = cargoSecretFiles([...pathDirectories, ...toolchains], home);

    if (os === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      this.sandbox = new SeatbeltSandbox({
        workspace: this.canonicalWorkspaceRoot,
        state: this.canonicalStateDirectory,
        scratch: this.scratch,
        home,
        skillDirectories: options.skillDirectories,
        readOnlySkillDirectories: options.readOnlySkillDirectories,
        secrets: options.hideSecrets ? secretPatterns() : undefined,
        denied: this.deniedFiles,
      });
      this.serviceSandbox = new SeatbeltSandbox({
        workspace: this.canonicalWorkspaceRoot,
        state: this.canonicalStateDirectory,
        scratch: this.scratch,
        home,
        secrets: secretPatterns(),
        denied: this.deniedFiles,
        loopback: false,
      });
    } else if (os === 'linux' && findExecutable('bwrap', this.path)) {
      this.sandbox = new BubblewrapSandbox({
        bwrap: findExecutable('bwrap', this.path)!,
        workspace: this.canonicalWorkspaceRoot,
        state: this.canonicalStateDirectory,
        scratch: this.scratch,
        home,
        hideSecrets: options.hideSecrets === true,
      });
      this.serviceSandbox = new BubblewrapSandbox({
        bwrap: findExecutable('bwrap', this.path)!,
        workspace: this.canonicalWorkspaceRoot,
        state: this.canonicalStateDirectory,
        scratch: this.scratch,
        home,
        hideSecrets: true,
      });
    } else {
      this.unavailableReason = unavailableReason(os);
    }

    this.label =
      this.sandbox?.name === 'macos-seatbelt'
        ? 'macOS Seatbelt'
        : this.sandbox?.name === 'linux-bubblewrap'
          ? 'Linux bubblewrap'
          : 'no sandbox';
    // Approvals are bound to this id, so any change of the effective policy invalidates them.
    const policy = [
      this.canonicalWorkspaceRoot,
      this.canonicalStateDirectory,
      this.path,
      toolchains,
      this.deniedFiles,
      options.hideSecrets === true,
      'v4',
    ];
    this.id =
      `native-${this.sandbox?.name ?? 'none'}:` +
      createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 24);
  }

  capabilities(): CommandRuntimeCapabilities {
    return {
      modes: ['read-only', 'workspace-write', 'danger-full-access'],
      network: true,
      tty: true,
      unsandboxed: true,
      shells: ['bash', 'sh'],
      tools: [],
    };
  }

  /**
   * One real self-test per runtime instance: inside a throwaway workspace a write lands, while a
   * secret read, a `.git` write, a write outside, a home listing, signalling an outside process and
   * launching an app through LaunchServices all fail.
   */
  private workspaceRetargeted(): boolean {
    if (this.invalidWorkspaceReason) return true;
    try {
      return realpathSync.native(this.configuredWorkspaceRoot) !== this.canonicalWorkspaceRoot;
    } catch {
      return true;
    }
  }

  availability(): RuntimeAvailability {
    if (this.closed) return {ok: false, reason: 'Command runtime is closed.'};
    if (this.invalidWorkspaceReason) return {ok: false, reason: this.invalidWorkspaceReason};
    if (!this.sandbox) return {ok: false, reason: this.unavailableReason!};
    if (this.workspaceRetargeted())
      return {ok: false, reason: 'The configured workspace path changed after runtime initialization.'};
    if (this.proven) return this.proven;

    const probe = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-probe-')));
    try {
      const result = this.runSelfTest(probe);
      if (result) return (this.proven = {ok: true});
      return {ok: false, reason: 'The native sandbox self-test failed.'};
    } catch (error) {
      return {
        ok: false,
        reason: 'The native sandbox self-test failed: ' + (error instanceof Error ? error.message : 'unknown'),
      };
    } finally {
      rmSync(probe, {recursive: true, force: true});
    }
  }

  private runSelfTest(probe: string): boolean {
    writeFileSync(join(probe, '.env'), 'PROBE_SECRET');
    mkdirSync(join(probe, '.git'));
    const outside = join(dirname(probe), 'fyn-probe-outside-' + randomUUID());
    // A throwaway "home": its credential directory must be unreadable while the rest of it, like
    // the rest of the system, stays readable (ADR 0061).
    const probeHome = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-probe-home-')));
    mkdirSync(join(probeHome, '.ssh'));
    writeFileSync(join(probeHome, '.ssh', 'id_probe'), 'PROBE_KEY');
    writeFileSync(join(probeHome, 'visible.txt'), 'VISIBLE');

    try {
      // The probe always enables the secret rule so a hide-secrets configuration is proven as well.
      const sandbox =
        this.sandbox!.name === 'macos-seatbelt'
          ? new SeatbeltSandbox({
              workspace: probe,
              scratch: this.scratch,
              home: probeHome,
              secrets: secretPatterns(),
            })
          : this.sandbox!;
      const script = [
        'echo ok > made',
        '! cat .env 2>/dev/null | grep -q PROBE',
        '! touch .git/x 2>/dev/null',
        `! touch ${JSON.stringify(outside)} 2>/dev/null`,
        ...(this.sandbox!.name === 'macos-seatbelt'
          ? [
              `! cat ${JSON.stringify(join(probeHome, '.ssh', 'id_probe'))} >/dev/null 2>&1`,
              `grep -q VISIBLE ${JSON.stringify(join(probeHome, 'visible.txt'))}`,
              `! touch ${JSON.stringify(join(probeHome, 'planted'))} 2>/dev/null`,
            ]
          : []),
        `! kill -0 ${process.pid} 2>/dev/null`,
        '! /usr/bin/open -g -j -a /System/Applications/Calculator.app 2>/dev/null',
      ].join(' && ');
      const argv = sandbox.wrap(
        ['/bin/bash', '--noprofile', '--norc', '-c', script],
        {mode: 'workspace-write', network: false},
        probe,
      );
      const result = spawnSync(argv[0]!, argv.slice(1), {
        cwd: probe,
        env: this.env(false),
        timeout: 10_000,
        encoding: 'utf8',
      });

      return (
        result.status === 0 &&
        readFileSync(join(probe, 'made'), 'utf8') === 'ok\n' &&
        !existsSync(outside) &&
        !existsSync(join(probe, '.git', 'x'))
      );
    } finally {
      rmSync(probeHome, {recursive: true, force: true});
    }
  }

  /**
   * Tool caches and config live in the session's private scratch directory, which the profile makes
   * writable (Codex lets commands write TMPDIR). The real home is hidden, so npm, yarn, pnpm, pip
   * and XDG-aware tools would otherwise fail with EPERM. No secret and no real path is exposed.
   */
  private cacheEnv(): Record<string, string> {
    const tmp = join(this.scratch, 'tmp');
    const home = join(this.scratch, 'home');
    return {
      BUN_INSTALL_CACHE_DIR: join(tmp, 'bun-cache'),
      npm_config_cache: join(tmp, 'npm-cache'),
      npm_config_store_dir: join(tmp, 'pnpm-store'),
      YARN_CACHE_FOLDER: join(tmp, 'yarn-cache'),
      PIP_CACHE_DIR: join(tmp, 'pip-cache'),
      GOCACHE: join(tmp, 'go-build'),
      COREPACK_HOME: join(tmp, 'corepack'),
      XDG_CACHE_HOME: join(tmp, 'xdg-cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    };
  }

  private env(tty: boolean, unsandboxed = false, proxyUrl?: string): Record<string, string> {
    if (unsandboxed) return this.hostEnv(tty);
    return {
      ...(proxyUrl ? {...proxyEnvironment(proxyUrl), NODE_USE_ENV_PROXY: '1'} : {}),
      ...EXEC_ENV,
      ...(tty ? {TERM: 'xterm-256color', NO_COLOR: ''} : {}),
      PATH: this.path,
      HOME: join(this.scratch, 'home'),
      TMPDIR: join(this.scratch, 'tmp'),
      ...this.cacheEnv(),
      ...(this.rustupHome ? {RUSTUP_HOME: this.rustupHome} : {}),
      ...(this.cargoHome ? {CARGO_HOME: this.cargoHome} : {}),
    };
  }

  /**
   * Environment of a command the user approved to run WITHOUT the sandbox (an escalation or Full
   * Access, F12): the user's real environment and HOME, as Codex's `shell_environment_policy`
   * (inherit all, default excludes `*KEY*`, `*SECRET*`, `*TOKEN*`) followed by Codex's unified-exec
   * overlay. Cosmew's own state and configuration variables never pass, and neither does the
   * sandbox scratch directory (no scratch HOME, XDG_* or cache redirects).
   */
  private hostEnv(tty: boolean): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || HOST_ENV_EXCLUDED.test(key) || /^(COSMEW|FUTRYN|HANNES)_/i.test(key)) continue;
      inherited[key] = value;
    }
    const {FUTRYN_SANDBOX: _marker, ...overlay} = EXEC_ENV;
    return {
      ...inherited,
      ...overlay,
      ...(tty ? {TERM: 'xterm-256color', NO_COLOR: ''} : {}),
      PATH: this.path,
      HOME: this.options.home ?? process.env.HOME ?? homedir(),
    };
  }

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome> {
    if (this.closed || this.invalidWorkspaceReason) throw new FutrynError('UNSUPPORTED');
    const sandbox = request.sandbox ?? READ_ONLY;
    if (!sandbox.unsandboxed && !this.availability().ok) throw new FutrynError('UNSUPPORTED');
    signal?.throwIfAborted();
    // Completed background tasks already have bounded snapshots; reclaim their terminal slots
    // when admission needs one, without consuming any live session's pending output.
    if (this.sessions.size >= NATIVE_LIMITS.maxSessions) {
      for (const [id, session] of this.sessions) {
        if (this.sessions.size < NATIVE_LIMITS.maxSessions) break;
        if (session.background && session.ended && !session.busy) this.sessions.delete(id);
      }
    }
    if (this.sessions.size >= NATIVE_LIMITS.maxSessions) throw new FutrynError('BUDGET');
    validateRequest(request);

    const workspace = new WorkspaceRoot(this.canonicalWorkspaceRoot);
    // writableRoots is the seatbelt write list and is omitted when the command is unsandboxed,
    // read-only, or excluded. cwdRoots keeps the trusted additional directories for the cwd.
    const cwd = workspace.resolve(request.cwd, request.cwdRoots ?? request.sandbox?.writableRoots ?? []);
    if (cwd.kind !== 'directory') throw new FutrynError('POLICY');
    if (this.workspaceRetargeted()) throw new FutrynError('POLICY');

    // Only an explicit, user-approved escalation (ADR 0053) skips the sandbox, and only for this
    // command. A sandbox that fails to start is reported; it is never replaced by this path.
    const argv =
      sandbox.unsandboxed === true ? shellArgv(request) : this.sandbox!.wrap(shellArgv(request), sandbox, cwd.absolute);
    const session = createSession(request, sandbox);

    try {
      if (session.tty) this.startPty(session, argv, cwd.absolute);
      else this.startPipes(session, argv, cwd.absolute);
    } catch {
      throw new FutrynError('UNSUPPORTED');
    }

    // The lease is the hard deadline for the command and everything it started.
    session.lease = setTimeout(() => {
      void this.stop(session, 'timeout');
    }, request.timeoutMs);
    this.sessions.set(session.id, session);
    session.taskChanged = () => this.publishTask(session);
    void session.done.then(() => {
      session.releaseAbort?.();
      this.publishTask(session);
    });

    const abort = () => {
      if (!session.background) void this.stop(session, 'cancelled');
    };
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
      env: this.env(true, session.sandbox.unsandboxed === true, session.sandbox.proxyUrl),
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
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: this.env(false, session.sandbox.unsandboxed === true, session.sandbox.proxyUrl),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
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
  private async stop(session: NativeSession, reason: 'cancelled' | 'timeout' | 'signalled'): Promise<void> {
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
    const abort = () => {
      if (!session.background) void this.stop(session, 'cancelled');
    };
    if (signal?.aborted && !session.background) await this.stop(session, 'cancelled');
    else signal?.addEventListener('abort', abort, {once: true});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!session.ended)
        await Promise.race([
          session.done,
          new Promise<void>(resolve => {
            session.yieldForeground = resolve;
          }),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, yieldMs);
          }),
        ]);
      if (signal?.aborted && !session.background) await this.stop(session, 'cancelled');

      if (!session.ended) this.moveToBackground(session);
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
      session.yieldForeground = undefined;
    }
  }

  private outcome(session: NativeSession): CommandOutcome {
    const kind = outcomeKind(session);
    const stdout = session.buffers.stdout,
      stderr = session.buffers.stderr;
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
        leader: session.spawnFailed ? 'not-started' : session.exitObserved ? 'exited' : 'unconfirmed',
        stopRequested: !!session.stop,
        output: session.outputClosed ? 'closed' : 'cut-off',
        descendants: session.spawnFailed ? 'not-started' : descendants,
      },
    };
  }

  session(id: string): CommandSessionInfo | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {
      cwd: session.request.cwd,
      command: session.request.command,
      tty: session.tty,
      sandbox: {...session.sandbox},
    };
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    const validSize =
      Number.isInteger(cols) && cols >= 10 && cols <= 1000 && Number.isInteger(rows) && rows >= 5 && rows <= 500;
    if (!session || !session.tty || session.ended || !validSize) throw new FutrynError('POLICY');
    session.ptyChild?.terminal?.resize(cols, rows);
  }

  /**
   * Codex write_stdin: empty input polls; other input goes to the session's pipe or PTY. SIGINT (or
   * `\x03` on a pipe session) interrupts the foreground job, which may survive it; SIGTERM ends the
   * whole session. The original lease never extends.
   */
  async writeStdin(
    id: string,
    chars: string,
    yieldTimeMs: number,
    signal?: AbortSignal,
    interrupt?: 'SIGINT' | 'SIGTERM',
    onOutput?: (chunk: CommandOutputChunk) => void,
  ): Promise<CommandOutcome> {
    const session = this.sessions.get(id);
    const validInput = chars.length <= NATIVE_LIMITS.maxStdinChars && !chars.includes('\u0000');
    const validYield = Number.isInteger(yieldTimeMs) && yieldTimeMs >= 0 && yieldTimeMs <= 30_000;
    if (!session || session.busy || this.closed || !validInput || !validYield) throw new FutrynError('POLICY');
    if (session.ended && (chars || interrupt)) throw new FutrynError('POLICY');

    session.busy = true;
    session.observer = onOutput;
    try {
      signal?.throwIfAborted();
      if (interrupt === 'SIGTERM') await this.stop(session, 'signalled');
      else if (interrupt === 'SIGINT' || (!session.tty && chars === '\u0003')) interruptForeground(session);
      else if (chars && !session.ended) sendInput(session, chars);
      return await this.collect(session, yieldTimeMs, signal);
    } finally {
      session.busy = false;
    }
  }

  /** Helper processes started by `spawnService`, stopped on shutdown. */
  private readonly services = new Set<ChildProcess>();

  /**
   * A language server or similar helper (ADR 0043) inside the same OS sandbox as commands, fixed to
   * read-only and no network; the repository's own binaries may be launched only this way. Refused
   * when the sandbox is unavailable — there is no unsandboxed fallback.
   */
  spawnService(argv: string[], cwd: string): ServiceProcess {
    if (!this.availability().ok || !argv.length) throw new FutrynError('UNSUPPORTED');
    const workspace = new WorkspaceRoot(this.canonicalWorkspaceRoot);
    const directory = workspace.resolve(cwd);
    if (directory.kind !== 'directory' || this.workspaceRetargeted()) throw new FutrynError('POLICY');
    // Keep a trusted leader until its group is killed; its PID cannot be reused before cleanup.
    // Descendants that create a new session remain unconfirmed on macOS.
    const supervised = ['/bin/sh', '-c', `trap 'kill -KILL 0' EXIT; "$@"; exit "$?"`, 'futryn-service', ...argv];
    const wrapped = this.serviceSandbox!.wrap(supervised, READ_ONLY, directory.absolute);
    const child = spawn(wrapped[0]!, wrapped.slice(1), {
      cwd: directory.absolute,
      env: this.env(false),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.services.add(child);
    child.stdin!.on('error', () => {});
    child.stderr!.on('data', () => {});
    child.once('exit', () => this.services.delete(child));
    child.once('error', () => this.services.delete(child));
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    };
    return {
      pid: child.pid,
      write: data => {
        if (child.stdin!.writable) child.stdin!.write(data);
      },
      onData: listener => {
        child.stdout!.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk)));
      },
      onExit: listener => {
        child.once('exit', code => listener(code));
        child.once('error', () => listener(null));
      },
      kill,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const child of this.services) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.services.clear();
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
  const done = new Promise<void>(resolve => {
    markDone = resolve;
  });
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
    taskTail: '',
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
  session.taskTail = (
    session.taskTail + new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 8192)))
  ).slice(-8192);
  session.taskChanged?.();
  const limit = session.tty ? session.request.maxOutputBytes : session.budgets.stderr;
  if (session.streamed[stream] >= limit) return;

  const text = new TextDecoder().decode(bytes.subarray(0, limit - session.streamed[stream]));
  session.streamed[stream] += bytes.length;
  try {
    session.observer?.({stream, text});
  } catch {
    session.observer = undefined;
  }
}

/** Codex: each call reports only the output produced since the previous call on this session. */
function resetOutputWindow(session: NativeSession): void {
  session.buffers = {
    stdout: new HeadTailBuffer(session.budgets.stdout),
    stderr: new HeadTailBuffer(session.budgets.stderr),
  };
  session.streamed = {stdout: 0, stderr: 0};
}

/** Output held open by a descendant must not hold the result forever. */
function onLeaderExit(session: NativeSession, code: number | null, signal: string | null): void {
  if (session.exitObserved) return;
  // Complete requested group cleanup at the owned leader's first exit notification. Otherwise
  // EOF can finish the session and cancel escalation while a TERM-ignoring child remains alive.
  // Never retry a saved group ID after recording this observation (macOS still permits setsid escapes).
  if (session.stop) signalGroup(session, 'SIGKILL');
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
  // A model-requested SIGTERM is a normal, completed request: report how the process ended.
  if (session.stop === 'signalled') return 'exited';
  if (session.stop === 'cancelled') return 'cancelled';
  return 'exited';
}

function signalGroup(session: NativeSession, signal: NodeJS.Signals): void {
  if (session.exitObserved || session.spawnFailed) return;
  try {
    if (session.pid) process.kill(-session.pid, signal);
  } catch {
    try {
      session.pipeChild?.kill(signal);
      session.ptyChild?.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function interruptForeground(session: NativeSession): void {
  if (session.tty) {
    session.ptyChild?.terminal?.write('\u0003');
    return;
  }
  try {
    process.kill(-session.pid!, 'SIGINT');
  } catch {
    /* already gone */
  }
}

function sendInput(session: NativeSession, chars: string): void {
  if (session.tty) session.ptyChild?.terminal?.write(chars);
  else session.pipeChild?.stdin?.write(chars);
}

// ---------------------------------------------------------------------------------------------
// Launch helpers

function validateRequest(request: CommandRequest): void {
  const shell = request.shell ?? 'bash';
  const validLease =
    Number.isInteger(request.timeoutMs) &&
    request.timeoutMs >= NATIVE_LIMITS.minLeaseMs &&
    request.timeoutMs <= NATIVE_LIMITS.maxLeaseMs;
  const validCommand = request.command.length <= 1024 && !request.command.includes('\u0000');
  const validOutput =
    Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes >= 1 && request.maxOutputBytes <= 60_000;
  if (!validLease || !validCommand || !validOutput || !['bash', 'sh'].includes(shell))
    throw new FutrynError('INVALID_INPUT');
}

/** The shell never reads project startup files unless a login shell was requested. */
function shellArgv(request: CommandRequest): string[] {
  if (request.shell === 'sh') return ['/bin/sh', ...(request.login ? ['-l'] : []), '-c', request.command];
  return ['/bin/bash', ...(request.login ? ['--login'] : ['--noprofile', '--norc']), '-c', request.command];
}

/**
 * Toolchains installed under home (bun, nvm…): each PATH directory below home and its parent. The
 * Rust homes are handled by `rustToolchainDirectories`, which never exposes all of `~/.cargo`.
 */
function toolchainDirectories(pathDirectories: string[], home: string): string[] {
  const rustHomes = new Set([realPath(join(home, '.cargo')), realPath(join(home, '.rustup'))]);
  const candidates = pathDirectories.flatMap(dir => [dir, dirname(dir)]).map(realPath);
  return [...new Set(candidates.filter(dir => dir.startsWith(home + '/') && !rustHomes.has(dir)))];
}

/**
 * rustup shims need only the toolchains and `settings.toml` of `~/.rustup` plus `~/.cargo/bin` and
 * `~/.cargo/registry`, all read-only. `CARGO_HOME` points at a private scratch directory that links
 * just `bin` and `registry`, so `~/.cargo/credentials*` and `~/.cargo/config*` never exist for the command.
 */
function rustToolchainDirectories(
  pathDirectories: string[],
  path: string,
  home: string,
  scratch: string,
): {rustupHome?: string; cargoHome?: string; readable: string[]} {
  const under = (dir: string) => dir.startsWith(home + '/');
  const rustupShim =
    findExecutable('rustup', path) !== undefined ||
    pathDirectories.some(dir => under(realPath(dir)) && existsSync(join(dir, 'rustup')));
  if (!rustupShim) return {readable: []};
  const rustup = realPath(join(home, '.rustup'));
  const cargo = realPath(join(home, '.cargo'));
  const readable: string[] = [];
  let rustupHome: string | undefined;
  if (existsSync(rustup) && under(rustup)) {
    rustupHome = rustup;
    for (const name of ['toolchains', 'settings.toml'])
      if (existsSync(join(rustup, name))) readable.push(realPath(join(rustup, name)));
  }
  let cargoHome: string | undefined;
  if (existsSync(cargo) && under(cargo)) {
    cargoHome = join(scratch, 'cargo');
    mkdirSync(cargoHome);
    for (const name of ['bin', 'registry']) {
      const source = join(cargo, name);
      if (!existsSync(source)) continue;
      const target = realPath(source);
      if (!under(target)) continue;
      symlinkSync(target, join(cargoHome, name));
      readable.push(target);
    }
  }
  return {rustupHome, cargoHome, readable};
}

/** Cargo registry tokens and config, for `~/.cargo`, `$CARGO_HOME` and any PATH directory that holds cargo, wherever it lives. */
function cargoSecretFiles(directories: string[], home: string): string[] {
  const roots = new Set([join(home, '.cargo'), realPath(join(home, '.cargo'))]);
  if (process.env.CARGO_HOME) roots.add(realPath(process.env.CARGO_HOME));
  for (const dir of directories)
    if (existsSync(join(dir, 'cargo')) || existsSync(join(dir, 'rustup'))) roots.add(realPath(dirname(dir)));
  const files = [...roots].flatMap(root =>
    ['credentials', 'credentials.toml', 'config', 'config.toml'].map(name => join(root, name)),
  );
  return [...new Set(files.flatMap(file => [file, realPath(file)]))];
}

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function unavailableReason(os: NodeJS.Platform): string {
  if (os === 'win32') return 'Native Windows command sandboxing is not implemented. Nothing can run.';
  if (os === 'linux') return 'bubblewrap (bwrap) is not installed; install it to run commands.';
  return `No native command sandbox for ${os}.`;
}

function findExecutable(name: string, path: string): string | undefined {
  for (const dir of path.split(':')) {
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next directory */
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
