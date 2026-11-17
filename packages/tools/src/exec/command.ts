import {z} from 'zod';
import {MAX_COMMAND_CHARS} from '@futryn/security';
import {plainTerminalText} from './output';
import type {CommandOutcome} from '@futryn/contracts';

/**
 * Bounds for one exec_command call. Yield bounds and the 10 000-token default are Codex's
 * (`unified_exec/mod.rs`, pinned 75fc67e8). `timeout_ms` is Futryn's hard lease: Codex keeps
 * terminals until exit or eviction, Futryn's PID1 deadline bounds an orphan after an owner crash.
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
  sandbox_permissions: z.enum(['use_default', 'with_additional_permissions', 'require_escalated']).optional(),
  additional_permissions: z
    .strictObject({
      network: z.strictObject({enabled: z.boolean()}).optional(),
      file_system: z.unknown().optional(),
    })
    .optional(),
  justification: z.string().min(1).max(500).optional(),
  prefix_rule: z.array(z.string().max(200)).max(32).optional(),
});
export type ExecInput = z.infer<typeof execInput>;
export const shellOf = (value: string | undefined) => (value === undefined ? ('bash' as const) : SHELLS[value]);

export const execDescriptor = {
  name: 'exec_command',
  description:
    'Runs a command in the Futryn sandbox (a PTY when tty is true, plain pipes otherwise), returning output or a session ID for ongoing interaction via write_stdin. The project directory is the live workspace: in workspace-write mode file changes are real and visible to other tools and git; .git is readable but never writable, Futryn state is hidden, and files outside the project are not visible. Only localhost can be reached; external network is off unless you set sandbox_permissions "with_additional_permissions", additional_permissions {"network":{"enabled":true}} and a justification (the user approves it). If a command legitimately needs more than the sandbox gives, set sandbox_permissions "require_escalated" with a justification: the user is asked and, if approved, that one command runs WITHOUT the sandbox. Use it only after a sandboxed attempt failed because of the sandbox. The session approval policy decides prompts: by default (on-request) commands run in the sandbox without asking, while dangerous commands (e.g. forced rm), network access and escalation ask the user; under never they are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: {type: 'string', description: 'Shell command to execute.'},
      workdir: {type: 'string', description: 'Working directory relative to the project root (default ".").'},
      tty: {type: 'boolean', description: 'True allocates a PTY for the command; false or omitted uses plain pipes.'},
      shell: {type: 'string', description: 'Shell binary: bash (default) or sh.'},
      login: {
        type: 'boolean',
        description: 'Request login-shell startup (trusted image profile only). Omit for a non-login shell.',
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
      sandbox_permissions: {
        type: 'string',
        enum: ['use_default', 'with_additional_permissions', 'require_escalated'],
        description:
          'Per-command sandbox override. Defaults to use_default. with_additional_permissions (with additional_permissions and a justification) adds network. require_escalated (with a justification) asks the user to run this one command without the sandbox.',
      },
      additional_permissions: {
        type: 'object',
        properties: {
          network: {
            type: 'object',
            properties: {enabled: {type: 'boolean'}},
            required: ['enabled'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
        description: 'Additional sandboxed access for this command; only network is supported.',
      },
      justification: {
        type: 'string',
        description: 'User-facing reason for additional permissions or escalation; omit otherwise.',
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
            ? 'The sandbox likely denied this operation (protected path, read-only mode, or no network). Nothing was retried. If it needs network, retry with sandbox_permissions "with_additional_permissions", additional_permissions {"network":{"enabled":true}} and a justification. If it needs access the sandbox never gives, you may retry the same command with sandbox_permissions "require_escalated" and a justification: the user is asked first and, if approved, it runs once WITHOUT the sandbox. Do not repeat it unchanged.'
            : 'The sandbox likely denied this operation (protected path, read-only mode, or no network). Nothing was retried; do not repeat it unchanged.',
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
