import type { Account, AuthMethod, ProviderAuthChallenge, BorderStyle, Integration, Provider, ThemeTokens } from '@hannes/contracts';
import type { RenderedBoxLine } from '../components/editor';

export type ConnectStep = 'provider' | 'method' | 'alias' | 'secret' | 'env' | 'custom-id' | 'url' | 'protocol' | 'auth' | 'catalog' | 'manual' | 'accounts' | 'actions' | 'rename' | 'confirm' | 'busy' | 'oauth';
export interface ConnectProviderState {
  selectedProviderIndex: number;
  selectedIndex: number;
  query: string;
  scrollOffset?: number;
  step: ConnectStep;
  aliasDraft: string;
  secretDraft: string;
  draft: string;
  providerId?: string;
  accountId?: string;
  method?: AuthMethod['id'];
  custom?: Partial<Provider>;
  customModelId?: string;
  authChallenge?: ProviderAuthChallenge;
  pendingAction?: 'logout' | 'remove';
  statusMessage?: string;
}
export function createInitialConnectProviderState(): ConnectProviderState {
  return { selectedProviderIndex: 0, selectedIndex: 0, query: '', step: 'provider', aliasDraft: '', secretDraft: '', draft: '' };
}
export function filterIntegrations(integrations: Integration[], query: string): Integration[] {
  const q = query.trim().toLowerCase();
  return integrations.filter(i => `${i.provider.name} ${i.provider.id} ${i.provider.baseURL}`.toLowerCase().includes(q));
}
export function connectionChoices(state: ConnectProviderState, integrations: Integration[], accounts: Account[]): { id: string; label: string }[] {
  const integration = integrations.find(i => i.provider.id === state.providerId);
  switch (state.step) {
    case 'provider': return [...filterIntegrations(integrations, state.query).map(i => ({ id: i.provider.id, label: `${i.provider.name}  ·  ${accounts.filter(a => a.providerId === i.provider.id && a.status === 'valid').length ? 'Connected' : 'Not connected'}  ·  ${i.methods.map(m => m.name).join(' / ')}` })), { id: '__custom', label: 'Custom endpoint…' }];
    case 'method': return integration?.methods.map(m => ({ id: m.id, label: `${m.name}  ·  ${m.description}` })) ?? [];
    case 'protocol': return ['chat', 'responses', 'anthropic', 'gemini'].map(id => ({ id, label: id }));
    case 'auth': return [{ id: 'api-key', label: 'API key' }, { id: 'none', label: 'No authentication — public/local endpoint' }];
    case 'catalog': return [{ id: 'openai', label: 'Discover models · OpenAI /models' }, { id: 'anthropic', label: 'Discover models · Anthropic /models' }, { id: 'gemini', label: 'Discover models · Gemini' }, { id: 'ollama', label: 'Discover models · Ollama /api/tags' }, { id: 'manual', label: 'Manual model ID · validate with a real generation' }];
    case 'accounts': return accounts.filter(a => !state.providerId || a.providerId === state.providerId).filter(a => `${a.alias} ${a.providerId}`.toLowerCase().includes(state.query.toLowerCase())).map(a => ({ id: a.id, label: `${a.alias}  ·  ${a.providerId}  ·  ${a.status}` }));
    case 'actions': return ['switch', 'add', 'rename', 'reconnect', 'logout', 'remove'].map(id => ({ id, label: ({ switch: 'Switch account and choose model', add: 'Add another account', rename: 'Rename account', reconnect: 'Reconnect / replace credential', logout: 'Logout · delete local credential', remove: 'Remove account and local credential' })[id]! }));
    case 'confirm': return [{ id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: `Confirm ${state.pendingAction}` }];
    default: return [];
  }
}
const labels: Partial<Record<ConnectStep, string>> = {
  provider: 'Connect a provider', method: 'Choose authentication method', alias: 'Name this account', secret: 'Enter API key · hidden · OS keyring', oauth: 'OpenRouter OAuth · paste one-time code (hidden)', env: 'Environment variable NAME · never enter the key here',
  'custom-id': 'Custom provider ID · letters, numbers, dash', url: 'Base URL · HTTPS or loopback HTTP', protocol: 'Choose API protocol', auth: 'Choose endpoint authentication', catalog: 'Choose model discovery', manual: 'Manual model ID',
  accounts: 'Manage accounts', actions: 'Account actions', rename: 'Rename account', confirm: 'Confirm account action', busy: 'Connecting · validating endpoint…',
};
/** A bounded, padded dialog: selected rows remain visible even in small terminals. */
export function renderConnectProviderOverlay(options: {
  width: number; height: number; integrations: Integration[]; accounts: Account[]; activeAccountId: string | null;
  state: ConnectProviderState; tokens: ThemeTokens; borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, integrations, accounts, activeAccountId, state: s, tokens: t } = options;
  const lines: RenderedBoxLine[] = [];
  const row = (text: string, fg = t.foreground, bg = t.overlayBackground, bold = false) => {
    const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    lines.push({ spans: [{ text: ('  ' + clean).slice(0, width).padEnd(width), fg, bg, bold }] });
  };
  row(labels[s.step] ?? 'Connect', t.accent, t.overlayBackground, true);
  if (height < 7) {
    row(s.statusMessage ?? (s.step === 'secret' ? 'API key: •••' : s.draft || s.query || '↑↓ Enter · Esc'));
    return lines.slice(0, height);
  }
  row(s.providerId ?? 'Provider API access · /login', t.foregroundMuted);
  row('');
  const choices = connectionChoices(s, integrations, accounts);
  if (s.step === 'provider' || s.step === 'accounts') row(`Search: ${s.query}▏`, t.foreground, t.backgroundElevated);
  else if (!choices.length && s.step !== 'busy') row(`${(s.step === 'secret' || s.step === 'oauth') ? '•'.repeat(Math.min(24, s.secretDraft.length)) : s.step === 'alias' ? s.aliasDraft : s.draft}▏`, t.foreground, t.backgroundElevated);
  else row('↑/↓ select · Enter continue', t.foregroundMuted);
  if (s.step === 'oauth' && s.authChallenge) {
    row('Open this URL in your browser; authorize, then paste the code:', t.info);
    const url = s.authChallenge.authorizationURL;
    const chunkWidth = Math.max(8, width - 4);
    for (let offset = 0; offset < url.length; offset += chunkWidth) row(url.slice(offset, offset + chunkWidth), t.accent);
    row(`Expires: ${s.authChallenge.expiresAt}`, t.foregroundMuted);
  }
  const room = Math.max(1, height - 8);
  const start = Math.max(0, Math.min(s.selectedIndex - room + 1, choices.length - room));
  for (const [offset, item] of choices.slice(start, start + room).entries()) {
    const selected = start + offset === s.selectedIndex;
    row(`${selected ? '›' : ' '} ${item.label}${item.id === activeAccountId ? '  ● active' : ''}`, selected ? t.selectionForeground : t.foreground, selected ? t.selection : t.overlayBackground, selected);
  }
  if (s.step === 'accounts' && !choices.length) row('No matching accounts. Use /login to add one.', t.foregroundMuted);
  while (lines.length < height - 4) row('');
  row(s.statusMessage ?? (s.step === 'method' ? 'API credentials required; subscription access is separate.' : 'Secrets stay in the OS keyring; no plaintext fallback.'), s.statusMessage ? t.warning : t.foregroundMuted);
  row(s.step === 'provider' ? 'Ctrl+A accounts · Type to search' : s.step === 'accounts' ? 'Ctrl+A add provider · Enter actions' : s.step === 'busy' ? 'Esc cancels authentication' : s.step === 'oauth' ? 'PgUp/PgDn URL · Enter exchange · Esc cancel' : 'Enter continue · Esc back/cancel', t.foregroundSubtle);
  row('Esc close · Input draft preserved', t.foregroundSubtle);
  if (lines.length <= height) return lines;
  const content = lines.slice(4, -3);
  const roomForContent = Math.max(0, height - 7);
  const offset = Math.max(0, Math.min(s.scrollOffset ?? 0, Math.max(0, content.length - roomForContent)));
  return [...lines.slice(0, 4), ...content.slice(offset, offset + roomForContent), ...lines.slice(-3)].slice(0, height);
}
