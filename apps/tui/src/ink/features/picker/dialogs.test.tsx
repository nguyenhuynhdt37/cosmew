/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {useEffect, type ReactNode} from 'react';
import {FutrynError, FULL_ACCESS_WARNING, type MemoryInfo, type UserQuestion} from '@futryn/contracts';
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
import {dialogFixture, provider, account, selection, session, child} from './test-fixture';
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
  expect(view.lastFrame()).toContain('╭');
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
  await key(view, '2');
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
  await key(view, '3');
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
  expect(view.lastFrame()).toContain('not applied');
  await key(view, '4');
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
test('Full Access requires explicit warning confirmation; Escape keeps sandbox', async () => {
  const fixture = dialogFixture();
  const view = routed(<PermissionRulesDialog />, fixture);
  await settle();
  await key(view, 'Full Access');
  await key(view, enter);
  expect(view.lastFrame()).toContain('WITHOUT');
  expect(fixture.client.permissionPreset()).toBe('auto');
  await key(view, esc);
  expect(fixture.client.permissionPreset()).toBe('auto');
  const next = routed(<PermissionRulesDialog />, fixture);
  await settle();
  await key(next, 'Full Access');
  await key(next, enter);
  await key(next, down);
  await key(next, enter);
  expect(fixture.client.permissionPreset()).toBe('full-access');
  expect(FULL_ACCESS_WARNING).toContain('WITHOUT');
});
test('permission rules can be added and removed through SDK validation', async () => {
  const fixture = dialogFixture();
  const view = renderInk(<PermissionRulesDialog />, {fixture});
  await settle();
  await key(view, '\t');
  await key(view, enter);
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
test('question selections require explicit submit; close dismisses', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser(questions);
  const view = routed(<QuestionDialog />, fixture);
  await settle();
  await key(view, enter);
  expect(fixture.client.listPendingQuestions()).toHaveLength(1);
  await key(view, esc);
  expect(await outcome).toEqual({kind: 'dismissed'});
});
test('question free text submits valid SDK answer', async () => {
  const fixture = dialogFixture();
  fixture.client.setUserInputAvailable(true);
  const outcome = fixture.client.askUser(questions);
  const view = routed(<QuestionDialog />, fixture);
  await settle();
  await key(view, 'Nhập');
  await key(view, enter);
  await key(view, 'Custom mode');
  await key(view, enter);
  // Text-entry completion remounts a fresh picker.
  await key(view, 'Submit');
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
  await key(view, 'Submit');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Answer every');
  await key(view, '\u007f'); // query remains editable; closing must settle every pending question
  await key(view, esc);
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
  await key(view, target);
  await key(view, enter);
  expect(engine.isPreviewing()).toBe(true);
  expect(engine.getCommittedAppearance().theme).toBe(original);
  view.unmount();
  expect(engine.isPreviewing()).toBe(false);
  const applied = renderInk(<ThemesDialog />, {themeEngine: engine});
  await settle();
  await key(applied, target);
  await key(applied, enter);
  await key(applied, enter);
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
  expect(view.lastFrame()).toContain('Shift+Tab');
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

test('preset cycling hook opens Full Access confirmation without granting authority', async () => {
  function Cycle() {
    const permissions = usePermissions();
    return (
      <PickerDialog
        title="Cycle"
        items={[{id: 'cycle', label: 'Cycle preset'}]}
        onSelect={() => permissions.cyclePreset()}
      />
    );
  }
  const fixture = dialogFixture();
  const view = renderInk(<InkApp client={fixture.client} slots={{composer: <Cycle />}} />, {fixture});
  await settle();
  await key(view, enter);
  expect(view.lastFrame()).toContain('WITHOUT');
  expect(fixture.client.permissionPreset()).toBe('auto');
  await key(view, esc);
  expect(fixture.client.permissionPreset()).toBe('auto');
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
  expect(fixture.client.listPendingQuestions()).toHaveLength(1);
  view.unmount();
  expect(await outcome).toEqual({kind: 'dismissed'});
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
