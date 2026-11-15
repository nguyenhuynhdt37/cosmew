import {afterEach,expect,test} from 'bun:test';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SeatbeltRuntime} from '@hannes/tools';
import {commandSummary} from '@hannes/tui';
import {ProcessSupervisor,runProcess} from '../../packages/tools/src/exec/process';
import {formatOutcome} from '../../packages/tools/src/exec/command';
import {observe,current,live,same,waitFor,dispose,type Observation} from '../process-fixtures/observe';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const osTest=test.skipIf(process.platform!=='darwin');
function fixture(){const root=realpathSync.native(mkdtempSync(join(tmpdir(),'futryn-supervision-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));const runtime=new SeatbeltRuntime({workspaceRoot:root});cleanup.push(()=>runtime.shutdown());expect(runtime.probeIsolation()).toEqual({ok:true});expect(runtime.availability().ok).toBe(false);return{root,runtime};}
const nonce=()=>crypto.randomUUID().replaceAll('-','');
const request=(root:string,command:string,timeoutMs=1500)=>({command,cwd:root,timeoutMs,maxOutputBytes:1000});

osTest('ordinary child and nested shell/pipeline: cancellation observes leader exit and disposes local collectors',async()=>{
 for(const nested of [false,true]){
  const f=fixture(),token=nonce();const controller=new AbortController();
  const script=nested?'sleep 5 | cat & wait':'sleep 5 & wait';
  const run=f.runtime.run(request(f.root,`exec /bin/bash --noprofile --norc -c '${script}' ${token}`),controller.signal);
  const parent=await waitFor(()=>observe().find(p=>p.command.includes(token)&&p.command.startsWith('/bin/bash')));
  const members=await waitFor(()=>{const found=observe().filter(p=>p.group===parent.group&&live(p));return found.length>=(nested?3:2)?found:undefined;});
  cleanup.push(()=>dispose(members));controller.abort();const result=await run;
  expect(result).toMatchObject({kind:'cancelled',signal:'SIGKILL',lifecycle:{leader:'exited',stopRequested:true,descendants:'unconfirmed'}});
  await waitFor(()=>members.every(p=>!current(p))?true:undefined);
  expect(members.every(p=>!current(p))).toBe(true);
 }
});
osTest('forked child spawning another child stays ordinary group-owned while the leader runs',async()=>{
 const f=fixture(),token=nonce(),controller=new AbortController();
 const run=f.runtime.run(request(f.root,`exec /usr/bin/perl -e '$p=fork();if(!$p){$p=fork();sleep 5;exit 0;}sleep 5;' ${token}`),controller.signal);
 const family=await waitFor(()=>{const found=observe().filter(p=>p.command.includes(token)&&p.command.startsWith('/usr/bin/perl')&&live(p));return found.length===3?found:undefined;});
 cleanup.push(()=>dispose(family));controller.abort();await run;
 await waitFor(()=>family.every(p=>!current(p))?true:undefined);
});
osTest('detachment and reparenting survive parent exit; EOF is not leader exit',async()=>{
 const f=fixture(),token=nonce();
 const command=`exec /usr/bin/perl -MPOSIX -e '$|=1;pipe(R,W);$p=fork();if($p){close W;<R>;exit 0;}close R;POSIX::setsid();print W qq(ready\\n);close W;select undef,undef,undef,0.05;if(open(F,qq(>forbidden))){print qq(WRITE_ALLOWED\\n);}else{print qq(WRITE_DENIED\\n);}print qq(CHILD:$$\\n);sleep 5;' ${token}`;
 const result=await f.runtime.run(request(f.root,command));
 const child=observe().find(p=>p.command.includes(token)&&p.command.startsWith('/usr/bin/perl')&&live(p));expect(child).toBeDefined();if(!child)return;
 cleanup.push(()=>dispose([child]));expect(child.group).toBe(child.pid);expect(child.ppid).toBe(1);
 await Bun.sleep(40);expect(current(child)).toBeDefined(); // second independent identity/state observation
 expect(result).toMatchObject({kind:'exited',exitCode:0,lifecycle:{leader:'exited',descendants:'unconfirmed',output:'cut-off'}});
 expect(formatOutcome(result,1500).truncated).toBe(true);
 expect(result.output).toContain('WRITE_DENIED');expect(existsSync(join(f.root,'forbidden'))).toBe(false);
});
osTest('timeout requests termination, but TUI/model never certify the tree dead',async()=>{
 const f=fixture();const result=await f.runtime.run(request(f.root,'exec /bin/sleep 5',150));
 expect(result).toMatchObject({kind:'timeout',lifecycle:{leader:'exited',stopRequested:true,descendants:'unconfirmed'}});
 const formatted=formatOutcome(result,150);expect(formatted.content).toContain('termination requested');expect(formatted.content).toContain('Descendant termination: unconfirmed');expect(formatted.content).not.toContain('tree was killed');
 expect(commandSummary({id:'c',name:'exec_command',input:{cmd:'sleep 5'}},{callId:'c',name:'exec_command',status:'error',code:'TIMEOUT',content:formatted.content},{live:false}).note).toContain('termination unconfirmed');
});
osTest('runtime shutdown cancels owned live runs, closes admission and is repeatable',async()=>{
 const f=fixture(),token=nonce();
 const run=f.runtime.run(request(f.root,`exec /bin/bash -c 'sleep 5 & wait' ${token}`));
 const leader=await waitFor(()=>observe().find(p=>p.command.includes(token)&&live(p)));cleanup.push(()=>dispose([leader]));
 await f.runtime.shutdown();expect(await run).toMatchObject({kind:'cancelled',lifecycle:{leader:'exited'}});expect(current(leader)).toBeUndefined();
 await f.runtime.shutdown();expect(await f.runtime.run(request(f.root,'printf should-not-start'))).toMatchObject({kind:'cancelled',lifecycle:{leader:'not-started',stopRequested:false}});
});
osTest('supervisor crash has no JS cleanup guarantee; disposable descendants survive',async()=>{
 const f=fixture(),token=nonce();
 const worker=spawn(process.execPath,[resolve('tests/process-fixtures/supervisor-worker.ts'),f.root,token],{cwd:resolve('.'),env:{PATH:'/usr/bin:/bin'},stdio:'ignore'});
 const exited=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
 let family:Observation[]=[];
 try{
  family=await waitFor(()=>{const found=observe().filter(p=>p.command.includes(token)&&p.command.startsWith('/usr/bin/perl')&&live(p));return found.length===2?found:undefined;});
  const detached=family.find(p=>p.group===p.pid)!;expect(detached).toBeDefined();
  worker.kill('SIGKILL');await exited;
  await Bun.sleep(40);for(const member of family)expect(current(member)).toBeDefined();
  expect(f.runtime.availability().ok).toBe(false);
 }finally{if(worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGKILL');await exited;}await dispose(family);}
});
osTest('rapid spawn/exit and stale supervisor references do not signal an unrelated live fixture',async()=>{
 const supervisor=new ProcessSupervisor();const f=fixture();
 const sentinel=spawn('/bin/sleep',['5'],{stdio:'ignore'});const exited=new Promise<void>(resolve=>sentinel.once('exit',()=>resolve()));
 const identity=await waitFor(()=>observe().find(p=>p.pid===sentinel.pid&&live(p)));
 try{
  for(let i=0;i<20;i++){
   const result=await supervisor.run({argv:['/bin/echo',String(i)],cwd:f.root,env:{},timeoutMs:1000,maxOutputBytes:100});expect(result.exitCode).toBe(0);
  }
  expect(supervisor.activeCount).toBe(0);await supervisor.shutdown();await supervisor.shutdown();
  expect(current(identity)).toBeDefined();expect(same(identity,current(identity)!)).toBe(true);
 }finally{sentinel.kill('SIGKILL');await exited;}
});
osTest('cancellation before launch, failed spawn and repeated execution release run ownership',async()=>{
 const supervisor=new ProcessSupervisor(),f=fixture(),controller=new AbortController();controller.abort();
 const spec={argv:['/bin/echo','hello'] as [string,string],cwd:f.root,env:{},timeoutMs:1000,maxOutputBytes:100};
 expect(await supervisor.run(spec,controller.signal)).toMatchObject({kind:'cancelled',lifecycle:{leader:'not-started',output:'closed'}});
 expect(await supervisor.run({...spec,argv:['/not-a-real-program']})).toMatchObject({kind:'spawn-failed',lifecycle:{leader:'not-started'}});
 for(let i=0;i<10;i++){expect((await supervisor.run(spec)).lifecycle.output).toBe('closed');expect(supervisor.activeCount).toBe(0);}
 await supervisor.shutdown();
 expect((await runProcess(spec,controller.signal)).lifecycle.descendants).toBe('not-started');
});
osTest('background output retention is bounded independently from leader exit and capture byte budget',async()=>{
 const f=fixture(),token=nonce();
 const result=await f.runtime.run({...request(f.root,`exec /usr/bin/perl -MPOSIX -e '$p=fork();if($p){print qq(HEAD\\n);exit 0;}POSIX::setsid();print qq(x) x 100000;sleep 5;' ${token}`),maxOutputBytes:100});
 const remaining=observe().filter(p=>p.command.includes(token)&&p.command.startsWith('/usr/bin/perl')&&live(p));cleanup.push(()=>dispose(remaining));
 expect(result.lifecycle).toMatchObject({leader:'exited',output:'cut-off',descendants:'unconfirmed'});expect(result.omittedBytes).toBeGreaterThan(90000);expect(result.output.length).toBeLessThan(200);
});

test('lifecycle formatting preserves unknown legacy observations and pre-launch cancellation',()=>{
 const legacy={kind:'exited' as const,exitCode:0,signal:null,output:'ok',omittedBytes:0,durationMs:1};
 expect(formatOutcome(legacy,1000).content).toContain('Descendant termination: unconfirmed');
 const cancelled={...legacy,kind:'cancelled' as const,exitCode:null,lifecycle:{leader:'not-started' as const,stopRequested:false,output:'closed' as const,descendants:'not-started' as const}};
 expect(formatOutcome(cancelled,1000).content).toStartWith('Cancelled before launch.');
 expect(formatOutcome(cancelled,1000).content).not.toContain('termination requested');
});
