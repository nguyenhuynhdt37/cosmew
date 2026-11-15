import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FutrynTuiApp} from '@hannes/tui';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {fixtureServer,memoryVault} from '../fixtures';

test('chat clicks toggle tool details; wheel/page scrolling is bounded and long selections keep frozen text',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hannes-chat-interactions-'));const server=fixtureServer();
 const app=startup(join(dir,'state'),{vault:memoryVault()});let tui:FutrynTuiApp|undefined;
 try{
  writeFileSync(join(dir,'notes.txt'),'hello');
  server.set({script:view=>view.results.length?{text:Array.from({length:80},(_,row)=>`Row ${row}: readable answer`).join('\n')}:{calls:[{name:'read',input:{path:'notes.txt',offset:1,limit:10}}]}});
  app.registry.add(server.provider('chat',{id:'chat',auth:'none'}));await app.accounts.add('chat','test',{kind:'none'});
  const client=app.createFutrynClient(dir);await client.discoverModels();client.selectModel('fixture-model');client.setToolsEnabled(true);
  tui=new FutrynTuiApp({client,cols:100,rows:30});await tui.initialize();await tui.submitPrompt('inspect');
  const bottom=tui.computeFrameSnapshot().transcriptViewport!;expect(bottom.offset).toBeGreaterThan(20);
  await tui.handleKey('WheelUp');let viewport=tui.computeFrameSnapshot().transcriptViewport!;expect(viewport.offset).toBe(bottom.offset-2);
  await tui.handleKey('WheelDown');expect(tui.computeFrameSnapshot().transcriptViewport!.offset).toBe(bottom.offset);
  await tui.handleKey('PageUp');viewport=tui.computeFrameSnapshot().transcriptViewport!;expect(viewport.offset).toBe(bottom.offset-viewport.height+2);
  for(let i=0;i<20;i++){await tui.handleKey('PageUp');tui.computeFrameSnapshot();}
  viewport=tui.computeFrameSnapshot().transcriptViewport!;expect(viewport.offset).toBe(0);
  const header=viewport.disclosures.find(hit=>hit.key.startsWith('tools:'))!;
  const mouse=`${viewport.top+header.row}:${viewport.left+1}`;
  await tui.handleKey(`MouseDown:${mouse}`);await tui.handleKey(`MouseUp:${mouse}`);
  let snapshot=tui.computeFrameSnapshot();expect(snapshot.plainText).toContain('▾ Completed');expect(snapshot.plainText).toContain('"limit":10');
  viewport=snapshot.transcriptViewport!;
  await tui.handleKey(`MouseDown:${mouse}`);await tui.handleKey(`MouseUp:${mouse}`);
  expect(tui.computeFrameSnapshot().plainText).not.toContain('"limit":10');
  snapshot=tui.computeFrameSnapshot();viewport=snapshot.transcriptViewport!;
  await tui.handleKey(`MouseDown:${viewport.top}:${viewport.left}`);
  await tui.handleKey(`MouseDrag:${viewport.top+viewport.height-1}:${viewport.left+20}`);
  for(let i=0;i<12;i++)await tui.handleKey('WheelDown');
  await tui.handleKey(`MouseUp:${viewport.top+viewport.height-1}:${viewport.left+20}`);
  const sequence=tui.takeClipboardSequence();expect(sequence).toContain('\x1b]52;c;');
  const copied=Buffer.from(sequence.slice(7,-1),'base64').toString();expect(copied).toContain('Row 20: readable answer');expect(copied).not.toContain('Ctrl+P commands');
  await tui.handleKey('Escape');expect(tui.computeFrameSnapshot().transcriptViewport).toBeDefined();
 }finally{await tui?.shutdown();await app.shutdownCommands();await app.subscriptions.shutdown();app.db.close();server.server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
