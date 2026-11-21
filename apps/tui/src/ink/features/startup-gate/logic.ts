import type {AccountVerification} from '@cosmew/sdk';

export function verificationMessage(
  reason: Extract<AccountVerification, {ok: false}>['reason'],
  account = 'The provider account',
  providerHint?: string,
): string {
  switch (reason) {
    case 'no-account':
      return 'Sign in to send. Your draft is still here.';
    case 'auth':
      return 'Account access was rejected. Sign in again or switch accounts. Your draft is still here.';
    case 'network':
      return 'Could not verify the account connection. Sign in again or switch accounts. Your draft is still here.';
    case 'model':
      return 'Could not verify the model. Use /model to choose a model or switch accounts. Your draft is still here.';
    case 'billing':
      return [
        `${account} is out of credits or needs a subscription.`,
        providerHint && `Provider says: ${providerHint}`,
        'Your draft is still here.',
      ]
        .filter(Boolean)
        .join(' ');
  }
}
