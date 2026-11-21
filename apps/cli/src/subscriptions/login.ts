import {FutrynError, type Account, type Provider} from '@cosmew/contracts';
import type {Application} from '../bootstrap/startup';

/** Browser sign-in (ChatGPT OAuth + PKCE, ADR 0047) for the CLI. Prints public authorization
 * instructions only; tokens go to the OS keyring. */
export async function loginOAuth(
  app: Application,
  provider: Provider,
  alias: string,
  signal: AbortSignal,
  existing?: Account,
): Promise<Account> {
  if (provider.auth !== 'oauth') throw new FutrynError('UNSUPPORTED');
  const client = app.createFutrynClient();
  const challenge = await client.beginProviderAuth(provider.id, 'oauth-browser');
  let previous = '';
  const display = () => {
    try {
      const progress = client.providerAuthProgress(challenge.id);
      const value = [
        progress.message,
        progress.authorizationURL,
        progress.userCode ? `Device code: ${progress.userCode}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      if (value && value !== previous) {
        process.stdout.write(app.redactor.text(value) + '\n');
        previous = value;
      }
    } catch {
      /* completion consumed the challenge */
    }
  };
  display();
  const timer = setInterval(display, 150);
  try {
    return await client.connectAccount(
      {
        providerId: provider.id,
        alias,
        reauthenticateAccountId: existing?.id,
        credential: {kind: 'keyring', key: crypto.randomUUID()},
        authChallengeId: challenge.id,
      },
      signal,
    );
  } finally {
    clearInterval(timer);
    await client.cancelProviderAuth(challenge.id);
  }
}
