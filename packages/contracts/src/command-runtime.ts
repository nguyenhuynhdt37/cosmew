export interface CommandOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

/**
 * Effective sandbox for one command (ADR 0034, Codex `SandboxPolicy` subset). `read-only` and
 * `workspace-write` are enforced by the runtime's mount namespace, never by parsing the command.
 * `network` is an explicitly approved additional permission. `unsandboxed` (ADR 0053, Codex
 * `SandboxPermissions::RequireEscalated`) runs that one command with no OS sandbox; it exists only
 * after the user approved exactly that command, and a runtime that cannot do it refuses.
 */
export interface CommandSandbox {
  /**
   * `danger-full-access` (ADR 0055, Codex `SandboxMode::DangerFullAccess`) is the session's Full
   * Access preset: the command runs with `unsandboxed: true` and no prompt. Only a runtime that
   * lists it in `capabilities().modes` can run it; Docker refuses.
   */
  mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  network: boolean;
  unsandboxed?: boolean;
}

/** One command to run in the sandbox. `cwd` is canonical and already inside the workspace. */
export interface CommandRequest {
  command: string;
  cwd: string;
  /** Hard lease: the runtime terminates the whole process tree at this deadline. */
  timeoutMs: number;
  maxOutputBytes: number;
  /** Wait before returning a running session (Codex yield_time_ms). Omitted: wait for exit or lease. */
  yieldTimeMs?: number;
  /** Defaults to `{mode:'read-only',network:false}` for runtimes that predate ADR 0034. */
  sandbox?: CommandSandbox;
  /** Allocate a real pseudo-terminal inside the sandbox (Codex `tty`). */
  tty?: boolean;
  /** Shell from the runtime's approved list (Codex `shell`); default bash. */
  shell?: 'bash' | 'sh';
  /** Login-shell startup from the image's trusted profile only (Codex `login`). */
  login?: boolean;
  onOutput?: (chunk: CommandOutputChunk) => void;
}

export interface CommandLifecycle {
  leader: 'not-started' | 'exited' | 'unconfirmed';
  stopRequested: boolean;
  output: 'closed' | 'cut-off';
  /** terminated requires confirmed exit of a verified PID namespace. */
  descendants: 'not-started' | 'unconfirmed' | 'terminated';
}

export interface CommandOutcome {
  kind: 'exited' | 'timeout' | 'cancelled' | 'spawn-failed' | 'running' | 'unconfirmed';
  sessionId?: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  omittedBytes: number;
  durationMs: number;
  lifecycle?: CommandLifecycle;
  /** The sandbox wrapper itself failed (bad profile, missing binary); the command never ran. */
  sandboxFailed?: boolean;
  /** The command ran and failed in a way that looks like a sandbox denial (Codex is_likely_sandbox_denied). */
  sandboxDenied?: boolean;
}

export type RuntimeAvailability = {ok: true} | {ok: false; reason: string};

/** What an available runtime can enforce. Requests outside it are refused, never downgraded. */
export interface CommandRuntimeCapabilities {
  modes: CommandSandbox['mode'][];
  network: boolean;
  tty: boolean;
  /** The runtime can run an explicitly approved command without its sandbox (ADR 0053). */
  unsandboxed?: boolean;
  shells: NonNullable<CommandRequest['shell']>[];
  /** Tools available inside the sandbox image, for the model-facing description. */
  tools: string[];
}

/** The launch facts of an owned session. Stdin authority is reviewed against these (Codex stdin_approval). */
export interface CommandSessionInfo {
  cwd: string;
  command: string;
  /** Omitted by pre-ADR-0034 runtimes: treated as a pipe session launched read-only. */
  tty?: boolean;
  sandbox?: CommandSandbox;
}

/**
 * The injected execution port (ADR 0022/0034). The dispatcher decides and audits; a runtime only
 * launches an already-approved command under its OS sandbox. `id` changes whenever the runtime's
 * fixed policy changes, so approvals bound to it cannot carry over to a different sandbox.
 */
/**
 * A long-lived helper process (a language server, ADR 0043) started by the command runtime inside
 * its OS sandbox: read-only workspace, no network, private HOME/TMPDIR. Raw stdio, no PTY.
 */
export interface ServiceProcess {
  readonly pid: number | undefined;
  write(data: Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onExit(listener: (code: number | null) => void): void;
  /** Stop the process group (SIGTERM, then SIGKILL). */
  kill(): void;
}

export interface CommandRuntime {
  readonly id: string;
  /** Human description shown in the approval prompt. */
  readonly label: string;
  availability(): RuntimeAvailability;
  capabilities?(): CommandRuntimeCapabilities;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome>;
  session?(id: string): CommandSessionInfo | undefined;
  writeStdin?(
    id: string,
    chars: string,
    yieldTimeMs: number,
    signal?: AbortSignal,
    interrupt?: 'SIGINT' | 'SIGTERM',
    onOutput?: (chunk: CommandOutputChunk) => void,
  ): Promise<CommandOutcome>;
  /** Resize an owned PTY session; refused for pipe sessions. */
  resize?(id: string, cols: number, rows: number): void;
  /**
   * Start a sandboxed helper process (ADR 0043): always read-only and without network; `cwd` must
   * be a workspace directory. Undefined on runtimes without a native sandbox.
   */
  spawnService?(argv: string[], cwd: string): ServiceProcess;
  /** Close admission and settle owned runs; this does not certify descendant containment. */
  shutdown?(): Promise<void>;
}
