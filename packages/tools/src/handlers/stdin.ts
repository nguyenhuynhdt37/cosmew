import {z} from 'zod';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import {EXEC_LIMITS, clampYield} from '../exec/command';
import {commandOutcomeResult} from '../runtimes/process';
import type {ToolHandler} from './types';

/**
 * Codex `write_stdin` (handlers/unified_exec/write_stdin.rs, pinned 75fc67e8). Session IDs are
 * runtime-owned UUIDs, never PIDs, and are not restored after restart. `signal` is a Futryn extension.
 */

/** Input longer than this cannot be shown in full in the approval prompt, so it is refused. */
const MAX_REVIEWABLE_INPUT = 900;

const input = z.strictObject({
  session_id: z.string().uuid(),
  chars: z.string().max(8000).default(''),
  yield_time_ms: z.number().int().min(0).max(300_000).optional(),
  signal: z.enum(['SIGINT', 'SIGTERM']).optional(),
});

const descriptor = {
  name: 'write_stdin',
  capability: 'process.execute' as const,
  description:
    'Writes characters to an existing exec_command session and returns recent output. Empty chars polls without writing. ' +
    'On a PTY session "\\u0003" is Ctrl-C; signal "SIGINT" interrupts the session\'s foreground job and "SIGTERM" ends the whole session. ' +
    "Input keeps the session's launch sandbox; sessions end at their original deadline and are never restored after restart.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: {type: 'string', description: 'Session ID returned by exec_command.'},
      chars: {
        type: 'string',
        maxLength: 8000,
        description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.',
      },
      yield_time_ms: {
        type: 'integer',
        description: `Wait before yielding output. Non-empty writes default to ${EXEC_LIMITS.stdinDefaultYieldMs} ms, polls to ${EXEC_LIMITS.pollDefaultYieldMs} ms; effective range ${EXEC_LIMITS.minYieldMs}-${EXEC_LIMITS.maxYieldMs} ms.`,
      },
      signal: {type: 'string', enum: ['SIGINT', 'SIGTERM']},
    },
    required: ['session_id'],
    additionalProperties: false,
  },
};

const refuse = (code: string, content: string): ToolOutput => ({status: 'error', code, content});

export function stdinHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor,
    available: () => options.commands?.availability().ok === true && !!options.commands.writeStdin,
    unavailable: {status: 'error', code: 'UNSUPPORTED', content: 'No verified session runtime on this host.'},

    prepare(args) {
      const parsed = input.safeParse(args);
      if (!parsed.success)
        return refuse(
          'INVALID_INPUT',
          'Expected session_id, at most 8000 input characters, optional yield_time_ms and signal. The output budget is set at launch.',
        );
      const data = parsed.data;
      const runtime = options.commands!;

      const session = runtime.session?.(data.session_id);
      if (!session) return refuse('SESSION_NOT_FOUND', 'No owned session with this ID; nothing was replayed.');
      if (data.signal && data.chars) return refuse('INVALID_INPUT', 'Send input or a signal, not both.');
      // Consent covers exactly what is sent: input the approval prompt cannot show in full is refused.
      if (JSON.stringify(data.chars).length > MAX_REVIEWABLE_INPUT)
        return refuse(
          'INVALID_INPUT',
          'Input too long to review in one approval; send it in parts of at most about 850 characters. Nothing was sent.',
        );

      const isWrite = !!data.chars || !!data.signal;
      const yieldMs = clampYield(
        data.yield_time_ms,
        isWrite ? EXEC_LIMITS.stdinDefaultYieldMs : EXEC_LIMITS.pollDefaultYieldMs,
      );
      const file = options.workspace.resolve(session.cwd);
      const command = `stdin ${data.session_id}: ${data.signal ?? JSON.stringify(data.chars)}`;
      const launch = session.sandbox ?? {mode: 'read-only' as const, network: false};

      return {
        kind: 'command',
        toolName: 'write_stdin',
        file,
        workdir: file.relative,
        command,
        label: options.redact(command).slice(0, 1024),
        runtime,
        runtimeId: runtime.id,
        sessionId: data.session_id,
        // A "session" approval covers input to this one session only, never other sessions or launches.
        grantCommand: `stdin ${data.session_id}`,
        executionKey: JSON.stringify({session: data.session_id, launch}),
        stdin: {chars: data.chars, interrupt: data.signal !== undefined, tty: session.tty === true, launch},
        execute: async (signal, onOutput) => {
          const outcome = await runtime.writeStdin!(
            data.session_id,
            data.chars,
            yieldMs,
            signal,
            data.signal,
            onOutput,
          );
          return commandOutcomeResult(outcome, 0, command);
        },
      };
    },
  };
}
