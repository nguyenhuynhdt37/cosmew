import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync,realpathSync,statSync,lstatSync,mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';import {join,relative,isAbsolute} from 'node:path';
import {FutrynError,type CommandRuntime,type CommandRequest,type CommandOutcome,type CommandOutputChunk,type CommandSandbox,type CommandSessionInfo,type CommandRuntimeCapabilities,type RuntimeAvailability} from '@futryn/contracts';
import {WorkspaceRoot,scanExecutionMasks} from '@futryn/workspace';
import {evaluateRead} from '@futryn/security';
import {CONTAINER_SUPERVISOR} from './container-supervisor';
import {HeadTailBuffer} from './output';
import {EXECUTION_IMAGE,GIT_IMAGE_TAG,verifiedDerivedImage} from './image';

export {EXECUTION_IMAGE};
/** Self-test results per engine identity + runtime policy id; never shared across a policy change. */
const proof=new Map<string,RuntimeAvailability>();
/** Engine identity is re-read at most this often; any change of identity re-runs the self-tests. */
const ENGINE_TTL_MS=15_000;
export const COMMAND_LIMITS={maxLeaseMs:1_800_000,minLeaseMs:1000,maxSessions:8,maxStdinChars:8000} as const;
const READ_ONLY:CommandSandbox={mode:'read-only',network:false};
const POLICY='v2:uid-owner-or-65534;capdrop-all+setuid,setgid,setpcap,kill;network-none-unless-approved;pid/ipc/cgroup-private;rootfs-ro;live-bind+masks(.git ro,secrets,state);lease';

interface Mount {Source:string;Target:string;ReadOnly:boolean}
interface OwnedSession {id:string;container:string;request:CommandRequest;sandbox:CommandSandbox;tty:boolean;
 /** Its top-level .git is a read-only mountpoint, so this session cannot rename or replace it (EBUSY). */
 gitPinned:boolean;process:ChildProcessWithoutNullStreams;buffers:{stdout:HeadTailBuffer;stderr:HeadTailBuffer};budgets:{stdout:number;stderr:number};streamed:{stdout:number;stderr:number};start:number;done:Promise<void>;ended:boolean;exitCode:number|null;stop?:'cancelled'|'timeout';observer?:CommandRequest['onOutput'];busy:boolean;namespaceDead:boolean;leaderStarted:boolean;receipt?:{kind:CommandOutcome['kind'];exitCode:number|null;signal:string|null;outputClosed:boolean;wrapperExitCode:number};protocolBroken?:boolean;deliveredSignal?:string;releaseAbort?:()=>void;stopping?:Promise<void>}

/** Codex `is_likely_sandbox_denied` (sandboxing/src/denial.rs, pinned 75fc67e8): a heuristic, never a retry trigger. */
export function likelySandboxDenied(exitCode:number|null,output:string):boolean {
 if(exitCode===null||exitCode===0||[2,126,127].includes(exitCode))return false;
 const lower=output.toLowerCase();
 return ['operation not permitted','permission denied','read-only file system','device or resource busy'].some(k=>lower.includes(k));
}

/**
 * Unified-exec backend on a fixed local Unix-socket Linux-container engine (ADR 0032 → 0034).
 * The live workspace is bind-mounted read-only or read-write; `.git` is always read-only; secret
 * files, Futryn state and patch temporaries are replaced by empty read-only mounts. Every boundary
 * is a mount/namespace property checked against the created container before it starts.
 */
export class DockerCommandRuntime implements CommandRuntime {
 readonly label='Docker sandbox · live workspace mount · .git read-only · secrets/state masked · no network unless approved · finite lease';
 private readonly owner=randomUUID();private readonly sessions=new Map<string,OwnedSession>();private readonly control:string;private readonly docker:string;private readonly socket:string;private closed=false;
 private readonly emptyFile:string;private readonly emptyDirectory:string;
 private engine?:{at:number;key:string;image:string;git:boolean};
 readonly id:string;
 constructor(private readonly options:{workspaceRoot:string;stateDirectory?:string}){
  this.control=mkdtempSync(join(tmpdir(),'fyn-docker-control-'));
  this.emptyFile=join(this.control,'masked-file');writeFileSync(this.emptyFile,'');chmodSync(this.emptyFile,0o444);
  this.emptyDirectory=join(this.control,'masked-directory');mkdirSync(this.emptyDirectory);chmodSync(this.emptyDirectory,0o555);
  this.docker=['/opt/homebrew/bin/docker','/usr/bin/docker','/usr/local/bin/docker'].find(p=>existsSync(p))??'/usr/bin/docker';
  try{this.socket=realpathSync('/var/run/docker.sock');}catch{this.socket='/var/run/docker.sock';}
  this.id='docker-unified-exec-v2:'+createHash('sha256').update(JSON.stringify([this.socket,EXECUTION_IMAGE,GIT_IMAGE_TAG,options.workspaceRoot,options.stateDirectory,CONTAINER_SUPERVISOR,POLICY])).digest('hex');
 }
 private env(){return{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:this.control,LANG:'C',DOCKER_CONFIG:this.control};}
 private prefix(){return['--host','unix://'+this.socket,'--config',this.control];}
 private cli(args:string[],timeout=10000){return spawnSync(this.docker,[...this.prefix(),...args],{env:this.env(),encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:4*1024*1024});}
 private flags(sandbox:CommandSandbox){return['--pid=',sandbox.network?'--network=bridge':'--network=none','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SETPCAP','--cap-add=KILL','--security-opt=no-new-privileges','--read-only','--pids-limit=128','--memory=512m','--memory-swap=512m','--cpus=1','--ipc=private','--cgroupns=private','--user=0:0','--tmpfs','/tmp:rw,nosuid,nodev,size=268435456,mode=1777','--ulimit','nofile=1024:1024','--entrypoint','/usr/local/bin/bun'];}
 private supervisor(launch:Record<string,unknown>){return ['--config=/dev/null','--no-env-file','-e',CONTAINER_SUPERVISOR,'--',JSON.stringify(launch)];}

 /** Engine identity and the approved image, cached briefly; identity changes invalidate self-tests. */
 private engineState(){
  if(this.engine&&Date.now()-this.engine.at<ENGINE_TTL_MS)return this.engine;
  this.engine=undefined;
  if(!['darwin','linux'].includes(process.platform)||!statSync(this.socket).isSocket())throw new Error('A local Unix-socket Linux-container engine is required.');
  const info=this.cli(['info','--format','{{json .}}']);if(info.status!==0)throw new Error('Local Docker engine unavailable.');const parsed=JSON.parse(info.stdout);
  if(parsed.OSType!=='linux'||parsed.CgroupVersion!=='2'||!parsed.SecurityOptions?.some((s:string)=>s.startsWith('name=seccomp')))throw new Error('Linux engine with default seccomp required.');
  const base=this.cli(['image','inspect',EXECUTION_IMAGE]);if(base.status!==0)throw new Error('Pinned approved image missing. Pull it explicitly during host setup; commands never pull.');
  const derived=this.cli(['image','inspect',GIT_IMAGE_TAG]);let image=EXECUTION_IMAGE,git=false;
  if(derived.status===0){const [b]=JSON.parse(base.stdout),[d]=JSON.parse(derived.stdout);if(verifiedDerivedImage(b,d)&&/^sha256:[a-f0-9]{64}$/.test(d.Id)){image=d.Id;git=true;}}
  return this.engine={at:Date.now(),key:parsed.ID+':'+parsed.ServerVersion+':'+JSON.stringify(parsed.SecurityOptions)+':'+image,image,git};
 }

 capabilities():CommandRuntimeCapabilities {
  let git=false;try{git=this.engineState().git;}catch{/* unavailable runtimes are never offered */}
  return {modes:['read-only','workspace-write'],network:true,tty:true,shells:['bash','sh'],tools:['bash','sh','bun','coreutils',...(git?['git']:[])]};
 }

 availability():RuntimeAvailability {
  if(this.closed)return{ok:false,reason:'Command runtime is closed.'};
  try{
   const engine=this.engineState();const key=engine.key+':'+this.id;const cached=proof.get(key)??this.persistedProof(key);if(cached){proof.set(key,cached);return cached;}
   // Same kernel profile as production: prove uid/capabilities, mount/network denial and a hard lease.
   const name='fyn-probe-'+randomUUID();try{
    const probe=this.cli(['run','--name',name,'--pull=never',...this.flags(READ_ONLY),engine.image,...this.supervisor({lease:1500,command:'test "$(id -u)" = 65534 && test "$(cat /proc/1/comm)" = bun && grep -q "CapEff:\\s*0000000000000000" /proc/self/status && grep -q "NoNewPrivs:\\s*1" /proc/self/status && test "$(cat /sys/fs/cgroup/pids.max)" = 128 && ! touch /etc/fyn-escape && test ! -e /var/run/docker.sock && bun -e \'fetch("http://1.1.1.1").then(()=>process.exit(1)).catch(()=>process.exit(0))\'',cwd:'/',uid:65534,gid:65534,tty:false,shell:'bash',login:false})],6000);
    if(probe.status!==0)throw new Error('Containment privilege/filesystem/network self-test failed.');
   }finally{this.cli(['rm','-f',name]);}
   const detached='fyn-probe-'+randomUUID();try{
    const result=this.cli(['run','--name',detached,'--pull=never',...this.flags(READ_ONLY),engine.image,...this.supervisor({lease:1000,command:'setsid sh -c "sleep 30" & wait',cwd:'/',uid:65534,gid:65534,tty:false,shell:'bash',login:false})],5000);
    const state=this.cli(['inspect','--format','{{json .State}}',detached]);const status=JSON.parse(state.stdout||'null');
    if(result.status!==124||!status||status.Running||status.Pid!==0)throw new Error('Detached-process lease/namespace teardown self-test failed.');
   }finally{this.cli(['rm','-f',detached]);}
   this.writeProbe(engine.image);
   const passed={ok:true} as const;proof.set(key,passed);this.persistProof(key);return passed;
  }catch(error){return {ok:false,reason:error instanceof Error?error.message:'Container verification failed.'};}
 }

 /**
  * Self-test evidence survives restarts only inside Futryn's state directory, which commands can
  * never see or write, and only for the same engine identity, image and runtime policy id, for 24 h.
  */
 private proofFile(){return this.options.stateDirectory?join(this.options.stateDirectory,'exec-runtime-proof.json'):undefined;}
 private persistedProof(key:string):RuntimeAvailability|undefined{
  const file=this.proofFile();if(!file)return undefined;
  try{const saved=JSON.parse(readFileSync(file,'utf8'));if(saved?.key===key&&typeof saved.at==='number'&&Date.now()-saved.at>=0&&Date.now()-saved.at<86_400_000)return{ok:true};}catch{/* no evidence */}
  return undefined;
 }
 private persistProof(key:string){const file=this.proofFile();if(!file)return;try{writeFileSync(file,JSON.stringify({key,at:Date.now()}),{mode:0o600});}catch{/* evidence is an optimisation only */}}

 /** Workspace-write self-test on a private tree: real writes land; masks and .git cannot be changed. */
 private writeProbe(image:string){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'fyn-write-probe-')));
  try{
   writeFileSync(join(root,'.env'),'PROBE_SECRET');mkdirSync(join(root,'.git'));writeFileSync(join(root,'.git','HEAD'),'ref: refs/heads/main\n');mkdirSync(join(root,'.futryn'));writeFileSync(join(root,'.futryn','state'),'STATE');
   const {args,uid,gid}=this.mounts(root,{mode:'workspace-write',network:false});
   const name='fyn-probe-'+randomUUID();try{
    const result=this.cli(['run','--name',name,'--pull=never',...this.flags(READ_ONLY),...args,'--workdir','/',image,...this.supervisor({lease:3000,command:'cd /workspace && echo WRITTEN > made.txt && test ! -s .env && ! rm .env 2>/dev/null && ! touch .git/escape 2>/dev/null && test ! -e .futryn/state && ! touch .futryn/x 2>/dev/null && ! touch /etc/escape 2>/dev/null && ! ln /etc/hostname hard 2>/dev/null',cwd:'/workspace',uid,gid,tty:false,shell:'bash',login:false})],8000);
    if(result.status!==0)throw new Error('Workspace-write mask self-test failed.');
   }finally{this.cli(['rm','-f',name]);}
   if(readFileSync(join(root,'made.txt'),'utf8')!=='WRITTEN\n'||readFileSync(join(root,'.env'),'utf8')!=='PROBE_SECRET'||existsSync(join(root,'.git','escape'))||existsSync(join(root,'hard')))throw new Error('Workspace-write host observation self-test failed.');
  }finally{rmSync(root,{recursive:true,force:true});}
 }

 /**
  * Mount plan for one launch. Masks are recomputed for every launch from the live tree, so a
  * secret created since the previous command is masked too. Returns the exact expected mount set.
  *
  * Docker follows symlinks in bind *sources*, so a workspace path used as a source could be swapped
  * for a symlink to a host directory between this scan and `docker create`. Therefore the only
  * workspace-sourced bind besides the root is the top-level `.git`, lstat-verified as a real directory,
  * and only while no running write-capable session could swap it (`allowGitSource`). Nested `.git`
  * entries, `.git` files and every other mask use sources from Futryn's private control directory.
  */
 private mounts(root:string,sandbox:CommandSandbox,allowGitSource=true){
  if(/[,"\n\r]/.test(root)||/[,"\n\r]/.test(this.control))throw new FutrynError('POLICY');
  const workspace=new WorkspaceRoot(root);const state=this.options.stateDirectory;
  const masks=scanExecutionMasks(workspace,(path,directory)=>{
   const name=path.toLowerCase().split('/').at(-1)!;
   if(name==='.git')return path==='.git'&&directory&&allowGitSource?'read-only':'hide';
   if(name==='.futryn'||name==='.hannes'||name.startsWith('.futryn-patch-')||name.startsWith('.hannes-patch-'))return 'hide';
   const decision=evaluateRead(path,join(workspace.root,path),{stateDirectory:state});
   if(decision.effect==='deny')return 'hide';
   if(decision.effect==='ask'&&!directory)return 'hide';
   return 'keep';
  });
  if(masks.readOnly.some(p=>p!=='.git'))throw new FutrynError('POLICY');
  if(masks.readOnly.length){const st=lstatSync(join(workspace.root,'.git'));if(st.isSymbolicLink()||!st.isDirectory())throw new FutrynError('POLICY');}
  const expected:Mount[]=[{Source:workspace.root,Target:'/workspace',ReadOnly:sandbox.mode==='read-only'},
   ...masks.readOnly.map(p=>({Source:join(workspace.root,p),Target:'/workspace/'+p,ReadOnly:true})),
   ...masks.hiddenFiles.map(p=>({Source:this.emptyFile,Target:'/workspace/'+p,ReadOnly:true})),
   ...masks.hiddenDirectories.map(p=>({Source:this.emptyDirectory,Target:'/workspace/'+p,ReadOnly:true}))];
  // Writes run as the workspace owner so host files keep their ownership; root-owned trees are refused.
  let uid=65534,gid=65534;
  if(sandbox.mode==='workspace-write'){const st=statSync(workspace.root);if(st.uid===0)throw new FutrynError('POLICY');uid=st.uid;gid=st.gid||65534;}
  return {expected,uid,gid,workspace,gitPinned:masks.readOnly.length>0,args:expected.flatMap(m=>['--mount',`type=bind,src=${m.Source},dst=${m.Target}${m.ReadOnly?',readonly':''}`])};
 }

 private owned(session:OwnedSession){const result=this.cli(['inspect','--format','{{index .Config.Labels "futryn.exec.owner"}}',session.container]);return result.status===0&&result.stdout.trim()===this.owner;}
 private async stop(session:OwnedSession,reason:'cancelled'|'timeout'){
  if(session.stopping)return session.stopping;session.stop=reason;
  session.stopping=(async()=>{if(!session.namespaceDead&&this.owned(session)){const killed=this.cli(['kill','--signal=KILL',session.container],5000);if(killed.status===0)session.deliveredSignal='SIGKILL';}
   await Promise.race([session.done,new Promise<void>(resolve=>{const timer=setTimeout(resolve,1500);session.done.finally(()=>clearTimeout(timer));})]);
  })();return session.stopping;
 }
 private send(session:OwnedSession,frame:Record<string,unknown>){if(!session.ended&&session.process.stdin.writable)session.process.stdin.write(JSON.stringify(frame)+'\n');}

 private outcome(session:OwnedSession):CommandOutcome {
  const receipt=session.receipt;
  const confirmed=session.namespaceDead&&!session.protocolBroken&&receipt?.wrapperExitCode===session.exitCode;
  const kind:CommandOutcome['kind']=!session.ended?'running':!session.leaderStarted?'spawn-failed':confirmed?receipt!.kind:session.namespaceDead&&session.deliveredSignal?'cancelled':'unconfirmed';
  const output=session.buffers.stdout.text()+(session.buffers.stderr.totalBytes?'\n[stderr]\n'+session.buffers.stderr.text():'');
  const exitCode=confirmed?receipt!.exitCode:null;
  return{kind,...(session.ended?{}:{sessionId:session.id}),...(kind==='spawn-failed'?{sandboxFailed:true}:{}),...(kind==='exited'&&likelySandboxDenied(exitCode,output)?{sandboxDenied:true}:{}),exitCode,signal:confirmed?receipt!.signal:session.deliveredSignal??null,output,omittedBytes:session.buffers.stdout.omittedBytes+session.buffers.stderr.omittedBytes,durationMs:Date.now()-session.start,lifecycle:{leader:session.ended&&!session.leaderStarted?'not-started':session.namespaceDead?'exited':'unconfirmed',stopRequested:!!session.stop||kind==='timeout'||kind==='cancelled',output:receipt?.outputClosed?'closed':'cut-off',descendants:session.ended&&!session.leaderStarted?'not-started':session.namespaceDead?'terminated':'unconfirmed'}};
 }

 private async collect(session:OwnedSession,yieldMs:number,signal?:AbortSignal):Promise<CommandOutcome>{
  const abort=()=>{void this.stop(session,'cancelled');};if(signal?.aborted)await this.stop(session,'cancelled');else signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{if(!session.ended)await Promise.race([session.done,new Promise<void>(resolve=>{timer=setTimeout(resolve,yieldMs);})]);if(signal?.aborted)await this.stop(session,'cancelled');const result=this.outcome(session);
  // Codex parity: each call reports the output produced since the previous call on this session.
  session.buffers={stdout:new HeadTailBuffer(session.budgets.stdout),stderr:new HeadTailBuffer(session.budgets.stderr)};session.streamed={stdout:0,stderr:0};if(session.ended&&(session.namespaceDead||!session.leaderStarted)){if(!session.leaderStarted&&this.owned(session))this.cli(['rm',session.container]);this.sessions.delete(session.id);}return result;}finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);session.observer=undefined;}
 }

 async run(request:CommandRequest,signal?:AbortSignal):Promise<CommandOutcome>{
  if(!this.availability().ok)throw new FutrynError('UNSUPPORTED');signal?.throwIfAborted();if(this.sessions.size>=COMMAND_LIMITS.maxSessions)throw new FutrynError('BUDGET');
  const sandbox=request.sandbox??READ_ONLY,tty=request.tty===true,shell=request.shell??'bash';
  if(!Number.isInteger(request.timeoutMs)||request.timeoutMs<COMMAND_LIMITS.minLeaseMs||request.timeoutMs>COMMAND_LIMITS.maxLeaseMs||request.command.length>1024||request.command.includes('\u0000')||!Number.isInteger(request.maxOutputBytes)||request.maxOutputBytes<1||request.maxOutputBytes>60000||!['read-only','workspace-write'].includes(sandbox.mode)||typeof sandbox.network!=='boolean'||!['bash','sh'].includes(shell))throw new FutrynError('INVALID_INPUT');
  const engine=this.engineState();
  // A running write session whose .git is not a pinned mountpoint could swap .git for a symlink; hide it then.
  const gitSafe=![...this.sessions.values()].some(s=>!s.ended&&s.sandbox.mode==='workspace-write'&&!s.gitPinned);
  const {expected,uid,gid,workspace,args,gitPinned}=this.mounts(this.options.workspaceRoot,sandbox,gitSafe);
  const cwd=workspace.resolve(request.cwd);if(cwd.kind!=='directory')throw new FutrynError('POLICY');
  const relativeCwd=relative(workspace.root,cwd.absolute);if(relativeCwd.startsWith('..')||isAbsolute(relativeCwd))throw new FutrynError('POLICY');
  let container='';const sessionId=randomUUID();try{
   signal?.throwIfAborted();
   const created=this.cli(['create','--interactive','--pull=never','--label','futryn.exec.owner='+this.owner,'--label','futryn.exec.session='+sessionId,...this.flags(sandbox),'--workdir','/',...args,engine.image,...this.supervisor({lease:request.timeoutMs,command:request.command,cwd:'/workspace'+(relativeCwd?'/'+relativeCwd:''),uid,gid,tty,cols:120,rows:40,shell,login:request.login===true})]);
   container=created.stdout.trim();if(created.status!==0||!/^[a-f0-9]{64}$/.test(container))throw new FutrynError('UNSUPPORTED');
   // The created container, not the request, is the authority: verify its actual policy before start.
   const configured=this.cli(['inspect','--format','{{json .HostConfig}}',container]);const host=JSON.parse(configured.stdout||'null');
   const mounts:Mount[]=(host?.Mounts??[]).map((m:{Type:string;Source:string;Target:string;ReadOnly?:boolean})=>m.Type==='bind'?{Source:m.Source,Target:m.Target,ReadOnly:m.ReadOnly===true}:{Source:'',Target:'',ReadOnly:false});
   const key=(m:Mount)=>JSON.stringify([m.Source,m.Target,m.ReadOnly]);const want=new Set(expected.map(key));
   if(!host||host.PidMode!==''||host.NetworkMode!==(sandbox.network?'bridge':'none')||host.Privileged||!host.ReadonlyRootfs||!host.SecurityOpt?.includes('no-new-privileges')||host.PidsLimit!==128||host.Memory!==536870912||host.NanoCpus!==1000000000||host.CgroupnsMode!=='private'||!host.CapDrop?.includes('ALL')||host.CapAdd?.some((cap:string)=>!['SETUID','SETGID','SETPCAP','KILL'].includes(cap.replace(/^CAP_/,'')))||host.Binds?.length||mounts.length!==expected.length||mounts.some(m=>!want.has(key(m))))throw new FutrynError('POLICY');
   signal?.throwIfAborted();
   const process=spawn(this.docker,[...this.prefix(),'start','--attach','--interactive',container],{env:this.env(),stdio:['pipe','pipe','pipe']});
   let resolve!:()=>void;const done=new Promise<void>(r=>{resolve=r;});
   const budget=tty?request.maxOutputBytes:Math.max(1,Math.ceil(request.maxOutputBytes/2));
   const session:OwnedSession={id:sessionId,container,request,sandbox,tty,gitPinned,process,buffers:{stdout:new HeadTailBuffer(budget),stderr:new HeadTailBuffer(Math.max(1,Math.floor(request.maxOutputBytes/2)))},budgets:{stdout:budget,stderr:Math.max(1,Math.floor(request.maxOutputBytes/2))},streamed:{stdout:0,stderr:0},start:Date.now(),done,ended:false,exitCode:null,observer:request.onOutput,busy:true,namespaceDead:false,leaderStarted:false};this.sessions.set(session.id,session);
   const decoders={stdout:new TextDecoder(),stderr:new TextDecoder()};
   const output=(stream:'stdout'|'stderr',bytes:Buffer)=>{session.buffers[stream].push(bytes);const limit=tty?request.maxOutputBytes:Math.floor(request.maxOutputBytes/2);const streamed=session.streamed;if(streamed[stream]<limit){const text=decoders[stream].decode(bytes.subarray(0,limit-streamed[stream]),{stream:true});streamed[stream]+=bytes.length;try{session.observer?.({stream,text});}catch{session.observer=undefined;}}};
   process.stdin.on('error',()=>{});
   let wire='';
   process.stdout.on('data',(bytes:Buffer)=>{wire+=bytes.toString('utf8');for(;;){const end=wire.indexOf('\n');if(end<0){if(wire.length>262144){session.protocolBroken=true;wire='';void this.stop(session,'cancelled');}break;}if(end>262144){session.protocolBroken=true;wire='';void this.stop(session,'cancelled');break;}const line=wire.slice(0,end);wire=wire.slice(end+1);try{const frame=JSON.parse(line);if(frame.type==='data'&&['stdout','stderr'].includes(frame.stream)&&typeof frame.data==='string'&&frame.data.length<=131072&&/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))output(frame.stream,Buffer.from(frame.data,'base64'));else if(frame.type==='result'&&!session.receipt&&['exited','timeout','cancelled','spawn-failed'].includes(frame.kind)&&(frame.exitCode===null||Number.isInteger(frame.exitCode))&&(frame.signal===null||typeof frame.signal==='string'&&/^SIG[A-Z0-9]{1,12}$/.test(frame.signal))&&typeof frame.outputClosed==='boolean'&&Number.isInteger(frame.wrapperExitCode))session.receipt=frame;else session.protocolBroken=true;}catch{session.protocolBroken=true;}}});
   process.stderr.on('data',bytes=>output('stderr',bytes));
   const finish=()=>{if(session.ended)return;const state=this.cli(['inspect','--format','{{json .State}}',container]);try{const observed=JSON.parse(state.stdout);session.leaderStarted=!!observed.StartedAt&&!observed.StartedAt.startsWith('0001-');session.namespaceDead=session.leaderStarted&&!observed.Running&&observed.Pid===0;session.exitCode=observed.ExitCode;}catch{session.namespaceDead=false;}session.ended=true;session.releaseAbort?.();if(session.namespaceDead&&this.owned(session))this.cli(['rm',container]);resolve();};
   process.once('error',finish);process.once('close',finish);
   const abortOwned=()=>{void this.stop(session,'cancelled');};signal?.addEventListener('abort',abortOwned,{once:true});session.releaseAbort=()=>signal?.removeEventListener('abort',abortOwned);
   try{return await this.collect(session,request.yieldTimeMs??request.timeoutMs+2500,signal);}finally{session.busy=false;}
  }catch(error){if(container&&!this.sessions.has(sessionId))this.cli(['rm','-f',container]);throw error;}
 }
 session(id:string):CommandSessionInfo|undefined{const s=this.sessions.get(id);return s?{cwd:s.request.cwd,command:s.request.command,tty:s.tty,sandbox:{...s.sandbox}}:undefined;}
 resize(id:string,cols:number,rows:number):void{const s=this.sessions.get(id);if(!s||!s.tty||s.ended||!Number.isInteger(cols)||cols<10||cols>1000||!Number.isInteger(rows)||rows<5||rows>500)throw new FutrynError('POLICY');this.send(s,{t:'rs',c:cols,r:rows});}
 /**
  * Codex write_stdin: empty input polls; input goes to the session's own pipe or PTY. SIGINT (or
  * `\x03` on a pipe session, Codex parity) interrupts the session's process group or PTY foreground
  * job, which may survive it; SIGTERM ends the whole namespace. Deadlines never extend.
  */
 async writeStdin(id:string,chars:string,yieldTimeMs:number,signal?:AbortSignal,interrupt?:'SIGINT'|'SIGTERM',onOutput?:(chunk:CommandOutputChunk)=>void):Promise<CommandOutcome>{
  const s=this.sessions.get(id);if(!s||s.busy||this.closed||(interrupt!==undefined&&!['SIGINT','SIGTERM'].includes(interrupt))||chars.length>COMMAND_LIMITS.maxStdinChars||chars.includes('\u0000')||!Number.isInteger(yieldTimeMs)||yieldTimeMs<0||yieldTimeMs>30000)throw new FutrynError('POLICY');if((!s.ended&&!this.owned(s))||(s.ended&&(chars||interrupt)))throw new FutrynError('POLICY');s.busy=true;s.observer=onOutput;
  try{signal?.throwIfAborted();
   if(interrupt==='SIGTERM'){this.cli(['kill','--signal=SIGTERM',s.container]);let grace:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([s.done,new Promise<void>(resolve=>{grace=setTimeout(resolve,500);})]);}finally{if(grace)clearTimeout(grace);}if(!s.namespaceDead)await this.stop(s,'cancelled');}
   else if(interrupt==='SIGINT'||(!s.tty&&chars==='\u0003'))this.send(s,{t:'int'});
   else if(chars&&!s.ended){const bytes=Buffer.from(chars,'utf8');for(let i=0;i<bytes.length;i+=8192)this.send(s,{t:'in',d:bytes.subarray(i,i+8192).toString('base64')});}
   return await this.collect(s,yieldTimeMs,signal);}finally{s.busy=false;}
 }
 async shutdown():Promise<void>{this.closed=true;await Promise.all([...this.sessions.values()].map(s=>this.stop(s,'cancelled')));this.sessions.clear();rmSync(this.control,{recursive:true,force:true});}
}
