import {z} from 'zod';
import {MAX_COMMAND_CHARS} from '@cosmew/security';
import {plainTerminalText} from './output';
import type {CommandOutcome} from '@cosmew/contracts';

/**
 * Bounds for one exec_command call. Yield bounds and the 10 000-token default are Codex's
 * (`unified_exec/mod.rs`, pinned 75fc67e8). `timeout_ms` is Cosmew's hard lease: Codex keeps
 * terminals until exit or eviction, Cosmew's PID1 deadline bounds an orphan after an owner crash.
 * Output tokens are approximated as 4 bytes each.
 */
export const EXEC_LIMITS = {
  defaultYieldMs: 10_000,
  minYieldMs: 250,
  maxYieldMs: 30_000,
  stdinDefaultYieldMs: 250,
  pollDefaultYieldMs: 5_000,
  /** Lease for commands that may become sessions; one-shot runtimes keep the old 10 s default. */
  defaultLeaseMs: 300_000,
  defaultTimeoutMs: 10_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 1_800_000,
  defaultOutputTokens: 10_000,
  minOutputTokens: 100,
  maxOutputTokens: 14_000,
  bytesPerToken: 4,
} as const;

export const clampYield = (ms: number | undefined, fallback: number) =>
  Math.min(EXEC_LIMITS.maxYieldMs, Math.max(EXEC_LIMITS.minYieldMs, ms ?? fallback));

const SHELLS: Record<string, 'bash' | 'sh'> = {
  bash: 'bash',
  '/bin/bash': 'bash',
  '/usr/bin/bash': 'bash',
  sh: 'sh',
  '/bin/sh': 'sh',
  '/usr/bin/sh': 'sh',
};

/** Strict: unknown arguments never silently change the execution mode. */
export const execInput = z.strictObject({
  cmd: z.string().min(1).max(MAX_COMMAND_CHARS),
  workdir: z.string().min(1).max(1024).optional(),
  shell: z.string().min(1).max(64).optional(),
  login: z.boolean().optional(),
  tty: z.boolean().optional(),
  yield_time_ms: z.number().int().min(0).max(300_000).optional(),
  max_output_tokens: z.number().int().min(EXEC_LIMITS.minOutputTokens).max(EXEC_LIMITS.maxOutputTokens).optional(),
  timeout_ms: z.number().int().min(EXEC_LIMITS.minTimeoutMs).max(EXEC_LIMITS.maxTimeoutMs).optional(),
  dangerouslyDisableSandbox: z.boolean().optional(),
  justification: z.string().min(1).max(500).optional(),
});
export type ExecInput = z.infer<typeof execInput>;
export const shellOf = (value: string | undefined) => (value === undefined ? ('bash' as const) : SHELLS[value]);

export const execDescriptor = {
  name: 'exec_command',
  description:
    'Runs a command (a PTY when tty is true, plain pipes otherwise), returning output or a session ID for write_stdin. Changes in the live workspace are real and visible to other tools and git. The sandbox is disabled by default; ordinary shell permission checks still apply, and default/acceptEdits ask unless a rule allows the command. When enabled, the sandbox limits writes to working directories, protects credential/state paths and .git writes, and routes HTTP(S) through a domain-filtering proxy; these protections do not apply to unsandboxed commands. autoAllowBashIfSandboxed defaults to false; when explicitly enabled it skips the ordinary Bash prompt for sandboxed commands, while deny/ask rules still apply. Settings may exclude commands from the sandbox under normal shell permissions. If an enabled sandbox blocks a legitimate operation, dangerouslyDisableSandbox with a justification requests one separately approved unsandboxed attempt; never use it to bypass a denied domain or path.',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: {type: 'string', description: 'Shell command to execute.'},
      workdir: {type: 'string', description: 'Working directory relative to the project root (default ".").'},
      tty: {type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.'},
      shell: {type: 'string', description: 'Shell binary: bash (default) or sh.'},
      login: {
        type: 'boolean',
        description:
          'Request login-shell startup, which may read shell profile files under the effective launch permissions. Omit for a non-login shell.',
      },
      yield_time_ms: {
        type: 'integer',
        description: `Wait before yielding output. Defaults to ${EXEC_LIMITS.defaultYieldMs} ms; effective range is ${EXEC_LIMITS.minYieldMs}-${EXEC_LIMITS.maxYieldMs} ms. A command still running then returns a session ID; that is not a timeout.`,
      },
      max_output_tokens: {
        type: 'integer',
        minimum: EXEC_LIMITS.minOutputTokens,
        maximum: EXEC_LIMITS.maxOutputTokens,
        description: `Output token budget (default ${EXEC_LIMITS.defaultOutputTokens}); the middle of longer output is omitted.`,
      },
      timeout_ms: {
        type: 'integer',
        minimum: EXEC_LIMITS.minTimeoutMs,
        maximum: EXEC_LIMITS.maxTimeoutMs,
        description: `Hard lease for the command and its session (default ${EXEC_LIMITS.defaultLeaseMs} ms). The whole process tree is terminated at this deadline.`,
      },
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description:
          'When the sandbox is enabled, request this one command WITHOUT it: requires a justification, always asks separately, and is refused if allowUnsandboxedCommands is false. When the sandbox is disabled, this flag adds no escalation; ordinary shell permissions apply.',
      },
      justification: {
        type: 'string',
        description: 'User-facing reason for dangerouslyDisableSandbox; omit otherwise.',
      },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  capability: 'process.execute' as const,
};

/** Model-facing text: a small header with the facts, then the cleaned output. */
export function formatOutcome(
  outcome: CommandOutcome,
  timeoutMs: number,
  canEscalate = false,
): {content: string; truncated: boolean} {
  const output = plainTerminalText(outcome.output);
  const truncated = outcome.omittedBytes > 0 || outcome.lifecycle?.output === 'cut-off';
  const head = [
    outcome.kind === 'running'
      ? `Running session: ${outcome.sessionId}. Poll or send input with write_stdin; the original hard deadline still applies.`
      : outcome.kind === 'timeout'
        ? timeoutMs > 0
          ? `Timed out after ${timeoutMs} ms; termination requested.`
          : 'The original session hard deadline expired; termination requested.'
        : outcome.kind === 'cancelled'
          ? outcome.lifecycle?.leader === 'not-started'
            ? 'Cancelled before launch.'
            : outcome.lifecycle?.stopRequested
              ? 'Cancelled; termination requested.'
              : 'Cancelled; termination status unconfirmed.'
          : outcome.exitCode === null
            ? outcome.signal
              ? `Process exited after signal ${outcome.signal}.`
              : 'Process completion is unconfirmed.'
            : `Exit code: ${outcome.exitCode}`,
    ...(outcome.sandboxDenied
      ? [
          canEscalate
            ? 'The sandbox likely denied this operation (a path outside the working directory, a protected or credential path, or a network domain the user has not allowed). Nothing was retried. If it needs access the sandbox never gives, you may retry the same command with dangerouslyDisableSandbox true and a justification: the user is asked first and, if approved, it runs once WITHOUT the sandbox. Do not repeat it unchanged.'
            : 'The sandbox likely denied this operation (a path outside the working directory, a protected or credential path, or a network domain). Nothing was retried; do not repeat it unchanged.',
        ]
      : []),
    `Wall time: ${(outcome.durationMs / 1000).toFixed(2)} s`,
    `Leader exit: ${outcome.lifecycle?.leader ?? 'unconfirmed'}.`,
    `Descendant termination: ${outcome.lifecycle?.descendants ?? 'unconfirmed'}.`,
    `Output capture: ${outcome.lifecycle?.output ?? 'unconfirmed'}.`,
    outcome.omittedBytes > 0
      ? `Output (${outcome.omittedBytes} bytes omitted from the middle):`
      : truncated && outcome.kind !== 'running'
        ? 'Output (capture ended before EOF):'
        : 'Output:',
  ];
  return {
    content: `${head.join('\n')}\n${output || '(no output)'}`,
    truncated: truncated && outcome.kind !== 'running',
  };
}
