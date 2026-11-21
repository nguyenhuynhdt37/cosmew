/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import type {TerminalMouseEvent, TerminalMouseInput} from '../../../input/mouse-input';
import {TerminalMouseProvider} from '../../hooks/use-terminal-wheel';
import {readFileSync} from 'node:fs';
import {cleanup} from 'ink-testing-library';
import {LiveDialog} from '../../ui/dialog-layout';
import {renderInk, settle} from '../../testing';
import {dialogFixture} from '../picker/test-fixture';
import {PlanApprovalDialog} from './index';
afterEach(cleanup);
function setup(extra: Parameters<typeof dialogFixture>[0] = {}) {
  const fixture = dialogFixture({
    ...extra,
    startSession: () => ({id: 's', selection: {accountId: 'a', modelId: 'm'}, messages: []}),
  });
  fixture.client.createSession();
  fixture.client.setPermissionMode('plan');
  fixture.client.setUserInputAvailable(true);
  const abort = new AbortController();
  const pending = fixture.client.proposePlan('# Add subtract\n' + 'Plan detail\n'.repeat(30), abort.signal);
  return {fixture, abort, pending};
}
test('plan choices remain reachable in 80x12; only explicit approval changes mode', async () => {
  const {fixture, abort, pending} = setup();
  const view = renderInk(
    <LiveDialog rows={12}>
      <PlanApprovalDialog width={80} visibleRows={2} onCancel={() => abort.abort()} />
    </LiveDialog>,
    {fixture},
  );
  await settle();
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(12);
  expect(view.lastFrame()).toContain('Yes, manually approve edits');
  expect(view.lastFrame()).toContain('Tell Cosmew what to change');
  expect(fixture.client.permissionMode()).toBe('plan');
  expect(view.lastFrame()).toContain('❯ 1. Yes');
  view.stdin.write('\x07');
  await settle();
  expect(view.lastFrame()).toContain('External editor is unavailable');
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('\r');
  await settle();
  expect(await pending).toEqual({kind: 'approved', mode: 'manual'});
  expect(fixture.client.permissionMode()).toBe('default');
});
test('feedback keeps plan mode and Escape cancels without approval', async () => {
  const {fixture, abort, pending} = setup();
  const view = renderInk(<PlanApprovalDialog onCancel={() => abort.abort()} />, {fixture});
  await settle();
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('Add tests');
  await settle();
  expect(fixture.client.pendingPlanApproval()).not.toBeNull();
  expect(fixture.client.permissionMode()).toBe('plan');
  view.stdin.write('\r');
  await settle();
  expect(await pending).toEqual({kind: 'feedback', feedback: 'Add tests'});
  expect(fixture.client.permissionMode()).toBe('plan');
  view.unmount();
  const second = setup();
  const cancelled = second.pending.catch(error => error.code);
  const other = renderInk(<PlanApprovalDialog onCancel={() => second.abort.abort()} />, {fixture: second.fixture});
  await settle();
  other.stdin.write('\x1b');
  await settle();
  expect(await cancelled).toBe('CANCELLED');
  expect(second.fixture.client.permissionMode()).toBe('plan');
});

test('accept edits is explicit and unavailable proposals cannot be approved late', async () => {
  const {fixture, abort, pending} = setup();
  const view = renderInk(<PlanApprovalDialog onCancel={() => abort.abort()} />, {fixture});
  await settle();
  view.stdin.write('1');
  await settle();
  expect(await pending).toEqual({kind: 'approved', mode: 'acceptEdits'});
  expect(fixture.client.permissionMode()).toBe('acceptEdits');
  expect(fixture.client.pendingPlanApproval()).toBeNull();
});

test('plan uses measured light and dark selection and rule colours', () => {
  type ReferenceRun = [number, number, string, string, boolean, boolean, boolean, string];
  const reference = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../docs/delivery/tui-v4/reference/live-120x36/L12-plan-approval.colors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as [number, ReferenceRun[]][];
  const runs = reference.flatMap(([, entries]) => entries);
  const rgb = (hex: string) => [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(';');
  const darkSelection = runs.find(run => run[7].includes('❯'))?.[2];
  const darkRule = runs.find(run => run[7].startsWith('▔'))?.[2];
  expect(darkSelection).toBeDefined();
  expect(darkRule).toBeDefined();
  for (const [mode, selection, rule] of [
    ['light', '5;114;126', '52;101;164'],
    ['dark', rgb(darkSelection!), rgb(darkRule!)],
  ]) {
    const result = Bun.spawnSync({
      cmd: [process.execPath, `${import.meta.dir}/colors-fixture.tsx`, mode!],
      env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const frame = JSON.parse(new TextDecoder().decode(result.stdout)) as string;
    expect(frame).toContain(`\x1b[38;2;${selection}m❯ `);
    expect(frame).toContain(`\x1b[38;2;${rule}m`);
  }
});

test('late Enter after backend cancellation cannot approve the stale plan or widen permissions', async () => {
  const {fixture, abort, pending} = setup();
  const outcome = pending.catch(error => error.code);
  const view = renderInk(<PlanApprovalDialog onCancel={() => abort.abort()} />, {fixture});
  await settle();
  abort.abort();
  expect(await outcome).toBe('CANCELLED');
  view.stdin.write('1');
  await settle();
  expect(fixture.client.pendingPlanApproval()).toBeNull();
  expect(fixture.client.permissionMode()).toBe('plan');
  expect(view.lastFrame()).not.toContain('bypass');
});

test('Shift+Tab approves feedback atomically and Ctrl+G publishes an edited revision without grants', async () => {
  const {fixture, abort, pending} = setup();
  const seen: string[] = [];
  const view = renderInk(
    <PlanApprovalDialog
      onCancel={() => abort.abort()}
      onEdit={async text => {
        seen.push(text);
        return '# Reviewed revision';
      }}
    />,
    {fixture},
  );
  await settle();
  view.stdin.write('\x07');
  await settle();
  expect(seen).toHaveLength(1);
  expect(fixture.client.pendingPlanApproval()?.plan).toBe('# Reviewed revision');
  expect(fixture.client.permissionMode()).toBe('plan');
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('\x1b[B');
  await settle();
  view.stdin.write('Add tests');
  await settle();
  view.stdin.write('\x1b[Z');
  await settle();
  expect(await pending).toEqual({
    kind: 'approved',
    mode: 'acceptEdits',
    feedback: 'Add tests',
    plan: '# Reviewed revision',
  });
  expect(fixture.client.permissionMode()).toBe('acceptEdits');
});

test('a cancelled pending review refuses the text from an editor still running', async () => {
  const {fixture, abort, pending} = setup();
  const cancelled = pending.catch(error => error.code);
  let finish!: (text: string) => void;
  const view = renderInk(
    <PlanApprovalDialog
      onCancel={() => abort.abort()}
      onEdit={() =>
        new Promise(resolve => {
          finish = resolve;
        })
      }
    />,
    {fixture},
  );
  await settle();
  view.stdin.write('\x07');
  await settle();
  abort.abort();
  expect(await cancelled).toBe('CANCELLED');
  finish('# Too late');
  await settle();
  expect(fixture.client.pendingPlanApproval()).toBeNull();
  expect(fixture.client.permissionMode()).toBe('plan');
});

test('the footer names the host editor and authoritative artifact path at 80x36', async () => {
  const {fixture, abort, pending} = setup({
    savePlanProposal: (_id, proposal) => ({...proposal, path: '/private/plans/proposal.md'}),
  });
  const cancelled = pending.catch(error => error.code);
  const view = renderInk(
    <LiveDialog rows={36}>
      <PlanApprovalDialog width={80} editorLabel="Neovim" onCancel={() => abort.abort()} />
    </LiveDialog>,
    {fixture},
  );
  await settle();
  expect(view.lastFrame()).toContain('ctrl+g to edit in Neovim · /private/plans/proposal.md');
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(36);
  abort.abort();
  expect(await cancelled).toBe('CANCELLED');
});

test('plan wheel scrolls its proposal and clicking approval only highlights until Enter', async () => {
  const {fixture, abort, pending} = setup();
  const listeners = new Set<(event: TerminalMouseEvent) => void>();
  const source: TerminalMouseInput = {
    stdin: {} as TerminalMouseInput['stdin'],
    subscribe: () => () => {},
    subscribeMouse: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => listeners.clear(),
  };
  const view = renderInk(
    <TerminalMouseProvider value={source}>
      <PlanApprovalDialog width={80} visibleRows={2} onCancel={() => abort.abort()} />
    </TerminalMouseProvider>,
    {fixture},
  );
  await settle();
  const row = (text: string) => {
    const index = view
      .lastFrame()!
      .split('\n')
      .findIndex(line => line.includes(text));
    expect(index).toBeGreaterThanOrEqual(0);
    return index + 1;
  };
  for (const listener of [...listeners]) listener({direction: 1, column: 4, row: row('Add subtract')});
  await settle();
  expect(view.lastFrame()).not.toContain('Add subtract');
  for (const listener of [...listeners]) listener({kind: 'click', column: 5, row: row('manually approve')});
  await settle();
  expect(view.lastFrame()).toContain('❯ 2. Yes, manually approve edits');
  expect(fixture.client.pendingPlanApproval()).not.toBeNull();
  expect(fixture.client.permissionMode()).toBe('plan');
  view.stdin.write('\r');
  await settle();
  expect(await pending).toEqual({kind: 'approved', mode: 'manual'});
});

test('plan diff fences use the shared signed gutter and hanging indent', async () => {
  const {Markdown} = await import('../../ui');
  const view = renderInk(<Markdown text={'```diff\n@@ -0,0 +138,1 @@\n+' + 'x'.repeat(300) + '\n```'} width={40} />);
  await settle();
  const rows = view.lastFrame()!.split('\n');
  expect(rows[0]).toContain('@@');
  expect(rows[1]).toStartWith(' 138 +');
  expect(rows.slice(2).every(row => !row.includes('+') && row.startsWith('      '))).toBe(true);
});
