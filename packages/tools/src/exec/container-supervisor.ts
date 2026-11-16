/**
 * Trusted PID1 program in the pinned image (ADR 0032/0034). Child output is data, never control
 * metadata. Host → supervisor control is framed JSON lines on stdin; child text cannot reach it.
 *
 * argv[1] is one JSON launch record: {lease, command, cwd, uid, gid, tty, cols, rows, shell, login}.
 * The supervisor validates it, drops to the unprivileged uid with no capabilities, and launches the
 * shell either on pipes (node:child_process) or on a pseudo-terminal it allocates inside the
 * namespace (Bun `terminal` spawn option). Both paths share the lease, framing and receipts.
 */
export const CONTAINER_SUPERVISOR=String.raw`
const {spawn}=require('node:child_process');
const signals=require('node:os').constants.signals;
let launch;try{launch=JSON.parse(process.argv[1]);}catch{process.exit(126);}
const int=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
if(!launch||typeof launch.command!=='string'||typeof launch.cwd!=='string'||!launch.cwd.startsWith('/')||!int(launch.lease,1000,1800000)||!int(launch.uid,1,4294967294)||!int(launch.gid,1,4294967294)||typeof launch.tty!=='boolean'||!['bash','sh'].includes(launch.shell)||typeof launch.login!=='boolean'||(launch.tty&&(!int(launch.cols,10,1000)||!int(launch.rows,5,500))))process.exit(126);
let finishing=false, observedExit=false, closed=0, result, child, term;
const streams=launch.tty?1:2;
const finish=(value,status)=>{
 if(finishing)return;
 finishing=true;
 const final={type:'result',...value,outputClosed:closed>=streams&&!dropped,wrapperExitCode:status};
 // A dead owner or blocked output cannot remove the hard lifetime boundary.
 setTimeout(()=>process.exit(status),250);
 while(pending.length)process.stdout.write(pending.shift());
 process.stdout.write(JSON.stringify(final)+'\n',()=>process.exit(status));
};
setTimeout(()=>finish({kind:'timeout',exitCode:null,signal:null},124),launch.lease);
process.on('SIGINT',()=>finish({kind:'cancelled',exitCode:null,signal:'SIGINT'},130));
process.on('SIGTERM',()=>finish({kind:'cancelled',exitCode:null,signal:'SIGTERM'},143));
// While another write-capable session runs, it could move a protected file between the host's mask
// scan and these mounts. Masks follow the files once mounted, so verify now, before any command
// runs: every protected entry under /workspace must itself be a mountpoint (ADR 0034).
const aborted=!!launch.verify&&!verifyMasks(launch.verify);
if(aborted){finishing=true;process.stdout.write(JSON.stringify({type:'result',kind:'spawn-failed',exitCode:null,signal:null,outputClosed:true,wrapperExitCode:125})+'\n',()=>process.exit(125));setTimeout(()=>process.exit(125),250);}
function verifyMasks(v){
 const fs=require('node:fs');
 let mounts;try{mounts=new Set(fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(Boolean).map(l=>l.split(' ')[4].replace(/\\([0-7]{3})/g,(_m,o)=>String.fromCharCode(parseInt(o,8)))));}catch{return false;}
 const secret=v.secret.map(r=>new RegExp(r,'i')),except=v.except.map(r=>new RegExp(r,'i'));let entries=0;
 const walk=dir=>{
  let list;try{list=fs.readdirSync(dir,{withFileTypes:true});}catch{return false;}
  for(const e of list){
   if(++entries>250000)return false;
   const path=dir+'/'+e.name,rel=path.slice('/workspace/'.length),name=e.name.toLowerCase();
   if(e.isSymbolicLink())continue;
   const protectedEntry=(name==='.git'&&!(rel==='.git'&&v.gitPinned))||name==='.futryn'||name==='.hannes'||name.startsWith('.futryn-patch-')||name.startsWith('.hannes-patch-')||v.hidden.includes(rel)||(!e.isDirectory()&&secret.some(r=>r.test(name))&&!except.some(r=>r.test(name)));
   if(protectedEntry){if(!mounts.has(path))return false;continue;}
   if(rel==='.git'){for(const f of ['config','config.worktree'])if(fs.existsSync(path+'/'+f)&&!mounts.has(path+'/'+f))return false;continue;}
   if(e.isDirectory()&&!mounts.has(path)&&!walk(path))return false;
  }
  return true;
 };
 return walk('/workspace');
}
// Codex UNIFIED_EXEC_ENV, adjusted for a terminal when one exists. Nothing is inherited from the host.
const env=['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp','LANG=C.UTF-8','LC_CTYPE=C.UTF-8','LC_ALL=C.UTF-8','PAGER=cat','GIT_PAGER=cat','GH_PAGER=cat','GIT_OPTIONAL_LOCKS=0','CODEX_CI=1','FUTRYN_SANDBOX=1',...(launch.tty?['TERM=xterm-256color']:['TERM=dumb','NO_COLOR=1','COLORTERM='])];
const shell=launch.shell==='sh'?['/bin/sh']:['/bin/bash','--noprofile','--norc'];
// A login shell reads only the image's read-only /etc/profile (HOME is the private /tmp).
const argv=['/usr/bin/setpriv','--reuid='+launch.uid,'--regid='+launch.gid,'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all',
 '/usr/bin/env','-i',...env,...(launch.login?(launch.shell==='sh'?['/bin/sh','-l']:['/bin/bash','--login']):shell),'-c',launch.command,'futryn-command'];
const frame=(stream,chunk)=>JSON.stringify({type:'data',stream,data:Buffer.from(chunk).toString('base64')})+'\n';
// A PTY master cannot be paused, so its frames queue while the host transport is blocked. The
// queue is bounded; beyond it bytes are dropped and the receipt reports output as cut off.
let blocked=false,queued=0,dropped=false;const pending=[];
const flush=()=>{blocked=false;while(pending.length){const next=pending.shift();queued-=next.length;if(!process.stdout.write(next)){blocked=true;process.stdout.once('drain',flush);return;}}};
const emit=(stream,chunk)=>{const line=frame(stream,chunk);if(blocked){if(queued+line.length>8388608){dropped=true;return;}pending.push(line);queued+=line.length;return;}if(!process.stdout.write(line)){blocked=true;process.stdout.once('drain',flush);}};
const exited=(code,signal)=>{
 observedExit=true;
 result={value:{kind:'exited',exitCode:code,signal:signal??null},status:code??(128+(signals[signal]??0))};
 if(closed>=streams)finish(result.value,result.status);
 else setTimeout(()=>finish(result.value,result.status),1000);
};
if(aborted){/* nothing runs */}else if(launch.tty){
 try{
  child=Bun.spawn(argv,{cwd:launch.cwd,terminal:{cols:launch.cols,rows:launch.rows,data(_t,data){emit('stdout',data);}}});
  term=child.terminal;
 }catch{finish({kind:'spawn-failed',exitCode:null,signal:null},126);}
 if(child)child.exited.then(()=>{
  // The PTY master reads remaining output for a bounded drain, then counts as closed.
  setTimeout(()=>{closed=streams;exited(child.exitCode,child.signalCode);},100);
 });
}else{
 child=spawn(argv[0],argv.slice(1),{cwd:launch.cwd,stdio:['pipe','pipe','pipe'],detached:true});
 child.stdin.on('error',()=>{});
 for(const stream of ['stdout','stderr']){
  const readable=child[stream];
  let paused=false;
  const pump=()=>{
   if(paused)return;
   let chunk;
   while((chunk=readable.read(Math.min(16384,Math.max(1,readable.readableLength))))!==null){
    const line=frame(stream,chunk);
    if(!process.stdout.write(line)){paused=true;process.stdout.once('drain',()=>{paused=false;pump();});return;}
   }
  };
  readable.on('readable',pump);
  readable.on('close',()=>{closed++;if(observedExit&&closed>=streams)finish(result.value,result.status);});
 }
 child.on('error',()=>finish({kind:'spawn-failed',exitCode:null,signal:null},126));
 child.on('exit',exited);
}
// Host control frames: input bytes, resize, interrupt of the session's own process group, EOF.
let wire='';
process.stdin.on('data',bytes=>{
 wire+=bytes.toString('utf8');
 for(;;){
  const end=wire.indexOf('\n');if(end<0){if(wire.length>65536)wire='';break;}
  const line=wire.slice(0,end);wire=wire.slice(end+1);
  let f;try{f=JSON.parse(line);}catch{continue;}
  if(!child||finishing)continue;
  if(f.t==='in'&&typeof f.d==='string'&&f.d.length<=16384){const data=Buffer.from(f.d,'base64');if(term)term.write(data);else child.stdin.write(data);}
  else if(f.t==='rs'&&term&&int(f.c,10,1000)&&int(f.r,5,500))term.resize(f.c,f.r);
  else if(f.t==='int'){if(term)term.write('\x03');else{try{process.kill(-child.pid,'SIGINT');}catch{}}}
  else if(f.t==='eof'&&!term)child.stdin.end();
 }
});
process.stdin.on('error',()=>{});
`;
