import {FutrynError, type Account, type Integration} from '@futryn/contracts';
import type {FutrynClient} from '@futryn/sdk';
import type {ConnectProviderState} from './types';

export function filterIntegrations(integrations: Integration[], query: string): Integration[] {
  const q = query.trim().toLowerCase();
  return integrations.filter(i =>
    `${i.provider.name} ${i.provider.id} ${i.provider.baseURL} ${i.providerIds?.join(' ') ?? ''} ${i.methods.map(m => m.name).join(' ')}`
      .toLowerCase()
      .includes(q),
  );
}
export function connectionChoices(
  state: ConnectProviderState,
  integrations: Integration[],
  accounts: Account[],
  activeAccountId?: string | null,
): {id: string; label: string; disabled?: boolean}[] {
  const integration = integrations.find(i => (i.providerIds ?? [i.provider.id]).includes(state.providerId!));
  const nameOf = (id: string) =>
    integrations.find(i => (i.providerIds ?? [i.provider.id]).includes(id))?.provider.name ?? id;
  switch (state.step) {
    case 'provider':
      return [
        ...filterIntegrations(integrations, state.query).map(i => ({
          id: i.provider.id,
          label: `${i.provider.name}${accounts.some(a => (i.providerIds ?? [i.provider.id]).includes(a.providerId) && a.status === 'valid') ? ' · Connected' : ''}`,
        })),
        {id: '__custom', label: 'Custom provider · any gateway or endpoint (9Router, LiteLLM…)'},
      ];
    case 'method':
      return [
        ...(integration?.methods
          .filter(
            m =>
              (!state.accountId ||
                !m.providerId ||
                m.providerId === accounts.find(a => a.id === state.accountId)?.providerId) &&
              (!m.advanced || state.showAdvanced),
          )
          .map(m => ({id: m.id, label: `${m.name}${m.available === false ? ' · Unavailable' : ''}`})) ?? []),
        ...(integration?.methods.some(m => m.advanced)
          ? [{id: '__advanced', label: state.showAdvanced ? 'Fewer options' : 'More options…'}]
          : []),
      ];
    case 'protocol':
      return ['chat', 'responses', 'anthropic', 'gemini'].map(id => ({id, label: id}));
    case 'auth':
      return [
        {id: 'api-key', label: 'API key'},
        {id: 'none', label: 'No authentication — public/local endpoint'},
      ];
    case 'catalog':
      return [
        {id: 'openai', label: 'Discover models · OpenAI /models'},
        {id: 'anthropic', label: 'Discover models · Anthropic /models'},
        {id: 'gemini', label: 'Discover models · Gemini'},
        {id: 'ollama', label: 'Discover models · Ollama /api/tags'},
        {id: 'manual', label: 'Manual model ID · validate with a real generation'},
      ];
    case 'accounts':
      return accounts
        .filter(a => !state.providerId || a.providerId === state.providerId)
        .filter(a =>
          `${a.alias} ${a.providerId} ${nameOf(a.providerId)}`.toLowerCase().includes(state.query.toLowerCase()),
        )
        .map(a => ({
          id: a.id,
          disabled: state.switchOnly && a.id === activeAccountId,
          label: `${state.switchOnly ? accounts.findIndex(item => item.id === a.id) + 1 + '. ' : ''}${a.alias}  ·  ${state.switchOnly || state.logoutOnly ? nameOf(a.providerId) + (a.status === 'logged-out' ? ' · Signed out' : '') : a.providerId + ' · ' + a.status}`,
        }));
    case 'actions':
      return ['switch', 'add', 'rename', 'reconnect', 'logout', 'remove'].map(id => ({
        id,
        disabled: id === 'switch' && state.accountId === activeAccountId,
        label: {
          switch: state.accountId === activeAccountId ? 'Already active' : 'Switch account and choose model',
          add: 'Add another account',
          rename: 'Rename account',
          reconnect: 'Reconnect / replace credential',
          logout: 'Logout · delete local credential',
          remove: 'Remove account and local credential',
        }[id]!,
      }));
    case 'confirm':
      return [
        {id: 'cancel', label: 'Cancel'},
        {
          id: 'confirm',
          label:
            state.pendingAction === 'switch'
              ? 'Continue with this account'
              : state.pendingAction === 'remove'
                ? 'Remove account'
                : 'Sign out',
        },
      ];
    default:
      return [];
  }
}

const SUBSCRIPTION_HINTS = (name: string): Record<string, string> => ({
  AUTH: `${name} sign-in could not be verified. Try signing in again.`,
  FORBIDDEN: `${name} signed in, but subscription access was denied. Check your plan or organization policy.`,
  STORAGE: 'Secure sign-in storage is unavailable. Unlock the OS keyring and retry.',
  INVALID_INPUT:
    'This sign-in may already belong to another profile. Use the existing profile or sign in with a different account.',
  POLICY: 'This account is busy or changed. Cancel the active request and retry.',
  TRANSPORT: `${name} could not be reached. Check the network and retry.`,
});

const PROVIDER_HINTS: Record<string, string> = {
  AUTH: 'Credential rejected or missing. Reconnect with a valid API key or environment variable.',
  FORBIDDEN: 'Access denied. Check API entitlement, billing and endpoint permissions.',
  STORAGE:
    'OS keyring unavailable or storage failed. Unlock the keyring or choose an environment reference. Retry /logout if cleanup failed.',
  TRANSPORT: 'Endpoint unreachable. Check base URL, network and server availability.',
  TIMEOUT: 'Endpoint timed out. Check the server and retry.',
  CANCELLED: 'Authentication cancelled; new credentials removed.',
  POLICY: 'Policy denied the endpoint or account. Use HTTPS or explicit loopback HTTP.',
  NOT_FOUND: 'Provider/model not found. Check the URL, discovery protocol or manual model ID.',
  RATE_LIMIT: 'Provider rate limited this request. Wait and retry.',
  INVALID_INPUT: 'Check the fields and use a unique provider/account name.',
};

/** Redacted, actionable text for a provider failure; never includes response bodies. */
export function describeProviderError(client: FutrynClient, error: unknown, providerId: string | undefined): string {
  const code = error instanceof FutrynError ? error.code : 'INVALID_INPUT';
  const provider =
    client.listProviders().find(p => p.id === providerId) ??
    client.listIntegrations().find(i => i.provider.id === providerId)?.provider;
  if (provider?.auth === 'oauth') {
    const hint = SUBSCRIPTION_HINTS(provider.name)[code];
    if (hint) return `${code}: ${hint}`;
  }
  return `${code}: ${PROVIDER_HINTS[code] ?? 'Provider response was invalid. Check API protocol and model discovery settings.'}`;
}

/** Environment variable NAME (not value) accepted for env-reference credentials. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
/** Custom provider IDs. */
export const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
/** Control characters never belong in a typed draft. */
export const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/** `Name=Value; Name2=$ENV_VAR` → static and environment-backed headers; a string is an error message. */
export function parseHeaderDraft(
  draft: string,
): {httpHeaders?: Record<string, string>; envHttpHeaders?: Record<string, string>} | string {
  const httpHeaders: Record<string, string> = {};
  const envHttpHeaders: Record<string, string> = {};
  for (const part of draft
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)) {
    const at = part.indexOf('=');
    if (at <= 0) return 'Invalid header: expected Name=Value or Name=$ENV_VAR.';
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (value.startsWith('$')) envHttpHeaders[name] = value.slice(1);
    else httpHeaders[name] = value;
  }
  return {
    ...(Object.keys(httpHeaders).length ? {httpHeaders} : {}),
    ...(Object.keys(envHttpHeaders).length ? {envHttpHeaders} : {}),
  };
}
