export interface CommandOutputChunk {stream:'stdout'|'stderr';text:string}

/** One command to run in the sandbox. `cwd` is canonical and already inside the workspace. */
export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  yieldTimeMs?:number;
  onOutput?:(chunk:CommandOutputChunk)=>void;
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
  sessionId?:string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  omittedBytes: number;
  durationMs: number;
  lifecycle?: CommandLifecycle;
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
  session?(id:string):{cwd:string;command:string}|undefined;
  writeStdin?(id:string,chars:string,yieldTimeMs:number,signal?:AbortSignal,interrupt?:'SIGINT'|'SIGTERM',onOutput?:(chunk:CommandOutputChunk)=>void):Promise<CommandOutcome>;
  /** Close admission and settle owned runs; this does not certify descendant containment. */
  shutdown?(): Promise<void>;
}
