/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {createClientFixture, renderInk, settle} from '../../testing';
import {ComposerFooter, StatusLine, contextLeft, footerSuffix, modeLine, shortcutWidths} from './index';
afterEach(cleanup);

test('footer uses exactly the reference mode strings; temporary text replaces the mode row', async () => {
  const labels = {
    default: '⏸ manual mode on',
    acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
    plan: '⏸ plan mode on (shift+tab to cycle)',
    bypassPermissions: '⏵⏵ bypass permissions on (shift+tab to cycle)',
  } as const;
  const view = renderInk(<ComposerFooter mode="default" width={100} />);
  for (const mode of Object.keys(labels) as (keyof typeof labels)[]) {
    expect(modeLine(mode)).toBe(labels[mode]);
    view.rerender(<ComposerFooter mode={mode} width={100} />);
    await settle();
    expect(view.lastFrame()).toBe('  ' + labels[mode]);
  }
  view.rerender(<ComposerFooter mode="plan" message="Esc again to clear" width={100} />);
  await settle();
  expect(view.lastFrame()).toBe('  Esc again to clear');
  view.rerender(<ComposerFooter mode="default" remaining={10} width={100} />);
  await settle();
  expect(view.lastFrame()).toBe(
    ' '.repeat(100 - 'Context left until auto-compact: 10%'.length) + 'Context left until auto-compact: 10%',
  );
});

test('context warning requires current measured usage, ignores estimates/stale/invalid limits, and starts below 20 percent', () => {
  const base = createClientFixture().client.context();
  const context = {
    ...base,
    outputReserve: 0,
    measuredCurrentHistory: true,
    lastMeasured: {
      source: 'provider' as const,
      usedTokens: 8100,
      limitTokens: 10000,
      measuredAt: '2026-11-19T00:00:00.000Z',
    },
  };
  expect(contextLeft(context)).toBe(10);
  expect(contextLeft({...context, measuredCurrentHistory: false})).toBeNull();
  expect(contextLeft({...context, lastMeasured: {...context.lastMeasured, source: 'estimate'}})).toBeNull();
  expect(contextLeft({...context, lastMeasured: {...context.lastMeasured, usedTokens: 7200}})).toBeNull();
  expect(contextLeft({...context, lastMeasured: {...context.lastMeasured, usedTokens: 10000}})).toBe(0);
  expect(contextLeft({...context, lastMeasured: {...context.lastMeasured, limitTokens: null}})).toBeNull();
  expect(contextLeft({...context, lastMeasured: {...context.lastMeasured, usedTokens: NaN}})).toBeNull();
  expect(contextLeft({...context, outputReserve: 10000})).toBeNull();
});

test('compatibility status export does not reintroduce model, cost, context, or extra hint rows', async () => {
  const client = createClientFixture().client;
  const view = renderInk(<StatusLine status={client.status()} usage={client.usage()} context={client.context()} />);
  await settle();
  expect(view.lastFrame()).toBe('');
});

test('suffixes follow the mode in the reference order and pluralise; bash and shortcut rows replace the mode', async () => {
  expect(footerSuffix({})).toEqual([]);
  expect(footerSuffix({busy: true, agents: 1})).toEqual(['esc to interrupt', '← 1 agent', '↓ to manage']);
  expect(footerSuffix({agents: 3, shells: 1})).toEqual(['1 shell', '← 3 agents', '↓ to manage']);
  expect(footerSuffix({shells: 2})).toEqual(['2 shells', '↓ to manage']);
  const view = renderInk(<ComposerFooter mode="plan" busy agents={1} width={100} />);
  await settle();
  expect(view.lastFrame()).toBe('  ⏸ plan mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent · ↓ to manage');
  view.rerender(<ComposerFooter mode="plan" bash busy agents={1} width={100} />);
  await settle();
  expect(view.lastFrame()).toBe('  ! for shell mode');
  expect(shortcutWidths(98)).toEqual([24, 35, 39]);
  expect(shortcutWidths(60)).toEqual([20, 20, 20]);
});
