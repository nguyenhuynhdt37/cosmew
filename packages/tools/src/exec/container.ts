import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,realpathSync,statSync,mkdirSync} from 'node:fs';
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';import {join,relative,isAbsolute} from 'node:path';
import {FutrynError,type CommandRuntime,type CommandRequest,type CommandOutcome,type CommandOutputChunk,type RuntimeAvailability} from '@futryn/contracts';
import {SecureFiles,WorkspaceRoot,captureExecutionSnapshot} from '@futryn/workspace';
import {evaluateRead} from '@futryn/security';
import {CONTAINER_SUPERVISOR} from './container-supervisor';
import {HeadTailBuffer} from './output';

export const EXECUTION_IMAGE='oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d';
const proof=new Map<string,RuntimeAvailability>();
interface OwnedSession {id:string;container:string;directory:string;request:CommandRequest;process:ChildProcessWithoutNullStreams;buffers:{stdout:HeadTailBuffer;stderr:HeadTailBuffer};start:number;done:Promise<void>;ended:boolean;exitCode:number|null;stop?:'cancelled'|'timeout';observer?:CommandRequest['onOutput'];busy:boolean;namespaceDead:boolean;leaderStarted:boolean;receipt?:{kind:CommandOutcome['kind'];exitCode:number|null;signal:string|null;outputClosed:boolean;wrapperExitCode:number};protocolBroken?:boolean;deliveredSignal?:string;releaseAbort?:()=>void;stopping?:Promise<void>}
/** Only a fixed local Unix-socket engine, pinned image and immutable containment policy. */
export class DockerCommandRuntime implements CommandRuntime {
 readonly label='Docker PID namespace · read-only workspace snapshot · no network · finite lease · pipe sessions';
 private readonly owner=randomUUID();private readonly sessions=new Map<string,OwnedSession>();private readonly control:string;private readonly docker:string;private readonly socket:string;private closed=false;
 readonly id:string;
 constructor(private readonly options:{workspaceRoot:string;stateDirectory?:string}){
  this.control=mkdtempSync(join(tmpdir(),'fyn-docker-control-'));
  this.docker=['/opt/homebrew/bin/docker','/usr/bin/docker','/usr/local/bin/docker'].find(p=>existsSync(p))??'/usr/bin/docker';
  try{this.socket=realpathSync('/var/run/docker.sock');}catch{this.socket='/var/run/docker.sock';}
  this.id='docker-snapshot-v1:'+createHash('sha256').update(JSON.stringify([this.socket,EXECUTION_IMAGE,options.workspaceRoot,options.stateDirectory,CONTAINER_SUPERVISOR,'uid65534-capdrop-networknone-pidprivate-readonly-lease-v1'])).digest('hex');
 }
 private env(){return{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:this.control,LANG:'C',DOCKER_CONFIG:this.control};}
 private prefix(){return['--host','unix://'+this.socket,'--config',this.control];}
 private cli(args:string[],timeout=10000){return spawnSync(this.docker,[...this.prefix(),...args],{env:this.env(),encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:1024*1024});}
 private flags(){return['--pid=','--network=none','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SETPCAP','--security-opt=no-new-privileges','--read-only','--pids-limit=128','--memory=512m','--memory-swap=512m','--cpus=1','--ipc=private','--cgroupns=private','--user=0:0','--tmpfs','/tmp:rw,nosuid,nodev,size=134217728,mode=1777','--ulimit','nofile=256:256','--entrypoint','/usr/local/bin/bun'];}
 private command(command:string,cwd:string,timeoutMs:number){return ['--config=/dev/null','--no-env-file','-e',CONTAINER_SUPERVISOR,'--',String(timeoutMs),command,cwd];}

 availability():RuntimeAvailability {
  if(this.closed)return{ok:false,reason:'Command runtime is closed.'};
  try{
   if(!SecureFiles.available())throw new Error('Descriptor-relative snapshots are unavailable on this host.');
   if(!['darwin','linux'].includes(process.platform)||!statSync(this.socket).isSocket())throw new Error('A local Unix-socket Linux-container engine is required.');
   const info=this.cli(['info','--format','{{json .}}']);if(info.status!==0)throw new Error('Local Docker engine unavailable.');const parsed=JSON.parse(info.stdout);
   if(parsed.OSType!=='linux'||parsed.CgroupVersion!=='2'||!parsed.SecurityOptions?.some((s:string)=>s.startsWith('name=seccomp')))throw new Error('Linux engine with default seccomp required.');
   const key=parsed.ID+':'+parsed.ServerVersion+':'+JSON.stringify(parsed.SecurityOptions)+':'+this.id;const cached=proof.get(key);if(cached)return cached;
   if(this.cli(['image','inspect',EXECUTION_IMAGE]).status!==0)throw new Error('Pinned approved image missing. Pull it explicitly during host setup; commands never pull.');
   // Same kernel profile as production: prove uid/capabilities, mount/network denial and a hard lease.
   const name='fyn-probe-'+randomUUID();try{
    const probe=this.cli(['run','--name',name,'--pull=never',...this.flags(),EXECUTION_IMAGE,...this.command('test "$(id -u)" = 65534 && test "$(cat /proc/1/comm)" = bun && grep -q "CapEff:\\s*0000000000000000" /proc/self/status && grep -q "NoNewPrivs:\\s*1" /proc/self/status && test "$(cat /sys/fs/cgroup/pids.max)" = 128 && ! touch /etc/fyn-escape && test ! -e /var/run/docker.sock && bun -e \'fetch("http://1.1.1.1").then(()=>process.exit(1)).catch(()=>process.exit(0))\'','/',1500)],6000);
    if(probe.status!==0)throw new Error('Containment privilege/filesystem/network self-test failed.');
   }finally{this.cli(['rm','-f',name]);}
   const detached='fyn-probe-'+randomUUID();try{
    const result=this.cli(['run','--name',detached,'--pull=never',...this.flags(),EXECUTION_IMAGE,...this.command('setsid sh -c "sleep 30" & wait','/',1000)],5000);
    const state=this.cli(['inspect','--format','{{json .State}}',detached]);const status=JSON.parse(state.stdout||'null');
    if(result.status!==124||!status||status.Running||status.Pid!==0)throw new Error('Detached-process lease/namespace teardown self-test failed.');
   }finally{this.cli(['rm','-f',detached]);}
   const passed={ok:true} as const;proof.set(key,passed);return passed;
  }catch(error){return {ok:false,reason:error instanceof Error?error.message:'Container verification failed.'};}
 }
 private owned(session:OwnedSession){const result=this.cli(['inspect','--format','{{index .Config.Labels "futryn.exec.owner"}}',session.container]);return result.status===0&&result.stdout.trim()===this.owner;}
 private async stop(session:OwnedSession,reason:'cancelled'|'timeout'){
  if(session.stopping)return session.stopping;session.stop=reason;
  session.stopping=(async()=>{if(!session.namespaceDead&&this.owned(session)){const killed=this.cli(['kill','--signal=KILL',session.container],5000);if(killed.status===0)session.deliveredSignal='SIGKILL';}
   await Promise.race([session.done,new Promise<void>(resolve=>{const timer=setTimeout(resolve,1500);session.done.finally(()=>clearTimeout(timer));})]);
  })();return session.stopping;
 }

 private outcome(session:OwnedSession):CommandOutcome {
  const receipt=session.receipt;
  const confirmed=session.namespaceDead&&!session.protocolBroken&&receipt?.wrapperExitCode===session.exitCode;
  const kind:CommandOutcome['kind']=!session.ended?'running':!session.leaderStarted?'spawn-failed':confirmed?receipt!.kind:session.namespaceDead&&session.deliveredSignal?'cancelled':'unconfirmed';
  return{kind,...(session.ended?{}:{sessionId:session.id}),...(kind==='spawn-failed'?{sandboxFailed:true}:{}),exitCode:confirmed?receipt!.exitCode:null,signal:confirmed?receipt!.signal:session.deliveredSignal??null,output:session.buffers.stdout.text()+(session.buffers.stderr.totalBytes?'\n[stderr]\n'+session.buffers.stderr.text():''),omittedBytes:session.buffers.stdout.omittedBytes+session.buffers.stderr.omittedBytes,durationMs:Date.now()-session.start,lifecycle:{leader:session.ended&&!session.leaderStarted?'not-started':session.namespaceDead?'exited':'unconfirmed',stopRequested:!!session.stop||kind==='timeout'||kind==='cancelled',output:receipt?.outputClosed?'closed':'cut-off',descendants:session.ended&&!session.leaderStarted?'not-started':session.namespaceDead?'terminated':'unconfirmed'}};
 }

 private async collect(session:OwnedSession,yieldMs:number,signal?:AbortSignal):Promise<CommandOutcome>{
  const abort=()=>{void this.stop(session,'cancelled');};if(signal?.aborted)await this.stop(session,'cancelled');else signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{if(!session.ended)await Promise.race([session.done,new Promise<void>(resolve=>{timer=setTimeout(resolve,yieldMs);})]);if(signal?.aborted)await this.stop(session,'cancelled');const result=this.outcome(session);if(session.ended&&(session.namespaceDead||!session.leaderStarted)){if(!session.leaderStarted&&this.owned(session))this.cli(['rm',session.container]);this.sessions.delete(session.id);rmSync(session.directory,{recursive:true,force:true});}return result;}finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);session.observer=undefined;}
 }
 async run(request:CommandRequest,signal?:AbortSignal):Promise<CommandOutcome>{
  if(!this.availability().ok)throw new FutrynError('UNSUPPORTED');signal?.throwIfAborted();if(this.sessions.size>=8)throw new FutrynError('BUDGET');
  if(!Number.isInteger(request.timeoutMs)||request.timeoutMs<1000||request.timeoutMs>120000||request.command.length>1024||!Number.isInteger(request.maxOutputBytes)||request.maxOutputBytes<1||request.maxOutputBytes>60000)throw new FutrynError('INVALID_INPUT');
  const workspace=new WorkspaceRoot(this.options.workspaceRoot),cwd=workspace.resolve(request.cwd);if(cwd.kind!=='directory')throw new FutrynError('POLICY');
  const directory=mkdtempSync(join(tmpdir(),'fyn-command-snapshot-')),snapshot=join(directory,'workspace');mkdirSync(snapshot);
  let container='';const sessionId=randomUUID();try{
   captureExecutionSnapshot(workspace,snapshot,path=>!path.toLowerCase().split('/').some(p=>p==='.futryn'||p==='.hannes'||p.startsWith('.hannes-patch-')||p.startsWith('.futryn-patch-'))&&evaluateRead(path,join(workspace.root,path),{stateDirectory:this.options.stateDirectory}).effect==='allow',signal);
   const relativeCwd=relative(workspace.root,cwd.absolute);if(relativeCwd.startsWith('..')||isAbsolute(relativeCwd)||snapshot.includes(','))throw new FutrynError('POLICY');
   const created=this.cli(['create','--interactive','--pull=never','--label','futryn.exec.owner='+this.owner,'--label','futryn.exec.session='+sessionId,...this.flags(),'--workdir','/','--mount',`type=bind,src=${snapshot},dst=/workspace,readonly`,EXECUTION_IMAGE,...this.command(request.command,'/workspace'+(relativeCwd?'/'+relativeCwd:''),request.timeoutMs)]);
   container=created.stdout.trim();if(created.status!==0||!/^[a-f0-9]{64}$/.test(container))throw new FutrynError('UNSUPPORTED');const configured=this.cli(['inspect','--format','{{json .HostConfig}}',container]);const host=JSON.parse(configured.stdout||'null');if(!host||host.PidMode!==''||host.NetworkMode!=='none'||host.Privileged||!host.ReadonlyRootfs||!host.SecurityOpt?.includes('no-new-privileges')||host.PidsLimit!==128||host.Memory!==536870912||host.NanoCpus!==1000000000||host.CgroupnsMode!=='private'||!host.CapDrop?.includes('ALL')||host.CapAdd?.some((cap:string)=>!['SETUID','SETGID','SETPCAP'].includes(cap.replace(/^CAP_/,'')))||host.Mounts?.length!==1||host.Mounts[0].Source!==snapshot||host.Mounts[0].Target!=='/workspace'||host.Mounts[0].ReadOnly!==true)throw new FutrynError('POLICY');signal?.throwIfAborted();
   const process=spawn(this.docker,[...this.prefix(),'start','--attach','--interactive',container],{env:this.env(),stdio:['pipe','pipe','pipe']});
   let resolve!:()=>void;const done=new Promise<void>(r=>{resolve=r;});const session:OwnedSession={id:sessionId,container,directory,request,process,buffers:{stdout:new HeadTailBuffer(Math.max(1,Math.ceil(request.maxOutputBytes/2))),stderr:new HeadTailBuffer(Math.max(1,Math.floor(request.maxOutputBytes/2)))},start:Date.now(),done,ended:false,exitCode:null,observer:request.onOutput,busy:true,namespaceDead:false,leaderStarted:false};this.sessions.set(session.id,session);
   const decoders={stdout:new TextDecoder(),stderr:new TextDecoder()};const streamed={stdout:0,stderr:0};
   const output=(stream:'stdout'|'stderr',bytes:Buffer)=>{session.buffers[stream].push(bytes);const budget=Math.floor(request.maxOutputBytes/2);if(streamed[stream]<budget){const text=decoders[stream].decode(bytes.subarray(0,budget-streamed[stream]),{stream:true});streamed[stream]+=bytes.length;try{session.observer?.({stream,text});}catch{session.observer=undefined;}}};
   process.stdin.on('error',()=>{});
   let wire='';
   process.stdout.on('data',(bytes:Buffer)=>{wire+=bytes.toString('utf8');for(;;){const end=wire.indexOf('\n');if(end<0){if(wire.length>262144){session.protocolBroken=true;wire='';void this.stop(session,'cancelled');}break;}if(end>262144){session.protocolBroken=true;wire='';void this.stop(session,'cancelled');break;}const line=wire.slice(0,end);wire=wire.slice(end+1);try{const frame=JSON.parse(line);if(frame.type==='data'&&['stdout','stderr'].includes(frame.stream)&&typeof frame.data==='string'&&frame.data.length<=131072&&/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))output(frame.stream,Buffer.from(frame.data,'base64'));else if(frame.type==='result'&&!session.receipt&&['exited','timeout','cancelled','spawn-failed'].includes(frame.kind)&&(frame.exitCode===null||Number.isInteger(frame.exitCode))&&(frame.signal===null||typeof frame.signal==='string'&&/^SIG[A-Z0-9]{1,12}$/.test(frame.signal))&&typeof frame.outputClosed==='boolean'&&Number.isInteger(frame.wrapperExitCode))session.receipt=frame;else session.protocolBroken=true;}catch{session.protocolBroken=true;}}});
   process.stderr.on('data',bytes=>output('stderr',bytes));
   const finish=()=>{if(session.ended)return;const state=this.cli(['inspect','--format','{{json .State}}',container]);try{const observed=JSON.parse(state.stdout);session.leaderStarted=!!observed.StartedAt&&!observed.StartedAt.startsWith('0001-');session.namespaceDead=session.leaderStarted&&!observed.Running&&observed.Pid===0;session.exitCode=observed.ExitCode;}catch{session.namespaceDead=false;}session.ended=true;session.releaseAbort?.();if(session.namespaceDead&&this.owned(session))this.cli(['rm',container]);resolve();};
   process.once('error',finish);process.once('close',finish);
   const abortOwned=()=>{void this.stop(session,'cancelled');};signal?.addEventListener('abort',abortOwned,{once:true});session.releaseAbort=()=>signal?.removeEventListener('abort',abortOwned);
   try{return await this.collect(session,request.yieldTimeMs??request.timeoutMs+2500,signal);}finally{session.busy=false;}
  }catch(error){if(container)this.cli(['rm','-f',container]);rmSync(directory,{recursive:true,force:true});throw error;}
 }
 session(id:string):{cwd:string;command:string}|undefined{const s=this.sessions.get(id);return s?{cwd:s.request.cwd,command:s.request.command}:undefined;}
 async writeStdin(id:string,chars:string,yieldTimeMs:number,signal?:AbortSignal,interrupt?:'SIGINT'|'SIGTERM',onOutput?:(chunk:CommandOutputChunk)=>void):Promise<CommandOutcome>{
  const s=this.sessions.get(id);if(!s||s.busy||this.closed||(interrupt!==undefined&&!['SIGINT','SIGTERM'].includes(interrupt))||chars.length>512||!Number.isInteger(yieldTimeMs)||yieldTimeMs<0||yieldTimeMs>30000)throw new FutrynError('POLICY');if((!s.ended&&!this.owned(s))||(s.ended&&chars))throw new FutrynError('POLICY');s.busy=true;s.observer=onOutput;
  try{signal?.throwIfAborted();if(interrupt){this.cli(['kill','--signal='+interrupt,s.container]);let grace:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([s.done,new Promise<void>(resolve=>{grace=setTimeout(resolve,500);})]);}finally{if(grace)clearTimeout(grace);}if(!s.namespaceDead)await this.stop(s,'cancelled');}else if(chars&&!s.ended)s.process.stdin.write(chars);return await this.collect(s,yieldTimeMs,signal);}finally{s.busy=false;}
 }
 async shutdown():Promise<void>{this.closed=true;await Promise.all([...this.sessions.values()].map(async s=>{await this.stop(s,'cancelled');if(s.namespaceDead)rmSync(s.directory,{recursive:true,force:true});}));this.sessions.clear();rmSync(this.control,{recursive:true,force:true});}
}
