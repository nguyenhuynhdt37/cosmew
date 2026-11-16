import {createHash, randomUUID} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative} from 'node:path';
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
import {CONTAINER_SUPERVISOR} from './container-supervisor';
import {planContainerMounts, type MountPlan, type MountSources} from './container-mounts';
import {FrameReader, hostConfigMatches, type Receipt} from './container-protocol';
import {EXECUTION_IMAGE, GIT_IMAGE_TAG, verifiedDerivedImage} from './image';
import {HeadTailBuffer} from './output';
import {likelySandboxDenied} from './sandbox-denial';

export {EXECUTION_IMAGE, likelySandboxDenied};

export const COMMAND_LIMITS = {
  minLeaseMs: 1000,
  maxLeaseMs: 1_800_000,
  maxSessions: 8,
  maxStdinChars: 8000,
} as const;

/** Engine identity is re-read at most this often; any change of identity re-runs the self-tests. */
const ENGINE_TTL_MS = 15_000;
/** Persisted self-test evidence is trusted for at most this long. */
const PROOF_TTL_MS = 86_400_000;
const DOCKER_CANDIDATES = ['/opt/homebrew/bin/docker', '/usr/bin/docker', '/usr/local/bin/docker'];
const READ_ONLY: CommandSandbox = {mode: 'read-only', network: false};
/** Part of the runtime id: approvals never carry over a change of this fixed policy. */
const POLICY =
  'v2:uid-owner-or-65534;capdrop-all+setuid,setgid,setpcap,kill;network-none-unless-approved;pid/ipc/cgroup-private;rootfs-ro;live-bind+masks(.git ro,secrets,state);lease';

/** Self-test results per engine identity + runtime id; shared by runtime instances in this process. */
const proof = new Map<string, RuntimeAvailability>();

interface EngineState {
  at: number;
  /** Engine ID, version, security options and image: the self-test evidence key. */
  key: string;
  image: string;
  git: boolean;
}

/** A running or finished command owned by this runtime. Its container is the session boundary. */
interface ContainerSession {
  id: string;
  container: string;
  request: CommandRequest;
  sandbox: CommandSandbox;
  tty: boolean;
  /** Its top-level `.git` is a read-only mountpoint, so this session cannot rename or replace it. */
  gitPinned: boolean;
  process: ChildProcessWithoutNullStreams;
  start: number;
  done: Promise<void>;
  ended: boolean;
  busy: boolean;
  observer?: CommandRequest['onOutput'];
  buffers: Record<'stdout' | 'stderr', HeadTailBuffer>;
  budgets: Record<'stdout' | 'stderr', number>;
  streamed: Record<'stdout' | 'stderr', number>;
  /** Observed from `docker inspect` after the attach stream closed. */
  leaderStarted: boolean;
  namespaceDead: boolean;
  exitCode: number | null;
  receipt?: Receipt;
  protocolBroken?: boolean;
  stop?: 'cancelled' | 'timeout';
  stopping?: Promise<void>;
  deliveredSignal?: string;
  releaseAbort?: () => void;
}

/**
 * Optional unified-exec backend on a fixed local Unix-socket Linux-container engine (ADR 0032/0034;
 * native is the default since ADR 0035). The live workspace is bind-mounted read-only or read-write,
 * `.git` is read-only, and secrets, Futryn state and patch temporaries are masked. Every boundary is a
 * mount/namespace property verified on the created container before it starts.
 */
export class DockerCommandRuntime implements CommandRuntime {
  readonly id: string;
  readonly label =
    'Docker sandbox · live workspace mount · .git read-only · secrets/state masked · no network unless approved · finite lease';

  /** Container label that proves a container belongs to this runtime instance. */
  private readonly owner = randomUUID();
  private readonly sessions = new Map<string, ContainerSession>();
  private readonly control: string;
  private readonly sources: MountSources;
  private readonly docker: string;
  private readonly socket: string;
  private engine?: EngineState;
  private closed = false;

  constructor(private readonly options: {workspaceRoot: string; stateDirectory?: string}) {
    this.control = mkdtempSync(join(tmpdir(), 'fyn-docker-control-'));
    const emptyFile = join(this.control, 'masked-file');
    writeFileSync(emptyFile, '');
    chmodSync(emptyFile, 0o444);
    const emptyDirectory = join(this.control, 'masked-directory');
    mkdirSync(emptyDirectory);
    chmodSync(emptyDirectory, 0o555);
    this.sources = {stateDirectory: options.stateDirectory, emptyFile, emptyDirectory, control: this.control};

    this.docker = DOCKER_CANDIDATES.find(path => existsSync(path)) ?? '/usr/bin/docker';
    try {
      this.socket = realpathSync('/var/run/docker.sock');
    } catch {
      this.socket = '/var/run/docker.sock';
    }

    const policy = [
      this.socket,
      EXECUTION_IMAGE,
      GIT_IMAGE_TAG,
      options.workspaceRoot,
      options.stateDirectory,
      CONTAINER_SUPERVISOR,
      POLICY,
    ];
    this.id = 'docker-unified-exec-v2:' + createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  }

  // -------------------------------------------------------------------------------------------
  // Docker CLI: a fixed binary, socket and empty private configuration; nothing from the host env.

  private env() {
    return {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: this.control, LANG: 'C', DOCKER_CONFIG: this.control};
  }

  private prefix() {
    return ['--host', 'unix://' + this.socket, '--config', this.control];
  }

  private cli(args: string[], timeout = 10_000) {
    return spawnSync(this.docker, [...this.prefix(), ...args], {
      env: this.env(),
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  /** The fixed containment policy; `hostConfigMatches` checks the created container against it. */
  private flags(sandbox: CommandSandbox): string[] {
    return [
      '--pid=',
      sandbox.network ? '--network=bridge' : '--network=none',
      '--cap-drop=ALL',
      '--cap-add=SETUID',
      '--cap-add=SETGID',
      '--cap-add=SETPCAP',
      '--cap-add=KILL',
      '--security-opt=no-new-privileges',
      '--read-only',
      '--pids-limit=128',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=1',
      '--ipc=private',
      '--cgroupns=private',
      '--user=0:0',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
      '--ulimit',
      'nofile=1024:1024',
      '--entrypoint',
      '/usr/local/bin/bun',
    ];
  }

  /** Bun arguments that run the trusted PID1 supervisor with one JSON launch record. */
  private supervisor(launch: Record<string, unknown>): string[] {
    return ['--config=/dev/null', '--no-env-file', '-e', CONTAINER_SUPERVISOR, '--', JSON.stringify(launch)];
  }

  private owned(session: ContainerSession): boolean {
    const result = this.cli(['inspect', '--format', '{{index .Config.Labels "futryn.exec.owner"}}', session.container]);
    return result.status === 0 && result.stdout.trim() === this.owner;
  }

  // -------------------------------------------------------------------------------------------
  // Engine identity and self-tests

  /** Engine identity and the approved image, cached briefly. */
  private engineState(): EngineState {
    if (this.engine && Date.now() - this.engine.at < ENGINE_TTL_MS) return this.engine;
    this.engine = undefined;

    if (!['darwin', 'linux'].includes(process.platform) || !statSync(this.socket).isSocket())
      throw new Error('A local Unix-socket Linux-container engine is required.');
    const info = this.cli(['info', '--format', '{{json .}}']);
    if (info.status !== 0) throw new Error('Local Docker engine unavailable.');
    const engine = JSON.parse(info.stdout);
    const seccomp = engine.SecurityOptions?.some((option: string) => option.startsWith('name=seccomp'));
    if (engine.OSType !== 'linux' || engine.CgroupVersion !== '2' || !seccomp)
      throw new Error('Linux engine with default seccomp required.');

    const base = this.cli(['image', 'inspect', EXECUTION_IMAGE]);
    if (base.status !== 0)
      throw new Error('Pinned approved image missing. Pull it explicitly during host setup; commands never pull.');

    // The optional git image is used by its content ID only after its layers are verified.
    let image = EXECUTION_IMAGE,
      git = false;
    const derived = this.cli(['image', 'inspect', GIT_IMAGE_TAG]);
    if (derived.status === 0) {
      const [baseImage] = JSON.parse(base.stdout),
        [derivedImage] = JSON.parse(derived.stdout);
      if (verifiedDerivedImage(baseImage, derivedImage) && /^sha256:[a-f0-9]{64}$/.test(derivedImage.Id)) {
        image = derivedImage.Id;
        git = true;
      }
    }

    const key = `${engine.ID}:${engine.ServerVersion}:${JSON.stringify(engine.SecurityOptions)}:${image}`;
    return (this.engine = {at: Date.now(), key, image, git});
  }

  capabilities(): CommandRuntimeCapabilities {
    let git = false;
    try {
      git = this.engineState().git;
    } catch {
      /* unavailable runtimes are never offered */
    }
    return {
      modes: ['read-only', 'workspace-write'],
      network: true,
      tty: true,
      shells: ['bash', 'sh'],
      tools: ['bash', 'sh', 'bun', 'coreutils', ...(git ? ['git'] : [])],
    };
  }

  availability(): RuntimeAvailability {
    if (this.closed) return {ok: false, reason: 'Command runtime is closed.'};
    try {
      const engine = this.engineState();
      const key = engine.key + ':' + this.id;
      const cached = proof.get(key) ?? this.persistedProof(key);
      if (cached) {
        proof.set(key, cached);
        return cached;
      }
      this.containmentProbe(engine.image);
      this.detachedProbe(engine.image);
      this.writeProbe(engine.image);
      const passed = {ok: true} as const;
      proof.set(key, passed);
      this.persistProof(key);
      return passed;
    } catch (error) {
      return {ok: false, reason: error instanceof Error ? error.message : 'Container verification failed.'};
    }
  }

  /** Same kernel profile as production: uid, capabilities, read-only root, no socket, no network. */
  private containmentProbe(image: string): void {
    const checks = [
      'test "$(id -u)" = 65534',
      'test "$(cat /proc/1/comm)" = bun',
      'grep -q "CapEff:\\s*0000000000000000" /proc/self/status',
      'grep -q "NoNewPrivs:\\s*1" /proc/self/status',
      'test "$(cat /sys/fs/cgroup/pids.max)" = 128',
      '! touch /etc/fyn-escape',
      'test ! -e /var/run/docker.sock',
      'bun -e \'fetch("http://1.1.1.1").then(()=>process.exit(1)).catch(()=>process.exit(0))\'',
    ].join(' && ');
    const result = this.runProbe(image, [], {lease: 1500, command: checks, cwd: '/', uid: 65534, gid: 65534}, 6000);
    if (result.status !== 0) throw new Error('Containment privilege/filesystem/network self-test failed.');
  }

  /** A detached `setsid` child must still die with the namespace at the lease. */
  private detachedProbe(image: string): void {
    const name = 'fyn-probe-' + randomUUID();
    try {
      const result = this.cli(
        [
          'run',
          '--name',
          name,
          '--pull=never',
          ...this.flags(READ_ONLY),
          image,
          ...this.supervisor(
            probeLaunch({lease: 1000, command: 'setsid sh -c "sleep 30" & wait', cwd: '/', uid: 65534, gid: 65534}),
          ),
        ],
        5000,
      );
      const state = JSON.parse(this.cli(['inspect', '--format', '{{json .State}}', name]).stdout || 'null');
      if (result.status !== 124 || !state || state.Running || state.Pid !== 0)
        throw new Error('Detached-process lease/namespace teardown self-test failed.');
    } finally {
      this.cli(['rm', '-f', name]);
    }
  }

  /** Workspace-write on a private tree: real writes land; masks and `.git` cannot be changed. */
  private writeProbe(image: string): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-write-probe-')));
    try {
      writeFileSync(join(root, '.env'), 'PROBE_SECRET');
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(root, '.futryn'));
      writeFileSync(join(root, '.futryn', 'state'), 'STATE');

      const plan = planContainerMounts(root, {mode: 'workspace-write', network: false}, this.sources);
      const checks = [
        'cd /workspace',
        'echo WRITTEN > made.txt',
        'test ! -s .env',
        '! rm .env 2>/dev/null',
        '! touch .git/escape 2>/dev/null',
        'test ! -e .futryn/state',
        '! touch .futryn/x 2>/dev/null',
        '! touch /etc/escape 2>/dev/null',
        '! ln /etc/hostname hard 2>/dev/null',
      ].join(' && ');
      const result = this.runProbe(
        image,
        plan.args,
        {lease: 3000, command: checks, cwd: '/workspace', uid: plan.uid, gid: plan.gid},
        8000,
      );
      if (result.status !== 0) throw new Error('Workspace-write mask self-test failed.');

      const hostOk =
        readFileSync(join(root, 'made.txt'), 'utf8') === 'WRITTEN\n' &&
        readFileSync(join(root, '.env'), 'utf8') === 'PROBE_SECRET' &&
        !existsSync(join(root, '.git', 'escape')) &&
        !existsSync(join(root, 'hard'));
      if (!hostOk) throw new Error('Workspace-write host observation self-test failed.');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  }

  private runProbe(image: string, mounts: string[], launch: ProbeLaunch, timeout: number) {
    const name = 'fyn-probe-' + randomUUID();
    try {
      return this.cli(
        [
          'run',
          '--name',
          name,
          '--pull=never',
          ...this.flags(READ_ONLY),
          ...mounts,
          ...(mounts.length ? ['--workdir', '/'] : []),
          image,
          ...this.supervisor(probeLaunch(launch)),
        ],
        timeout,
      );
    } finally {
      this.cli(['rm', '-f', name]);
    }
  }

  /**
   * Self-test evidence survives restarts only inside Futryn's state directory, which commands can
   * never see or write, and only for the same engine identity, image and runtime id, for 24 h.
   */
  private proofFile(): string | undefined {
    return this.options.stateDirectory ? join(this.options.stateDirectory, 'exec-runtime-proof.json') : undefined;
  }

  private persistedProof(key: string): RuntimeAvailability | undefined {
    const file = this.proofFile();
    if (!file) return undefined;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const age = Date.now() - saved?.at;
      if (saved?.key === key && typeof saved.at === 'number' && age >= 0 && age < PROOF_TTL_MS) return {ok: true};
    } catch {
      /* no evidence */
    }
    return undefined;
  }

  private persistProof(key: string): void {
    const file = this.proofFile();
    if (!file) return;
    try {
      writeFileSync(file, JSON.stringify({key, at: Date.now()}), {mode: 0o600});
    } catch {
      /* evidence is an optimisation only */
    }
  }

  // -------------------------------------------------------------------------------------------
  // Launch

  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome> {
    if (!this.availability().ok) throw new FutrynError('UNSUPPORTED');
    signal?.throwIfAborted();
    if (this.sessions.size >= COMMAND_LIMITS.maxSessions) throw new FutrynError('BUDGET');
    const sandbox = request.sandbox ?? READ_ONLY;
    validateRequest(request, sandbox);

    const engine = this.engineState();
    // A running write session whose .git is not a pinned mountpoint could swap .git for a symlink:
    // hide .git for this launch, and let PID1 re-verify every mask before the command starts.
    const writers = [...this.sessions.values()].filter(
      session => !session.ended && session.sandbox.mode === 'workspace-write',
    );
    const gitSafe = !writers.some(session => !session.gitPinned);
    const plan = planContainerMounts(this.options.workspaceRoot, sandbox, this.sources, gitSafe);

    const cwd = plan.workspace.resolve(request.cwd);
    if (cwd.kind !== 'directory') throw new FutrynError('POLICY');
    const relativeCwd = relative(plan.workspace.root, cwd.absolute);
    if (relativeCwd.startsWith('..') || isAbsolute(relativeCwd)) throw new FutrynError('POLICY');

    const sessionId = randomUUID();
    let container = '';
    try {
      signal?.throwIfAborted();
      container = this.createContainer(
        sessionId,
        engine.image,
        request,
        sandbox,
        plan,
        '/workspace' + (relativeCwd ? '/' + relativeCwd : ''),
        writers.length > 0,
      );
      signal?.throwIfAborted();
      const session = this.startSession(sessionId, container, request, sandbox, plan.gitPinned);

      const abort = () => {
        void this.stop(session, 'cancelled');
      };
      signal?.addEventListener('abort', abort, {once: true});
      session.releaseAbort = () => signal?.removeEventListener('abort', abort);

      try {
        return await this.collect(session, request.yieldTimeMs ?? request.timeoutMs + 2500, signal);
      } finally {
        session.busy = false;
      }
    } catch (error) {
      if (container && !this.sessions.has(sessionId)) this.cli(['rm', '-f', container]);
      throw error;
    }
  }

  /** Create the container and verify its actual configuration; returns the container id. */
  private createContainer(
    sessionId: string,
    image: string,
    request: CommandRequest,
    sandbox: CommandSandbox,
    plan: MountPlan,
    cwd: string,
    verifyMasks: boolean,
  ): string {
    const launch = {
      lease: request.timeoutMs,
      command: request.command,
      cwd,
      uid: plan.uid,
      gid: plan.gid,
      tty: request.tty === true,
      cols: 120,
      rows: 40,
      shell: request.shell ?? 'bash',
      login: request.login === true,
      ...(verifyMasks ? {verify: plan.verify} : {}),
    };
    const created = this.cli([
      'create',
      '--interactive',
      '--pull=never',
      '--label',
      'futryn.exec.owner=' + this.owner,
      '--label',
      'futryn.exec.session=' + sessionId,
      ...this.flags(sandbox),
      '--workdir',
      '/',
      ...plan.args,
      image,
      ...this.supervisor(launch),
    ]);
    const container = created.stdout.trim();
    if (created.status !== 0 || !/^[a-f0-9]{64}$/.test(container)) {
      if (container) this.cli(['rm', '-f', container]);
      throw new FutrynError('UNSUPPORTED');
    }

    const host = JSON.parse(this.cli(['inspect', '--format', '{{json .HostConfig}}', container]).stdout || 'null');
    if (!hostConfigMatches(host, sandbox, plan.expected)) {
      this.cli(['rm', '-f', container]);
      throw new FutrynError('POLICY');
    }
    return container;
  }

  /** Start the verified container attached, and wire its framed output into a new session. */
  private startSession(
    id: string,
    container: string,
    request: CommandRequest,
    sandbox: CommandSandbox,
    gitPinned: boolean,
  ): ContainerSession {
    const tty = request.tty === true;
    // A PTY merges stdout and stderr, so it gets the whole budget.
    const stdoutBudget = tty ? request.maxOutputBytes : Math.max(1, Math.ceil(request.maxOutputBytes / 2));
    const stderrBudget = Math.max(1, Math.floor(request.maxOutputBytes / 2));
    let markDone!: () => void;
    const done = new Promise<void>(resolve => {
      markDone = resolve;
    });

    const child = spawn(this.docker, [...this.prefix(), 'start', '--attach', '--interactive', container], {
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: ContainerSession = {
      id,
      container,
      request,
      sandbox,
      tty,
      gitPinned,
      process: child,
      start: Date.now(),
      done,
      ended: false,
      busy: true,
      observer: request.onOutput,
      buffers: {stdout: new HeadTailBuffer(stdoutBudget), stderr: new HeadTailBuffer(stderrBudget)},
      budgets: {stdout: stdoutBudget, stderr: stderrBudget},
      streamed: {stdout: 0, stderr: 0},
      leaderStarted: false,
      namespaceDead: false,
      exitCode: null,
    };
    this.sessions.set(id, session);

    const decoders = {stdout: new TextDecoder(), stderr: new TextDecoder()};
    const recordOutput = (stream: 'stdout' | 'stderr', bytes: Buffer) => {
      session.buffers[stream].push(bytes);
      const limit = tty ? request.maxOutputBytes : Math.floor(request.maxOutputBytes / 2);
      if (session.streamed[stream] >= limit) return;
      const text = decoders[stream].decode(bytes.subarray(0, limit - session.streamed[stream]), {stream: true});
      session.streamed[stream] += bytes.length;
      try {
        session.observer?.({stream, text});
      } catch {
        session.observer = undefined;
      }
    };

    const frames = new FrameReader({
      onData: recordOutput,
      onReceipt: receipt => {
        session.receipt = receipt;
      },
      onProtocolError: fatal => {
        session.protocolBroken = true;
        if (fatal) void this.stop(session, 'cancelled');
      },
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (bytes: Buffer) => frames.push(bytes));
    // Docker's own stderr (not the command's) is kept as stderr output.
    child.stderr.on('data', bytes => recordOutput('stderr', bytes));

    const finish = () => {
      if (session.ended) return;
      this.observeFinalState(session);
      session.ended = true;
      session.releaseAbort?.();
      if (session.namespaceDead && this.owned(session)) this.cli(['rm', container]);
      markDone();
    };
    child.once('error', finish);
    child.once('close', finish);
    return session;
  }

  /** Docker's stopped state with Pid 0 is required before descendant termination is certified. */
  private observeFinalState(session: ContainerSession): void {
    try {
      const state = JSON.parse(this.cli(['inspect', '--format', '{{json .State}}', session.container]).stdout);
      session.leaderStarted = !!state.StartedAt && !state.StartedAt.startsWith('0001-');
      session.namespaceDead = session.leaderStarted && !state.Running && state.Pid === 0;
      session.exitCode = state.ExitCode;
    } catch {
      session.namespaceDead = false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Session lifecycle

  private async stop(session: ContainerSession, reason: 'cancelled' | 'timeout'): Promise<void> {
    if (session.stopping) return session.stopping;
    session.stop = reason;
    session.stopping = (async () => {
      if (!session.namespaceDead && this.owned(session)) {
        const killed = this.cli(['kill', '--signal=KILL', session.container], 5000);
        if (killed.status === 0) session.deliveredSignal = 'SIGKILL';
      }
      await Promise.race([session.done, sleepUnless(1500, session.done)]);
    })();
    return session.stopping;
  }

  private send(session: ContainerSession, frame: Record<string, unknown>): void {
    if (!session.ended && session.process.stdin.writable) session.process.stdin.write(JSON.stringify(frame) + '\n');
  }

  /** Wait up to `yieldMs`, then report the state and the output since the previous call. */
  private async collect(session: ContainerSession, yieldMs: number, signal?: AbortSignal): Promise<CommandOutcome> {
    const abort = () => {
      void this.stop(session, 'cancelled');
    };
    if (signal?.aborted) await this.stop(session, 'cancelled');
    else signal?.addEventListener('abort', abort, {once: true});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!session.ended)
        await Promise.race([
          session.done,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, yieldMs);
          }),
        ]);
      if (signal?.aborted) await this.stop(session, 'cancelled');

      const result = outcomeOf(session);
      // Codex parity: each call reports the output produced since the previous call on this session.
      session.buffers = {
        stdout: new HeadTailBuffer(session.budgets.stdout),
        stderr: new HeadTailBuffer(session.budgets.stderr),
      };
      session.streamed = {stdout: 0, stderr: 0};

      if (session.ended && (session.namespaceDead || !session.leaderStarted)) {
        if (!session.leaderStarted && this.owned(session)) this.cli(['rm', session.container]);
        this.sessions.delete(session.id);
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      session.observer = undefined;
    }
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
    this.send(session, {t: 'rs', c: cols, r: rows});
  }

  /**
   * Codex write_stdin: empty input polls; input goes to the session's own pipe or PTY. SIGINT (or
   * `\x03` on a pipe session, Codex parity) interrupts the session's process group or PTY foreground
   * job, which may survive it; SIGTERM ends the whole namespace. Deadlines never extend.
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
    const validInterrupt = interrupt === undefined || interrupt === 'SIGINT' || interrupt === 'SIGTERM';
    const validInput = chars.length <= COMMAND_LIMITS.maxStdinChars && !chars.includes('\u0000');
    const validYield = Number.isInteger(yieldTimeMs) && yieldTimeMs >= 0 && yieldTimeMs <= 30_000;
    if (!session || session.busy || this.closed || !validInterrupt || !validInput || !validYield)
      throw new FutrynError('POLICY');
    if (!session.ended && !this.owned(session)) throw new FutrynError('POLICY');
    if (session.ended && (chars || interrupt)) throw new FutrynError('POLICY');

    session.busy = true;
    session.observer = onOutput;
    try {
      signal?.throwIfAborted();
      if (interrupt === 'SIGTERM') await this.terminate(session);
      else if (interrupt === 'SIGINT' || (!session.tty && chars === '\u0003')) this.send(session, {t: 'int'});
      else if (chars && !session.ended) this.sendInput(session, chars);
      return await this.collect(session, yieldTimeMs, signal);
    } finally {
      session.busy = false;
    }
  }

  /** SIGTERM to PID1 (it reports a cancelled receipt), escalating to SIGKILL after a short grace. */
  private async terminate(session: ContainerSession): Promise<void> {
    this.cli(['kill', '--signal=SIGTERM', session.container]);
    await Promise.race([session.done, sleepUnless(500, session.done)]);
    if (!session.namespaceDead) await this.stop(session, 'cancelled');
  }

  /** Input travels as base64 frames of at most 8 KiB, so it can never look like a control frame. */
  private sendInput(session: ContainerSession, chars: string): void {
    const bytes = Buffer.from(chars, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      this.send(session, {t: 'in', d: bytes.subarray(offset, offset + 8192).toString('base64')});
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => this.stop(session, 'cancelled')));
    this.sessions.clear();
    rmSync(this.control, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

interface ProbeLaunch {
  lease: number;
  command: string;
  cwd: string;
  uid: number;
  gid: number;
}

const probeLaunch = (launch: ProbeLaunch) => ({...launch, tty: false, shell: 'bash', login: false});

function validateRequest(request: CommandRequest, sandbox: CommandSandbox): void {
  const shell = request.shell ?? 'bash';
  const validLease =
    Number.isInteger(request.timeoutMs) &&
    request.timeoutMs >= COMMAND_LIMITS.minLeaseMs &&
    request.timeoutMs <= COMMAND_LIMITS.maxLeaseMs;
  const validCommand = request.command.length <= 1024 && !request.command.includes('\u0000');
  const validOutput =
    Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes >= 1 && request.maxOutputBytes <= 60_000;
  const validSandbox =
    (sandbox.mode === 'read-only' || sandbox.mode === 'workspace-write') && typeof sandbox.network === 'boolean';
  if (!validLease || !validCommand || !validOutput || !validSandbox || !['bash', 'sh'].includes(shell))
    throw new FutrynError('INVALID_INPUT');
}

/**
 * A result is confirmed only when the namespace is observed dead, the protocol stayed intact and
 * the supervisor's receipt agrees with Docker's exit code. Anything else is reported as such.
 */
function outcomeOf(session: ContainerSession): CommandOutcome {
  const receipt = session.receipt;
  const confirmed = session.namespaceDead && !session.protocolBroken && receipt?.wrapperExitCode === session.exitCode;
  const kind = outcomeKind(session, confirmed);
  const {stdout, stderr} = session.buffers;
  const output = stdout.text() + (stderr.totalBytes ? '\n[stderr]\n' + stderr.text() : '');
  const exitCode = confirmed ? receipt!.exitCode : null;
  const notStarted = session.ended && !session.leaderStarted;

  return {
    kind,
    ...(session.ended ? {} : {sessionId: session.id}),
    ...(kind === 'spawn-failed' ? {sandboxFailed: true} : {}),
    ...(kind === 'exited' && likelySandboxDenied(exitCode, output) ? {sandboxDenied: true} : {}),
    exitCode,
    signal: confirmed ? receipt!.signal : (session.deliveredSignal ?? null),
    output,
    omittedBytes: stdout.omittedBytes + stderr.omittedBytes,
    durationMs: Date.now() - session.start,
    lifecycle: {
      leader: notStarted ? 'not-started' : session.namespaceDead ? 'exited' : 'unconfirmed',
      stopRequested: !!session.stop || kind === 'timeout' || kind === 'cancelled',
      output: receipt?.outputClosed ? 'closed' : 'cut-off',
      descendants: notStarted ? 'not-started' : session.namespaceDead ? 'terminated' : 'unconfirmed',
    },
  };
}

function outcomeKind(session: ContainerSession, confirmed: boolean): CommandOutcome['kind'] {
  if (!session.ended) return 'running';
  if (!session.leaderStarted) return 'spawn-failed';
  if (confirmed) return session.receipt!.kind;
  if (session.namespaceDead && session.deliveredSignal) return 'cancelled';
  return 'unconfirmed';
}

/** Resolves after `ms`, or earlier (with its timer cleared) once `settled` settles. */
function sleepUnless(ms: number, settled: Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    void settled.finally(() => clearTimeout(timer));
  });
}
