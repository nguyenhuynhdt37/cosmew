/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import type {PermissionPromptRequest} from '@cosmew/contracts';
import {renderInk, settle} from '../../testing';
import {PickerDialog} from './index';
import {PermissionRequestDialog, PermissionRulesDialog} from '../permissions';
import {QuestionDialog} from '../question';
import {permissionChoices, permissionTitle} from '../permissions/logic';
import {HelpDialog} from '../help';
import {SettingsDialog} from '../settings';
import {Usage, useUsage} from '../usage';
import {dialogFixture} from './test-fixture';
afterEach(cleanup);
test('Settings slash enters search without filtering by slash; Space toggles outside search and remains text inside', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<SettingsDialog />, {fixture});
  await settle();
  // First row is editor mode, deliberately unsupported; Space must explain the limit rather than filter it out.
  await key(view, ' ');
  expect(view.lastFrame()).toContain('Not implemented');
  expect(view.lastFrame()).not.toContain('No matches');
  await key(view, '/');
  await key(view, 'tool calls');
  expect(view.lastFrame()).not.toContain('No matches');
  await key(view, ' ');
  expect(view.lastFrame()).not.toContain('No matches');
  await key(view, '\x1b'); // search closes first; settings stays mounted
  expect(view.lastFrame()).toContain('Editor mode');
  view.unmount();
});
test('settings list keeps Up/Down navigation after leaving the first row', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<SettingsDialog />, {fixture});
  await settle();
  await key(view, '\u001b[B');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('Changing directory requires a new CLI launch');
  view.unmount();
});
async function key(view: ReturnType<typeof renderInk>, value: string) {
  view.stdin.write(value);
  await settle();
}

test('shared picker frame uses the ▔ rule, unnumbered pointer rows, aligned description and the ✔ marker at 80/36', async () => {
  for (const width of [80, 36]) {
    const selected: string[] = [];
    const view = renderInk(
      <PickerDialog
        title="Choose model"
        width={width}
        items={[
          {id: 'a', label: 'Alpha', description: 'Fast', current: true},
          {id: 'b', label: 'Beta'},
        ]}
        onSelect={item => selected.push(item.id)}
      />,
    );
    await settle();
    expect(view.lastFrame()).toContain('▔'.repeat(width));
    expect(view.lastFrame()).toContain('❯ ✔ Alpha  Fast');
    expect(view.lastFrame()).not.toContain('╭');
    // The narrow footer wraps using Ink's cell measurement.
    expect(view.lastFrame()!.replace(/\s+/g, ' ')).toContain('↑/↓ to navigate · Enter to select · Esc to close');
    await key(view, '\u001b[B');
    expect(view.lastFrame()).toMatch(/❯ +Beta/);
    expect(view.lastFrame()).toContain('✔ Alpha');
    expect(selected).toEqual([]);
    await key(view, '\r');
    expect(selected).toEqual(['b']);
    view.unmount();
  }
});

test('every permission kind retains target, warning/diff and all numbered offered scopes', async () => {
  const cases: {capability: PermissionPromptRequest['capability']; action: string; title: string; diff?: string}[] = [
    {capability: 'fs.read', action: 'read .env', title: 'Read file'},
    {capability: 'process.execute', action: 'exec_command · NO SANDBOX', title: 'Bash command'},
    ...['edit', 'write', 'apply_patch'].map(action => ({
      capability: 'fs.write' as const,
      action,
      title: action === 'write' ? 'Write file' : 'Edit file',
      diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
    })),
    {capability: 'network.connect', action: 'web_fetch', title: 'Fetch'},
    {capability: 'network.connect', action: 'Allow network', title: 'Network access'},
    {capability: 'mcp.call', action: 'mcp__sample__tool', title: 'MCP tool'},
    {capability: 'network.search', action: 'web_search', title: 'Web Search'},
  ];
  for (const entry of cases) {
    const fixture = dialogFixture();
    const request = fixture.client.enqueuePermissionRequest({
      capability: entry.capability,
      action: entry.action,
      target: 'file.ts',
      reason: 'Review requested operation',
      decisions: ['once'],
      diffPreview: entry.diff,
    });
    const view = renderInk(<PermissionRequestDialog request={request} width={80} visibleRows={10} />, {fixture});
    await settle();
    expect(permissionTitle(request)).toBe(entry.title);
    const frame = view.lastFrame()!;
    expect(frame).toContain(entry.title);
    expect(frame).not.toContain('Type to filter');
    expect(frame).toContain('Esc to cancel · Tab to amend');
    expect(frame).toContain('file.ts');
    const edit = entry.capability === 'fs.write';
    if (!edit && entry.capability !== 'fs.read')
      expect(frame.indexOf('file.ts')).toBeLessThan(frame.indexOf('Review requested operation'));
    const escalated = entry.action.includes('NO SANDBOX');
    // Safe default: the cursor starts on Yes, except for an unsandboxed command, which starts on No.
    expect(frame).toContain(escalated ? '❯ 2. No' : '❯ 1. Yes');
    expect(frame).toContain('1. Yes');
    // Edit/Write may offer the mode switch; every kind keeps a plain No last and offers nothing else.
    expect(frame).toContain(edit ? '3. No' : '2. No');
    expect(frame).not.toContain(edit ? '4.' : '3.');
    if (edit) {
      expect(frame).toContain('2. Yes, and switch to accept edits');
      expect(frame).toContain('1 -old');
      expect(frame).toContain('1 +new');
      expect(frame).toContain(`Do you want to make this edit to file.ts?`);
    } else expect(frame).toContain('Do you want to proceed?');
    if (escalated) expect(frame).toContain('NO SANDBOX');
    await key(view, '9');
    expect(fixture.client.listPendingPermissions()).toHaveLength(1);
    await key(view, '1');
    expect(fixture.client.listPermissions()[0]?.status).toBe('approved_once');
    view.unmount();
  }
});

test('offered scopes have contiguous keys, exact domain/rule descriptions and no invented always scope', () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'network.connect',
    action: 'network',
    target: 'api.test',
    reason: 'Fetch',
    decisions: ['once', 'session', 'always'],
    alwaysRule: 'domain:api.test',
  });
  const choices = permissionChoices(request);
  expect(choices.map(c => [c.key, c.id])).toEqual([
    ['1', 'once'],
    ['2', 'session'],
    ['3', 'always'],
    ['4', 'deny'],
  ]);
  expect(choices[2]?.description).toBe('sandbox.network.allowedDomains: api.test');
  expect(
    permissionChoices({...request, decisions: ['session', 'always'], alwaysRule: undefined}).map(c => [c.key, c.id]),
  ).toEqual([
    ['1', 'session'],
    ['2', 'deny'],
  ]);
});

test('help, permissions and settings tabs respond to arrows and Tab without filtering picker text', async () => {
  const help = renderInk(<HelpDialog visibleRows={40} />);
  await settle();
  expect(help.lastFrame()).toContain('Help  General   Commands   Custom commands');
  expect(help.lastFrame()).not.toContain('/permissions');
  await key(help, '\u001b[C');
  expect(help.lastFrame()).toContain('Help  General   Commands   Custom commands');
  expect(help.lastFrame()).toContain('/permissions');
  await key(help, '\t');
  expect(help.lastFrame()).toContain('No custom commands');
  await key(help, '\u001b[D');
  expect(help.lastFrame()).toContain('/permissions');
  help.unmount();
  const permissions = renderInk(<PermissionRulesDialog />);
  await settle();
  expect(permissions.lastFrame()).toContain('Permissions  Recently blocked   Allow   Ask   Deny   Mode   Workspace');
  expect(permissions.lastFrame()).toContain("Cosmew won't ask before using allowed tools.");
  expect(permissions.lastFrame()).toContain('Add a new rule…');
  await key(permissions, '\u001b[C');
  expect(permissions.lastFrame()).toContain('Cosmew will always ask for confirmation');
  await key(permissions, '\u001b[D');
  expect(permissions.lastFrame()).toContain("Cosmew won't ask");
  expect(permissions.lastFrame()).not.toContain('Filter:');
  permissions.unmount();
  const settings = renderInk(<SettingsDialog onNavigate={() => {}} />);
  await settle();
  expect(settings.lastFrame()).toContain('Settings  Status   Config   Usage   Stats');
  expect(settings.lastFrame()).toContain('⌕ Search settings…');
  expect(settings.lastFrame()).toContain('↓ to navigate · ↑ to switch tabs · Esc to go back');
  await key(settings, '\u001b[A'); // first row -> tab bar
  await key(settings, '\u001b[C'); // Config -> Usage
  expect(settings.lastFrame()).toContain('←/→ to switch · d for details · Esc to close');
  await key(settings, 'd');
  expect(settings.lastFrame()).toContain('SESSION USAGE');
  expect(settings.lastFrame()).toContain('d for summary');
  await key(settings, '\u001b[D');
  await key(settings, '\u001b[D'); // Usage -> Config -> Status
  expect(settings.lastFrame()).toContain('Provider:');
  expect(settings.lastFrame()).toContain('MCP servers:       None · /mcp');
  settings.unmount();
  function Status() {
    return <Usage state={useUsage({kind: 'status', onClose: () => {}})} visibleRows={40} />;
  }
  const status = renderInk(<Status />);
  await settle();
  expect(status.lastFrame()).toContain('Settings  Status   Config   Usage   Stats');
  expect(status.lastFrame()).toContain('Workspace:');
  expect(status.lastFrame()).toContain('←/→ to switch · Esc to close');
  expect(status.lastFrame()).not.toContain('d for details');
});

test('short permission frame reserves choices; an unsandboxed command defaults to No, Tab amends with a reason', async () => {
  const {LiveDialog} = await import('../../ui/dialog-layout');
  for (const amend of [false, true]) {
    const fixture = dialogFixture();
    const request = fixture.client.enqueuePermissionRequest({
      capability: 'process.execute',
      action: 'exec_command · NO SANDBOX',
      target: Array.from({length: 30}, (_, i) => `echo line-${i}`).join('\n'),
      reason: 'Review unsandboxed command',
      decisions: ['once', 'session'],
    });
    const reasons: string[] = [];
    const view = renderInk(
      <LiveDialog rows={12}>
        <PermissionRequestDialog
          request={request}
          width={80}
          visibleRows={8}
          onDenied={reason => reasons.push(reason)}
        />
      </LiveDialog>,
      {fixture},
    );
    await settle();
    expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(12);
    expect(view.lastFrame()).toContain('NO SANDBOX');
    expect(view.lastFrame()).toContain('1. Yes');
    expect(view.lastFrame()).toContain('2. Yes, and');
    expect(view.lastFrame()).toContain('❯ 3. No');
    if (amend) {
      await key(view, '\t');
      expect(view.lastFrame()).toContain('Tell Cosmew what to do differently (optional)');
      expect(fixture.client.listPendingPermissions()).toHaveLength(1);
      await key(view, 'use a dry run');
      await key(view, '\r');
      expect(reasons).toEqual(['use a dry run']);
    } else {
      await key(view, '\r'); // Enter on the default (No) never grants
      expect(reasons).toEqual(['']);
    }
    expect(fixture.client.listPermissions()[0]?.status).toBe('denied');
    view.unmount();
  }
});

test('Edit prompts offer the accept-edits switch; choosing it approves once and changes the mode', async () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'edit',
    target: 'a.txt',
    reason: 'Edit',
    decisions: ['once'],
    diffPreview: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-hello\n+HELLO\n world',
  });
  const view = renderInk(<PermissionRequestDialog request={request} width={100} />, {fixture});
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('Edit file');
  expect(frame).toContain('╌'.repeat(100));
  expect(frame).toContain(' 1 -hello');
  expect(frame).toContain(' 1 +HELLO');
  expect(frame).toContain(' 2  world');
  expect(frame.replace(/\s+/g, ' ')).toContain(
    '2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
  );
  expect(fixture.client.permissionMode()).toBe('default');
  await key(view, '2');
  expect(fixture.client.listPermissions()[0]?.status).toBe('approved_once');
  expect(fixture.client.permissionMode()).toBe('acceptEdits');
});

test('a write to a new file is titled Create file and asks to create it', async () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'write',
    target: 'poem.txt',
    reason: 'Create',
    decisions: ['once'],
    diffPreview: '--- /dev/null\n+++ b/poem.txt\n@@ -0,0 +1,2 @@\n+line one\n+line two',
  });
  const view = renderInk(<PermissionRequestDialog request={request} width={100} />, {fixture});
  await settle();
  expect(permissionTitle(request)).toBe('Create file');
  expect(view.lastFrame()).toContain('Create file');
  expect(view.lastFrame()).toContain('Do you want to create poem.txt?');
  expect(view.lastFrame()).toContain(' 1 line one');
});

test('question dialog uses chips and an inline free-text row, and keeps answers across tabs until submission', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser([
    {id: 'first', header: 'First', question: 'Choose a speed', options: [{label: 'Fast', description: 'Less latency'}]},
    {
      id: 'second',
      header: 'Second',
      question: 'Choose another',
      options: [{label: 'Careful', description: 'More work'}],
    },
  ]);
  const view = renderInk(<QuestionDialog width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('─'.repeat(80));
  expect(view.lastFrame()).toContain('☐ First   ☐ Second   ✔ Submit');
  expect(view.lastFrame()).toContain('❯ 1. Fast');
  expect(view.lastFrame()).toContain('     Less latency');
  expect(view.lastFrame()).toContain('2. Type something.');
  expect(view.lastFrame()).toContain('3. Chat about this');
  expect(view.lastFrame()).toContain('Enter to select · ←/→ to switch questions · ↑/↓ to navigate · Esc to cancel');
  await key(view, '\r');
  expect(view.lastFrame()).toContain('☒ First');
  expect(view.lastFrame()).toContain('Choose another');
  expect(fixture.client.listPendingQuestions()).toHaveLength(1);
  await key(view, '\u001b[D');
  expect(view.lastFrame()).toContain('Choose a speed');
  expect(view.lastFrame()).toContain('☒ First');
  view.unmount();
  expect(await outcome).toEqual({kind: 'dismissed'});
});

test('the accept-edits switch is offered only from default mode and only for edits', async () => {
  const fixture = dialogFixture();
  const edit = fixture.client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'edit',
    target: 'a',
    reason: 'r',
    decisions: ['once'],
  });
  const bash = fixture.client.enqueuePermissionRequest({
    capability: 'process.execute',
    action: 'exec',
    target: 'ls',
    reason: 'r',
    decisions: ['once'],
  });
  expect(permissionChoices(edit, 'default').map(c => c.id)).toEqual(['once', 'acceptEdits', 'deny']);
  expect(permissionChoices(edit, 'acceptEdits').map(c => c.id)).toEqual(['once', 'deny']);
  expect(permissionChoices(edit, 'plan').map(c => c.id)).toEqual(['once', 'deny']);
  expect(permissionChoices(edit).map(c => c.id)).toEqual(['once', 'deny']);
  expect(permissionChoices(bash, 'default').map(c => c.id)).toEqual(['once', 'deny']);
});
