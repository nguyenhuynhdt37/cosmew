import {z} from 'zod';
import type {ToolHandler} from './types';
import type {ToolDispatcherOptions} from '../context';
import {commandOutcomeResult} from '../runtimes/process';
import {EXEC_LIMITS, clampYield} from '../exec/command';

/**
 * Codex `write_stdin` (handlers/unified_exec/write_stdin.rs, pinned 75fc67e8). Session IDs are
 * runtime-owned UUIDs, never PIDs, and are not restored after restart. `signal` is a Futryn extension.
 */
const input=z.strictObject({session_id:z.string().uuid(),chars:z.string().max(8000).default(''),yield_time_ms:z.number().int().min(0).max(300_000).optional(),signal:z.enum(['SIGINT','SIGTERM']).optional()});
export function stdinHandler(options:ToolDispatcherOptions):ToolHandler{return{
 descriptor:{name:'write_stdin',capability:'process.execute',description:'Writes characters to an existing exec_command session and returns recent output. Empty chars polls without writing. On a PTY session "\\u0003" is Ctrl-C; signal "SIGINT" interrupts the session\'s foreground job and "SIGTERM" ends the whole session. Input keeps the session\'s launch sandbox; sessions end at their original deadline and are never restored after restart.',inputSchema:{type:'object',properties:{session_id:{type:'string',description:'Session ID returned by exec_command.'},chars:{type:'string',maxLength:8000,description:'Bytes to write to stdin. Defaults to empty, which polls without writing.'},yield_time_ms:{type:'integer',description:`Wait before yielding output. Non-empty writes default to ${EXEC_LIMITS.stdinDefaultYieldMs} ms, polls to ${EXEC_LIMITS.pollDefaultYieldMs} ms; effective range ${EXEC_LIMITS.minYieldMs}-${EXEC_LIMITS.maxYieldMs} ms.`},signal:{type:'string',enum:['SIGINT','SIGTERM']}},required:['session_id'],additionalProperties:false}},
 available:()=>options.commands?.availability().ok===true&&!!options.commands.writeStdin,
 unavailable:{status:'error',code:'UNSUPPORTED',content:'No verified session runtime on this host.'},
 prepare(args){const parsed=input.safeParse(args);if(!parsed.success)return{status:'error',code:'INVALID_INPUT',content:'Expected session_id, at most 8000 input characters, optional yield_time_ms and signal. The output budget is set at launch.'};const data=parsed.data,runtime=options.commands!,session=runtime.session?.(data.session_id);if(!session)return{status:'error',code:'SESSION_NOT_FOUND',content:'No owned session with this ID; nothing was replayed.'};if(data.signal&&data.chars)return{status:'error',code:'INVALID_INPUT',content:'Send input or a signal, not both.'};
  const yieldMs=clampYield(data.yield_time_ms,data.chars||data.signal?EXEC_LIMITS.stdinDefaultYieldMs:EXEC_LIMITS.pollDefaultYieldMs);
  // The approval label is bounded for the permission prompt; the grant scope (executionKey) binds the exact input.
  const shown=data.signal??JSON.stringify(data.chars),file=options.workspace.resolve(session.cwd),command=`stdin ${data.session_id}: ${shown.length>900?shown.slice(0,900)+'…':shown}`,grantCommand=`stdin ${data.session_id}`;
  const launch=session.sandbox??{mode:'read-only' as const,network:false};
  return{kind:'command',file,command,grantCommand,workdir:file.relative,label:options.redact(command).slice(0,1024),runtime,runtimeId:runtime.id,toolName:'write_stdin',sessionId:data.session_id,// A session grant covers input to this session only, never other sessions or new launches.
   executionKey:JSON.stringify({session:data.session_id,launch}),
   stdin:{chars:data.chars,interrupt:data.signal==='SIGINT'||data.signal==='SIGTERM',tty:session.tty===true,launch},
   execute:async(signal,onOutput)=>{const result=await runtime.writeStdin!(data.session_id,data.chars,yieldMs,signal,data.signal,onOutput);return commandOutcomeResult(result,0,command);}};
 }
};}
