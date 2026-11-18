import {expect, test} from 'bun:test';
import * as sdk from '@futryn/sdk';
import {deriveTokensFromTriplet, renderTranscriptMessages} from '@futryn/tui';

const block =
  '<oai-mem-citation>\n<citation_entries>\npreference.md:1-3|note=[used preference]\nMEMORY.md:1-2|note=[index]\n../outside.md:1-2|note=[bad]\npreference.md:1-3|note=[duplicate]\n</citation_entries>\n</oai-mem-citation>';
test('citations parse safe memory files once and exclude index/traversal', () => {
  expect(sdk).toHaveProperty('parseMemoryCitations');
  expect(sdk.parseMemoryCitations('Answer.\n' + block)).toEqual({content: 'Answer.', files: ['preference.md']});
  expect(sdk.parseMemoryCitations('```xml\n' + block + '\n```')).toEqual({
    content: '```xml\n' + block + '\n```',
    files: [],
  });
});
test('TUI hides raw citations including streaming fragments and renders a compact line', () => {
  const tokens = deriveTokensFromTriplet('#101520', '#edf2ff', '#f69e6f');
  const render = (content: string, streaming = false) =>
    renderTranscriptMessages({
      items: [{id: 'answer', role: 'assistant', content, streaming}],
      width: 120,
      tokens,
      borderStyle: 'rounded',
    })
      .map(l => l.spans.map(s => s.text).join(''))
      .join('\n');
  const visible = render('Answer.\n' + block);
  expect(visible).toContain('Ký ức đã dùng: preference.md');
  expect(visible).not.toContain('<oai-mem');
  expect(visible).not.toContain('MEMORY.md');
  for (let length = 1; length < block.length; length++)
    expect(render('Answer.\n' + block.slice(0, length), true)).not.toContain('<oai-mem');
  expect(render('```xml\n' + block + '\n```')).toContain('<oai-mem-citation>');
});
