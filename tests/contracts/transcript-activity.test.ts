import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolCall, ToolResult } from '@hannes/contracts';
import { FutrynTuiApp, deriveTokensFromTriplet, explorationRows, formatElapsed, messagesToTranscript, reasoningTitle, renderTranscriptMessages, type TranscriptItem } from '@hannes/tui';
import { startup } from '../../apps/cli/src/bootstrap/startup';
import { fixtureServer, memoryVault, type ScriptedView } from '../fixtures';

/** ADR 0021 timeline, drawn Claude Code style (ADR 0028): `✻ Thought`, `⏺ Tool(args)` + `⎿ result`, `⏺ answer`. */
const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
const plain = (item: TranscriptItem, width = 80) => renderTranscriptMessages({ items: [item], width, tokens, borderStyle: 'rounded' }).map(line => line.spans.map(span => span.text).join('').trimEnd());
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
const ok = (callId: string, name: string, content = 'x', extra: Partial<ToolResult> = {}): ToolResult => ({ callId, name, status: 'ok', content, ...extra });

test('a turn renders in arrival order: thinking, exploration, thinking, answer', () => {
  const calls = [call('1', 'grep', { pattern: 'verifyToken', path: 'src' }), call('2', 'read', { path: 'src/routes.ts' }), call('3', 'read', { path: 'src/service.ts' })];
  const item: TranscriptItem = { id: 'a', role: 'assistant', content: 'verifyToken is in src/service.ts.', toolCalls: calls, toolResults: [ok('1', 'grep'), ok('2', 'read'), ok('3', 'read')],
    reasoning: 'Find the route\nFollow the import', parts: [
      { kind: 'reasoning', text: 'Find the route' }, { kind: 'tools', callIds: ['1', '2', '3'] }, { kind: 'reasoning', text: 'Follow the import' }, { kind: 'text', text: 'verifyToken is in src/service.ts.' }] };
  expect(plain(item)).toEqual([
    '✻ Thought  (ctrl+r to expand)',
    '',
    '⏺ Search("verifyToken" in src)',
    '  ⎿  Found 1 match',
    '',
    '⏺ Read(src/routes.ts)',
    '  ⎿  Read 1 line',
    '',
    '⏺ Read(src/service.ts)',
    '  ⎿  Read 1 line',
    '',
    '✻ Thought  (ctrl+r to expand)',
    '',
    '⏺ verifyToken is in src/service.ts.',
  ]);
  // Expanded thinking is dim italic and indented; the answer is not italic.
  item.reasoningExpanded = true;
  const lines = renderTranscriptMessages({ items: [item], width: 80, tokens, borderStyle: 'rounded' });
  expect(lines[1]!.spans.slice(1).every(span => span.italic && span.fg === tokens.foregroundMuted)).toBe(true);
  expect(lines.at(-1)!.spans.some(span => span.italic)).toBe(false);
});

test('reasoning titles lose their markdown stars inline', () => {
  const item: TranscriptItem = { id: 'a', role: 'assistant', content: 'ok', reasoningExpanded: true, parts: [{ kind: 'reasoning', text: '**Finding routes** then reading' }, { kind: 'text', text: 'ok' }] };
  expect(plain(item).slice(0, 2)).toEqual(['✻ Thought · Finding routes', '  Finding routes then reading']);
});

test('Ctrl+R state hides thinking parts and keeps everything else', () => {
  const item: TranscriptItem = { id: 'a', role: 'assistant', content: 'done', reasoning: 'secret plan', reasoningExpanded: false, parts: [{ kind: 'reasoning', text: 'secret plan' }, { kind: 'text', text: 'done' }] };
  // Only the one-line header stays; the plan text itself is hidden.
  expect(plain(item)).toEqual(['✻ Thought  (ctrl+r to expand)', '', '⏺ done']);
  expect(plain(item).join('\n')).not.toContain('secret plan');
});

test('exploration rows: adjacent reads merge, outcomes split them, names stay unambiguous', () => {
  const calls = [
    call('1', 'glob', { pattern: '**/*.ts', path: 'src' }), call('2', 'read', { path: 'a/index.ts' }), call('3', 'read', { path: 'b/index.ts' }),
    call('4', 'read', { path: 'a/index.ts' }), call('5', 'read', { path: '.env' }), call('6', 'read', { path: 'big.log' }), call('7', 'grep', { pattern: 'x', glob: '*.md' }),
    call('8', 'read', { path: 'z.ts' }), call('9', 'read', { path: 'w.ts' }),
  ];
  const results: ToolResult[] = [ok('1', 'glob'), ok('2', 'read'), ok('3', 'read'), ok('4', 'read', '[unchanged] same'), { callId: '5', name: 'read', status: 'denied', code: 'DENIED', content: '' },
    ok('6', 'read', 'x', { truncated: true }), ok('7', 'grep'), { callId: '8', name: 'read', status: 'error', code: 'TOOL_BUDGET', content: '' }];
  expect(explorationRows(calls, results).map(r => `${r.verb} ${r.target}${r.note ? ` (${r.note})` : ''}|${r.tone}`)).toEqual([
    'List **/*.ts in src|ok',
    'Read a/index.ts, b/index.ts|ok', // same file name in two folders: full paths
    'Read a/index.ts (unchanged)|muted',
    'Read .env (denied)|error',
    'Read big.log (partial)|muted',
    'Search x (*.md)|ok',
    'Read z.ts (over budget)|error',
    'Read w.ts|ok', // still running: no outcome yet
  ]);
});

test('a live call says Running until its result arrives; long arguments wrap to two rows, then …', () => {
  const item: TranscriptItem = { id: 'a', role: 'assistant', content: '', streaming: true, toolCalls: [call('1', 'read', { path: 'src/a-very-long-directory-name/another-long-directory/file-with-a-long-name.ts' })], parts: [{ kind: 'tools', callIds: ['1'] }] };
  expect(plain(item, 40)).toEqual(['⏺ Read(src/a-very-long-directory-name/', '  another-long-directory/file-with-a…', '  ⎿  Running…']);
  item.toolResults = [ok('1', 'read')]; item.streaming = false;
  expect(plain(item, 40).at(-1)).toBe('  ⎿  Read 1 line');
  // Expanding the call shows the full arguments.
  item.expandedActivities = ['tools:1'];
  const full = plain(item, 40);
  expect(full.join('\n')).not.toContain('…');
  expect(full.join('').replace(/\s+/g, '')).toContain('"path":"src/a-very-long-directory-name/another-long-directory/file-with-a-long-name.ts"');
});

test('control bytes in model-chosen paths never reach the screen', () => {
  const item: TranscriptItem = { id: 'a', role: 'assistant', content: '', toolCalls: [call('1', 'read', { path: 'x\u001b]0;pwn\u0007.ts' }), call('2', 'grep', { pattern: 'a\u001b[2Jb' })], toolResults: [ok('1', 'read'), ok('2', 'grep')], parts: [{ kind: 'tools', callIds: ['1', '2'] }] };
  for (const line of plain(item)) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});

test('stored conversations rebuild the same order, so resumed sessions look alike', () => {
  const messages: Message[] = [
    { role: 'user', content: 'how?' },
    { role: 'assistant', content: 'Looking first.', toolCalls: [call('1', 'glob', { pattern: '**/routes.*' })] }, { role: 'tool', content: 'src/routes.ts', toolCallId: '1', toolName: 'glob' },
    { role: 'assistant', content: '', toolCalls: [call('2', 'read', { path: 'src/routes.ts' })] }, { role: 'tool', content: '[denied: DENIED] no', toolCallId: '2', toolName: 'read' },
    { role: 'assistant', content: 'Could not read routes.' },
  ];
  const [, answer] = messagesToTranscript(messages, { idPrefix: 's' });
  expect(answer!.parts).toEqual([{ kind: 'text', text: 'Looking first.' }, { kind: 'tools', callIds: ['1'] }, {kind:'tools',callIds:['2']}, { kind: 'text', text: 'Could not read routes.' }]);
  expect(plain(answer!)).toEqual(['⏺ Looking first.', '', '⏺ Glob(**/routes.*)', '  ⎿  Found 1 file', '', '⏺ Read(src/routes.ts)', '  ⎿  Permission denied', '', '⏺ Could not read routes.']);
  // Plain chats keep the flat layout.
  expect(messagesToTranscript([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], { idPrefix: 's' })[1]!.parts).toBeUndefined();
});

test('status helpers: Codex elapsed format and the latest bold reasoning title', () => {
  expect([0, 12_400, 65_000, 3_723_000].map(formatElapsed)).toEqual(['0s', '12s', '1m 05s', '1h 02m 03s']);
  expect(reasoningTitle('**Finding routes**\nlooked\n**Tracing verifyToken**\nmore')).toBe('Tracing verifyToken');
  expect(reasoningTitle('no title here')).toBeUndefined();
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

test('live frame: each call appears while the turn runs, with a status line, and stays after the answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'futryn-activity-home-')); const ws = mkdtempSync(join(tmpdir(), 'futryn-activity-ws-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }), () => rmSync(ws, { recursive: true, force: true }));
  writeFileSync(join(ws, 'notes.txt'), 'hello\n');
  writeFileSync(join(ws, 'second.txt'), 'next step\n');
  const server = fixtureServer(); cleanup.push(() => server.server.stop(true));
  // The first reply asks for a read and slows the next request, leaving a window to look at the frame mid-turn.
  server.set({ script: (view: ScriptedView) => {
    if (view.results.length > 1) return { text: 'Notes say hello.' };
    if (view.results.length === 1) return {calls:[{name:'read',input:{path:'second.txt'}}]};
    server.set({ delay: 500 });
    return { calls: [{ name: 'read', input: { path: 'notes.txt' } }] };
  } });
  const app = startup(home, { vault: memoryVault() }); cleanup.push(() => app.db.close());
  app.registry.add(server.provider('chat', { id: 'tooly', auth: 'none' })); await app.accounts.add('tooly', 'main', { kind: 'none' });
  const client = app.createFutrynClient(ws); await client.discoverModels(); client.selectModel('fixture-model'); client.setToolsEnabled(true);
  const tui = new FutrynTuiApp({ client, cols: 90, rows: 24 }); await tui.initialize(); cleanup.push(() => tui.shutdown());
  const turn = tui.submitPrompt('what is in notes?');
  const end = Date.now() + 4000;
  while (!tui.getTranscript().at(-1)?.toolResults?.length && Date.now() < end) await Bun.sleep(5);
  const live = tui.computeFrameSnapshot().plainText;
  expect(live).toContain('⏺ Read(notes.txt)');
  expect(live).toContain('✻ Waiting for model…');
  expect(live).toContain('⎿  Read 1 line'); // the call finished; the model is being asked again
  expect(live).toMatch(/[•◦] Waiting for model \(\d+s • Esc to interrupt\)/);
  while((tui.getTranscript().at(-1)?.toolResults?.length??0)<2&&Date.now()<end)await Bun.sleep(5);
  expect(tui.getTranscript().at(-1)?.parts?.filter(part=>part.kind==='tools')).toHaveLength(2);
  const next=tui.computeFrameSnapshot().plainText;
  expect(next).toContain('⏺ Read(second.txt)');expect(next).toContain('Waiting for model…');
  await turn;
  const done = tui.computeFrameSnapshot().plainText;
  expect(done).toContain('⏺ Read(notes.txt)');expect(done).toContain('⏺ Read(second.txt)');
  expect(done).toContain('Notes say hello.');
  expect(done).not.toContain('Esc to interrupt)');
});

test('a pending model continuation appears below completed tools without inventing reasoning',()=>{
 const item:TranscriptItem={id:'a',role:'assistant',content:'',streaming:true,awaitingModel:true,toolCalls:[call('r','read',{path:'src/a.ts'})],toolResults:[ok('r','read')],parts:[{kind:'tools',callIds:['r']}]};
 expect(plain(item)).toEqual(['⏺ Read(src/a.ts)','  ⎿  Read 1 line','','✻ Waiting for model…']);
 expect(item.reasoning).toBeUndefined();item.streaming=false;expect(plain(item)).not.toContain('✻ Waiting for model…');
});
test('consecutive completed rounds stay separate when the model sends no text or summary',()=>{
 const messages:Message[]=[{role:'user',content:'inspect'},
  {role:'assistant',content:'',toolCalls:[call('a','read',{path:'a.ts'})]},{role:'tool',toolCallId:'a',toolName:'read',content:'a'},
  {role:'assistant',content:'',toolCalls:[call('b','read',{path:'b.ts'})]},{role:'tool',toolCallId:'b',toolName:'read',content:'b'},
  {role:'assistant',content:'done'}];
 const item=messagesToTranscript(messages,{idPrefix:'x'})[1]!;
 expect(item.parts?.filter(p=>p.kind==='tools')).toHaveLength(2);
 expect(plain(item)).toEqual(['⏺ Read(a.ts)','  ⎿  Read 1 line','','⏺ Read(b.ts)','  ⎿  Read 1 line','','⏺ done']);
});
test('patch activity uses actual changed paths and is never drawn as a read',()=>{
 const c=call('p','apply_patch',{patch:'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch'});
 const item:TranscriptItem={id:'a',role:'assistant',content:'',streaming:true,toolCalls:[c],parts:[{kind:'tools',callIds:['p']}]};
 expect(plain(item).join('\n')).toContain('Patch pending');expect(plain(item).join('\n')).toContain('src/a.ts');
 item.toolResults=[ok('p','apply_patch',JSON.stringify({status:'applied',changes:[{path:'src/a.ts',action:'update'}],remaining:[]}))];item.streaming=false;
 expect(plain(item)).toEqual(['⏺ Update(src/a.ts)','  ⎿  Patched','     Updated src/a.ts']);
 expect(plain(item).join('\n')).not.toContain('Explored');
 item.toolResults=[{...item.toolResults[0]!,status:'error',code:'PARTIAL_APPLY',content:JSON.stringify({status:'partial',changes:[{path:'src/a.ts',action:'update'}],remaining:['src/b.ts'],failureCode:'STALE_CONTENT'})}];
 expect(plain(item).join('\n')).toContain('Patch partially applied');expect(plain(item).join('\n')).toContain('Not applied: src/b.ts');
});
test('a cancelled read with no result is shown as stopped rather than explored',()=>{
 const item:TranscriptItem={id:'a',role:'assistant',content:'',streaming:false,toolCalls:[call('r','read',{path:'a.ts'})],parts:[{kind:'tools',callIds:['r']}]};
 expect(plain(item)).toEqual(['⏺ Read(a.ts)','  ⎿  Stopped']);
});

test('interrupted patch receipts render on resume at EOF and stay before the next user turn',()=>{
 const patch=call('p','apply_patch',{patch:'*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch'});
 const messages:Message[]=[{role:'user',content:'write a'},{role:'assistant',content:'',toolCalls:[patch]},{role:'tool',toolName:'apply_patch',toolCallId:'p',content:JSON.stringify({status:'applied',changes:[{path:'a.ts',action:'add'}]})}];
 expect(messagesToTranscript(messages,{idPrefix:'resume'})).toHaveLength(2);
 const items=messagesToTranscript([...messages,{role:'user',content:'continue'},{role:'assistant',content:'next answer'}],{idPrefix:'resume'});
 expect(items.map(item=>item.role)).toEqual(['user','assistant','user','assistant']);expect(plain(items[1]!)).toEqual(['⏺ Update(a.ts)','  ⎿  Patched','     Added a.ts']);expect(items[3]!.toolCalls).toBeUndefined();
});
test('malformed patch receipts and pending/stopped/denied calls never invent file changes',()=>{
 const item:TranscriptItem={id:'p',role:'assistant',content:'',streaming:false,toolCalls:[call('p','apply_patch',{patch:'*** Begin Patch\n*** Delete File: a.ts\n*** End Patch'})]};
 expect(plain(item).join('\n')).toContain('Patch stopped');
 item.toolResults=[{callId:'p',name:'apply_patch',status:'denied',content:'no'}];expect(plain(item).join('\n')).toContain('Patch denied');expect(plain(item).join('\n')).not.toContain('Deleted');
 item.toolResults=[{callId:'p',name:'apply_patch',status:'denied',content:JSON.stringify({changes:[{path:'a.ts',action:'delete'}],createdDirectories:['forged']})}];expect(plain(item).join('\n')).not.toContain('Deleted');expect(plain(item).join('\n')).not.toContain('Created directory');
 item.toolResults=[ok('p','apply_patch','{broken')];expect(plain(item).join('\n')).toContain('Patch completed');expect(plain(item).join('\n')).not.toContain('Deleted');
 item.toolResults=[ok('p','apply_patch',JSON.stringify({changes:'untrusted'}))];expect(plain(item).join('\n')).not.toContain('Patched');
 item.toolResults=[{callId:'p',name:'apply_patch',status:'error',code:'PARTIAL_APPLY',content:JSON.stringify({status:'partial',changes:[],createdDirectories:['src'],remaining:['src/a.ts'],failureCode:'WRITE_FAILED'})}];
 expect(plain(item).join('\n')).toContain('Created directory src');expect(plain(item).join('\n')).toContain('Not applied: src/a.ts');
});
