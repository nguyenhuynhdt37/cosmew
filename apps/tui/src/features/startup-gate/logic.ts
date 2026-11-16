import type { Account, ThemeTokens } from '@futryn/contracts';
import type { GateRow, StartupPhase } from './types';

/** A verification request that takes longer than this is reported as a timeout. */
export const CHECK_TIMEOUT_SECONDS = 20;

/** Overlays the gate lets through while the user signs in. */
export const GATE_OVERLAYS: readonly string[] = ['connect', 'models'];
/** Global shortcuts that must not open other overlays during sign-in. */
export const GATE_BLOCKED_KEYS: readonly string[] = ['Ctrl+P', 'Ctrl+T', 'Ctrl+L', 'Ctrl+S', 'Ctrl+D', 'Ctrl+B', 'Ctrl+N'];

/** Accounts the user may still pick from (signed-out ones are hidden). */
export const selectableAccounts = (accounts: Account[]): Account[] => accounts.filter(account => account.status !== 'logged-out');

/** Number of rows the keyboard cursor can land on. */
export const optionCount = (phase: StartupPhase, accounts: Account[]): number => (phase === 'trust' ? 2 : accounts.length + 1);

/** Keep the cursor inside the list even when accounts changed underneath it. */
export const clampOption = (index: number, count: number): number => Math.max(0, Math.min(index, Math.max(0, count - 1)));

/** Which account to pre-select after a failed check: the first other usable one, else "sign in". */
export function suggestedAlternative(accounts: Account[], failedId: string): number {
  const other = accounts.findIndex(candidate => candidate.id !== failedId && candidate.status !== 'invalid');
  return other < 0 ? accounts.length : other;
}

export const TIMEOUT_MESSAGE = `Check timed out after ${CHECK_TIMEOUT_SECONDS}s. Retry, or choose another account.`;

export function failureMessage(code: string): string {
  return ['AUTH', 'FORBIDDEN'].includes(code)
    ? 'Account access was rejected. Choose another or sign in again.'
    : `Check failed (${code}). Check connection and retry, or choose another account.`;
}

export interface GateContent {
  phase: Exclude<StartupPhase, 'off' | 'login'>;
  index: number;
  message: string;
  workspace: string;
  activeAlias: string;
  /** Model being tested, if any. */
  model?: string;
  /** Seconds since the verification request started. */
  elapsedSeconds: number;
  accounts: Account[];
  width: number;
  height: number;
  tokens: ThemeTokens;
}

/** Rows of the dialog, exactly `height` of them; the footer always stays the last row. */
export function gateRows(c: GateContent): GateRow[] {
  const { tokens, width: w, height: h } = c;
  const rows: GateRow[] = [];
  const add = (text: string, fg = tokens.foreground, bold = false) => rows.push({ text, fg, bold });
  const option = (selected: boolean, label: string) => add(`${selected ? '›' : ' '} ${label}`, selected ? tokens.accent : tokens.foreground, selected);

  if (c.phase === 'trust') {
    add('Trust this folder?', tokens.accent, true);
    const path = c.workspace.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    const available = Math.max(1, w - 4);
    add(path.length > available ? '…' + path.slice(-(available - 1)) : path, tokens.foregroundMuted);
    if (h >= 9) add('Futryn may read files here and send them to the model.');
    add(w < 35 ? 'May incur cost.' : 'Account check sends a small, potentially billed request.', tokens.warning);
    option(c.index === 0, 'Allow for this session');
    option(c.index === 1, 'Exit');
  } else if (c.phase === 'checking') {
    add('Checking account…', tokens.accent, true);
    add(c.model ? `${c.activeAlias} · ${c.model}` : c.activeAlias, tokens.foregroundMuted);
    add(`Sending a small test request… ${c.elapsedSeconds}s`);
    if (h >= 6) add(`Gives up after ${CHECK_TIMEOUT_SECONDS}s. Esc to cancel.`, tokens.foregroundSubtle);
  } else {
    add('Choose an account', tokens.accent, true);
    if (h >= 8) add(c.message || 'Select an account or sign in.', tokens.warning);
    const choices = [...c.accounts.map(account => `${account.alias} · ${account.providerId}`), 'Sign in to another account'];
    const room = Math.max(1, h - (h >= 8 ? 4 : 3));
    const start = Math.max(0, Math.min(c.index - room + 1, choices.length - room));
    for (const [offset, text] of choices.slice(start, start + room).entries()) option(start + offset === c.index, text);
  }

  const body = rows.slice(0, Math.max(0, h - 1));
  while (body.length < h - 1) body.push({ text: '', fg: tokens.foreground });
  body.push({ text: w >= 35 ? '↑↓ Choose · Enter Continue · Esc Exit' : '↑↓  Enter  Esc', fg: tokens.foregroundSubtle });
  return body.slice(0, h);
}

/** Dialog height per phase (before clamping to the terminal). */
export const gateHeight = (phase: StartupPhase): number => (phase === 'checking' ? 7 : 10);
