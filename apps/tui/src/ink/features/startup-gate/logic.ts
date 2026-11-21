import type {Account} from '@cosmew/contracts';

/** A verification request that takes longer than this is reported as a timeout. */
export const CHECK_TIMEOUT_SECONDS = 20;

/** Accounts the user may still pick from (signed-out ones are hidden). */
export const selectableAccounts = (accounts: Account[]): Account[] =>
  accounts.filter(account => account.status !== 'logged-out');

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
