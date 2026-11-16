import type {ToolDispatcherOptions} from '../context';
import {EXEC_LIMITS, execDescriptor, execInput} from '../exec/command';
import {runCommand} from '../runtimes/process';
import type {ToolHandler} from './types';

export function commandHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor:execDescriptor,
    available:()=>options.commands?.availability().ok===true,
    unavailable:{status:'error',code:'SANDBOX_UNAVAILABLE',content:'exec_command is unavailable: no verified command sandbox on this host. Nothing was run.'},
    prepare(args) {
      const parsed=execInput.safeParse(args);
      if (!parsed.success) return {status:'error',code:'INVALID_INPUT',content:'Invalid arguments for exec_command. Supported: cmd (required), workdir, timeout_ms, max_output_tokens. Use write_stdin for supported pipe sessions; tty is not supported.'};
      const input=parsed.data, runtime=options.commands!;if(input.yield_time_ms!==undefined&&!runtime.writeStdin)return {status:'error',code:'UNSUPPORTED',content:'This runtime does not support pipe sessions.'};
      const file=options.workspace.resolve(input.workdir ?? '.');
      if (file.kind!=='directory') return {status:'error',code:'NOT_A_DIRECTORY',content:`${file.relative} is not a directory.`,target:file.relative};
      const label=options.redact(`${file.relative==='.'?'':file.relative+': '}${input.cmd}`).slice(0,1024);
      const request={command:input.cmd,cwd:file.absolute,timeoutMs:input.timeout_ms ?? EXEC_LIMITS.defaultTimeoutMs,yieldTimeMs:input.yield_time_ms,maxOutputBytes:(input.max_output_tokens ?? EXEC_LIMITS.defaultOutputTokens)*EXEC_LIMITS.bytesPerToken};
      return {kind:'command',file,command:input.cmd,workdir:input.workdir ?? '.',label,runtime,runtimeId:runtime.id,executionKey:JSON.stringify({timeoutMs:request.timeoutMs,session:input.yield_time_ms!==undefined}),execute:(signal,onOutput)=>runCommand(runtime,{...request,onOutput},label,signal)};
    },
  };
}
