import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../..');
const cleanup:string[]=[];afterEach(()=>{for(const path of cleanup.splice(0))rmSync(path,{recursive:true,force:true});});
const manifest=(path:string)=>JSON.parse(readFileSync(join(root,path),'utf8'));
test('Futryn package identity exposes fyn and futryn as the same executable',()=>{
 expect(manifest('package.json').name).toBe('futryn');
 const cli=manifest('apps/cli/package.json');expect(cli.name).toBe('@futryn/cli');expect(cli.bin.fyn).toBe('./src/index.ts');expect(cli.bin.futryn).toBe(cli.bin.fyn);
});
test('fyn resolves its source from another project and displays Futryn help',()=>{
 const project=mkdtempSync(join(tmpdir(),'futryn-cli-project-'));cleanup.push(project);
 const entry=manifest('apps/cli/package.json').bin.fyn;expect(typeof entry).toBe('string');
 const binary=join(project,'fyn');symlinkSync(resolve(root,'apps/cli',entry),binary);
 const child=Bun.spawnSync([binary,'--help'],{cwd:project,stdout:'pipe',stderr:'pipe'});
 expect(child.exitCode).toBe(0);expect(child.stdout.toString()).toContain('Futryn');expect(child.stdout.toString()).toContain('fyn');expect(child.stdout.toString()).not.toContain('Hannes /');
});

test('new storage names preserve legacy accounts without merging or moving state',async()=>{
 const {defaultStateDirectory}=await import('../../apps/cli/src/bootstrap/paths');
 const {mkdirSync}=await import('node:fs');const home=mkdtempSync(join(tmpdir(),'futryn-state-home-'));cleanup.push(home);
 expect(defaultStateDirectory({},home)).toBe(join(home,'.futryn'));
 mkdirSync(join(home,'.hannes'));expect(defaultStateDirectory({},home)).toBe(join(home,'.hannes'));
 mkdirSync(join(home,'.futryn'));expect(defaultStateDirectory({},home)).toBe(join(home,'.futryn'));
 expect(defaultStateDirectory({HANNES_HOME:'/legacy-state'},home)).toBe('/legacy-state');
 expect(defaultStateDirectory({FUTRYN_HOME:'/new-state',HANNES_HOME:'/legacy-state'},home)).toBe('/new-state');
});
test('fyn uses FUTRYN_HOME from a different project and keeps HANNES_HOME as a fallback',()=>{
 const project=mkdtempSync(join(tmpdir(),'futryn-external-project-'));cleanup.push(project);
 const binary=join(project,'fyn');symlinkSync(resolve(root,'apps/cli',manifest('apps/cli/package.json').bin.fyn),binary);
 for(const name of ['FUTRYN_HOME','HANNES_HOME']){
  const state=join(project,name);const child=Bun.spawnSync([binary,'status','--json'],{cwd:project,env:{...process.env,FUTRYN_HOME:undefined,HANNES_HOME:undefined,[name]:state},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(0);expect(JSON.parse(child.stdout.toString()).sessionId).toBeNull();expect(readFileSync(join(state,'provider-auth.sqlite')).length).toBeGreaterThan(0);
 }
});
test('the legacy error alias keeps instanceof compatible and both state directory names deny writes',async()=>{
 const {FutrynError,HannesError}=await import('@futryn/contracts');const {evaluateWrite}=await import('@futryn/security');
 expect(HannesError).toBe(FutrynError);expect(new FutrynError('POLICY')).toBeInstanceOf(HannesError);
 for(const path of ['.futryn/state','nested/.FUTRYN/state','.hannes/state','.futryn-patch-temporary'])expect(evaluateWrite(path,'/project/'+path).effect).toBe('deny');
});
