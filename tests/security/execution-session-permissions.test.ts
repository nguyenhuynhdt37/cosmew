import {test,expect,afterEach} from 'bun:test';import {mkdtempSync,realpathSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ToolDispatcher,platformCommandRuntime} from '@futryn/tools';import {WorkspaceRoot} from '@futryn/workspace';import {Redactor,SessionGrants} from '@futryn/security';import type {CommandRuntime,CommandOutcome} from '@futryn/contracts';
const cleanup:string[]=[];afterEach(()=>{for(const path of cleanup.splice(0))rmSync(path,{recursive:true,force:true});});
const exited:CommandOutcome={kind:'exited',exitCode:0,signal:null,output:'done',omittedBytes:0,durationMs:1};
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'fyn-session-permission-')));cleanup.push(root);return root;}
test('command session grants bind the hard deadline and revocation still requires a current decision',async()=>{
 const root=fixture(),grants=new SessionGrants();let prompts=0,runs=0;const runtime:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>({ok:true}),run:async()=>{runs++;return exited;}};
 const dispatcher=new ToolDispatcher({workspace:new WorkspaceRoot(root),grants,commands:runtime,redact:s=>s,approve:async()=>{prompts++;return'session';}});
 for(const timeout of [1000,1000,2000])expect((await dispatcher.invoke({id:crypto.randomUUID(),name:'exec_command',input:{cmd:'echo test',timeout_ms:timeout}})).status).toBe('ok');expect(prompts).toBe(2);grants.clear();await dispatcher.invoke({id:crypto.randomUUID(),name:'exec_command',input:{cmd:'echo test',timeout_ms:1000}});expect(prompts).toBe(3);expect(runs).toBe(4);
});
test('stdin under a drifted sandbox requires a distinct current scope, and expiry while approving sends nothing',async()=>{
 // Codex stdin_approval: input needs review only when the launch policy differs from the current one.
 const root=fixture(),id=crypto.randomUUID();let expired=false,writes=0;const scopes:string[]=[];const runtime:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>({ok:true}),run:async()=>exited,session:s=>s===id&&!expired?{cwd:root,command:'read value',tty:false,sandbox:{mode:'read-only',network:false}}:undefined,writeStdin:async()=>{writes++;return exited;}};
 const dispatcher=new ToolDispatcher({workspace:new WorkspaceRoot(root),grants:new SessionGrants(),commands:runtime,sandbox:()=>({mode:'workspace-write',escalation:'on-request'}),redact:s=>s,approve:async request=>{scopes.push(request.scopeKey!);expired=true;return'once';}});
 const result=await dispatcher.invoke({id:crypto.randomUUID(),name:'write_stdin',input:{session_id:id,chars:'value\n'}});expect(result.code).toBe('SESSION_EXPIRED');expect(writes).toBe(0);expect(scopes[0]).toContain(id);expect(scopes[0]).not.toContain('value');const unknown=await dispatcher.invoke({id:crypto.randomUUID(),name:'write_stdin',input:{session_id:crypto.randomUUID(),chars:'guess'}});expect(unknown.code).toBe('SESSION_NOT_FOUND');expect(scopes).toHaveLength(1);
});
test('streaming output is control-stripped and a secret split across chunks never leaks',async()=>{
 const root=fixture(),redactor=new Redactor();const secret='registered-secret-value';redactor.register(secret);const runtime:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>({ok:true}),run:async request=>{request.onOutput?.({stream:'stdout',text:'safe registered-'});request.onOutput?.({stream:'stdout',text:'secret-value\x1b]52;c;attack\x07 tail'});return{...exited,output:'safe '+secret+' tail'};}};
 const dispatcher=new ToolDispatcher({workspace:new WorkspaceRoot(root),grants:new SessionGrants(),commands:runtime,redact:(s,incomplete)=>incomplete?redactor.stream().push(s):redactor.text(s),approve:async()=>'once'});const streamed:string[]=[];const result=await dispatcher.invoke({id:crypto.randomUUID(),name:'exec_command',input:{cmd:'test'}},undefined,c=>streamed.push(c.text));expect(streamed.join('')).toBe('safe [REDACTED] tail');expect(result.content).not.toContain(secret);expect(streamed.join('')).not.toContain('\x1b');
});
test('unsupported Windows never falls back to an unrestricted container or shell',()=>{const runtime=platformCommandRuntime({workspaceRoot:fixture(),platform:'win32',container:true});expect(runtime.availability().ok).toBe(false);});

test('stdin review: polls and interrupts never prompt; input always asks; a session answer covers only that session; tightened policy refuses',async()=>{
 const root=fixture(),id=crypto.randomUUID(),other=crypto.randomUUID();let prompts=0;const sent:string[]=[];let mode:'read-only'|'workspace-write'='workspace-write';
 const info={cwd:root,command:'bash -i',tty:true,sandbox:{mode:'workspace-write' as const,network:false}};
 const runtime:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>({ok:true}),run:async()=>exited,session:s=>s===id||s===other?info:undefined,writeStdin:async(_id,chars)=>{sent.push(chars);return exited;}};
 const dispatcher=new ToolDispatcher({workspace:new WorkspaceRoot(root),grants:new SessionGrants(),commands:runtime,sandbox:()=>({mode,escalation:'on-request'}),redact:s=>s,approve:async()=>{prompts++;return'session';}});
 const stdin=(session:string,input:Record<string,unknown>)=>dispatcher.invoke({id:crypto.randomUUID(),name:'write_stdin',input:{session_id:session,...input}});
 expect((await stdin(id,{})).status).toBe('ok');expect((await stdin(id,{signal:'SIGINT'})).status).toBe('ok');expect(prompts).toBe(0);
 // Input to an approved shell is a new command: it asks; "session" then covers this session's later input only.
 expect((await stdin(id,{chars:'rm -rf build\n'})).status).toBe('ok');expect(prompts).toBe(1);
 expect((await stdin(id,{chars:'ls\n'})).status).toBe('ok');expect(prompts).toBe(1);
 expect((await stdin(other,{chars:'ls\n'})).status).toBe('ok');expect(prompts).toBe(2);
 mode='read-only';
 const refused=await stdin(id,{chars:'more\n'});expect(refused.status).toBe('denied');expect(refused.content).toContain('start a new command');expect(sent).toEqual(['','','rm -rf build\n','ls\n','ls\n']);
 expect((await stdin(id,{})).status).toBe('ok');expect(prompts).toBe(2);
});

test('long stdin input gets a bounded approval label, not the 1024-character command limit, and reaches the session exactly',async()=>{
 const root=fixture(),id=crypto.randomUUID();const sent:string[]=[];
 const runtime:CommandRuntime={id:'fixture',label:'fixture only',availability:()=>({ok:true}),run:async()=>exited,session:s=>s===id?{cwd:root,command:'cat',tty:false,sandbox:{mode:'read-only',network:false}}:undefined,writeStdin:async(_id,chars)=>{sent.push(chars);return exited;}};
 const dispatcher=new ToolDispatcher({workspace:new WorkspaceRoot(root),grants:new SessionGrants(),commands:runtime,redact:s=>s,approve:async request=>{expect(request.target.length).toBeLessThanOrEqual(1024);return'once';}});
 const chars='x'.repeat(7000)+'\n';const result=await dispatcher.invoke({id:crypto.randomUUID(),name:'write_stdin',input:{session_id:id,chars}});
 expect(result.status).toBe('ok');expect(sent).toEqual([chars]);
});
