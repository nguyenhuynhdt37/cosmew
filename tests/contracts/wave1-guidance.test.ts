import {expect, test} from 'bun:test';
import {explorationGuidance} from '@futryn/core';

test('wave 1 guidance describes only offered capabilities and actual configured approval boundaries', () => {
  const baseline = explorationGuidance(['read', 'grep']);
  expect(baseline).not.toContain('update_plan');
  expect(baseline).not.toContain('request_user_input');
  expect(baseline).not.toContain('web_search');
  expect(baseline).not.toContain('web_fetch');
  expect(baseline).not.toContain('lsp');
  const full = explorationGuidance([
    'read',
    'grep',
    'edit',
    'exec_command',
    'update_plan',
    'request_user_input',
    'lsp',
    'web_search',
    'web_fetch',
  ]);
  for (const tool of ['update_plan', 'request_user_input', 'lsp', 'web_search', 'web_fetch'])
    expect(full).toContain(tool);
  expect(full).not.toContain('You cannot use the network');
  expect(full).not.toContain('must approve each distinct command');
  expect(full).not.toContain('in a read-only, network-less sandbox');
  expect(full).toContain('configured sandbox');
  expect(full).toContain('untrusted');
});
