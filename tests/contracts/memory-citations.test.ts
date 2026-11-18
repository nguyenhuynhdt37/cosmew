import {expect, test} from 'bun:test';
import * as sdk from '@futryn/sdk';

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
