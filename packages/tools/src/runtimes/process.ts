import {FutrynError, type CommandOutcome, type CommandRequest, type CommandRuntime} from '@futryn/contracts';
import type {ToolOutput} from '../context';
import {formatOutcome} from '../exec/command';

/**
 * The model-facing result of a command launch or of input to an owned session. It reports only
 * what was observed: an unconfirmed outcome is never presented as success.
 */
export function commandOutcomeResult(outcome: CommandOutcome, timeoutMs: number, target: string): ToolOutput {
  const durationMs = outcome.durationMs;
  if (outcome.kind === 'unconfirmed') {
    return {
      status: 'error',
      code: 'EXECUTION_UNKNOWN',
      content: 'Command completion or namespace teardown could not be confirmed. Do not replay this command.',
      target,
      durationMs,
    };
  }
  if (outcome.sandboxFailed || outcome.kind === 'spawn-failed') {
    return {
      status: 'error',
      code: 'SANDBOX_FAILED',
      content: 'The sandbox could not start the command; no unsandboxed fallback was attempted.',
      target,
      durationMs,
    };
  }

  const {content, truncated} = formatOutcome(outcome, timeoutMs);
  const common = {content, target, truncated: truncated || undefined, durationMs};
  switch (outcome.kind) {
    case 'running':
      return {status: 'ok', sessionId: outcome.sessionId, ...common};
    case 'cancelled':
      return {status: 'error', code: 'CANCELLED', ...common};
    case 'timeout':
      return {status: 'error', code: 'TIMEOUT', ...common};
  }
  // Codex SandboxErr::Denied: reported as a denial, never retried here (there is no unsandboxed retry).
  if (outcome.sandboxDenied) return {status: 'error', code: 'SANDBOX_DENIED', exitCode: outcome.exitCode, ...common};
  return {status: 'ok', exitCode: outcome.exitCode, ...common};
}

export async function runCommand(
  runtime: CommandRuntime,
  request: CommandRequest,
  target: string,
  signal?: AbortSignal,
): Promise<ToolOutput> {
  try {
    return commandOutcomeResult(await runtime.run(request, signal), request.timeoutMs, target);
  } catch (error) {
    // Launch refusals are truthful results, not generic tool failures; nothing ran in either case.
    if (error instanceof FutrynError && error.code === 'BUDGET') {
      return {
        status: 'error',
        code: 'BUDGET',
        content: 'Too many running sessions or protected paths. Collect or stop a session first. Nothing was run.',
        target,
      };
    }
    if (error instanceof FutrynError && error.code === 'POLICY') {
      return {
        status: 'error',
        code: 'SANDBOX_FAILED',
        content:
          'The sandbox refused to launch: the workspace changed while protections were applied, or a path cannot be protected. Nothing was run.',
        target,
      };
    }
    throw error;
  }
}
