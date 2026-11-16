import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';
import {delimiter,dirname,join,relative,isAbsolute} from 'node:path';
import {FutrynError,type CommandOutcome,type CommandOutputChunk,type CommandRequest,type CommandRuntime,type CommandRuntimeCapabilities,type CommandSandbox,type CommandSessionInfo,type RuntimeAvailability} from '@futryn/contracts';
import {WorkspaceRoot,scanExecutionMasks} from '@futryn/workspace';
import {evaluateRead,SECRET_FILE_EXCEPTIONS,SECRET_FILE_RULES} from '@futryn/security';
import {HeadTailBuffer} from './output';
import {likelySandboxDenied} from './container';

export const NATIVE_LIMITS={maxLeaseMs:1_800_000,minLeaseMs:1000,maxSessions:16,maxStdinChars:8000} as const;
const READ_ONLY:CommandSandbox={mode:'read-only',network:false};
/** Codex UNIFIED_EXEC_ENV (unified_exec/process_manager.rs, pinned 75fc67e8). Nothing else is inherited except PATH. */
const EXEC_ENV={NO_COLOR:'1',TERM:'dumb',LANG:'C.UTF-8',LC_CTYPE:'C.UTF-8',LC_ALL:'C.UTF-8',COLORTERM:'',PAGER:'cat',GIT_PAGER:'cat',GH_PAGER:'cat',CODEX_CI:'1',GIT_OPTIONAL_LOCKS:'0',FUTRYN_SANDBOX:'1'};

const escapeRegex=(t:string)=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ci=(text:string)=>[...text].map(ch=>/[a-z]/i.test(ch)?`[${ch.toLowerCase()}${ch.toUpperCase()}]`:escapeRegex(ch)).join('');
const sbplString=(t:string)=>JSON.stringify(t);

/** Secret file names as SBPL regexes over absolute paths (same table as the read tool). */
function secretRegexes(){
 return {deny:SECRET_FILE_RULES.map(r=>r.match==='exact'?`/${ci(r.value)}$`:r.match==='prefix'?`/${ci(r.value)}[^/]${r.value.endsWith('.')?'+':'*'}$`:`${ci(r.value)}$`),except:SECRET_FILE_EXCEPTIONS.map(n=>`/${ci(n)}$`)};
}

interface Platform {
 readonly name:'macos-seatbelt'|'linux-bubblewrap';
 /** Wrap the shell argv in the OS sandbox for this launch. */
 wrap(argv:string[],sandbox:CommandSandbox,cwd:string):string[];
 /** Whether the sandbox itself guarantees descendants die with the leader. */
 readonly containsDescendants:boolean;
}

export interface NativeRuntimeOptions {workspaceRoot:string;stateDirectory?:string;platform?:NodeJS.Platform;hostPath?:string;home?:string;
 /** Hide secret-named project files from commands (FUTRYN_SANDBOX_HIDE_SECRETS=1). Off by default like Codex: bun/node/vite read .env themselves and fail with EPERM. */
 hideSecrets?:boolean}

/**
 * Native unified-exec runtime (ADR 0035), the Codex model: the command runs on the host under the
 * OS sandbox. macOS: `/usr/bin/sandbox-exec` with a generated profile. Linux: bubblewrap with
 * namespaces. Readable: the system, toolchains on PATH and the workspace; never other user files,
 * Futryn state or secret-named files. Writable (workspace-write): the workspace except `.git`,
 * plus a private temporary directory. Network: none unless approved for the command.
 */
export class NativeCommandRuntime implements CommandRuntime {
 readonly id:string;readonly label:string;
 private readonly platform:Platform|undefined;private readonly reason:string|undefined;
 private readonly sessions=new Map<string,NativeSession>();private readonly scratch:string;private readonly path:string;
 private proven?:RuntimeAvailability;private closed=false;
 constructor(private readonly options:NativeRuntimeOptions){
  const os=options.platform??process.platform;const home=options.home??homedir();
  this.scratch=mkdtempSync(join(tmpdir(),'fyn-exec-'));mkdirSync(join(this.scratch,'home'));mkdirSync(join(this.scratch,'tmp'));
  const pathDirs=[...new Set((options.hostPath??process.env.PATH??'').split(delimiter).filter(d=>isAbsolute(d)&&existsSync(d)))];
  this.path=[...pathDirs,'/usr/bin','/bin','/usr/sbin','/sbin'].filter((d,i,a)=>a.indexOf(d)===i).join(':');
  // Toolchains installed under the home directory (bun, nvm, cargo…) stay readable: each PATH
  // directory below home and its parent install root, resolved, never home itself.
  const real=(p:string)=>{try{return realpathSync(p);}catch{return p;}};
  const toolchains=[...new Set(pathDirs.flatMap(d=>[d,dirname(d)]).map(real).filter(d=>d.startsWith(real(home)+'/')))];
  const sbs=secretRegexes();
  if(os==='darwin'&&existsSync('/usr/bin/sandbox-exec')){
   this.platform=new Seatbelt(options.workspaceRoot,options.stateDirectory,this.scratch,real(home),toolchains,options.hideSecrets?sbs:undefined);
  }else if(os==='linux'&&findExecutable('bwrap',this.path)){
   this.platform=new Bubblewrap(findExecutable('bwrap',this.path)!,options.workspaceRoot,options.stateDirectory,this.scratch,real(home),options.hideSecrets===true);
  }else this.reason=os==='win32'?'Native Windows command sandboxing is not implemented. Nothing can run.':os==='linux'?'bubblewrap (bwrap) is not installed; install it to run commands.':`No native command sandbox for ${os}.`;
  this.label=this.platform?.name==='macos-seatbelt'?'macOS Seatbelt':this.platform?.name==='linux-bubblewrap'?'Linux bubblewrap':'no sandbox';
  this.id='native-'+(this.platform?.name??'none')+':'+createHash('sha256').update(JSON.stringify([options.workspaceRoot,options.stateDirectory,this.path,toolchains,options.hideSecrets===true,'v1'])).digest('hex').slice(0,24);
 }

 capabilities():CommandRuntimeCapabilities{return{modes:['read-only','workspace-write'],network:true,tty:true,shells:['bash','sh'],tools:[]};}

 /** One real self-test per runtime: a write inside the workspace lands, writes outside and secret reads fail. */
 availability():RuntimeAvailability{
  if(this.closed)return{ok:false,reason:'Command runtime is closed.'};
  if(!this.platform)return{ok:false,reason:this.reason!};
  if(this.proven)return this.proven;
  const probe=realpathSync(mkdtempSync(join(tmpdir(),'fyn-probe-')));
  try{
   writeFileSync(join(probe,'.env'),'PROBE_SECRET');mkdirSync(join(probe,'.git'));
   const outside=join(dirname(probe),'fyn-probe-outside-'+randomUUID());
   const probePlatform=this.platform.name==='macos-seatbelt'?new Seatbelt(probe,undefined,this.scratch,realpathSync(this.options.home??homedir()),[],secretRegexes()):this.platform;
   // The probe always checks the secret rule so a hide-secrets configuration is proven too.
   const argv=probePlatform.wrap(['/bin/bash','--noprofile','--norc','-c',`echo ok > made && ! cat .env 2>/dev/null | grep -q PROBE && ! touch .git/x 2>/dev/null && ! touch ${JSON.stringify(outside)} 2>/dev/null && ! ls ${JSON.stringify(this.options.home??homedir())} >/dev/null 2>&1 && ! kill -0 ${process.pid} 2>/dev/null && ! /usr/bin/open -g -j -a /System/Applications/Calculator.app 2>/dev/null`],{mode:'workspace-write',network:false},probe);
   const r=spawnSync(argv[0]!,argv.slice(1),{cwd:probe,env:this.env(false),timeout:10000,encoding:'utf8'});
   if(r.status!==0||readFileSync(join(probe,'made'),'utf8')!=='ok\n'||existsSync(outside)||existsSync(join(probe,'.git','x')))return{ok:false,reason:'The native sandbox self-test failed: '+(r.stderr||'').slice(0,200)};
   return this.proven={ok:true};
  }catch(error){return{ok:false,reason:'The native sandbox self-test failed: '+(error instanceof Error?error.message:'unknown')};}
  finally{rmSync(probe,{recursive:true,force:true});}
 }

 private env(tty:boolean):Record<string,string>{return{...EXEC_ENV,...(tty?{TERM:'xterm-256color',NO_COLOR:''}:{}),PATH:this.path,HOME:join(this.scratch,'home'),TMPDIR:join(this.scratch,'tmp'),BUN_INSTALL_CACHE_DIR:join(this.scratch,'tmp','bun-cache')};}

 async run(request:CommandRequest,signal?:AbortSignal):Promise<CommandOutcome>{
  if(!this.availability().ok)throw new FutrynError('UNSUPPORTED');signal?.throwIfAborted();
  if(this.sessions.size>=NATIVE_LIMITS.maxSessions)throw new FutrynError('BUDGET');
  const sandbox=request.sandbox??READ_ONLY,tty=request.tty===true,shell=request.shell??'bash';
  if(!Number.isInteger(request.timeoutMs)||request.timeoutMs<NATIVE_LIMITS.minLeaseMs||request.timeoutMs>NATIVE_LIMITS.maxLeaseMs||request.command.length>1024||request.command.includes('\u0000')||!Number.isInteger(request.maxOutputBytes)||request.maxOutputBytes<1||request.maxOutputBytes>60000||!['bash','sh'].includes(shell))throw new FutrynError('INVALID_INPUT');
  const workspace=new WorkspaceRoot(this.options.workspaceRoot);const cwd=workspace.resolve(request.cwd);if(cwd.kind!=='directory')throw new FutrynError('POLICY');
  const rel=relative(workspace.root,cwd.absolute);if(rel.startsWith('..')||isAbsolute(rel))throw new FutrynError('POLICY');
  const shellArgv=shell==='sh'?['/bin/sh',...(request.login?['-l']:[]),'-c',request.command]:['/bin/bash',...(request.login?['--login']:['--noprofile','--norc']),'-c',request.command];
  const argv=this.platform!.wrap(shellArgv,sandbox,cwd.absolute);
  const id=randomUUID();const budget=tty?request.maxOutputBytes:Math.max(1,Math.ceil(request.maxOutputBytes/2));const errBudget=Math.max(1,Math.floor(request.maxOutputBytes/2));
  let resolveDone!:()=>void;const done=new Promise<void>(r=>{resolveDone=r;});
  const s:NativeSession={id,request,sandbox,tty,start:Date.now(),done,ended:false,exitCode:null,signal:null,busy:true,observer:request.onOutput,budgets:{stdout:budget,stderr:errBudget},buffers:{stdout:new HeadTailBuffer(budget),stderr:new HeadTailBuffer(errBudget)},streamed:{stdout:0,stderr:0},outputClosed:false,leaderStarted:false};
  const output=(stream:'stdout'|'stderr',bytes:Buffer)=>{s.buffers[stream].push(bytes);const limit=tty?request.maxOutputBytes:errBudget;if(s.streamed[stream]<limit){const text=new TextDecoder().decode(bytes.subarray(0,limit-s.streamed[stream]));s.streamed[stream]+=bytes.length;try{s.observer?.({stream,text});}catch{s.observer=undefined;}}};
  const exited=(code:number|null,sig:string|null)=>{if(s.exitObserved)return;s.exitObserved=true;s.exitCode=code;s.signal=sig;
   // Output held open by a descendant must not hold the result forever (Codex POST_EXIT_CLOSE_WAIT_CAP spirit).
   const settle=()=>{if(s.ended)return;s.ended=true;clearTimeout(s.lease);resolveDone();};
   if(s.outputClosed)settle();else setTimeout(settle,1000);};
  try{
   if(tty){
    const child=Bun.spawn(argv,{cwd:cwd.absolute,env:this.env(true),terminal:{cols:120,rows:40,data:(_t,data)=>output('stdout',Buffer.from(data))}});
    s.bun=child;s.pid=child.pid;s.leaderStarted=true;
    child.exited.then(()=>{setTimeout(()=>{s.outputClosed=true;exited(child.exitCode,typeof child.signalCode==="string"?child.signalCode:null);},100);});
   }else{
    const child=spawn(argv[0]!,argv.slice(1),{cwd:cwd.absolute,env:this.env(false),stdio:['pipe','pipe','pipe'],detached:true});
    s.node=child;s.pid=child.pid;child.stdin!.on('error',()=>{});
    child.stdout!.on('data',b=>output('stdout',b));child.stderr!.on('data',b=>output('stderr',b));
    child.once('spawn',()=>{s.leaderStarted=true;});
    child.once('error',()=>{s.spawnFailed=true;s.outputClosed=true;exited(null,null);});
    child.once('exit',(code,sig)=>exited(code,sig));
    child.once('close',()=>{s.outputClosed=true;if(s.exitObserved&&!s.ended){s.ended=true;clearTimeout(s.lease);resolveDone();}});
   }
  }catch{throw new FutrynError('UNSUPPORTED');}
  s.lease=setTimeout(()=>{void this.stop(s,'timeout');},request.timeoutMs);
  this.sessions.set(id,s);
  const abort=()=>{void this.stop(s,'cancelled');};signal?.addEventListener('abort',abort,{once:true});s.release=()=>signal?.removeEventListener('abort',abort);
  try{return await this.collect(s,request.yieldTimeMs??request.timeoutMs+2500,signal);}finally{s.busy=false;}
 }

 /** Stop the whole process group (pipes: detached group; PTY: its session). Escalates to SIGKILL. */
 private async stop(s:NativeSession,reason:'cancelled'|'timeout'){
  if(s.ended||s.stop)return s.done;s.stop=reason;
  const group=(sig:NodeJS.Signals)=>{try{if(s.pid)process.kill(-s.pid,sig);}catch{try{s.node?.kill(sig);s.bun?.kill(sig);}catch{/* gone */}}};
  group('SIGTERM');const kill=setTimeout(()=>group('SIGKILL'),500);
  await Promise.race([s.done,new Promise(r=>setTimeout(r,2500))]);clearTimeout(kill);
  if(!s.ended){group('SIGKILL');s.ended=true;s.unconfirmed=true;}
  return s.done;
 }

 private outcome(s:NativeSession):CommandOutcome{
  const kind:CommandOutcome['kind']=!s.ended?'running':s.spawnFailed?'spawn-failed':s.unconfirmed?'unconfirmed':s.stop==='timeout'?'timeout':s.stop==='cancelled'?'cancelled':'exited';
  const output=s.buffers.stdout.text()+(s.buffers.stderr.totalBytes?'\n[stderr]\n'+s.buffers.stderr.text():'');
  const exitCode=kind==='exited'?s.exitCode:null;
  const descendants=!s.ended?'unconfirmed':this.platform?.containsDescendants?'terminated':'unconfirmed';
  return{kind,...(s.ended?{}:{sessionId:s.id}),...(kind==='spawn-failed'?{sandboxFailed:true}:{}),...(kind==='exited'&&likelySandboxDenied(exitCode,output)?{sandboxDenied:true}:{}),
   exitCode,signal:kind==='exited'?s.signal:s.stop?'SIGTERM':null,output,omittedBytes:s.buffers.stdout.omittedBytes+s.buffers.stderr.omittedBytes,durationMs:Date.now()-s.start,
   lifecycle:{leader:s.spawnFailed?'not-started':s.ended?'exited':'unconfirmed',stopRequested:!!s.stop,output:s.outputClosed?'closed':'cut-off',descendants:s.spawnFailed?'not-started':descendants}};
 }

 private async collect(s:NativeSession,yieldMs:number,signal?:AbortSignal):Promise<CommandOutcome>{
  const abort=()=>{void this.stop(s,'cancelled');};if(signal?.aborted)await this.stop(s,'cancelled');else signal?.addEventListener('abort',abort,{once:true});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!s.ended)await Promise.race([s.done,new Promise<void>(r=>{timer=setTimeout(r,yieldMs);})]);
   if(signal?.aborted)await this.stop(s,'cancelled');
   const result=this.outcome(s);
   // Codex: each call reports output produced since the previous call on this session.
   s.buffers={stdout:new HeadTailBuffer(s.budgets.stdout),stderr:new HeadTailBuffer(s.budgets.stderr)};s.streamed={stdout:0,stderr:0};
   if(s.ended){s.release?.();this.sessions.delete(s.id);}
   return result;
  }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);s.observer=undefined;}
 }

 session(id:string):CommandSessionInfo|undefined{const s=this.sessions.get(id);return s?{cwd:s.request.cwd,command:s.request.command,tty:s.tty,sandbox:{...s.sandbox}}:undefined;}
 resize(id:string,cols:number,rows:number):void{const s=this.sessions.get(id);if(!s||!s.tty||s.ended||!Number.isInteger(cols)||cols<10||cols>1000||!Number.isInteger(rows)||rows<5||rows>500)throw new FutrynError('POLICY');s.bun?.terminal?.resize(cols,rows);}
 async writeStdin(id:string,chars:string,yieldTimeMs:number,signal?:AbortSignal,interrupt?:'SIGINT'|'SIGTERM',onOutput?:(chunk:CommandOutputChunk)=>void):Promise<CommandOutcome>{
  const s=this.sessions.get(id);
  if(!s||s.busy||this.closed||chars.length>NATIVE_LIMITS.maxStdinChars||chars.includes('\u0000')||!Number.isInteger(yieldTimeMs)||yieldTimeMs<0||yieldTimeMs>30000||(s.ended&&(chars||interrupt)))throw new FutrynError('POLICY');
  s.busy=true;s.observer=onOutput;
  try{signal?.throwIfAborted();
   if(interrupt==='SIGTERM')await this.stop(s,'cancelled');
   else if(interrupt==='SIGINT'||(!s.tty&&chars==='\u0003')){if(s.tty)s.bun?.terminal?.write('\u0003');else try{process.kill(-s.pid!,'SIGINT');}catch{/* gone */}}
   else if(chars&&!s.ended){if(s.tty)s.bun?.terminal?.write(chars);else s.node?.stdin?.write(chars);}
   return await this.collect(s,yieldTimeMs,signal);
  }finally{s.busy=false;}
 }
 async shutdown():Promise<void>{this.closed=true;await Promise.all([...this.sessions.values()].map(s=>this.stop(s,'cancelled')));this.sessions.clear();rmSync(this.scratch,{recursive:true,force:true});}
}

interface NativeSession {id:string;request:CommandRequest;sandbox:CommandSandbox;tty:boolean;start:number;done:Promise<void>;ended:boolean;exitCode:number|null;signal:string|null;busy:boolean;
 observer?:(chunk:CommandOutputChunk)=>void;budgets:{stdout:number;stderr:number};buffers:{stdout:HeadTailBuffer;stderr:HeadTailBuffer};streamed:{stdout:number;stderr:number};
 outputClosed:boolean;leaderStarted:boolean;exitObserved?:boolean;spawnFailed?:boolean;unconfirmed?:boolean;stop?:'cancelled'|'timeout';lease?:ReturnType<typeof setTimeout>;release?:()=>void;
 pid?:number;node?:ChildProcess;bun?:ReturnType<typeof Bun.spawn>}

/** Codex base-policy sysctl allow-list (seatbelt_base_policy.sbpl, pinned 75fc67e8). */
const SYSCTLS='(sysctl-name "hw.activecpu") (sysctl-name "hw.busfrequency_compat") (sysctl-name "hw.byteorder") (sysctl-name "hw.cacheconfig") (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.cpufamily") (sysctl-name "hw.cpufrequency_compat") (sysctl-name "hw.cputype") (sysctl-name "hw.l1dcachesize_compat") (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat") (sysctl-name "hw.l3cachesize_compat") (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine") (sysctl-name "hw.model") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.nperflevels") (sysctl-name "hw.packages") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.pagesize") (sysctl-name "hw.physicalcpu") (sysctl-name "hw.physicalcpu_max") (sysctl-name "hw.logicalcpu") (sysctl-name "hw.cpufrequency") (sysctl-name "hw.tbfrequency_compat") (sysctl-name "hw.vectorunit") (sysctl-name "machdep.cpu.brand_string") (sysctl-name "kern.argmax") (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.maxproc") (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status") (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.sysv.semmns") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version") (sysctl-name "sysctl.proc_cputype") (sysctl-name "vm.loadavg") (sysctl-name-prefix "hw.optional.arm.") (sysctl-name-prefix "hw.optional.armv8_") (sysctl-name-prefix "hw.perflevel") (sysctl-name-prefix "kern.proc.pgrp.") (sysctl-name-prefix "kern.proc.pid.") (sysctl-name-prefix "net.routetable.")';

function findExecutable(name:string,path:string){for(const dir of path.split(':')){const c=join(dir,name);try{if(statSync(c).isFile())return c;}catch{/* next */}}return undefined;}

/**
 * macOS Seatbelt profile, modelled on Codex `sandboxing/src/seatbelt.rs` + base policy: reads are
 * allowed broadly but user home directories are denied except toolchains and the workspace; writes
 * only to the workspace (workspace-write) and a private temp dir; `.git`, Futryn state and secret
 * names are denied last so they win.
 */
class Seatbelt implements Platform {
 readonly name='macos-seatbelt' as const;readonly containsDescendants=false;
 constructor(private readonly workspace:string,private readonly state:string|undefined,private readonly scratch:string,private readonly home:string,private readonly toolchains:string[],private readonly secrets:{deny:string[];except:string[]}|undefined){}
 profile(sandbox:CommandSandbox):string{
  const ws=this.workspace,wsRe=escapeRegex(ws);
  return [
   '(version 1)','(deny default)',
   // Codex seatbelt_base_policy.sbpl + preferences policy (pinned 75fc67e8): no blanket mach-lookup,
   // so LaunchServices/AppleEvents/pasteboard (e.g. `open -a`) cannot start anything outside the sandbox.
   '(allow process-exec process-fork)','(allow signal (target same-sandbox))','(allow process-info* (target same-sandbox))',
   `(allow sysctl-read ${SYSCTLS})`,'(allow sysctl-write (sysctl-name "kern.grade_cputype"))',
   '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
   '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.PowerManagement.control") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (local-name "com.apple.cfprefsd.agent"))',
   '(allow ipc-posix-sem)','(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))',
   '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))','(allow user-preference-read)',
   // Terminals: only this session's own PTY (sandbox extension) and /dev/tty; ioctl on inherited fds.
   '(allow pseudo-tty)','(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
   '(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))','(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))',
   '(allow file-read*)',
   `(deny file-read* (subpath "/Users") (subpath ${sbplString(this.home)}) (subpath "/Volumes"))`,
   `(allow file-read-metadata (literal "/Users") (path-ancestors ${sbplString(ws)}))`,
   `(allow file-read* (subpath ${sbplString(ws)}) ${this.toolchains.map(t=>`(subpath ${sbplString(t)})`).join(' ')} (subpath ${sbplString(this.scratch)}))`,
   `(allow file-write* (subpath ${sbplString(join(this.scratch,'tmp'))}) (subpath ${sbplString(join(this.scratch,'home'))}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
   ...(sandbox.mode==='workspace-write'?[`(allow file-write* (subpath ${sbplString(ws)}) (subpath "/private/tmp"))`,`(deny file-write* (regex #"^${wsRe}/(.*/)?\\.[gG][iI][tT](/|$)"))`]:[]),
   // .git/config stays readable (git fails without it, as in Codex); URL credentials are redacted from output instead.
   `(deny file-read* file-write* (regex #"^${wsRe}/(.*/)?\\.(futryn|hannes)(/|$)") (regex #"^${wsRe}/(.*/)?\\.(futryn|hannes)-patch-"))`,
   ...(this.state?[`(deny file-read* file-write* (subpath ${sbplString(this.state)}))`]:[]),
   // Optional: secret names hidden inside the project only; system files such as /etc/ssl/cert.pem stay readable.
   ...(this.secrets?[`(deny file-read* file-write* (require-all (regex #"^${wsRe}/") (require-any ${this.secrets.deny.map(r=>`(regex #"${r}")`).join(' ')}) ${this.secrets.except.map(r=>`(require-not (regex #"${r}"))`).join(' ')}))`]:[]),
   ...(sandbox.network?['(allow network*)','(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
    // Codex seatbelt_network_policy.sbpl, only for an approved network escalation.
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.SecurityServer") (global-name "com.apple.networkd") (global-name "com.apple.ocspd") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.dnssd.service"))']:['(deny network*)']),
  ].join('\n');
 }
 wrap(argv:string[],sandbox:CommandSandbox):string[]{return['/usr/bin/sandbox-exec','-p',this.profile(sandbox),...argv];}
}

/**
 * Linux bubblewrap, modelled on Codex `sandboxing/src/bwrap.rs`: read-only root, writable
 * workspace bind (workspace-write), read-only `.git`, home hidden behind tmpfs, masked secrets and
 * state, private /tmp, PID namespace with die-with-parent, and no network namespace unless approved.
 * IMPLEMENTED — NOT TESTED on a Linux host (ADR 0035).
 */
class Bubblewrap implements Platform {
 readonly name='linux-bubblewrap' as const;readonly containsDescendants=true;
 constructor(private readonly bwrap:string,private readonly workspace:string,private readonly state:string|undefined,private readonly scratch:string,private readonly home:string,private readonly hideSecrets:boolean){}
 wrap(argv:string[],sandbox:CommandSandbox,cwd:string):string[]{
  const ws=new WorkspaceRoot(this.workspace);
  const masks=scanExecutionMasks(ws,(path,directory)=>{const name=path.toLowerCase().split('/').at(-1)!;if(name==='.git')return path==='.git'&&directory?'read-only':'hide';if(name==='.futryn'||name==='.hannes'||name.startsWith('.futryn-patch-')||name.startsWith('.hannes-patch-'))return 'hide';const d=evaluateRead(path,join(ws.root,path),{stateDirectory:this.state});return d.effect==='deny'||(this.hideSecrets&&d.effect==='ask'&&!directory)?'hide':'keep';});
  return [this.bwrap,'--die-with-parent','--new-session','--unshare-pid','--unshare-ipc',...(sandbox.network?[]:['--unshare-net']),
   '--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--tmpfs',this.home,
   '--bind',join(this.scratch,'home'),join(this.scratch,'home'),'--bind',join(this.scratch,'tmp'),join(this.scratch,'tmp'),
   sandbox.mode==='workspace-write'?'--bind':'--ro-bind',ws.root,ws.root,
   ...masks.readOnly.flatMap(p=>['--ro-bind',join(ws.root,p),join(ws.root,p)]),
   // Same as the Docker mask: git works with an empty repository config, credentials stay hidden.
   ...masks.readOnly.flatMap(p=>['config','config.worktree'].filter(f=>existsSync(join(ws.root,p,f))).flatMap(f=>['--ro-bind','/dev/null',join(ws.root,p,f)])),
   ...masks.hiddenFiles.flatMap(p=>['--ro-bind','/dev/null',join(ws.root,p)]),
   ...masks.hiddenDirectories.flatMap(p=>['--tmpfs',join(ws.root,p),'--remount-ro',join(ws.root,p)]),
   ...(this.state&&!this.state.startsWith(ws.root+'/')?['--tmpfs',this.state]:[]),
   '--chdir',cwd,'--',...argv];
 }
}
