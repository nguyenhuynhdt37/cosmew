import {expect, test} from 'bun:test';
import {defaultAppearance, FutrynError, type PendingQuestion} from '@cosmew/contracts';
import {SLASH_COMMANDS} from '@cosmew/sdk';
import {permissionChoices, isEscalation} from '../permissions';
import {stateFor, choose, answersFor, collect} from '../question';
import {connectionChoices, parseHeaderDraft, describeProviderError} from '../connect';
import {configurationRows, settingsRows, clampStep, SETTINGS_SECTIONS} from '../settings';
import {formatDuration, tokenTotal, transcriptLines, typeRow, childRow} from '../agents';
import {helpItems} from '../help';
import {describeDialogError} from './index';
import {dialogFixture, provider, account, child} from './test-fixture';
test('permission choices number offered scopes contiguously and require an offered always rule', () => {
  const fixture = dialogFixture();
  const request = fixture.client.enqueuePermissionRequest({
    capability: 'network.connect',
    action: 'Allow network access to api.test',
    target: 'api.test',
    reason: 'Fetch',
    decisions: ['once'],
  });
  expect(permissionChoices(request).map(c => c.key)).toEqual(['1', '2']);
  expect(permissionChoices({...request, decisions: ['session', 'always']} as typeof request).map(c => c.id)).toEqual([
    'session',
    'deny',
  ]);
  expect(isEscalation({...request, action: 'Run WITHOUT SANDBOX in .'})).toBe(true);
  expect(isEscalation(request)).toBe(false);
});
test('question logic preserves multiselect, free text, and locates missing answers', () => {
  const request: PendingQuestion = {
    questionId: 'q',
    createdAt: new Date().toISOString(),
    questions: [
      {
        id: 'pick',
        header: 'Pick',
        question: 'Choose',
        multiple: true,
        options: [
          {label: 'One', description: ''},
          {label: 'Two', description: ''},
        ],
      },
      {id: 'single', header: 'Single', question: 'Choose', options: [{label: 'Yes', description: ''}]},
    ],
  };
  const state = stateFor(request);
  const q = request.questions[0]!;
  expect(collect(request, state)).toEqual({ok: false, missing: 0});
  state.answers[0] = choose(q, choose(q, state.answers[0]!, 1), 0);
  expect(answersFor(q, {...state.answers[0]!, other: ' Other '})).toEqual(['One', 'Two', 'Other']);
  expect(collect(request, state)).toEqual({ok: false, missing: 1});
  state.answers[1] = choose(request.questions[1]!, {...state.answers[1]!, other: 'Old text'}, 0);
  expect(state.answers[1].other).toBe('');
  expect(collect(request, state)).toEqual({
    ok: true,
    answers: {pick: {answers: ['One', 'Two']}, single: {answers: ['Yes']}},
  });
  expect(choose(q, state.answers[0]!, 99)).toBe(state.answers[0]!);
  expect(choose(q, state.answers[0]!, 0).chosen).toEqual([1]);
});
test('provider choices preserve advanced, account actions and custom protocols', () => {
  const integrations = [
    {
      provider,
      notice: '',
      methods: [
        {id: 'api-key' as const, name: 'Key', description: ''},
        {id: 'env' as const, name: 'Environment', description: '', advanced: true},
      ],
    },
  ];
  const base = {step: 'provider' as const, query: '', selectedIndex: 0, aliasDraft: '', secretDraft: '', draft: ''};
  expect(connectionChoices(base, integrations, [account]).some(c => c.id === '__custom')).toBe(true);
  expect(
    connectionChoices({...base, step: 'method', providerId: provider.id}, integrations, [account]).map(c => c.id),
  ).toEqual(['api-key', '__advanced']);
  expect(
    connectionChoices({...base, step: 'method', providerId: provider.id, showAdvanced: true}, integrations, [
      account,
    ]).some(c => c.id === 'env'),
  ).toBe(true);
  expect(
    connectionChoices({...base, step: 'actions', accountId: account.id}, integrations, [account], account.id).find(
      c => c.id === 'switch',
    )?.disabled,
  ).toBe(true);
  expect(connectionChoices({...base, step: 'protocol'}, integrations, []).map(c => c.id)).toEqual([
    'chat',
    'responses',
    'anthropic',
    'gemini',
  ]);
  expect(connectionChoices({...base, step: 'catalog'}, integrations, []).map(c => c.id)).toContain('manual');
});
test('header parsing and provider errors never echo secret input', () => {
  expect(parseHeaderDraft('X-Client=terminal; Authorization=$API_TOKEN')).toEqual({
    httpHeaders: {'X-Client': 'terminal'},
    envHttpHeaders: {Authorization: 'API_TOKEN'},
  });
  expect(parseHeaderDraft('private-secret-value')).not.toContain('private-secret-value');
  const fixture = dialogFixture();
  expect(describeProviderError(fixture.client, new Error('private-secret'), provider.id)).not.toContain(
    'private-secret',
  );
  expect(describeProviderError(fixture.client, new FutrynError('AUTH'), provider.id)).toContain('Credential');
  expect(describeDialogError(new Error('token-secret'))).not.toContain('token-secret');
});
test('settings reports every supported section and every appearance control from SDK state', () => {
  const fixture = dialogFixture();
  for (const section of SETTINGS_SECTIONS)
    expect(configurationRows(fixture.client, section, defaultAppearance(), 'dark').length).toBeGreaterThan(0);
  expect(settingsRows(defaultAppearance(), 'light')).toHaveLength(13);
  expect(clampStep(0.9, 0.5, 0, 1)).toBe(1);
  expect(clampStep(1, -5, 0, 1)).toBe(0);
  expect(
    configurationRows(fixture.client, 'General', defaultAppearance(), 'dark').find(
      r => r.label === 'Terminal shortcuts',
    )?.value,
  ).toContain('keybindings.json');
  expect(
    configurationRows(fixture.client, 'Sessions', defaultAppearance(), 'dark').find(
      r => r.label === 'Manual compaction',
    )?.value,
  ).toContain('/compact');
});
test('agent transcript retains tool failure and text; bounded duration/usage formatting is stable', () => {
  expect(formatDuration(61000)).toBe('1m01s');
  expect(formatDuration(-1)).toBe('0s');
  expect(formatDuration(3600000)).toBe('1h0m');
  expect(tokenTotal(null)).toBe(0);
  expect(typeRow({name: 'review', source: 'user', description: 'Review code', tools: []})).toContain('no tools');
  expect(childRow(child, false, Date.parse(child.createdAt) + 2000)).toContain('2s');
  expect(
    transcriptLines({
      ...child,
      steps: [
        {kind: 'tool', toolName: 'read', target: 'file.ts', status: 'denied', output: 'Permission denied'},
        {kind: 'text', text: 'No data'},
      ],
    }).join('\n'),
  ).toContain('[denied]');
});
test('help commands are generated from SLASH_COMMANDS with no duplicate command registry', () => {
  const items = helpItems();
  for (const command of SLASH_COMMANDS.filter(c => c.help !== false))
    expect(items.some(i => i.id === command.command)).toBe(true);
});
