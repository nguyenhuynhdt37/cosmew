import { spawn } from 'node:child_process';
import type { CommandLifecycle } from '@hannes/contracts';
import { HeadTailBuffer } from './output';

/** Observations about one owned leader, never a certificate that every descendant is dead. */
export interface ProcessOutcome {
  kind: 'exited' | 'timeout' | 'cancelled' | 'spawn-failed';
  exitCode: number | null;
  signal: string | null;
  output: HeadTailBuffer;
  durationMs: number;
  lifecycle: CommandLifecycle;
}
export interface ProcessSpec {
  argv: [string, ...string[]];
  cwd: string;
  /** Complete environment; nothing is inherited. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Best-effort signalling is limited to the original group before the owned leader's exit is observed.
 * No ps enumeration, saved-PID retries after exit, or claim of detached descendant containment.
 * Node delivers its child exit observation on the same JS thread as these checks/signals.
 */
export function runProcess(spec: ProcessSpec, signal?: AbortSignal): Promise<ProcessOutcome> {
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 120000) throw new RangeError('Invalid process timeout');
  const started = performance.now();
  const output = new HeadTailBuffer(spec.maxOutputBytes);
  const absent = (kind: 'cancelled' | 'spawn-failed'): ProcessOutcome => ({kind,exitCode:null,signal:null,output,durationMs:Math.round(performance.now()-started),lifecycle:{leader:'not-started',stopRequested:false,output:'closed',descendants:'not-started'}});
  if (signal?.aborted) return Promise.resolve(absent('cancelled'));
  return new Promise(resolvePromise => {
    let child: ReturnType<typeof spawn>;
    try { child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env:spec.env,detached:true,stdio:['ignore','pipe','pipe']}); }
    catch {resolvePromise(absent('spawn-failed'));return;}
    let settled=false, stopRequested=false;
    let reason: 'timeout' | 'cancelled' | null=null;
    let exit: {code:number|null;signal:string|null} | null=null;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    const requestStop = () => {
      // Observed exit fences late signals. This is not a kernel-stable identity guarantee or
      // a handle for descendants; do not signal a saved numeric ID after the exit observation.
      if (!child.pid || exit || child.exitCode !== null || child.signalCode !== null) return;
      stopRequested=true;
      try {process.kill(-child.pid,'SIGKILL');} catch {/* not delivered; no success inferred */}
      try {child.kill('SIGKILL');} catch {/* not delivered; wait for an actual exit observation */}
    };
    const finish = (kind:ProcessOutcome['kind'], outputClosed:boolean) => {
      if (settled) return;
      settled=true;
      clearTimeout(timeout);clearTimeout(drain);clearTimeout(stopDeadline);
      signal?.removeEventListener('abort',onAbort);
      child.stdout?.removeAllListeners('data');child.stderr?.removeAllListeners('data');
      child.stdout?.destroy();child.stderr?.destroy();
      // A failed signal must not keep local application shutdown waiting forever. An unref is
      // resource release, not process termination. The unknown state is carried in the result.
      if (!exit) child.unref();
      resolvePromise({kind,exitCode:exit?.code??null,signal:exit?.signal??null,output,durationMs:Math.round(performance.now()-started),
        lifecycle:{leader:child.pid ? exit ? 'exited':'unconfirmed':'not-started',stopRequested,output:outputClosed?'closed':'cut-off',descendants:child.pid?'unconfirmed':'not-started'}});
    };
    const stop = (why:'timeout'|'cancelled') => {
      if (settled || reason) return;
      reason=why;requestStop();
      stopDeadline=setTimeout(()=>finish(why,false),1000);
    };
    const onAbort=()=>stop('cancelled');
    const timeout=setTimeout(()=>stop('timeout'),spec.timeoutMs);
    child.stdout!.on('data',(chunk:Buffer)=>output.push(chunk));
    child.stderr!.on('data',(chunk:Buffer)=>output.push(chunk));
    child.once('error',()=>{
      if (!child.pid) finish('spawn-failed',true);
      // Errors from signalling an existing child are not spawn failure or observed exit.
    });
    child.once('exit',(code,sig)=>{
      exit={code,signal:sig};
      if (settled) return;
      clearTimeout(timeout);
      // Leader exit and pipe EOF are independent. A background writer can keep pipes open.
      drain=setTimeout(()=>finish(reason??'exited',false),250);
    });
    child.once('close',(code,sig)=>{
      if (!exit && child.pid) exit={code,signal:sig};
      finish(reason??(child.pid?'exited':'spawn-failed'),true);
    });
    signal?.addEventListener('abort',onAbort,{once:true});
    if (signal?.aborted) onAbort();
  });
}

/** Local run ownership, cancellation and bounded resource release; NOT an OS lifetime boundary. */
export class ProcessSupervisor {
  private closed=false;
  private readonly active=new Set<{abort:AbortController;done:Promise<ProcessOutcome>}>();
  get activeCount(): number {return this.active.size;}
  run(spec:ProcessSpec,signal?:AbortSignal): Promise<ProcessOutcome> {
    const abort=new AbortController();
    const forward=()=>abort.abort();
    if (this.closed || signal?.aborted) abort.abort();
    signal?.addEventListener('abort',forward,{once:true});
    let done:Promise<ProcessOutcome>;
    try {done=runProcess(spec,abort.signal);} catch(error) {signal?.removeEventListener('abort',forward);throw error;}
    const entry={abort,done};this.active.add(entry);
    return done.finally(()=>{signal?.removeEventListener('abort',forward);this.active.delete(entry);});
  }
  async shutdown():Promise<void> {
    this.closed=true;
    const runs=[...this.active];
    for(const run of runs)run.abort.abort();
    await Promise.allSettled(runs.map(run=>run.done));
  }
}
