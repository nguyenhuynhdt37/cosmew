/** Task 02 F on the default native backend (ADR 0035): fixture model → real dispatcher → real Seatbelt. */
import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,existsSync,realpathSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {NativeCommandRuntime} from '@futryn/tools';import {startup} from '../../apps/cli/src/bootstrap/startup';import {fixtureServer,memoryVault,type ScriptedReply,type ScriptedView} from '../fixtures';
const nativeTest=test.skipIf(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'));const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
async function setup(protocol:'chat'|'anthropic',script:(v:ScriptedView)=>ScriptedReply){
 const home=mkdtempSync(join(tmpdir(),'fyn-exec-home-')),root=realpathSync(mkdtempSync(join(tmpdir(),'fyn-exec-agent-')));clean.push(()=>{rmSync(home,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});});
 writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{test:'bun test',build:'bun build entry.ts --outfile=/tmp/bundle.js',lint:'bun lint.ts'}}));writeFileSync(join(root,'entry.ts'),'export const answer = 42;\n');writeFileSync(join(root,'entry.test.ts'),"import {test,expect} from 'bun:test'; import {answer} from './entry';test('answer',()=>expect(answer).toBe(42));\n");writeFileSync(join(root,'lint.ts'),"import {readFileSync} from 'node:fs';if(!readFileSync('entry.ts','utf8').trimEnd().endsWith(';'))process.exit(1);console.log('LINT_PASS');");
 const server=fixtureServer();server.set({script});clean.push(()=>server.server.stop(true));const app=startup(home,{vault:memoryVault(),commands:(workspaceRoot,stateDirectory)=>new NativeCommandRuntime({workspaceRoot,stateDirectory})});clean.push(async()=>{await app.shutdownCommands();await app.subscriptions.shutdown();app.db.close();});
 app.registry.add(server.provider(protocol,{id:'exec-fixture',auth:'none'}));await app.accounts.add('exec-fixture','fixture',{kind:'none'});const client=app.createFutrynClient(root);await client.discoverModels();client.selectModel('fixture-model');client.setToolsEnabled(true);return{home,root,app,client,server};
}
async function sendApproved(c:Awaited<ReturnType<typeof setup>>){const seen:string[]=[],events:any[]=[];let finished=false;
 const sending=(async()=>{try{for await(const event of c.client.sendMessage('Run the requested checks through the sandbox.'))events.push(event);}finally{finished=true;}})();
 const deadline=Date.now()+25000;while(!finished&&Date.now()<deadline){for(const p of c.client.listPendingPermissions())if(!seen.includes(p.approvalId)){expect(p.capability).toBe('process.execute');seen.push(p.approvalId);c.client.resolvePermission(p.approvalId,p.scopeHash,'once');}await Bun.sleep(10);}expect(finished).toBe(true);await sending;return{events,approvals:seen.length};
}
nativeTest('Task 02 F 40-46 (native Seatbelt): the model writes source with Bash, sees the real failing test, fixes it with Bash, reruns and reports verified results',async()=>{
 // Fixture model only: this proves Futryn's loop/runtime wiring, not real-model capability.
 const c=await setup('chat',v=>{const last=v.results.at(-1);
  if(!last)return{calls:[{name:'exec_command',input:{cmd:"mkdir -p src && printf 'export const add = (a: number, b: number) => a - b;\\n' > src/math.ts && printf \"import {test,expect} from 'bun:test'; import {add} from './math'; test('add',()=>expect(add(2,3)).toBe(5));\\n\" > src/math.test.ts; echo CREATED"}}]};
  if(last.name==='exec_command'&&last.content.includes('CREATED'))return{calls:[{name:'exec_command',input:{cmd:'bun test src'}}]};
  if(last.name==='exec_command'&&/Exit code: [1-9]/.test(last.content))return{calls:[{name:'exec_command',input:{cmd:"perl -pi -e 's/a - b/a + b/' src/math.ts && cat src/math.ts"}}]};
  if(last.name==='exec_command'&&last.content.includes('a + b'))return{calls:[{name:'exec_command',input:{cmd:'bun test src'}}]};
  return{text:/Exit code: 0/.test(last.content)&&last.content.includes('1 pass')?'VERIFIED: bun test src passes (1 pass).':'NOT VERIFIED'};});
 const {events,approvals}=await sendApproved(c);
 const results=events.filter(e=>e.type==='toolResult').map(e=>e.result);
 expect(results.map(r=>r.exitCode)).toEqual([0,1,0,0]);expect(results[1].content).toContain('fail');expect(approvals).toBe(4);
 expect(events.filter(e=>e.type==='textDelta').map(e=>e.text).join('')).toBe('VERIFIED: bun test src passes (1 pass).');
 // The fix is in the real project, visible to the host.
 expect(readFileSync(join(c.root,'src/math.ts'),'utf8')).toContain('a + b');
 const stored=c.app.conversations.recover(c.client.activeSession()!.id);expect(stored.turns.at(-1)!.state).toBe('completed');expect(stored.messages.filter(m=>m.toolName==='exec_command')).toHaveLength(4);
},120000);
