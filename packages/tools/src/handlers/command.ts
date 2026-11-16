import type {CommandSandbox} from '@futryn/contracts';
import {effectiveSandboxMode, type ToolDispatcherOptions} from '../context';
import {EXEC_LIMITS, clampYield, execDescriptor, execInput, shellOf} from '../exec/command';
import {runCommand} from '../runtimes/process';
import type {ToolHandler} from './types';

const refuse = (code: string, content: string) => ({status: 'error' as const, code, content});

/** Codex `exec_command` preparation (handlers/unified_exec/preparation.rs, pinned 75fc67e8), Futryn policy. */
export function commandHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor:execDescriptor,
    available:()=>options.commands?.availability().ok===true,
    unavailable:{status:'error',code:'SANDBOX_UNAVAILABLE',content:'exec_command is unavailable: no verified command sandbox on this host. Nothing was run.'},
    prepare(args) {
      const parsed=execInput.safeParse(args);
      if (!parsed.success) return refuse('INVALID_INPUT','Invalid arguments for exec_command. Supported: cmd (required), workdir, tty, shell, login, yield_time_ms, max_output_tokens, timeout_ms, sandbox_permissions, additional_permissions, justification.');
      const input=parsed.data, runtime=options.commands!;
      // Escalation is explicit and narrow. There is no unsandboxed mode to fall back to.
      if (input.sandbox_permissions==='require_escalated') return refuse('UNSUPPORTED','Unsandboxed execution is not available in Futryn. Nothing was run. Request network with sandbox_permissions "with_additional_permissions", or edit files with apply_patch.');
      if (input.prefix_rule) return refuse('UNSUPPORTED','prefix_rule is not supported; the user manages reusable command rules with /permissions. Nothing was run.');
      const extra=input.sandbox_permissions==='with_additional_permissions';
      if (input.additional_permissions && !extra) return refuse('INVALID_INPUT','additional_permissions requires sandbox_permissions "with_additional_permissions". Nothing was run.');
      if (extra && (input.additional_permissions?.file_system!==undefined)) return refuse('UNSUPPORTED','Additional filesystem access is not supported; commands can only write inside the project in workspace-write mode. Nothing was run.');
      if (extra && input.additional_permissions?.network?.enabled!==true) return refuse('INVALID_INPUT','with_additional_permissions needs additional_permissions {"network":{"enabled":true}}. Nothing was run.');
      if (extra && !input.justification) return refuse('INVALID_INPUT','Additional permissions need a justification for the user. Nothing was run.');
      const shell=shellOf(input.shell);
      const capabilities=runtime.capabilities?.() ?? {network:false,tty:false,shells:['bash'] as ('bash'|'sh')[]};
      const mode=effectiveSandboxMode(options,runtime);
      if (!mode) return refuse('SANDBOX_UNAVAILABLE','This runtime cannot enforce the configured sandbox. Nothing was run.');
      const sandbox:CommandSandbox={mode,network:extra};
      if (!shell || !capabilities.shells.includes(shell)) return refuse('UNSUPPORTED',`Shell ${JSON.stringify(input.shell)} is not available in this sandbox (available: ${capabilities.shells.join(', ')}). Nothing was run.`);
      if (input.tty && !capabilities.tty) return refuse('UNSUPPORTED','This runtime cannot allocate a PTY; omit tty. Nothing was run.');
      if (sandbox.network && !capabilities.network) return refuse('UNSUPPORTED','This runtime cannot grant network access. Nothing was run.');
      const sessions=!!runtime.writeStdin;
      if (input.tty && !sessions) return refuse('UNSUPPORTED','This runtime does not support sessions. Nothing was run.');
      const file=options.workspace.resolve(input.workdir ?? '.');
      if (file.kind!=='directory') return {status:'error',code:'NOT_A_DIRECTORY',content:`${file.relative} is not a directory.`,target:file.relative};
      const label=options.redact(`${file.relative==='.'?'':file.relative+': '}${input.cmd}`).slice(0,1024);
      const request={command:input.cmd,cwd:file.absolute,sandbox,tty:input.tty===true,shell,login:input.login===true,
        timeoutMs:input.timeout_ms ?? (sessions?EXEC_LIMITS.defaultLeaseMs:EXEC_LIMITS.defaultTimeoutMs),
        // Codex: every launch yields after yield_time_ms; a command still running then is a session, not a timeout.
        yieldTimeMs:sessions?clampYield(input.yield_time_ms,EXEC_LIMITS.defaultYieldMs):undefined,
        maxOutputBytes:(input.max_output_tokens ?? EXEC_LIMITS.defaultOutputTokens)*EXEC_LIMITS.bytesPerToken};
      // The approval scope binds everything that changes authority or lifetime, not just the text.
      const executionKey=JSON.stringify({timeoutMs:request.timeoutMs,session:sessions,sandbox,tty:request.tty,shell,login:request.login});
      return {kind:'command',file,command:input.cmd,workdir:input.workdir ?? '.',label,runtime,runtimeId:runtime.id,executionKey,sandbox,...(input.justification?{justification:input.justification}:{}),execute:(signal,onOutput)=>runCommand(runtime,{...request,onOutput},label,signal)};
    },
  };
}
