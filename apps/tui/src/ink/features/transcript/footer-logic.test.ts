import {createElement} from 'react';
import {cleanup} from 'ink-testing-library';
import {InkApp} from '../../app';
import {dialogFixture} from '../picker/test-fixture';
import {render, renderInk, settle} from '../../testing';
import {buildKeymap, keymapStore} from '../../hooks/keymap';
import {DetailedFooter} from './detailed-footer';
import {afterEach, expect, test} from 'bun:test';
import {stringCells} from '../../ui/text-line';
import {composeDetailedFooter} from './footer-logic';

const base = {width: 120, toggleKey: 'ctrl+o', editorName: 'code', showingAll: false, searchActive: false};
const title = 'Showing detailed transcript · ctrl+o to toggle';

test('B2 uses the full virtual scroll hint only when it strictly fits', () => {
  const full = `${title} · ↑/↓ to scroll · v to open in code · ? for shortcuts`;
  expect(composeDetailedFooter(base)).toEqual({left: full, right: 'verbose '});
  const boundary = 2 + stringCells(full) + stringCells('verbose ');
  expect(composeDetailedFooter({...base, width: boundary}).left).toBe(`${title} · ? for shortcuts`);
  expect(composeDetailedFooter({...base, width: boundary + 1}).left).toBe(full);
  for (const width of [60, 80, 100]) {
    const {left} = composeDetailedFooter({...base, width});
    expect(left).not.toContain('↑/↓');
    if (width >= 80) expect(left).toBe(`${title} · ? for shortcuts`);
  }
});

test('B2 search, activity prefix and independent right badge precedence', () => {
  expect(composeDetailedFooter({...base, searchActive: true, badge: '2 of 7'})).toEqual({
    left: `${title} · n/N to navigate`,
    right: '2 of 7 ',
  });
  for (const status of ['working', 'dialog waiting'] as const) {
    const footer = composeDetailedFooter({...base, status});
    expect(footer.left).toStartWith(`${status} · ${title}`);
    expect(footer.right).toBe('');
    expect(composeDetailedFooter({...base, status, badge: '2 of 7'}).right.trimEnd()).toBe('2 of 7');
  }
  expect(composeDetailedFooter({...base, rightStatus: 'rendering…', badge: '2 of 7'}).right).toBe('rendering… ');
});

test('B2 non-virtual variants and remapped labels', () => {
  expect(composeDetailedFooter({...base, virtualScroll: false, showAllKey: 'ctrl+k'}).left).toBe(
    `${title} · ctrl+k to show all`,
  );
  expect(composeDetailedFooter({...base, virtualScroll: false, showingAll: true}).left).toBe(
    `${title} · ctrl+e to collapse`,
  );
  expect(
    composeDetailedFooter({...base, virtualScroll: false, suppressShowAll: true, editorName: undefined}).left,
  ).toBe(`${title} · v to open in editor`);
  expect(composeDetailedFooter({...base, toggleKey: 'alt+t', editorKey: 'x', helpKey: 'h'}).left).toBe(
    'Showing detailed transcript · alt+t to toggle · ↑/↓ to scroll · x to open in code · h for shortcuts',
  );
  expect(composeDetailedFooter({...base, searchActive: true, nextMatchKey: 'm', previousMatchKey: 'M'}).left).toBe(
    `${title} · m/M to navigate`,
  );
});

test('footer truncates the left end with an ellipsis after reserving indent and badge', () => {
  expect(composeDetailedFooter({...base, width: 40})).toEqual({
    left: 'Showing detailed transcript · …',
    right: 'verbose',
  });
});

test('cell budget property for every width 24–200, wide and long labels, all states', () => {
  for (let width = 24; width <= 200; width++)
    for (const status of [undefined, 'working', 'dialog waiting'] as const)
      for (const searchActive of [false, true])
        for (const virtualScroll of [false, true])
          for (const badge of [undefined, '2 of 7', '界'.repeat(120)]) {
            const footer = composeDetailedFooter({
              ...base,
              width,
              status,
              searchActive,
              virtualScroll,
              badge,
              toggleKey: '界'.repeat(width % 17),
              editorName: '編輯器'.repeat(width % 13),
            });
            expect(2 + stringCells(footer.left) + stringCells(footer.right)).toBeLessThanOrEqual(width);
            expect(footer.left + footer.right).not.toContain('\n');
          }
});

afterEach(() => {
  cleanup();
  keymapStore.reset();
});

test('inline shell keeps the full footer for an empty transcript with a draft at width 140', async () => {
  const fixture = dialogFixture({validateAccount: async () => ({models: 1, validation: 'fixture'})});
  const view = render(createElement(InkApp, {client: fixture.client, width: 140}));
  await settle();
  view.stdin.write('\x1b[A');
  await settle();
  view.stdin.write('\r');
  for (let wait = 0; wait < 100 && !view.lastFrame()?.includes('manual mode on'); wait++) await settle();
  expect(view.lastFrame()).toContain('manual mode on');
  view.stdin.write('keep this');
  await settle();
  view.stdin.write('\x0f');
  await settle();
  expect(view.lastFrame()).toContain('↑/↓ to scroll · v to open in');
  expect(view.lastFrame()).toContain('? for shortcuts');
  expect(view.lastFrame()).not.toContain('to show all');
  view.unmount();
});

test('rendered footer uses default arrows and updates hints after a live keymap remap', async () => {
  const view = renderInk(createElement(DetailedFooter, {width: 140, editorName: 'code'}));
  await settle();
  expect(view.lastFrame()).toContain('↑/↓ to scroll · v to open in code · ? for shortcuts');
  keymapStore.set(
    buildKeymap(
      JSON.stringify({
        bindings: [
          {context: 'Global', bindings: {'ctrl+o': null, 'alt+t': 'app:toggleTranscript'}},
          {context: 'Transcript', bindings: {v: null, x: 'transcript:openEditor', '?': null, h: 'transcript:help'}},
        ],
      }),
    ),
  );
  await settle();
  expect(view.lastFrame()).toContain('alt+t to toggle');
  expect(view.lastFrame()).toContain('x to open in code · h for shortcuts');
});
