import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,linkSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {WorkspaceRoot,captureExecutionSnapshot} from '@futryn/workspace';
import {evaluateRead} from '@futryn/security';
test('execution snapshot materializes internal links but never exposes secrets, git, external links or hardlinks',()=>{
 const home=mkdtempSync(join(tmpdir(),'fyn-exec-snapshot-'));try{const root=join(home,'workspace'),out=join(home,'snapshot');mkdirSync(root);mkdirSync(out);mkdirSync(join(root,'src'));writeFileSync(join(root,'src/main.ts'),'export const value=42;');writeFileSync(join(root,'.env'),'secret');mkdirSync(join(root,'.git'));writeFileSync(join(root,'.git/config'),'private');symlinkSync('src',join(root,'linked'));
 const allow=(path:string)=>evaluateRead(path,join(root,path)).effect==='allow';captureExecutionSnapshot(new WorkspaceRoot(root),out,allow);expect(readFileSync(join(out,'linked/main.ts'),'utf8')).toBe('export const value=42;');expect(existsSync(join(out,'.env'))).toBe(false);expect(existsSync(join(out,'.git'))).toBe(false);
 writeFileSync(join(home,'outside'),'private');symlinkSync('../outside',join(root,'escape'));expect(()=>captureExecutionSnapshot(new WorkspaceRoot(root),join(home,'escape-snapshot'),allow)).toThrow();rmSync(join(root,'escape'));linkSync(join(home,'outside'),join(root,'hardlink'));expect(()=>captureExecutionSnapshot(new WorkspaceRoot(root),join(home,'hardlink-snapshot'),allow)).toThrow();
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('execution snapshots bound file count, bytes and cancellation without following cycles',()=>{
 const home=mkdtempSync(join(tmpdir(),'fyn-exec-bound-'));try{const root=join(home,'workspace');mkdirSync(root);writeFileSync(join(root,'file'),'content');const workspace=new WorkspaceRoot(root);expect(()=>captureExecutionSnapshot(workspace,join(home,'bytes'),()=>true,undefined,{maxBytes:2})).toThrow();expect(()=>captureExecutionSnapshot(workspace,join(home,'count'),()=>true,undefined,{maxFiles:0})).toThrow();const aborted=new AbortController();aborted.abort();expect(()=>captureExecutionSnapshot(workspace,join(home,'cancel'),()=>true,aborted.signal)).toThrow();symlinkSync('.',join(root,'loop'));expect(()=>captureExecutionSnapshot(workspace,join(home,'cycle'),()=>true)).toThrow();}finally{rmSync(home,{recursive:true,force:true});}
});
