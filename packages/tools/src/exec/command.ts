import { z } from 'zod';
import { MAX_COMMAND_CHARS } from '@futryn/security';
import { plainTerminalText } from './output';
import type { CommandOutcome } from '@futryn/contracts';

/** Bounds for one exec_command call (ADR 0022). Output tokens are approximated as 4 bytes each. */
export const EXEC_LIMITS = {
  defaultTimeoutMs: 10_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 120_000,
  defaultOutputTokens: 10_000,
  minOutputTokens: 100,
  maxOutputTokens: 14_000,
  bytesPerToken: 4,
} as const;

/** Strict: unsupported arguments such as tty are rejected rather than silently ignored. */
export const execInput = z.strictObject({
  cmd: z.string().min(1).max(MAX_COMMAND_CHARS),
  yield_time_ms:z.number().int().min(0).max(30000).optional(),
  workdir: z.string().min(1).max(1024).optional(),
  timeout_ms: z.number().int().min(EXEC_LIMITS.minTimeoutMs).max(EXEC_LIMITS.maxTimeoutMs).optional(),
  max_output_tokens: z.number().int().min(EXEC_LIMITS.minOutputTokens).max(EXEC_LIMITS.maxOutputTokens).optional(),
});
export type ExecInput = z.infer<typeof execInput>;

export const execDescriptor = {
  name: 'exec_command',
  description: 'Run a command in an isolated read-only project snapshot with a finite hard deadline. No host writes or network; secrets and .git are omitted. Use /tmp for test/build outputs. Optional yield_time_ms returns an owned pipe session; no PTY. The user approves each command. Prefer read/glob/grep for single lookups; use this for rg searches and pipelines such as `rg -n "name" src | head` or `nl -ba file | sed -n 10,40p`.',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The shell command to run.' },
      yield_time_ms:{type:'integer',minimum:0,maximum:30000,description:'Return a pipe session if still running after this wait. The hard timeout cannot be extended.'},
      workdir: { type: 'string', description: 'Working directory relative to the project root (default ".").' },
      timeout_ms: { type: 'integer', minimum: EXEC_LIMITS.minTimeoutMs, maximum: EXEC_LIMITS.maxTimeoutMs, description: `Request termination after this many milliseconds (default ${EXEC_LIMITS.defaultTimeoutMs}); namespace teardown is reported only when confirmed.` },
      max_output_tokens: { type: 'integer', minimum: EXEC_LIMITS.minOutputTokens, maximum: EXEC_LIMITS.maxOutputTokens, description: `Output budget, about 4 bytes per token (default ${EXEC_LIMITS.defaultOutputTokens}); the middle of longer output is omitted.` },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  capability: 'process.execute' as const,
};

/** Model-facing text: a small header with the facts, then the cleaned output. */
export function formatOutcome(outcome: CommandOutcome, timeoutMs: number): { content: string; truncated: boolean } {
  const output = plainTerminalText(outcome.output);
  const truncated = outcome.omittedBytes > 0 || outcome.lifecycle?.output === 'cut-off';
  const head = [
    outcome.kind==='running'?`Running session: ${outcome.sessionId}. Poll or send input with write_stdin; the original hard deadline still applies.`:outcome.kind === 'timeout' ? (timeoutMs>0?`Timed out after ${timeoutMs} ms; termination requested.`:'The original session hard deadline expired; termination requested.') : outcome.kind === 'cancelled' ? outcome.lifecycle?.leader === 'not-started' ? 'Cancelled before launch.' : outcome.lifecycle?.stopRequested ? 'Cancelled; termination requested.' : 'Cancelled; termination status unconfirmed.' : outcome.exitCode === null ? outcome.signal ? `Process exited after signal ${outcome.signal}.` : 'Process completion is unconfirmed.' : `Exit code: ${outcome.exitCode}`,
    `Wall time: ${(outcome.durationMs / 1000).toFixed(2)} s`,
    `Leader exit: ${outcome.lifecycle?.leader ?? 'unconfirmed'}.`,
    `Descendant termination: ${outcome.lifecycle?.descendants ?? 'unconfirmed'}.`,
    `Output capture: ${outcome.lifecycle?.output ?? 'unconfirmed'}.`,
    outcome.omittedBytes > 0 ? `Output (${outcome.omittedBytes} bytes omitted from the middle):` : truncated ? 'Output (capture ended before EOF):' : 'Output:',
  ];
  return { content: `${head.join('\n')}\n${output || '(no output)'}`, truncated };
}
