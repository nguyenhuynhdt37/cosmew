/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {renderInk, settle} from '../../testing';
import {PanelTabs, SearchBox} from '../../ui';
import {LiveDialog} from '../../ui/dialog-layout';
import {Usage, useUsage} from '../usage';
import {contextBlock, contextText, CONTEXT_COLUMNS, CONTEXT_ROWS} from '../usage/logic';
import {shortcutRows, HELP_SHORTCUT_COLUMNS} from '../help/logic';
import {dialogFixture} from '../picker/test-fixture';
import {
  RewindDialog,
  McpDialog,
  HooksDialog,
  cancelledResult,
  commandResult,
  mcpRowText,
  notImplementedResult,
  rewindRows,
} from './index';
afterEach(cleanup);
const key = async (view: ReturnType<typeof renderInk>, value: string) => {
  view.stdin.write(value);
  await settle();
};

test('PanelTabs draws the title, one padded gap between tabs and a reversed selected tab', () => {
  const view = renderInk(
    <PanelTabs title="Settings" tabs={['Status', 'Config', 'Usage', 'Stats']} selected="Config" />,
  );
  expect(view.lastFrame()).toBe('Settings  Status   Config   Usage   Stats');
});

test('SearchBox is a rounded 3-row box with the ⌕ placeholder, the caret while typing and exactly the requested width', () => {
  const empty = renderInk(<SearchBox width={40} placeholder="Search settings…" />);
  const lines = empty.lastFrame()!.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(`╭${'─'.repeat(38)}╮`);
  expect(lines[1]).toContain('│ ⌕ Search settings…');
  expect(lines[2]).toBe(`╰${'─'.repeat(38)}╯`);
  expect(lines.every(line => Array.from(line).length === 40)).toBe(true);
  const typed = renderInk(<SearchBox width={40} value="mcp" />);
  expect(typed.lastFrame()).toContain('│ ⌕ mcp▏');
});

test('command result lines follow "❯ /export" + "  ⎿  Export cancelled" with the no-break space', () => {
  expect(cancelledResult('/export', 'Export')).toEqual({
    prompt: '❯ /export',
    result: ['  ⎿  Export cancelled'],
  });
  expect(notImplementedResult('/hooks').result).toEqual(['  ⎿  Not implemented']);
  expect(commandResult('/x', 'first', 'second').result).toEqual(['  ⎿  first', '     second']);
});

test('MCP rows use the status glyphs and singular/plural tool counts', () => {
  expect(mcpRowText({name: 'easel', state: 'connected', tools: 1})).toBe('✔ easel  1 tool');
  expect(mcpRowText({name: 'db', state: 'connected', tools: 27})).toBe('✔ db  27 tools');
  expect(mcpRowText({name: 'gh', state: 'failed'})).toBe('✘ gh');
  expect(mcpRowText({name: 'x', state: 'needs-auth'})).toBe('⚠ x');
  expect(mcpRowText({name: 'cu', state: 'disabled'})).toBe('◯ cu');
});

test('/mcp says no servers are configured and /hooks stays Not implemented', async () => {
  const mcp = renderInk(<McpDialog />);
  await settle();
  expect(mcp.lastFrame()).toContain('No servers configured.');
  expect(mcp.lastFrame()).toContain('Project files are not started.');
  expect(mcp.lastFrame()).toContain('Esc to close');
  expect(mcp.lastFrame()).toContain('OAuth management: Not implemented');
  expect(mcp.lastFrame()).not.toMatch(/✔|✘/);
  const hooks = renderInk(<HooksDialog />);
  await settle();
  expect(hooks.lastFrame()).toContain('Not implemented');
  expect(hooks.lastFrame()).toContain('No hooks configured');
  expect(hooks.lastFrame()).toContain('Esc to close');
  expect(hooks.lastFrame()).not.toMatch(/✔|✘/);
});
test('/mcp keeps the first server selectable after an empty refresh', async () => {
  let servers: Array<{name: string; transport: 'stdio'; state: 'connected'; tools: number}> = [];
  const fixture = dialogFixture({
    mcpStatus: () => ({configPath: '/user/mcp.json', problems: [], servers}),
  });
  const view = renderInk(<McpDialog />, {fixture});
  await settle();
  await key(view, '\u001b[B');
  servers = [{name: 'new-server', transport: 'stdio', state: 'connected', tools: 1}];
  view.rerender(<McpDialog />);
  await settle();
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Source: /user/mcp.json');
  view.unmount();
});

test('rewind uses durable checkpoints and requires a scope confirmation', async () => {
  const checkpoint = {
    id: 'cp-1',
    sessionId: 's',
    createdAt: '',
    conversationIndex: 0,
    prompt: 'first',
    promptId: 'p',
    text: 'first',
    fileChanges: [{path: 'a.txt', additions: 2, deletions: 1}],
    files: 1,
    restorable: true,
  };
  expect(rewindRows([checkpoint])[0]?.detail).toBe('a.txt +2 -1');
  expect(rewindRows([{...checkpoint, restorable: false}])[0]?.detail).toBe('⚠ No code restore');
  const calls: string[] = [];
  const fixture = dialogFixture({
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
    checkpoints: () => [checkpoint],
    rewindCheckpoint: async (_session, id, scope, _signal, instructions) => {
      calls.push(`${id}:${scope}${instructions ? `:${instructions}` : ''}`);
      return {checkpointId: id, scope, restored: false, code: 'CONFLICT'};
    },
  });
  fixture.client.createSession();
  const view = renderInk(
    <LiveDialog rows={12}>
      <RewindDialog width={80} />
    </LiveDialog>,
    {fixture},
  );
  await settle();
  expect(view.lastFrame()).toContain('❯ (current)');
  await key(view, '\x1b[A');
  await key(view, '\r');
  expect(calls).toEqual([]);
  expect(view.lastFrame()).toContain('Restore code and conversation');
  expect(view.lastFrame()).toContain('Summarize from here');
  expect(view.lastFrame()).toContain('Never mind');
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(12);
  await key(view, '\r');
  expect(calls).toEqual(['cp-1:both']);
  expect(view.lastFrame()).toContain('Restore failed: CONFLICT');
  for (let n = 0; n < 3; n++) await key(view, '\x1b[B');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Optional focus');
  expect(calls).toEqual(['cp-1:both']);
  await key(view, 'pending tests');
  await key(view, '\r');
  expect(calls).toEqual(['cp-1:both', 'cp-1:summarize:pending tests']);
  expect(view.lastFrame()).toContain('Restore failed: CONFLICT');
});

test('/context grid is 20x7 cells whose categories add up to the grid, from real SDK numbers', () => {
  const fixture = dialogFixture();
  const block = contextBlock(fixture.client);
  expect(block.rows).toHaveLength(CONTEXT_ROWS);
  expect(block.rows.every(row => row.length === CONTEXT_COLUMNS)).toBe(true);
  const counts = new Map<string, number>();
  for (const cell of block.rows.flat()) counts.set(cell, (counts.get(cell) ?? 0) + 1);
  expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(CONTEXT_COLUMNS * CONTEXT_ROWS);
  expect(block.categories.map(c => c.kind)).toEqual(['instructions', 'messages', 'free', 'buffer']);
  // The model window of the fixture is 100000 tokens; automatic compaction starts at 85%.
  expect(block.limitTokens).toBe(100000);
  expect(block.categories.find(c => c.kind === 'buffer')?.tokens).toBe(15000);
  const text = contextText(block);
  expect(text[1]).toContain('Estimated usage by category');
  expect(text.join('\n')).toContain('Context window:  100k tokens');
  expect(text.join('\n')).toContain('MCP tools · /mcp\n└ User mcp.json');
  expect(text.join('\n')).toContain('System prompt and tool schemas are not measured.');
});

test('the /context view draws the grid with the legend', async () => {
  function Context() {
    return <Usage state={useUsage({kind: 'context', onClose: () => {}})} />;
  }
  const view = renderInk(<Context />, {fixture: dialogFixture()});
  await settle();
  expect(view.lastFrame()).toContain('⛶ ⛶ ⛶');
  expect(view.lastFrame()).toContain('Estimated usage by category');
  expect(view.lastFrame()).toContain('Free space: 85k tokens (85%)');
  expect(view.lastFrame()).not.toContain('▔');
});

test('shortcut table has three columns when wide and stacks when narrow, and only lists real rows', () => {
  const wide = shortcutRows(100);
  expect(wide[0]).toMatch(/^! for shell mode\s+esc esc to clear input\s+ctrl\+shift\+_ to undo$/);
  expect(wide).toHaveLength(Math.max(...HELP_SHORTCUT_COLUMNS.map(c => c.length)));
  expect(shortcutRows(60)).toEqual(HELP_SHORTCUT_COLUMNS.flat());
  // No row advertises a command Cosmew does not have.
  expect(HELP_SHORTCUT_COLUMNS.flat().join('\n')).not.toMatch(/\/btw|alt\+o|alt\+t/);
});

test('MCP metadata is grouped by real source and preserves all status glyphs', async () => {
  const fixture = dialogFixture({
    mcpStatus: () => ({
      configPath: '/user/mcp.json',
      problems: [],
      servers: [{name: 'user-server', transport: 'stdio', state: 'connected', tools: 2}],
    }),
    searchMcpStatus: () => [{name: 'search-server', status: 'needs-auth', toolCount: 0, source: 'Search provider'}],
  });
  const view = renderInk(<McpDialog />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('/user/mcp.json');
  expect(view.lastFrame()).toContain('Search provider');
  expect(view.lastFrame()).toContain('✔ user-server');
  expect(view.lastFrame()).toContain('⚠ search-server');
});
