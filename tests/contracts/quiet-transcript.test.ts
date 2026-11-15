import {expect,test} from 'bun:test';
import {deriveTokensFromTriplet,renderMarkdownBody,renderTranscriptMessages,type TranscriptItem} from '@hannes/tui';
const tokens=deriveTokensFromTriplet('#faf9f5','#262624','#a85236');
const text=(lines:ReturnType<typeof renderMarkdownBody>)=>lines.map(l=>l.spans.map(s=>s.text).join('')).join('\n');
test('answer Markdown renders emphasis and file references without raw markup or duplicate absolute paths',()=>{
 const lines=renderMarkdownBody({content:'## Quota\n**Nhận quota:** [apps/cli/src/host.ts](/Users/huynh/codes/hannes/apps/cli/src/host.ts:308) đọc `rateLimits`.',width:80,tokens,bg:tokens.background,syntaxHighlighting:true});
 const shown=text(lines);expect(shown).toContain('Nhận quota:');expect(shown).toContain('apps/cli/src/host.ts:308');expect(shown).not.toContain('/Users/');expect(shown).not.toContain('**');expect(shown).not.toContain('](');expect(shown).not.toContain('`');expect(shown).not.toContain('##');expect(lines.flatMap(l=>l.spans).some(s=>s.bold&&s.text.includes('Nhận quota:'))).toBe(true);
});
test('consecutive tool rounds render as one compact activity block while the underlying timeline stays intact',()=>{
 const item:TranscriptItem={id:'a',role:'assistant',content:'done',parts:[{kind:'tools',callIds:['a']},{kind:'tools',callIds:['b']},{kind:'text',text:'done'}],toolCalls:[{id:'a',name:'read',input:{path:'src/a.ts'}},{id:'b',name:'read',input:{path:'src/b.ts'}}],toolResults:[{callId:'a',name:'read',status:'ok',content:'a'},{callId:'b',name:'read',status:'ok',content:'b'}]};
 const shown=text(renderTranscriptMessages({items:[item],width:90,tokens,borderStyle:'rounded'}));expect(shown.match(/Explored/g)).toHaveLength(1);expect(shown).toContain('Read a.ts, b.ts');expect(item.parts).toHaveLength(3);
});

test('compact activity disclosures preserve tool arguments, ordering, errors and real reasoning',()=>{
 const item:TranscriptItem={id:'a',role:'assistant',content:'answer',parts:[{kind:'reasoning',text:'**Checking config**\nProvider summary details.'},{kind:'tools',callIds:['r']},{kind:'text',text:'answer'}],toolCalls:[{id:'r',name:'read',input:{path:'src/config.ts',offset:40,limit:20}}],toolResults:[{callId:'r',name:'read',status:'denied',content:'denied'}]};
 const render=()=>renderTranscriptMessages({items:[item],width:100,tokens,borderStyle:'rounded',compactActivities:true});
 const folded=render();expect(text(folded)).toContain('▸ Thinking · Checking config');expect(text(folded)).toContain('Finished with errors');expect(text(folded)).not.toContain('Provider summary details.');expect(text(folded)).not.toContain('"offset"');
 expect(folded.filter(line=>line.disclosure).map(line=>line.disclosure)).toEqual([{itemId:'a',key:'reasoning:0'},{itemId:'a',key:'tools:r'}]);
 item.expandedActivities=['reasoning:0','tools:r'];const expanded=text(render());expect(expanded).toContain('Provider summary details.');expect(expanded).toContain('read {"path":"src/config.ts","offset":40,"limit":20}');expect(expanded).toContain('→ denied');expect(expanded.indexOf('Checking config')).toBeLessThan(expanded.indexOf('"offset"'));expect(expanded.indexOf('"offset"')).toBeLessThan(expanded.indexOf('• answer'));
 item.reasoningExpanded=true;item.collapsedActivities=['reasoning:0'];item.parts![0]={kind:'reasoning',text:'**Checking config**\nProvider summary details. More deltas.'};expect(text(render())).not.toContain('More deltas.');expect(text(render())).toContain('\"offset\":40');
});

test('terminal repaint hides and parks the hardware cursor instead of leaving it at the right edge',async()=>{
 const {renderAnsiDiff}=await import('../../apps/tui/src/render/ansi-diff');
 const cells=[[{ch:'x',fg:tokens.foreground,bg:tokens.background,bold:false}]];
 const output=renderAnsiDiff(cells,1,'none',null);
 expect(output.startsWith('\x1b[?25l')).toBe(true);expect(output.endsWith('\x1b[1;1H')).toBe(true);expect(output).not.toContain('\x1b[?25h');expect(renderAnsiDiff(cells,1,'none',cells)).toBe('');
});
