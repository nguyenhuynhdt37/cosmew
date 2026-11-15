import { z } from 'zod';
import { MAX_COMMAND_CHARS } from '@hannes/security';
import { plainTerminalText } from './output';
import type { CommandOutcome } from '@hannes/contracts';

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

/** Strict: an argument this slice does not implement (tty, yield_time_ms, …) is an error, not ignored. */
export const execInput = z.strictObject({
  cmd: z.string().min(1).max(MAX_COMMAND_CHARS),
  workdir: z.string().min(1).max(1024).optional(),
  timeout_ms: z.number().int().min(EXEC_LIMITS.minTimeoutMs).max(EXEC_LIMITS.maxTimeoutMs).optional(),
  max_output_tokens: z.number().int().min(EXEC_LIMITS.minOutputTokens).max(EXEC_LIMITS.maxOutputTokens).optional(),
});
export type ExecInput = z.infer<typeof execInput>;

export const execDescriptor = {
  name: 'exec_command',
  description: 'Run one shell command (bash) in the project and return its exit code and output. It runs once to completion in a read-only sandbox: no file writes, no network, no access outside the project, and secret files and .git are hidden. The user approves each command. Prefer read/glob/grep for single lookups; use this for rg searches and pipelines such as `rg -n "name" src | head` or `nl -ba file | sed -n 10,40p`.',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The shell command to run.' },
      workdir: { type: 'string', description: 'Working directory relative to the project root (default ".").' },
      timeout_ms: { type: 'integer', minimum: EXEC_LIMITS.minTimeoutMs, maximum: EXEC_LIMITS.maxTimeoutMs, description: `Request termination after this many milliseconds (default ${EXEC_LIMITS.defaultTimeoutMs}); descendant termination is not guaranteed.` },
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
    outcome.kind === 'timeout' ? `Timed out after ${timeoutMs} ms; termination requested.` : outcome.kind === 'cancelled' ? outcome.lifecycle?.leader === 'not-started' ? 'Cancelled before launch.' : outcome.lifecycle?.stopRequested ? 'Cancelled; termination requested.' : 'Cancelled; termination status unconfirmed.' : outcome.exitCode === null ? outcome.signal ? `Process exited after signal ${outcome.signal}.` : 'Process completion is unconfirmed.' : `Exit code: ${outcome.exitCode}`,
    `Wall time: ${(outcome.durationMs / 1000).toFixed(2)} s`,
    `Leader exit: ${outcome.lifecycle?.leader ?? 'unconfirmed'}.`,
    `Descendant termination: ${outcome.lifecycle?.descendants ?? 'unconfirmed'}.`,
    `Output capture: ${outcome.lifecycle?.output ?? 'unconfirmed'}.`,
    outcome.omittedBytes > 0 ? `Output (${outcome.omittedBytes} bytes omitted from the middle):` : truncated ? 'Output (capture ended before EOF):' : 'Output:',
  ];
  return { content: `${head.join('\n')}\n${output || '(no output)'}`, truncated };
}
