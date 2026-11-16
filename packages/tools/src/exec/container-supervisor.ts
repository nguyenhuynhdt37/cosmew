/** Trusted PID1 program in the pinned image. Child output is data, never control metadata. */
export const CONTAINER_SUPERVISOR=String.raw`
const {spawn}=require('node:child_process');
const signals=require('node:os').constants.signals;
let finishing=false, observedExit=false, closed=0, result;
const finish=(value,status)=>{
 if(finishing)return;
 finishing=true;
 const final={type:'result',...value,outputClosed:closed===2,wrapperExitCode:status};
 // A dead owner or blocked output cannot remove the hard lifetime boundary.
 setTimeout(()=>process.exit(status),250);
 process.stdout.write(JSON.stringify(final)+'\n',()=>process.exit(status));
};
const lease=Number(process.argv[1]);
if(!Number.isInteger(lease)||lease<1000||lease>120000)process.exit(126);
setTimeout(()=>finish({kind:'timeout',exitCode:null,signal:null},124),lease);
process.on('SIGINT',()=>finish({kind:'cancelled',exitCode:null,signal:'SIGINT'},130));
process.on('SIGTERM',()=>finish({kind:'cancelled',exitCode:null,signal:'SIGTERM'},143));
const child=spawn('/usr/bin/setpriv',[
 '--reuid=65534','--regid=65534','--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all',
 '/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp','LANG=C','TERM=dumb','NO_COLOR=1',
 '/bin/bash','--noprofile','--norc','-c',process.argv[2],'futryn-command'
],{cwd:process.argv[3],stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);
child.stdin.on('error',()=>{});
for(const stream of ['stdout','stderr']){
 const readable=child[stream];
 let blocked=false;
 const pump=()=>{
  if(blocked)return;
  let chunk;
  while((chunk=readable.read(Math.min(16384,Math.max(1,readable.readableLength))))!==null){
   const frame=JSON.stringify({type:'data',stream,data:chunk.toString('base64')})+'\n';
   if(!process.stdout.write(frame)){blocked=true;process.stdout.once('drain',()=>{blocked=false;pump();});return;}
  }
 };
 readable.on('readable',pump);
 readable.on('close',()=>{closed++;if(observedExit&&closed===2)finish(result.value,result.status);});
}
child.on('error',()=>finish({kind:'spawn-failed',exitCode:null,signal:null},126));
child.on('exit',(code,signal)=>{
 observedExit=true;
 result={value:{kind:'exited',exitCode:code,signal:signal??null},status:code??(128+(signals[signal]??0))};
 if(closed===2)finish(result.value,result.status);
 else setTimeout(()=>finish(result.value,result.status),1000);
});
`;
