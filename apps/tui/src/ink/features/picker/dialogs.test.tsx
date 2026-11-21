/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect, type ReactNode} from 'react';
import {FutrynError, BYPASS_PERMISSIONS_WARNING, type MemoryInfo, type UserQuestion} from '@cosmew/contracts';
import {InkApp} from '../../app';
import {useOverlay} from '../../core';
import {renderInk, settle} from '../../testing';
import {ThemeEngine} from '../../../theme/theme';
import {PickerDialog, TextEntry, Detail, useDialogTask, useDialogRefresh} from './index';
import {PermissionsDialog, PermissionRulesDialog, usePermissions} from '../permissions';
import {QuestionDialog} from '../question';
import {ModelsDialog, EffortDialog} from '../models';
import {ConnectDialog} from '../connect';
import {SessionsDialog} from '../sessions';
import {ThemesDialog} from '../themes';
import {MemoryDialog} from '../memory';
import {AgentsDialog} from '../agents';
import {SkillsDialog} from '../skills';
import {HelpDialog} from '../help';
import {SettingsDialog} from '../settings';
import {dialogFixture, provider, account, model, selection, session, child} from './test-fixture';
afterEach(cleanup);
const down = '\u001b[B';
const enter = '\r';
const esc = '\u001b';
async function key(view: ReturnType<typeof renderInk>, value: string) {
  view.stdin.write(value);
  await settle();
}
function Open({children}: {children: ReactNode}) {
  const {open} = useOverlay();
  useEffect(() => {
    open('test-dialog', children);
  }, [open, children]);
  return null;
}
function routed(children: ReactNode, fixture = dialogFixture()) {
  return renderInk(<InkApp client={fixture.client} slots={{status: <Open>{children}</Open>}} />, {fixture});
}
test('picker filters and clamps narrow Unicode content without ANSI controls', async () => {
  const selected: string[] = [];
  const view = renderInk(
    <PickerDialog
      title="Pick"
      width={20}
      items={[
        {id: 'x', label: '你好 hello\u001b]52;c;bad\u0007'},
        {id: 'y', label: 'Beta'},
      ]}
      onSelect={item => selected.push(item.id)}
    />,
  );
  await settle();
  expect(view.lastFrame()).not.toContain('bad');
  await key(view, 'Beta');
  await key(view, enter);
  expect(selected).toEqual(['y']);
  view.rerender(<PickerDialog title="Small" width={8} items={[]} onSelect={() => {}} />);
  await settle();
  expect(view.lastFrame()).toContain('▔');
  expect(view.lastFrame()).not.toContain('╭');
});
test('hidden input masks paste, removes a Unicode code point and submits once', async () => {
  const submitted: string[] = [];
  const view = renderInk(<TextEntry label="API key" hidden onSubmit={v => submitted.push(v)} />);
  await settle();
  await key(view, 'private🔐');
  expect(view.lastFrame()).not.toContain('private');
  await key(view, '\u007f');
  await key(view, enter);
  expect(submitted).toEqual(['private']);
  expect(view.lastFrame()).not.toContain('private');
});
test('detail scrolls within bounds and strips terminal injection', async () => {
  const view = renderInk(<Detail text={'one\ntwo\nthree\u001b]52;c;bad\u0007'} visibleRows={2} />);
  await settle();
  await key(view, down);
  expect(view.lastFrame()).toContain('three');
  expect(view.lastFrame()).not.toContain('bad');
  await key(view, down);
  expect(view.lastFrame()).toContain('2–3/3');
});
test('dialog tasks abort on unmount and never report raw error bodies', async () => {
  let signal: AbortSignal | undefined;
  let release: () => void = () => {};
  function Probe() {
    const task = useDialogTask();
    return (
      <PickerDialog
        title="Task"
        message={task.message}
        items={[{id: 'run', label: 'Run'}]}
        onSelect={() =>
          void task.run(async s => {
            signal = s;
            await new Promise<void>(r => {
              release = r;
            });
            throw new Error('secret-response');
          })
        }
      />
    );
  }
  const view = renderInk(<Probe />);
  await settle();
  await key(view, enter);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  release();
  await settle();
  expect(view.frames.join('')).not.toContain('secret-response');
});
test('permissions ignore unavailable numbered decisions and closing denies SDK waiter', async () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'process.execute',
    action: 'exec_command · NO SANDBOX',
    target: 'npm test',
    reason: 'Escalation',
    decisions: ['once'],
  });
  const view = routed(<PermissionsDialog />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('NO SANDBOX');
  expect(view.lastFrame()).not.toContain('Cả phiên');
  await key(view, '9');
  expect(fixture.client.listPendingPermissions()).toHaveLength(1);
  await key(view, esc);
  expect(fixture.client.listPermissions().find(r => r.approvalId === request.approvalId)?.status).toBe('denied');
});
test('once and session numbered choices resolve only their scope', async () => {
  for (const [number, status] of [
    ['1', 'approved_once'],
    ['2', 'approved_session'],
  ] as const) {
    const fixture = dialogFixture();
    fixture.client.enqueuePermissionRequest({capability: 'fs.read', action: 'read', target: 'a.ts', reason: 'Review'});
    const view = routed(<PermissionsDialog />, fixture);
    await settle();
    await key(view, number);
    expect(fixture.client.listPermissions()[0]?.status).toBe(status);
    const repeated = fixture.client.enqueuePermissionRequest({
      capability: 'fs.read',
      action: 'read',
      target: 'a.ts',
      reason: 'Review',
    });
    expect(repeated.status).toBe(number === '2' ? 'approved_session' : 'pending');
    view.unmount();
  }
});
test('always saves exactly the offered rule before approval', async () => {
  const fixture = dialogFixture();
  fixture.client.enqueuePermissionRequest({
    capability: 'process.execute',
    action: 'exec_command',
    target: 'npm test',
    reason: 'Test',
    decisions: ['once', 'always'],
    alwaysRule: 'Bash(npm test:*)',
  });
  const view = routed(<PermissionsDialog />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('Bash(npm test:*)');
  await key(view, '2');
  expect(fixture.client.permissionRules().allow).toContain('Bash(npm test:*)');
  expect(fixture.client.listPermissions()[0]?.status).toBe('approved_always');
});
test('denial captures reason as host feedback after SDK denial', async () => {
  const fixture = dialogFixture();
  fixture.client.enqueuePermissionRequest({
    capability: 'fs.write',
    action: 'apply_patch',
    target: 'a.ts',
    reason: 'Write',
    diffPreview: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
  });
  const reasons: string[] = [];
  const view = routed(<PermissionsDialog onDenied={reason => reasons.push(reason)} />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('1 -old');
  expect(view.lastFrame()).toContain('1 +new');
  expect(view.lastFrame()).toContain('Esc to cancel · Tab to amend');
  await key(view, '\t');
  await key(view, 'Keep old behavior');
  await key(view, enter);
  expect(reasons).toEqual(['Keep old behavior']);
  expect(fixture.client.listPermissions()[0]?.status).toBe('denied');
});
test('expired or tightened prompt cannot be approved by stale UI', async () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'fs.read',
    action: 'read',
    target: 'a.ts',
    reason: 'Read',
  });
  const view = routed(<PermissionsDialog />, fixture);
  await settle();
  fixture.client.resolvePermission(request.approvalId, request.scopeHash, 'deny');
  await key(view, '1');
  expect(fixture.client.listPermissions()[0]?.status).toBe('denied');
});
test('the permissions dialog lists the Claude Code modes; bypassPermissions is not offered unless launched in it', async () => {
  const fixture = dialogFixture();
  const view = routed(<PermissionRulesDialog />, fixture);
  await settle();
  for (let i = 0; i < 3; i++) await key(view, '\t'); // Allow -> Ask -> Deny -> Mode
  expect(view.lastFrame()).toContain('accept edits');
  expect(view.lastFrame()).toContain('plan mode');
  expect(view.lastFrame()).not.toContain('bypass permissions');
  expect(fixture.client.permissionMode()).toBe('default');
  await key(view, down);
  await key(view, enter);
  expect(fixture.client.permissionMode()).toBe('acceptEdits');
  expect(BYPASS_PERMISSIONS_WARNING).toContain('skips every permission prompt');
});
test('permission rules can be added and removed through SDK validation', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<PermissionRulesDialog />, {fixture});
  await settle();
  await key(view, enter); // Allow tab: "Add a new rule…"
  await key(view, enter); // settings file: local
  await key(view, 'bad-rule');
  await key(view, enter);
  expect(fixture.client.permissionRules().allow).toEqual([]);
  expect(view.lastFrame()).toContain('INVALID_INPUT');
  await key(view, 'Bash(npm test:*)');
  await key(view, enter);
  expect(fixture.client.permissionRules().allow).toContain('Bash(npm test:*)');
  await key(view, down);
  await key(view, enter);
  await key(view, down);
  await key(view, enter);
  expect(fixture.client.permissionRules().allow).toEqual([]);
});
const questions: UserQuestion[] = [
  {
    id: 'mode',
    header: 'Mode',
    question: 'Which mode?',
    options: [
      {label: 'Fast', description: 'Less latency'},
      {label: 'Thorough', description: 'More work'},
    ],
  },
];
test('a single question answers on Enter; Esc and "Chat about this" dismiss', async () => {
  const cases: [string[], {kind: 'answered'; answers: {mode: {answers: string[]}}} | {kind: 'dismissed'}][] = [
    [[enter], {kind: 'answered', answers: {mode: {answers: ['Fast']}}}],
    [[esc], {kind: 'dismissed'}],
    [[down, down, down, enter], {kind: 'dismissed'}],
  ];
  for (const [keys, expected] of cases) {
    const fixture = dialogFixture();
    fixture.client.setUserInputAvailable(true);
    const outcome = fixture.client.askUser(questions);
    const view = routed(<QuestionDialog />, fixture);
    await settle();
    expect(view.lastFrame()).toContain('❯ 1. Fast');
    expect(view.lastFrame()).toContain('Chat about this');
    for (const next of keys) await key(view, next);
    expect(await outcome).toEqual(expected);
    view.unmount();
  }
});
test('question free text is typed inline on the "Type something." row and submits a valid SDK answer', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser(questions);
  const view = routed(<QuestionDialog />, fixture);
  await settle();
  await key(view, down);
  await key(view, down);
  await key(view, 'Custom mode');
  expect(view.lastFrame()).toContain('3. Custom mode');
  await key(view, enter);
  expect(await outcome).toEqual({kind: 'answered', answers: {mode: {answers: ['Custom mode']}}});
});
test('multiple question tabs retain answers and reject incomplete submission', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser([
    ...questions,
    {...questions[0]!, id: 'other', header: 'Other', multiple: true},
  ]);
  const view = routed(<QuestionDialog />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('☐ Mode');
  await key(view, enter); // answers Mode and moves to the next question
  expect(view.lastFrame()).toContain('☒ Mode');
  expect(view.lastFrame()).toContain('Select all that apply.');
  await key(view, '\u001b[C'); // -> Submit tab
  expect(view.lastFrame()).toContain('Review your answers');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Answer every');
  await key(view, esc); // closing must settle every pending question
  expect(await outcome).toEqual({kind: 'dismissed'});
});
test('models select advertised effort through public SDK', async () => {
  const fixture = dialogFixture({selectModel: () => selection});
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, 'high');
  await key(view, enter);
  expect(fixture.client.status().reasoningEffort).toBe('high');
});
test('model discovery aborts on close', async () => {
  let signal: AbortSignal | undefined;
  let finish: () => void = () => {};
  const fixture = dialogFixture({
    discoverModels: async (_a, s) => {
      signal = s;
      await new Promise<void>(r => {
        finish = r;
      });
      throw new FutrynError('CANCELLED');
    },
  });
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  await key(view, '\u0012');
  expect(view.lastFrame()).toContain('Discovering');
  await key(view, esc);
  expect(signal?.aborted).toBe(true);
  finish();
  await settle();
  expect(view.lastFrame()).not.toContain('Model /');
});
test('effort picker blocks changes while streaming', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<EffortDialog isStreaming />, {fixture});
  await settle();
  await key(view, 'high');
  await key(view, enter);
  expect(fixture.client.status().reasoningEffort).not.toBe('high');
  expect(view.lastFrame()).toContain('Cancel the active');
});
test('sessions resume from filtered catalog and revoke old grants', async () => {
  const fixture = dialogFixture({
    listSessions: () => [session],
    getSession: () => ({...session, messages: []}),
    resumeSession: id => ({id, selection, messages: []}),
  });
  const view = routed(<SessionsDialog />, fixture);
  await settle();
  await key(view, 'rendering');
  await key(view, enter);
  await key(view, enter);
  expect(fixture.client.status().activeSessionId).toBe(session.id);
});
test('sessions Ctrl+N starts a new session instead of moving the picker highlight', async () => {
  let created = 0;
  const fixture = dialogFixture({
    listSessions: () => [session],
    startSession: () => {
      created++;
      return {id: `new-${created}`, selection, messages: []};
    },
  });
  const view = renderInk(<SessionsDialog />, {fixture});
  await settle();
  await key(view, '\x0e');
  expect(created).toBe(1);
  expect(fixture.client.status().activeSessionId).toBe('new-1');
  view.unmount();
});
test('session deletion failure keeps item and reports honest error', async () => {
  const fixture = dialogFixture({listSessions: () => [session], deleteSession: () => false});
  const view = renderInk(<SessionsDialog />, {fixture});
  await settle();
  await key(view, enter);
  await key(view, down);
  await key(view, enter);
  await key(view, down);
  await key(view, enter);
  expect(view.lastFrame()).toContain('not deleted');
});
test('theme preview rolls back on close and applies only after confirmation', async () => {
  const engine = new ThemeEngine({env: {NO_COLOR: '1'}, systemDarkPreference: true});
  const original = engine.getCommittedAppearance().theme;
  const target = original === 'light' ? 'dark' : 'light';
  const view = renderInk(<ThemesDialog />, {themeEngine: engine});
  await settle();
  await key(view, target); // highlighting a theme previews it
  expect(engine.isPreviewing()).toBe(true);
  expect(engine.getCommittedAppearance().theme).toBe(original);
  view.unmount();
  expect(engine.isPreviewing()).toBe(false);
  const applied = renderInk(<ThemesDialog />, {themeEngine: engine});
  await settle();
  await key(applied, target);
  await key(applied, enter); // Enter applies; there is no second confirmation step
  expect(engine.getCommittedAppearance().theme).toBe(target);
});
const memory: MemoryInfo = {
  name: 'layout',
  description: 'Layout notes',
  type: 'project',
  usage_count: 0,
  last_usage: null,
  updated_at: new Date().toISOString(),
  unused: true,
};
test('memory lists stale metadata, reads and shows denied delete honestly', async () => {
  const calls: string[] = [];
  const fixture = dialogFixture({
    memories: () => [memory],
    memoryDirectory: () => '/fixture-memory',
    memoryAction: async action => {
      calls.push(action);
      return {
        callId: 'm',
        name: 'memory',
        status: action === 'delete' ? 'denied' : 'ok',
        content: action === 'delete' ? 'Read Only denies delete' : '# Layout notes',
      };
    },
  });
  const view = renderInk(<MemoryDialog />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('lâu không dùng');
  await key(view, 'layout');
  await key(view, enter);
  await key(view, enter);
  expect(view.lastFrame()).toContain('# Layout notes');
  expect(calls).toEqual(['read']);
  view.unmount();
  const deletion = renderInk(<MemoryDialog />, {fixture});
  await settle();
  await key(deletion, 'layout');
  await key(deletion, enter);
  await key(deletion, 'Delete');
  await key(deletion, enter);
  await key(deletion, down);
  await key(deletion, enter);
  expect(deletion.lastFrame()).toContain('Read Only denies delete');
  expect(fixture.client.memories()).toHaveLength(1);
});
test('agents expose types, transcript and stopping through SDK', async () => {
  let stopped = '';
  const fixture = dialogFixture({
    agentTypes: () => ({
      types: [{name: 'explore', source: 'builtin', description: 'Read files', tools: ['read']}],
      warnings: [],
      errors: [],
    }),
    subagents: () => [child],
    inspectSubagent: () => child,
    stopSubagent: id => {
      stopped = id;
      return true;
    },
  });
  fixture.ports.resumeSession = id => ({id, selection, messages: []});
  fixture.client.resumeSession(session.id);
  const view = renderInk(<AgentsDialog />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('built-in');
  await key(view, 'Inspect rendering');
  await key(view, enter);
  await key(view, 'Stop');
  await key(view, enter);
  expect(stopped).toBe(child.id);
  view.unmount();
  const transcript = renderInk(<AgentsDialog />, {fixture});
  await settle();
  await key(transcript, 'Inspect rendering');
  await key(transcript, enter);
  await key(transcript, enter);
  expect(transcript.lastFrame()).toContain('Found layout issue');
});
test('skills retain source, explicit-only state and discovery diagnostics', async () => {
  const fixture = dialogFixture({
    skills: () => ({
      skills: [
        {
          name: 'review',
          description: 'Review changes',
          source: 'project',
          path: '/fixture/SKILL.md',
          directory: '/fixture',
          shortPath: 'skills/review',
          disableModelInvocation: true,
        },
      ],
      errors: [{code: 'INVALID_SKILL'}],
      warnings: [],
    }),
  });
  const invoked: string[] = [];
  const view = renderInk(<SkillsDialog onInvoke={command => invoked.push(command)} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('INVALID_SKILL');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Explicit invocation only');
  await key(view, enter);
  expect(invoked).toEqual(['/review']);
});
test('help renders canonical keymap and slash metadata', async () => {
  const view = renderInk(<HelpDialog visibleRows={40} />);
  await settle();
  expect(view.lastFrame()).toContain('Help  General   Commands   Custom commands');
  expect(view.lastFrame()).toContain('shift+tab to cycle modes');
  expect(view.lastFrame()).toContain('←/→ to switch · Esc to close');
  await key(view, '\u001b[C');
  expect(view.lastFrame()).toContain('/permissions');
  expect(view.lastFrame()).toContain('/skills');
});
test('settings edits user budget and keeps unavailable controls honest', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<SettingsDialog initialSection="Agent" onNavigate={() => {}} />, {fixture});
  await settle();
  await key(view, 'Token budget');
  await key(view, enter);
  expect(fixture.client.defaultTurnBudget().value?.maxTokens).toBe(10000);
  view.unmount();
  const appearance = renderInk(<SettingsDialog initialSection="Appearance" onNavigate={() => {}} />, {fixture});
  await settle();
  await key(appearance, 'Wallpaper');
  await key(appearance, enter);
  expect(appearance.lastFrame()).toContain('unavailable');
});
test('connect masks API keys, clears failed credential and keeps raw error secret', async () => {
  const fixture = dialogFixture({
    addAccount: async () => {
      throw new Error('secret-server-response');
    },
  });
  const view = renderInk(<ConnectDialog />, {fixture});
  await settle();
  await key(view, enter);
  await key(view, enter);
  await key(view, 'private-api-key');
  expect(view.lastFrame()).not.toContain('private-api-key');
  await key(view, enter);
  expect(view.lastFrame()).not.toContain('secret-server-response');
  expect(view.lastFrame()).not.toContain('private-api-key');
  expect(view.lastFrame()).toContain('INVALID_INPUT');
});
test('OAuth close aborts waiting provider authentication and cancels challenge', async () => {
  let signal: AbortSignal | undefined;
  const cancelled: string[] = [];
  let reject: ((error: unknown) => void) | undefined;
  const oauth = {...provider, id: 'chatgpt', auth: 'oauth' as const};
  const fixture = dialogFixture({
    listProviders: () => [oauth],
    listIntegrations: () => [
      {provider: oauth, notice: '', methods: [{id: 'oauth-browser', name: 'ChatGPT OAuth', description: 'Browser'}]},
    ],
    beginProviderAuth: async () => ({
      id: 'challenge',
      authorizationURL: 'https://auth.example.test',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      autoComplete: true,
    }),
    completeOAuthSignIn: async (_p, _id, s) => {
      signal = s;
      return new Promise((_r, fail) => {
        reject = fail;
      });
    },
    cancelProviderAuth: id => {
      cancelled.push(id);
    },
  });
  const view = routed(<ConnectDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, enter);
  expect(view.lastFrame()).toContain('auth.example.test');
  await key(view, esc);
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toContain('challenge');
  reject?.(new FutrynError('CANCELLED'));
  await settle();
  expect(view.lastFrame()).not.toContain('Connecting');
});
test('connect account management preserves rename, reconnect, logout and remove choices', async () => {
  let alias = '';
  const fixture = dialogFixture({
    renameAccount: (_id, value) => {
      alias = value;
      return {...account, alias: value};
    },
  });
  const view = renderInk(<ConnectDialog initialStep="accounts" />, {fixture});
  await settle();
  await key(view, enter);
  expect(view.lastFrame()).toContain('Reconnect');
  expect(view.lastFrame()).toContain('Remove account');
  await key(view, 'Rename');
  await key(view, enter);
  await key(view, 'Work');
  await key(view, enter);
  expect(alias).toBe('Work');
});

test('multiple question answers survive tab navigation and submit together', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser([
    {...questions[0]!, multiple: true},
    {...questions[0]!, id: 'second', header: 'Second'},
  ]);
  const view = routed(<QuestionDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, down);
  await key(view, enter);
  await key(view, '\t');
  await key(view, enter);
  await key(view, 'Submit');
  await key(view, enter);
  expect(await outcome).toEqual({
    kind: 'answered',
    answers: {mode: {answers: ['Fast', 'Thorough']}, second: {answers: ['Fast']}},
  });
});

test('API key connection uses SDK validation and opens models after success', async () => {
  let received = '';
  let validated = false;
  const fixture = dialogFixture({
    addAccount: async (_provider, _alias, _credential, secret) => {
      received = secret ?? '';
      return account;
    },
    validateAccount: async () => {
      validated = true;
      return {models: 1, validation: 'fixture-api'};
    },
    useAccount: () => account,
    selectModel: () => selection,
  });
  const view = routed(<ConnectDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, enter);
  await key(view, 'hidden-key');
  await key(view, enter);
  expect(received).toBe('hidden-key');
  expect(validated).toBe(true);
  expect(view.lastFrame()).toContain('Model / Reasoning effort');
  expect(view.frames.join('')).not.toContain('hidden-key');
});

test('OAuth begin failure returns to method selection with safe diagnostics', async () => {
  const fixture = dialogFixture({
    listIntegrations: () => [{provider, notice: '', methods: [{id: 'oauth-browser', name: 'OAuth', description: ''}]}],
    beginProviderAuth: async () => {
      throw new FutrynError('TRANSPORT');
    },
  });
  const view = renderInk(<ConnectDialog />, {fixture});
  await settle();
  await key(view, enter);
  await key(view, enter);
  expect(view.lastFrame()).toContain('TRANSPORT');
  expect(view.lastFrame()).toContain('method');
});

test('custom provider wizard saves user config with environment-backed headers', async () => {
  const saved: (typeof provider)[] = [];
  const fixture = dialogFixture({
    addProvider: value => {
      saved.push(value);
      return value;
    },
  });
  const view = renderInk(<ConnectDialog />, {fixture});
  await settle();
  await key(view, 'Custom provider');
  await key(view, enter);
  await key(view, 'gateway');
  await key(view, enter);
  await key(view, 'https://gateway.example.test/v1');
  await key(view, enter);
  await key(view, 'responses');
  await key(view, enter);
  await key(view, enter);
  await key(view, 'Manual');
  await key(view, enter);
  await key(view, 'gateway-model');
  await key(view, enter);
  await key(view, 'Authorization=$GATEWAY_TOKEN');
  await key(view, enter);
  expect(saved[0]).toMatchObject({
    id: 'gateway',
    source: 'config',
    protocol: 'responses',
    auth: 'api-key',
    catalog: 'manual',
    models: ['gateway-model'],
    envHttpHeaders: {Authorization: 'GATEWAY_TOKEN'},
  });
  expect(view.frames.join('')).not.toContain('Authorization=$GATEWAY_TOKEN');
});

test('the mode cycling hook follows default -> acceptEdits -> plan -> default', async () => {
  function Cycle() {
    const permissions = usePermissions();
    return (
      <PickerDialog
        title="Cycle"
        items={[{id: 'cycle', label: 'Cycle mode'}]}
        onSelect={() => permissions.cycleMode()}
      />
    );
  }
  const fixture = dialogFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{composer: <Cycle />}} />, {fixture});
  await settle();
  await key(view, enter);
  expect(fixture.client.permissionMode()).toBe('acceptEdits');
  await key(view, enter);
  expect(fixture.client.permissionMode()).toBe('plan');
  await key(view, enter);
  expect(fixture.client.permissionMode()).toBe('default');
});

test('closing while OAuth challenge is being created cancels a late challenge', async () => {
  let finish: ((challenge: {id: string; authorizationURL: string; expiresAt: string}) => void) | undefined;
  let signal: AbortSignal | undefined;
  const cancelled: string[] = [];
  const fixture = dialogFixture({
    listIntegrations: () => [{provider, notice: '', methods: [{id: 'oauth-browser', name: 'OAuth', description: ''}]}],
    beginProviderAuth: async (_p, _m, s) => {
      signal = s;
      return new Promise(resolve => {
        finish = resolve;
      });
    },
    cancelProviderAuth: id => {
      cancelled.push(id);
    },
  });
  const view = routed(<ConnectDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, enter);
  await key(view, esc);
  expect(signal?.aborted).toBe(true);
  finish?.({
    id: 'late',
    authorizationURL: 'https://auth.example.test',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await settle();
  expect(cancelled).toEqual(['late']);
  expect(view.lastFrame()).not.toContain('OAuth');
});

test('logout and removal keep separate SDK semantics and require explicit confirmation', async () => {
  const removed: boolean[] = [];
  const fixture = dialogFixture({
    logoutAccount: async (_id, remove) => {
      removed.push(Boolean(remove));
    },
  });
  const view = renderInk(<ConnectDialog initialStep="accounts" />, {fixture});
  await settle();
  await key(view, enter);
  await key(view, 'Logout');
  await key(view, enter);
  expect(removed).toEqual([]);
  await key(view, down);
  await key(view, enter);
  expect(removed).toEqual([false]);
  view.unmount();
  const removal = renderInk(<ConnectDialog initialStep="accounts" />, {fixture});
  await settle();
  await key(removal, enter);
  await key(removal, 'Remove');
  await key(removal, enter);
  await key(removal, down);
  await key(removal, enter);
  expect(removed).toEqual([false, true]);
});

test('overlay scopes block background input and unmount dismisses the question', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser(questions);
  function Replace() {
    const router = useOverlay();
    return (
      <PickerDialog
        title="Host"
        items={[{id: 'replace', label: 'Replace'}]}
        onSelect={() => router.open('help', <HelpDialog />)}
      />
    );
  }
  const view = renderInk(
    <InkApp
      client={fixture.client}
      slots={{
        composer: <Replace />,
        status: (
          <Open>
            <QuestionDialog />
          </Open>
        ),
      }}
    />,
    {fixture},
  );
  await settle();
  // Input is scoped to the overlay. Host input must not replace it while it is open.
  await key(view, 'Replace');
  await key(view, enter);
  // The overlay consumed Enter (answering its own option); the host picker never opened Help over it.
  expect(await outcome).toEqual({kind: 'answered', answers: {mode: {answers: ['Fast']}}});
  expect(view.lastFrame()).not.toContain('Shortcuts');
  view.unmount();
});

test('dialog subscriptions ignore streaming deltas but refresh permission state', async () => {
  let renders = 0;
  function Probe() {
    useDialogRefresh();
    renders++;
    return <Detail text="Stable dialog" />;
  }
  const fixture = dialogFixture();
  const view = renderInk(<Probe />, {fixture});
  await settle();
  const before = renders;
  for (let n = 0; n < 1000; n++) fixture.client.emitReactiveEvent('streaming');
  await settle();
  expect(renders).toBe(before);
  fixture.client.emitReactiveEvent('permission');
  await settle();
  expect(renders).toBeGreaterThan(before);
  view.unmount();
  const after = renders;
  fixture.client.emitReactiveEvent('done');
  await settle();
  expect(renders).toBe(after);
});

test('model picker s and effort slider s apply only to this session without saving settings', async () => {
  const fixture = dialogFixture({
    selectModel: () => {
      throw new Error('persistent selection forbidden');
    },
  });
  const before = JSON.stringify(fixture.settings);
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  await key(view, '\u001b[C');
  await key(view, 's');
  expect(fixture.client.status().reasoningEffort).toBe('high');
  expect(JSON.stringify(fixture.settings)).toBe(before);
  expect(view.lastFrame()).not.toContain('Not implemented');
  view.unmount();
  const effort = routed(<EffortDialog />, fixture);
  await settle();
  await key(effort, '\u001b[D');
  await key(effort, 's');
  expect(fixture.client.status().reasoningEffort).toBe('low');
  expect(JSON.stringify(fixture.settings)).toBe(before);
});

test('effort Auto without levels explains configuration and resets with Enter or s', async () => {
  for (const input of [enter, 's']) {
    const fixture = dialogFixture({cachedModels: () => [{...model, reasoningEfforts: undefined}]});
    const keyName = account.id + ':' + model.id;
    fixture.settings.reasoningPreferences = {[keyName]: 'high'};
    const before = JSON.stringify(fixture.settings);
    const view = routed(<EffortDialog />, fixture);
    await settle();
    const frame = view.lastFrame()!;
    expect(frame).toContain('No effort levels known for');
    expect(frame).toContain('sample-model');
    expect(frame).toContain('~/.cosmew/config.toml');
    expect(frame).not.toContain('←/→ to adjust');
    await key(view, input);
    expect(view.lastFrame()).not.toContain('Reasoning effort');
    expect(view.lastFrame()).not.toContain('Action failed');
    if (input === 's') expect(JSON.stringify(fixture.settings)).toBe(before);
    else expect(fixture.settings.reasoningPreferences?.[keyName]).toBeUndefined();
    view.unmount();
  }
});

test('model panel and effort panel identify protocols with no effort wire mapping', async () => {
  for (const protocol of ['anthropic', 'gemini'] as const) {
    const fixture = dialogFixture();
    fixture.settings.providers = [{...provider, protocol}];
    const view = routed(<EffortDialog />, fixture);
    await settle();
    expect(view.lastFrame()).toContain(`${protocol} protocol`);
    expect(view.lastFrame()).toContain('no wire mapping');
    expect(view.lastFrame()).not.toContain('←/→ to adjust');
    await key(view, enter);
    expect(view.lastFrame()).not.toContain('Action failed');
    view.unmount();
    const models = routed(<ModelsDialog />, fixture);
    await settle();
    await key(models, enter);
    expect(models.lastFrame()).toContain(`${protocol} protocol`);
    models.unmount();
  }
});

test('model panel explains unknown levels and its Auto option closes without error', async () => {
  const fixture = dialogFixture({
    cachedModels: () => [{...model, reasoningEfforts: undefined}],
    selectModel: () => selection,
  });
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('No effort levels known');
  await key(view, enter);
  expect(view.lastFrame()).toContain('~/.cosmew/config.toml');
  await key(view, enter);
  expect(view.lastFrame()).not.toContain('Model ·');
  expect(view.lastFrame()).not.toContain('Action failed');
});

test('grok-4.7 discovered levels appear in effort and model panels and save xhigh', async () => {
  const grok = {...model, id: 'grok-4.7', reasoningEfforts: ['low', 'medium', 'high', 'xhigh']};
  const fixture = dialogFixture({
    cachedModels: () => [grok],
    resolveSelection: () => ({...selection, modelId: grok.id}),
  });
  const view = routed(<EffortDialog />, fixture);
  await settle();
  for (const level of ['Auto', 'low', 'medium', 'high', 'xhigh']) expect(view.lastFrame()).toContain(level);
  for (let i = 0; i < 4; i++) await key(view, '\u001b[C');
  await key(view, enter);
  expect(fixture.client.status().reasoningEffort).toBe('xhigh');
  view.unmount();
  const panel = routed(<ModelsDialog />, fixture);
  await settle();
  expect(panel.lastFrame()).toContain('low · medium · high · xhigh');
});
test('model panel hides non-coding metadata and a reveals it without filtering the list', async () => {
  const image = {...model, id: 'excluded-image', capabilities: {...model.capabilities, text: 'unsupported' as const}};
  const fixture = dialogFixture({cachedModels: () => [model, image]});
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  expect(view.lastFrame()).toContain('1 non-coding models hidden');
  expect(view.lastFrame()).not.toContain('excluded-image');
  await key(view, 'a');
  expect(view.lastFrame()).toContain('excluded-image');
  await key(view, 'a');
  expect(view.lastFrame()).not.toContain('excluded-image');
});

test('SDK discovery defaults to coding models and all restores the complete catalog', async () => {
  const image = {...model, id: 'image', capabilities: {...model.capabilities, tools: 'unsupported' as const}};
  const manual = {...image, id: 'manual', source: 'manual' as const};
  const selected = {...image, id: model.id};
  const fixture = dialogFixture({discoverModels: async () => ({models: [selected, image, manual], stale: false})});
  expect((await fixture.client.discoverModels()).models.map(m => m.id)).toEqual([model.id, 'manual']);
  expect((await fixture.client.discoverModels({all: true})).models).toHaveLength(3);
});
test('model effort subpanel s applies the highlighted effort only for this session', async () => {
  const fixture = dialogFixture({selectModel: () => selection});
  const before = structuredClone(fixture.settings);
  const view = routed(<ModelsDialog />, fixture);
  await settle();
  await key(view, enter);
  await key(view, down);
  await key(view, 's');
  expect(fixture.client.status().reasoningEffort).toBe('low');
  expect(fixture.settings).toEqual(before);
});

for (const Panel of [EffortDialog, ModelsDialog]) {
  for (const fails of [false, true]) {
    test(`${Panel.name} refreshes missing effort levels silently (failure=${fails})`, async () => {
      let finish!: () => void;
      let current: typeof model = {...model, reasoningEfforts: undefined};
      let calls = 0;
      const fixture = dialogFixture({
        cachedModels: () => [current],
        refreshModelMetadata: () => {
          calls++;
          return new Promise<void>((resolve, reject) => {
            finish = () => {
              if (fails) reject(new Error('private transport error'));
              else {
                current = {...model};
                resolve();
              }
            };
          });
        },
      });
      const view = routed(<Panel />, fixture);
      await settle();
      expect(view.lastFrame()).toContain('Loading effort levels…');
      finish();
      await settle();
      expect(view.lastFrame()).not.toContain('Loading effort levels…');
      expect(view.lastFrame()).not.toContain('private transport error');
      expect(view.lastFrame()).toContain(fails ? 'No effort levels known' : 'high');
      expect(calls).toBe(1);
      view.unmount();
    });
  }
}
