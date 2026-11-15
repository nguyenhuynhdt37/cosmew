/** Independent test-only observation. Never used by production signalling. */
import {spawnSync} from 'node:child_process';
export interface Observation {pid:number;ppid:number;group:number;state:string;started:string;command:string}
export function observe():Observation[]{
 const result=spawnSync('/bin/ps',['-A','-o','pid=,ppid=,pgid=,stat=,lstart=,command='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024*1024});
 if(result.status!==0)throw new Error('Independent ps observation failed');
 return result.stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/.exec(line);return match?[{pid:Number(match[1]),ppid:Number(match[2]),group:Number(match[3]),state:match[4]!,started:match[5]!,command:match[6]!}]:[];});
}
export const live=(p:Observation)=>!p.state.startsWith('Z');
export const same=(a:Observation,b:Observation)=>a.pid===b.pid&&a.started===b.started&&a.command===b.command;
export function current(original:Observation):Observation|undefined{return observe().find(p=>same(original,p)&&live(p));}
export async function waitFor<T>(check:()=>T|undefined,ms=2500):Promise<T>{const until=Date.now()+ms;do{const result=check();if(result!==undefined)return result;await Bun.sleep(15);}while(Date.now()<until);throw new Error('Bounded process observation timed out');}
/** Disposable fixtures sleep only a few seconds; check identity again before scoped cleanup. */
export async function dispose(records:Observation[]):Promise<void>{
 for(const record of records){if(current(record))try{process.kill(record.pid,'SIGKILL');}catch{/* exited */}}
 await waitFor(()=>records.every(record=>!current(record))?true:undefined);
}
