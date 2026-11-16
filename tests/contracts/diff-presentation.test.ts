import {expect, test} from 'bun:test';
import {
  deriveTokensFromTriplet,
  renderDiffViewerOverlay,
  renderTranscriptMessages,
  type TranscriptItem,
} from '@futryn/tui';
import {parseUnifiedDiff, renderDiffCodeLine} from '../../apps/tui/src/features/diff/code-lines';
const tokens = deriveTokensFromTriplet('#fafafa', '#252525', '#245db8');
const diff = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,2 +10,2 @@\n const a = 1;\n-old();\n+new();\n';
const plain = (lines: {spans: {text: string}[]}[]) =>
  lines.map(line => line.spans.map(span => span.text).join('')).join('\n');

test('diff rows retain exact line numbers, code suffixes, signs and separate added/deleted surfaces', () => {
  const lines = parseUnifiedDiff(diff);
  expect(lines.map(line => [line.type, line.oldLine, line.newLine])).toEqual([
    ['hunk', null, null],
    ['context', 10, 10],
    ['del', 11, null],
    ['add', null, 11],
  ]);
  const added = renderDiffCodeLine(lines[3]!, 40, tokens),
    removed = renderDiffCodeLine(lines[2]!, 40, tokens);
  expect(plain(added)).toContain('+ new();');
  expect(plain(removed)).toContain('- old();');
  expect(added[0]!.spans[1]!.bg).not.toBe(removed[0]!.spans[1]!.bg);
  const long = {...lines[3]!, content: 'x'.repeat(200) + 'END'};
  const wrapped = renderDiffCodeLine(long, 32, tokens);
  expect(plain(wrapped)).toContain('END');
  expect(wrapped.every(line => line.spans.reduce((n, span) => n + span.text.length, 0) === 32)).toBe(true);
  const headerLike = parseUnifiedDiff('@@ -1 +1 @@\n--- source text\n+++ source text\n');
  expect(headerLike.map(line => line.type)).toEqual(['hunk', 'del', 'add']);
});

test('workspace diff shows selectable file list and clamps scrolling across wide and narrow terminals', () => {
  const files = Array.from({length: 30}, (_, i) => ({
    path: `src/file-${i}.ts`,
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    lines: parseUnifiedDiff(diff),
  }));
  const report = {workspace: '/project', gitAvailable: true, files, totalAdditions: 30, totalDeletions: 30};
  for (const width of [28, 60, 110]) {
    const state = {selectedFileIndex: 22, scrollOffset: 9999};
    const rendered = renderDiffViewerOverlay({width, height: 18, report, state, tokens, borderStyle: 'rounded'});
    expect(rendered).toHaveLength(18);
    expect(plain(rendered)).toContain('src/file-22.ts');
    expect(plain(rendered)).toContain('new();');
    expect(state.scrollOffset).toBe(0);
    expect(rendered.every(line => line.spans.reduce((n, span) => n + span.text.length, 0) === width)).toBe(true);
  }
});

test('inline patch preview shows only returned successful/partial changes, never denied proposals or failed receipt payloads', () => {
  const item: TranscriptItem = {
    id: 'a',
    role: 'assistant',
    content: 'Done',
    parts: [
      {kind: 'tools', callIds: ['p']},
      {kind: 'text', text: 'Done'},
    ],
    toolCalls: [
      {id: 'p', name: 'apply_patch', input: {patch: '*** Begin Patch\n*** Delete File: unrelated.ts\n*** End Patch'}},
    ],
    toolResults: [
      {
        callId: 'p',
        name: 'apply_patch',
        status: 'ok',
        content: JSON.stringify({changes: [{path: 'src/a.ts', action: 'update', diff}]}),
      },
    ],
  };
  const render = () =>
    renderTranscriptMessages({items: [item], width: 100, tokens, borderStyle: 'rounded', compactActivities: true});
  expect(plain(render())).toContain('src/a.ts · applied diff');
  expect(plain(render())).toContain('new();');
  expect(plain(render())).not.toContain('Deleted unrelated.ts');
  item.toolResults![0]!.status = 'denied';
  expect(plain(render())).not.toContain('applied diff');
  expect(plain(render())).not.toContain('new();');
  item.toolResults![0]!.status = 'error';
  item.toolResults![0]!.code = 'STALE_CONTENT';
  expect(plain(render())).not.toContain('new();');
  item.toolResults![0]!.code = 'PARTIAL_APPLY';
  expect(plain(render())).toContain('new();');
  expect(plain(render())).toContain('Patch partially applied');
});

test('diff keyboard navigation switches files, pages and exits without changing files', async () => {
  const {DiffFeature} = await import('../../apps/tui/src/features/diff/controller');
  const lines = Array.from({length: 80}, (_, i) => ({
    type: 'add' as const,
    oldLine: null,
    newLine: i + 1,
    content: `code-${i}`,
  }));
  const files = ['a.ts', 'b.ts'].map(path => ({path, status: 'modified' as const, additions: 80, deletions: 0, lines}));
  let closed = false;
  const host = {
    cols: 120,
    rows: 30,
    client: {
      getWorkspaceDiff: () => ({
        workspace: '/fixture',
        gitAvailable: true,
        files,
        totalAdditions: 160,
        totalDeletions: 0,
      }),
    },
    closeOverlay: () => {
      closed = true;
    },
  };
  const feature = new DiffFeature(host as unknown as import('../../apps/tui/src/core/feature').TuiHost);
  const theme = {tokens, borderStyle: 'rounded' as const, effectiveMode: 'light' as const};
  const render = () => plain(feature.render('diff', {width: 100, height: 14}, theme));
  feature.open();
  expect(render()).toContain('code-0');
  feature.handleKey('diff', 'PageDown');
  expect(render()).not.toContain('code-0 ');
  for (let i = 0; i < 20; i++) {
    feature.handleKey('diff', 'PageDown');
    render();
  }
  expect(render()).toContain('code-79');
  feature.handleKey('diff', 'ArrowUp');
  expect(render()).toContain('code-78');
  feature.handleKey('diff', 'ArrowRight');
  expect(render()).toContain('b.ts');
  expect(render()).toContain('code-0');
  feature.handleKey('diff', 'Escape');
  expect(closed).toBe(true);
  expect(files[0]!.lines).toHaveLength(80);
});

test('write approval uses colored proposed code and keeps denial selected', async () => {
  const {renderPermissionDialogOverlay} = await import('../../apps/tui/src/features/permissions/view');
  const state = {selectedIndex: 0, selectedAction: 'deny' as const};
  const request = {
    approvalId: '00000000-0000-4000-8000-000000000001',
    capability: 'fs.write' as const,
    action: 'Update src/a.ts',
    target: 'src/a.ts',
    riskLevel: 'high' as const,
    reason: 'Review changes',
    scopeHash: 'fixture-hash',
    createdAt: '2026-11-15T00:00:00Z',
    expiresAt: '2026-11-15T01:00:00Z',
    status: 'pending' as const,
    diffPreview: diff,
  };
  const rendered = renderPermissionDialogOverlay({
    width: 100,
    height: 28,
    requests: [request],
    state,
    tokens,
    borderStyle: 'rounded',
  });
  expect(plain(rendered)).toContain('proposed changes (not applied)');
  expect(plain(rendered)).toContain('+ new();');
  expect(plain(rendered)).toContain('- old();');
  expect(plain(rendered)).toContain('› [3] No');
  expect(state.selectedAction).toBe('deny');
  const colors = new Set(rendered.flatMap(line => line.spans.map(span => span.bg)));
  expect(colors.size).toBeGreaterThan(2);
});
