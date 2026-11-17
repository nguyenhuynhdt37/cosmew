import {FutrynError, type Account, type Provider} from '@futryn/contracts';
import type {Application} from '../bootstrap/startup';

/** Shared line/administration subscription UX. Prints public authorization
 * instructions only; the official runtime and OS vault own secret material. */
export async function loginSubscription(
  app: Application,
  provider: Provider,
  alias: string,
  signal: AbortSignal,
  existing?: Account,
  device = false,
): Promise<Account> {
  const client = app.createFutrynClient();
  const methodId =
    provider.auth === 'oauth' ? 'oauth-browser' : device ? 'subscription-device' : 'subscription-browser';
  const integration = client.listIntegrations().find(i => i.provider.id === provider.id);
  const method = integration?.methods.find(m => m.id === methodId);
  if (method?.available === false) {
    process.stderr.write((method.diagnostic ?? 'Install the official runtime.') + '\n');
    throw new FutrynError('RUNTIME_UNAVAILABLE');
  }
  const challenge = await client.beginProviderAuth(provider.id, methodId);
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
