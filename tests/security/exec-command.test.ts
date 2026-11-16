import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type CommandRuntime, type CommandOutcome} from '@futryn/contracts';
import {SessionGrants, evaluateExec} from '@futryn/security';
import {WorkspaceRoot} from '@futryn/workspace';
import {ToolDispatcher, SeatbeltRuntime, platformCommandRuntime, HeadTailBuffer, plainTerminalText, commandGrantTarget} from '@futryn/tools';
import {runProcess} from '../../packages/tools/src/exec/process';
const cleanup: (() => void)[] = [];
afterEach(() => {for (const fn of cleanup.splice(0).reverse()) fn();});
function fixture() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(),'futryn-exec-')));
  cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const root = join(dir,'workspace'), state=join(root,'state'); mkdirSync(state,{recursive:true});
  writeFileSync(join(root,'source.ts'),'export const marker = 1;\n');
  return {dir,root,state,workspace:new WorkspaceRoot(root)};
}
const outcome = (overrides: Partial<CommandOutcome> = {}): CommandOutcome => ({kind:'exited',exitCode:0,signal:null,output:'ok\n',omittedBytes:0,durationMs:1,...overrides});
function mock(f: ReturnType<typeof fixture>, approve: ConstructorParameters<typeof ToolDispatcher>[0]['approve']) {
  let calls=0; const grants=new SessionGrants();
  const runtime: CommandRuntime = {id:'test-policy',label:'fixture only',availability:()=>({ok:true}),run:async()=>{calls++;return outcome();}};
  const dispatcher = new ToolDispatcher({workspace:f.workspace,grants,commands:runtime,approve,redact:t=>t,stateDirectory:f.state});
  return {dispatcher,grants,runtime,calls:()=>calls};
}
const invoke = (dispatcher:ToolDispatcher,input: unknown,signal?:AbortSignal) => dispatcher.invoke({id:crypto.randomUUID(),name:'exec_command',input},signal);

test('production command gate is closed on every platform, without an unsafe fallback',async()=>{
  const f=fixture(); let prompts=0;
  for(const platform of ['darwin','linux','win32'] as const){
    const commands=platformCommandRuntime({workspaceRoot:f.root,platform});
    expect(commands.availability().ok).toBe(false);
    const tools=new ToolDispatcher({workspace:f.workspace,grants:new SessionGrants(),commands,approve:async()=>{prompts++;return 'once';},redact:t=>t});
    expect(tools.descriptors().map(t=>t.name)).toEqual(['read','glob','grep','apply_patch']);
    expect(await invoke(tools,{cmd:'touch forbidden'})).toMatchObject({status:'error',code:'SANDBOX_UNAVAILABLE'});
  }
  expect(prompts).toBe(0);expect(existsSync(join(f.root,'forbidden'))).toBe(false);
});

test('commands require their own explicit decision; denial and pre-cancellation never launch',async()=>{
  const f=fixture();const c=mock(f,async request=>{expect(request.capability).toBe('process.execute');return 'deny';});
  c.grants.grant('fs.read',f.root);
  expect(await invoke(c.dispatcher,{cmd:'printf hello'})).toMatchObject({status:'denied',code:'DENIED'});
  const controller=new AbortController();controller.abort();
  await expect(invoke(c.dispatcher,{cmd:'printf hello'},controller.signal)).rejects.toThrow();
  expect(c.calls()).toBe(0);
});

test('strict arguments and canonical cwd policy reject unsupported modes and workspace escapes',async()=>{
  const f=fixture();const c=mock(f,async()=> 'once');
  symlinkSync(f.dir,join(f.root,'escape'));
  // yield_time_ms is clamped like Codex (250-30000 ms), so it is no longer an invalid argument.
  for(const input of [{cmd:'x',tty:true},{cmd:'x',sandbox_permissions:'require_escalated'},{cmd:'x',additional_permissions:{network:{enabled:true}}},{cmd:'x',sandbox_permissions:'with_additional_permissions',additional_permissions:{network:{enabled:true}}},{cmd:'x',prefix_rule:['git']},{cmd:'x',shell:'/bin/zsh'},{cmd:'x',session_id:'fake'},{cmd:'x',timeout_ms:1},{cmd:'x',max_output_tokens:999999},{cmd:'a'.repeat(1025)},{cmd:'x\0y'}]) expect((await invoke(c.dispatcher,input)).status).not.toBe('ok');
  for(const workdir of ['missing','source.ts','../','escape','state']) expect((await invoke(c.dispatcher,{cmd:'x',workdir})).status).not.toBe('ok');
  expect(c.calls()).toBe(0);
  expect(evaluateExec('echo x','.',f.root).effect).toBe('ask');
});

test('session execution grants bind command, canonical cwd and sandbox policy and can be revoked',async()=>{
  const f=fixture();let prompts=0;const c=mock(f,async()=>{prompts++;return 'session';});mkdirSync(join(f.root,'sub'));
  await invoke(c.dispatcher,{cmd:'printf hello'});await invoke(c.dispatcher,{cmd:'printf hello'});
  expect(prompts).toBe(1);
  await invoke(c.dispatcher,{cmd:'printf other'});await invoke(c.dispatcher,{cmd:'printf hello',workdir:'sub'});
  expect(commandGrantTarget('printf hello',f.root,'different')).not.toBe(commandGrantTarget('printf hello',f.root,c.runtime.id));
  c.grants.clear();await invoke(c.dispatcher,{cmd:'printf hello'});
  expect(prompts).toBe(4);expect(c.calls()).toBe(5);
});

test('cwd swapped during approval is denied again before execution',async()=>{
  const f=fixture();mkdirSync(join(f.root,'sub'));
  const c=mock(f,async()=>{rmSync(join(f.root,'sub'),{recursive:true});symlinkSync(f.dir,join(f.root,'sub'));return 'once';});
  expect(await invoke(c.dispatcher,{cmd:'pwd',workdir:'sub'})).toMatchObject({status:'denied',code:'DENIED'});expect(c.calls()).toBe(0);
});

test('bounded capture keeps head/tail, rejects invalid bounds, and removes terminal controls',()=>{
  const buffer=new HeadTailBuffer(10);buffer.push(Buffer.from('HEAD'+'x'.repeat(100000)+'TAIL'));
  expect(buffer.omittedBytes).toBe(99998);expect(buffer.totalBytes).toBe(100008);
  expect(buffer.text()).toContain('HEADx');expect(buffer.text()).toEndWith('xTAIL');
  expect(()=>new HeadTailBuffer(0)).toThrow();expect(()=>new HeadTailBuffer(Infinity)).toThrow();
  expect(plainTerminalText('\x1b[31mred\x1b[0m\x1b]52;c;clipboard\x07\r\n\x00')).toBe('red\n');
});

test('executor reports spawn failure and cancellation without inventing an exit code',async()=>{
  const f=fixture();const spec={argv:['/definitely/not/a/program'] as [string],cwd:f.root,env:{},timeoutMs:1000,maxOutputBytes:100};
  expect(await runProcess(spec)).toMatchObject({kind:'spawn-failed',exitCode:null});
  const controller=new AbortController();controller.abort();
  expect(await runProcess(spec,controller.signal)).toMatchObject({kind:'cancelled',exitCode:null});
});

function candidate(){const f=fixture();const runtime=new SeatbeltRuntime({workspaceRoot:f.root,stateDirectory:f.state,extraExecutables:['rg']});expect(runtime.probeIsolation()).toEqual({ok:true});expect(runtime.availability().ok).toBe(false);return {...f,runtime};}
const osTest=test.skipIf(process.platform!=='darwin');
osTest('macOS candidate OS sandbox: rg, pipeline, exit codes and missing executable are real',async()=>{
  const f=candidate();
  for(const [command,code,text] of [['rg -n marker source.ts',0,'1:export const marker'],['nl -ba source.ts | sed -n 1p',0,'marker'],['exit 7',7,''],['futryn_missing_executable_03a',127,'not found']] as const){
    const result=await f.runtime.run({command,cwd:f.root,timeoutMs:1000,maxOutputBytes:1000});expect(result.exitCode).toBe(code);expect(result.output).toContain(text);
  }
});
osTest('macOS candidate denies writes, outside and symlink reads, state, git, secrets and network',async()=>{
  const f=candidate();writeFileSync(join(f.dir,'outside'),'DISPOSABLE_OUTSIDE_CANARY');symlinkSync(join(f.dir,'outside'),join(f.root,'escape'));
  mkdirSync(join(f.root,'.git'));writeFileSync(join(f.root,'.git','config'),'GIT_CANARY');writeFileSync(join(f.state,'auth'),'STATE_CANARY');
  for(const name of ['.env','.ENV.production','test.pem'])writeFileSync(join(f.root,name),'SECRET_CANARY');
  for(const command of ['printf mutation > newfile','printf mutation >> source.ts','cat ../outside','cat escape','cat state/auth','cat .git/config','cat .env','cat .ENV.production','cat test.pem']){
    const result=await f.runtime.run({command,cwd:f.root,timeoutMs:1000,maxOutputBytes:1000});expect(result.exitCode).not.toBe(0);expect(result.output).not.toContain('CANARY');
  }
  expect(existsSync(join(f.root,'newfile'))).toBe(false);
  let received=0;const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>{received++;return new Response('NETWORK_CANARY');}});cleanup.push(()=>server.stop(true));
  const network=await f.runtime.run({command:`/usr/bin/curl --noproxy '*' --connect-timeout 1 --max-time 1 http://127.0.0.1:${server.port}`,cwd:f.root,timeoutMs:2000,maxOutputBytes:1000});
  expect(network.exitCode).not.toBe(0);expect(received).toBe(0);
});
osTest('macOS candidate has explicit environment and bounded stdout/stderr; invalid sandbox fails closed',async()=>{
  const f=candidate();process.env.FUTRYN_EXEC_CANARY='DISPOSABLE_ENV_CANARY';cleanup.push(()=>{delete process.env.FUTRYN_EXEC_CANARY;});
  const result=await f.runtime.run({command:'env; for ((i=0;i<10000;i++)); do printf A; printf B >&2; done',cwd:f.root,timeoutMs:3000,maxOutputBytes:200});
  expect(result.output).not.toContain('DISPOSABLE_ENV_CANARY');expect(result.omittedBytes).toBeGreaterThan(10000);expect(result.output.length).toBeLessThan(300);
  const invalid=new SeatbeltRuntime({workspaceRoot:f.root,sandboxExec:'/does/not/exist'});
  expect(invalid.probeIsolation().ok).toBe(false);expect(await invalid.run({command:'true',cwd:f.root,timeoutMs:1000,maxOutputBytes:100})).toMatchObject({kind:'spawn-failed',sandboxFailed:true});
});
osTest('macOS candidate cancellation and timeout kill ordinary child process groups',async()=>{
  const f=candidate();
  for(const cancelled of [false,true]){
    const controller=new AbortController();const timer=cancelled?setTimeout(()=>controller.abort(),150):undefined;
    const result=await f.runtime.run({command:'sleep 20 & echo CHILD:$!; wait',cwd:f.root,timeoutMs:300,maxOutputBytes:100},controller.signal);clearTimeout(timer);
    expect(result.kind).toBe(cancelled?'cancelled':'timeout');const pid=Number(/CHILD:(\d+)/.exec(result.output)?.[1]);expect(pid).toBeGreaterThan(0);
    let alive=true;try{process.kill(pid,0);}catch{alive=false;}expect(alive).toBe(false);
  }
});
osTest('mandatory gate negative evidence: setsid child escapes candidate cleanup, so production stays disabled',async()=>{
  const f=candidate();const result=await f.runtime.run({command:"/usr/bin/perl -MPOSIX -e '$p=fork(); if($p){print qq(CHILD:$p\\n);exit 0;} POSIX::setsid(); sleep 20;'",cwd:f.root,timeoutMs:1000,maxOutputBytes:100});
  const pid=Number(/CHILD:(\d+)/.exec(result.output)?.[1]);expect(pid).toBeGreaterThan(0);
  try{expect(()=>process.kill(pid,0)).not.toThrow();expect(platformCommandRuntime({workspaceRoot:f.root}).availability().ok).toBe(false);}
  finally{try{process.kill(pid,'SIGKILL');}catch{/* fixture already exited */}}
});
