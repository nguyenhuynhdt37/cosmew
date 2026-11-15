/** One command to run in the sandbox. `cwd` is canonical and already inside the workspace. */
export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CommandOutcome {
  kind: 'exited' | 'timeout' | 'cancelled' | 'spawn-failed';
  exitCode: number | null;
  signal: string | null;
  output: string;
  omittedBytes: number;
  durationMs: number;
  /** The sandbox wrapper itself failed (bad profile, missing binary); the command never ran. */
  sandboxFailed?: boolean;
}

export type RuntimeAvailability = { ok: true } | { ok: false; reason: string };

/**
 * The injected execution port (ADR 0022). The dispatcher decides and audits; a runtime only
 * launches an already-approved command under its OS sandbox. `id` changes whenever the effective
 * policy changes, so approvals bound to it cannot carry over to a different sandbox.
 */
export interface CommandRuntime {
  readonly id: string;
  /** Human description shown in the approval prompt. */
  readonly label: string;
  availability(): RuntimeAvailability;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandOutcome>;
}
