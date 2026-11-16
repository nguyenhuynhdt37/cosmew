import { expect, test } from 'bun:test';
import type { Account } from '@futryn/contracts';
import { StartupGate, clampOption, gateRows, suggestedAlternative, type TuiHost } from '@futryn/tui';

/**
 * The gate depends only on the TuiHost seam, so its state machine can be driven with a
 * hand-written host. These checks cover branches the full app cannot reach deterministically.
 */
const account = (id: string, status: Account['status'] = 'valid'): Account => ({ id, alias: id, providerId: 'p', status, authGeneration: 1 } as unknown as Account);

function harness(options: { accounts?: Account[]; selection?: boolean; command?: () => Promise<void> } = {}) {
  const accounts = options.accounts ?? [account('a')];
  const calls = { banner: [] as (string | null)[], grants: 0, exit: 0, overlays: [] as string[], diagnose: 0, ran: [] as string[] };
  const state = { overlay: 'none', accounts };
  const client = {
    status: () => ({ activeAccount: state.accounts[0], selection: options.selection === false ? undefined : { accountId: 'a', modelId: 'm' }, workspace: '/w' }),
    listAccounts: () => state.accounts,
    diagnose: async () => { calls.diagnose++; return 'ok'; },
    discoverModels: async () => ({ models: [] }),
    useAccount: () => accounts[0],
  };
  const host = {
    client, themeEngine: {}, cols: 80, rows: 24, isStreaming: false, composerDraft: '', workspaceAccess: false,
    grantWorkspaceAccess: () => { calls.grants++; },
    get overlay() { return state.overlay; },
    openOverlay: (o: string) => { state.overlay = o; calls.overlays.push(o); },
    closeOverlay: () => { state.overlay = 'none'; },
    setBanner: (m: string | null) => { calls.banner.push(m); },
    requestExit: () => { calls.exit++; },
    syncTranscript: () => {},
    runSlashCommand: async (raw: string) => { calls.ran.push(raw); await options.command?.(); },
    describeError: () => 'described',
    features: { models: { showMessage: () => {}, awaitModelForAccount: () => {} }, accounts: { switching: false, continueWithAccount: async () => true } },
  } as unknown as TuiHost;
  return { gate: new StartupGate(host), calls, state };
}
const until = async (fn: () => boolean) => { const end = Date.now() + 2000; while (!fn() && Date.now() < end) await Bun.sleep(5); expect(fn()).toBe(true); };

test('a startup command that throws is a command error, not an account failure', async () => {
  const h = harness({ command: async () => { throw new Error('boom'); } });
  h.gate.start('/anything');
  await h.gate.handleKey('ArrowUp'); await h.gate.handleKey('Enter');
  await until(() => h.calls.ran.length === 1);
  await h.gate.shutdown();
  expect(h.calls.grants).toBe(1);               // consent was recorded before anything ran
  expect(h.gate.phase).toBe('off');              // the account was verified and stays open
  expect(h.calls.banner).toContain('described'); // the failure surfaces as a message
});

test('verification is skipped until a model exists, then runs exactly once after selection', async () => {
  const h = harness({ selection: false });
  h.gate.start();
  await h.gate.handleKey('ArrowUp'); await h.gate.handleKey('Enter');
  await until(() => h.calls.overlays.includes('models'));
  expect(h.calls.diagnose).toBe(0);
});

test('Esc and Ctrl+C during consent exit without verifying', async () => {
  for (const key of ['Escape', 'Ctrl+C']) {
    const h = harness(); h.gate.start();
    expect(await h.gate.handleKey(key)).toBe(true);
    expect(h.calls.exit).toBe(1); expect(h.calls.diagnose).toBe(0); expect(h.calls.grants).toBe(0);
  }
});

test('the cursor is clamped when the account list shrinks underneath it', () => {
  expect(clampOption(5, 2)).toBe(1);
  expect(clampOption(-1, 3)).toBe(0);
  expect(clampOption(4, 0)).toBe(0);
});

test('failed account is skipped when proposing an alternative, falling back to sign-in', () => {
  const list = [account('a'), account('b', 'invalid'), account('c')];
  expect(suggestedAlternative(list, 'a')).toBe(2);
  expect(suggestedAlternative([account('a')], 'a')).toBe(1);
});

test('the footer keeps its row and no dialog row is overwritten, even on tiny heights', () => {
  const tokens = new Proxy({}, { get: (_t, k) => String(k) }) as never;
  for (const height of [4, 5, 7, 9, 10]) {
    for (const phase of ['trust', 'choose', 'checking'] as const) {
      const rows = gateRows({ phase, index: 0, message: 'm', workspace: '/w', activeAlias: 'a', elapsedSeconds: 3, accounts: [account('a'), account('b')], width: 40, height, tokens });
      expect(rows.length).toBe(height);
      expect(rows.at(-1)!.text).toContain('Enter');
    }
  }
});

test('the checking screen shows the model under test, elapsed time and the timeout', () => {
  const tokens = new Proxy({}, { get: (_t, k) => String(k) }) as never;
  const rows = gateRows({ phase: 'checking', index: 0, message: '', workspace: '/w', activeAlias: 'main', model: 'gpt-x', elapsedSeconds: 7, accounts: [], width: 60, height: 7, tokens });
  const text = rows.map(r => r.text).join('\n');
  expect(text).toContain('main · gpt-x'); expect(text).toContain('7s'); expect(text).toContain('Esc to cancel');
});
