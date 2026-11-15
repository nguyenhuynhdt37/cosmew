import {HannesError, type CommandRequest, type CommandRuntime} from '@hannes/contracts';
import type {ToolOutput} from '../context';
import {formatOutcome} from '../exec/command';

/** Process backend formatting; OS launch and ownership stay in the injected sandbox runtime. */
export async function runCommand(runtime: CommandRuntime, request: CommandRequest, target: string, signal?: AbortSignal): Promise<ToolOutput> {
  const outcome=await runtime.run(request,signal);
  if (outcome.kind==='cancelled' || signal?.aborted) throw new HannesError('CANCELLED');
  if (outcome.sandboxFailed || outcome.kind==='spawn-failed') return {status:'error',code:'SANDBOX_FAILED',content:'The sandbox could not start the command; it did not run unsandboxed.',target,durationMs:outcome.durationMs};
  const {content,truncated}=formatOutcome(outcome,request.timeoutMs);
  if (outcome.kind==='timeout') return {status:'error',code:'TIMEOUT',content,target,truncated:truncated || undefined,durationMs:outcome.durationMs};
  return {status:'ok',content,target,truncated:truncated || undefined,exitCode:outcome.exitCode,durationMs:outcome.durationMs};
}
