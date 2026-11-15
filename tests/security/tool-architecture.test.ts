import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionGrants} from '@hannes/security';
import {WorkspaceRoot} from '@hannes/workspace';
import {ToolDispatcher, type CommandRuntime, type ToolAuditRecord} from '@hannes/tools';
import {ToolRegistry} from '../../packages/tools/src/registry';
import {ToolRouter} from '../../packages/tools/src/router';
import {createHandlers} from '../../packages/tools/src/handlers';
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'hannes-routing-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'file.txt'),'marker');writeFileSync(join(root,'.env'),'private');
 const audit:ToolAuditRecord[]=[];let prompts=0,runs=0,ready=true;
 const commands:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>ready ? {ok:true} : {ok:false,reason:'closed'},run:async()=>{runs++;return{kind:'exited',exitCode:0,signal:null,output:'ok',omittedBytes:0,durationMs:0};}};
 const options={workspace:new WorkspaceRoot(root),grants:new SessionGrants(),commands,redact:(s:string)=>s,audit:(r:ToolAuditRecord)=>audit.push(r),approve:async()=>{prompts++;return 'deny' as const;}};
 return{root,options,audit,runs:()=>runs,prompts:()=>prompts,disable:()=>{ready=false;}};
}
test('registry rejects duplicate identities, owns descriptor snapshots and routes only exposed available entries',()=>{
 const f=fixture(),registry=new ToolRegistry();const handlers=createHandlers(f.options);
 for(const handler of handlers)registry.register(handler);
 expect(()=>registry.register(handlers[0]!)).toThrow();
 expect(registry.descriptors().map(d=>d.name)).toEqual(['read','glob','grep','exec_command','apply_patch']);
 const descriptor=registry.descriptors()[0]!;descriptor.name='shell';descriptor.inputSchema.type='anything';
 expect(registry.descriptors()[0]).toMatchObject({name:'read',inputSchema:{type:'object'}});
 const router=new ToolRouter(registry);
 expect(router.resolve('read')).toHaveProperty('handler');
 for(const name of ['shell','bash','functions.read','constructor','__proto__'])expect(router.resolve(name)).toMatchObject({status:'error',code:'UNKNOWN_TOOL'});
 f.disable();expect(registry.descriptors().some(d=>d.name==='exec_command')).toBe(false);
 expect(router.resolve('exec_command')).toMatchObject({code:'SANDBOX_UNAVAILABLE'});
 const hidden=new ToolRegistry();hidden.register(handlers[0]!,false);
 expect(hidden.descriptors()).toEqual([]);expect(new ToolRouter(hidden).resolve('read')).toMatchObject({code:'UNKNOWN_TOOL'});
});
test('exposure does not authorize reads or commands, and duplicate payloads with fresh IDs recheck grants',async()=>{
 const f=fixture(),tools=new ToolDispatcher(f.options);
 for(const name of ['read','exec_command']){
  const input=name==='read'?{path:'.env'}:{cmd:'echo ok'};
  for(let i=0;i<2;i++)expect(await tools.invoke({id:crypto.randomUUID(),name,input})).toMatchObject({status:'denied'});
 }
 expect(f.prompts()).toBe(4);expect(f.runs()).toBe(0);
 expect(f.audit.filter(r=>r.phase==='requested')).toHaveLength(4);
 expect(f.audit.filter(r=>r.phase==='completed')).toHaveLength(4);
});
test('concurrent duplicate call IDs cannot prompt or execute twice; cancellation completes audit without granting',async()=>{
 const f=fixture();let release!:(value:'session')=>void;
 const tools=new ToolDispatcher({...f.options,approve:()=>new Promise(resolve=>{release=resolve;})});
 const call={id:'same-call',name:'read',input:{path:'.env'}};const abort=new AbortController();
 const first=tools.invoke(call,abort.signal);
 expect(await tools.invoke(call)).toMatchObject({code:'DUPLICATE_CALL',status:'error'});
 abort.abort();release('session');await expect(first).rejects.toThrow();
 expect(f.options.grants.list()).toEqual([]);
 expect(f.audit.some(r=>r.phase==='completed'&&r.code==='CANCELLED')).toBe(true);
});
test('runtime availability and policy identity are rechecked after command approval',async()=>{
 const f=fixture();const tools=new ToolDispatcher({...f.options,approve:async()=>{f.disable();return 'once';}});
 expect(await tools.invoke({id:'gate',name:'exec_command',input:{cmd:'echo ok'}})).toMatchObject({code:'SANDBOX_UNAVAILABLE'});
 expect(f.runs()).toBe(0);
 const g=fixture();const changed=new ToolDispatcher({...g.options,approve:async()=>{Object.assign(g.options.commands,{id:'changed-policy'});return 'once';}});
 expect(await changed.invoke({id:'policy',name:'exec_command',input:{cmd:'echo ok'}})).toMatchObject({status:'denied'});
 expect(g.runs()).toBe(0);
});

test('revocation before a read starts wins over exposure and a previously valid session grant',async()=>{
 const f=fixture(),tools=new ToolDispatcher(f.options);
 f.options.grants.grant('fs.read',join(f.options.workspace.root,'.env'));
 const pending=tools.invoke({id:'revoked',name:'read',input:{path:'.env'}});
 f.options.grants.clear();
 expect(await pending).toMatchObject({status:'denied',code:'DENIED'});
 expect(f.prompts()).toBe(0);
});
test('grep cancellation stops its worker and settles audit, and completed IDs do not cache authority',async()=>{
 const f=fixture(),tools=new ToolDispatcher(f.options),abort=new AbortController();
 const pending=tools.invoke({id:'search',name:'grep',input:{pattern:'marker'}},abort.signal);
 abort.abort();await expect(pending).rejects.toMatchObject({code:'CANCELLED'});
 expect(f.audit.filter(r=>r.callId==='search'&&r.phase==='completed')).toEqual([expect.objectContaining({code:'CANCELLED'})]);
 expect(await tools.invoke({id:'search',name:'read',input:{path:'.env'}})).toMatchObject({status:'denied'});
 expect(f.prompts()).toBe(1);
});

test('duplicate exec IDs cannot launch a second process while the first runtime is active',async()=>{
 const f=fixture();let runs=0,release!:()=>void,started!:()=>void;
 const launched=new Promise<void>(resolve=>{started=resolve;});
 f.options.commands.run=async()=>{runs++;started();await new Promise<void>(resolve=>{release=resolve;});return{kind:'exited',exitCode:0,signal:null,output:'done',omittedBytes:0,durationMs:1};};
 const tools=new ToolDispatcher({...f.options,approve:async()=> 'once'});
 const call={id:'exec-duplicate',name:'exec_command',input:{cmd:'echo ok'}};
 const first=tools.invoke(call);await launched;
 expect(await tools.invoke(call)).toMatchObject({code:'DUPLICATE_CALL'});
 expect(runs).toBe(1);release();expect(await first).toMatchObject({status:'ok',callId:call.id,exitCode:0});
});
