import { expect, test } from 'bun:test';
import { deriveTokensFromTriplet } from '@hannes/tui';
import { renderFyn, type FynState } from '../../apps/tui/src/components/mascot';
import { createInitialComposerState, renderPromptComposerLines } from '../../apps/tui/src/components/editor';
import { renderMarkdownBody, renderTranscriptMessages } from '../../apps/tui/src/components/messages';
const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');

test('miniature Fyn retains both ears, eyes, feet and a complete tail throughout its animation', () => {
  for (const state of ['idle', 'thinking', 'streaming', 'waiting', 'done', 'error', 'cancelled', 'sleep'] as FynState[]) {
    for (const time of [0, 0.3, 0.8, 1.2, 4.5, 20]) {
      const lines = renderFyn({ state, time, tokens, width: 28, scale: 5 });
      expect(lines).toHaveLength(6);
      expect(lines.at(-1)!.spans[0]!.text).toContain('Fyn ·');
      for (const line of lines) expect(line.spans.reduce((sum, span) => sum + span.text.length, 0)).toBeLessThanOrEqual(28);
      const art = lines.slice(0, -1);
      expect(art[0]!.spans[2]!.fg).toBe(state === 'error' ? tokens.error : state === 'waiting' ? tokens.warning : tokens.accent);
      expect(art.at(-1)!.spans.some(span => span.fg !== tokens.background)).toBe(true);
      expect(art[2]!.spans.slice(10).some(span => span.fg !== tokens.background || span.bg !== tokens.background)).toBe(true);
    }
  }
  const open = renderFyn({ state: 'idle', time: 0, tokens, width: 28, scale: 5 });
  expect(open[1]!.spans[3]!.bg).toBe(tokens.background);
  expect(open[1]!.spans[7]!.bg).toBe(tokens.background);
});

test('composer keeps the current cursor visible in wrapped and long multiline drafts within its height budget', () => {
  for (const width of [30, 56, 100]) {
    const state = createInitialComposerState();
    state.value = 'old line\n'.repeat(9) + 'a'.repeat(width * 2) + 'VISIBLE';
    state.cursor = state.value.length;
    const options = { width, state, mode: 'chat' as const, activeModelLabel: 'model', activeAccountLabel: 'personal', isStreaming: false, focused: true, tokens, borderStyle: 'rounded' as const, maxHeight: 9 };
    const lines = renderPromptComposerLines(options);
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.flatMap(l => l.spans).map(s => s.text).join('')).toContain('VISIBLE');
    expect(lines.some(l => l.spans.some(s => s.bg === tokens.cursor))).toBe(true);
    state.value = '/'; state.cursor = 1; state.slashMenuOpen = true;
    const popup = renderPromptComposerLines({ ...options, maxHeight: 12 });
    expect(popup.length).toBeLessThanOrEqual(12);
    for (const line of popup) expect(line.spans.reduce((sum, span) => sum + span.text.length, 0)).toBeLessThanOrEqual(width);
  }
});

test('chat preserves long code lines and uses the same left edge for prompts and replies', () => {
  const source = 'const value = "' + 'x'.repeat(140) + '";';
  const body = renderMarkdownBody({ content: '```ts\n' + source + '\n```', width: 40, tokens, bg: tokens.background, syntaxHighlighting: true });
  expect(body.slice(1).map(l => l.spans.map(s => s.text).join('').trim()).join('')).toBe(source);
  const lines = renderTranscriptMessages({ items: [{ id: 'u', role: 'user', content: 'Prompt' }, { id: 'a', role: 'assistant', content: 'Response' }], width: 80, tokens, borderStyle: 'rounded' });
  expect(lines[0]!.spans[0]!.text).toBe('› ');
  expect(lines[2]!.spans[0]!.text).toBe('• ');
});

test('composer prioritizes interruption and preserves account identity when model names are long', () => {
  const state = createInitialComposerState();
  const options = {width: 62, state, mode:'chat' as const, activeModelLabel:'very-long-provider-model-name-with-many-segments-2026', activeAccountLabel:'work', focused:true, tokens, borderStyle:'rounded' as const};
  const idle = renderPromptComposerLines({...options, isStreaming:false}).flatMap(row => row.spans.map(span => span.text)).join('');
  expect(idle).toContain('… · work');
  const busy = renderPromptComposerLines({...options, isStreaming:true, telemetryLabel:'~$0.001'}).flatMap(row => row.spans.map(span => span.text)).join('');
  expect(busy).toContain('Esc interrupt');
});
