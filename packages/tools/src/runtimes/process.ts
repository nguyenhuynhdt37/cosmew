import type {CommandOutcome,CommandRequest,CommandRuntime} from '@futryn/contracts';
import type {ToolOutput} from '../context';
import {formatOutcome} from '../exec/command';

/** Shared truthful result projection for command launch and owned-session input. */
export function commandOutcomeResult(outcome:CommandOutcome,timeoutMs:number,target:string):ToolOutput {
 if(outcome.kind==='unconfirmed')return{status:'error',code:'EXECUTION_UNKNOWN',content:'Command completion or namespace teardown could not be confirmed. Do not replay this command.',target,durationMs:outcome.durationMs};
 if(outcome.sandboxFailed||outcome.kind==='spawn-failed')return{status:'error',code:'SANDBOX_FAILED',content:'The sandbox could not start the command; no unsandboxed fallback was attempted.',target,durationMs:outcome.durationMs};
 const {content,truncated}=formatOutcome(outcome,timeoutMs);
 const common={content,target,truncated:truncated||undefined,durationMs:outcome.durationMs};
 if(outcome.kind==='running')return{status:'ok',sessionId:outcome.sessionId,...common};
 if(outcome.kind==='cancelled')return{status:'error',code:'CANCELLED',...common};
 if(outcome.kind==='timeout')return{status:'error',code:'TIMEOUT',...common};
 // Codex SandboxErr::Denied: reported as a denial, never retried here (Futryn has no unsandboxed retry).
 if(outcome.sandboxDenied)return{status:'error',code:'SANDBOX_DENIED',exitCode:outcome.exitCode,...common};
 return{status:'ok',exitCode:outcome.exitCode,...common};
}
export async function runCommand(runtime:CommandRuntime,request:CommandRequest,target:string,signal?:AbortSignal):Promise<ToolOutput>{return commandOutcomeResult(await runtime.run(request,signal),request.timeoutMs,target);}
