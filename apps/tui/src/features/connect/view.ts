import type {Account, BorderStyle, Integration, ThemeTokens} from '@futryn/contracts';
import type {RenderedBoxLine} from '../../ui';
import {connectionChoices} from './logic';
import type {ConnectProviderState, ConnectStep} from './types';

const labels: Partial<Record<ConnectStep, string>> = {
  provider: 'Connect a provider',
  method: 'Choose authentication method',
  secret: 'Enter API key · hidden · OS keyring',
  oauth: 'OpenRouter OAuth · paste one-time code (hidden)',
  env: 'Environment variable NAME · never enter the key here',
  'custom-id': 'Custom provider ID · letters, numbers, dash',
  url: 'Base URL · HTTPS or loopback HTTP',
  protocol: 'Choose API protocol',
  auth: 'Choose endpoint authentication',
  catalog: 'Choose model discovery',
  manual: 'Manual model ID',
  accounts: 'Manage accounts',
  actions: 'Account actions',
  rename: 'Rename account',
  confirm: 'Confirm account action',
  busy: 'Connecting · validating endpoint…',
};
/** A bounded, padded dialog: selected rows remain visible even in small terminals. */
export function renderConnectProviderOverlay(options: {
  width: number;
  height: number;
  integrations: Integration[];
  accounts: Account[];
  activeAccountId: string | null;
  state: ConnectProviderState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height: maxHeight, integrations, accounts, activeAccountId, state: s, tokens: t} = options;
  const choices = connectionChoices(s, integrations, accounts, activeAccountId);
  const statusLines: string[] = [];
  if (s.statusMessage) {
    let line = '';
    for (const word of s.statusMessage.split(/\s+/)) {
      if (line && line.length + word.length + 1 > Math.max(10, width - 4)) {
        statusLines.push(line);
        line = word;
      } else line += (line ? ' ' : '') + word;
    }
    if (line) statusLines.push(line);
  }
  const errorRows = Math.max(0, Math.min(3, statusLines.length) - 1);
  const height = Math.min(
    maxHeight,
    Math.max(8, choices.length ? choices.length + 8 : s.authChallenge ? 14 : 10) + errorRows,
  );
  const lines: RenderedBoxLine[] = [];
  const row = (text: string, fg = t.foreground, bg = t.overlayBackground, bold = false) => {
    const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    lines.push({spans: [{text: ('  ' + clean).slice(0, width).padEnd(width), fg, bg, bold}]});
  };
  const title =
    s.step === 'busy' && s.pendingAction === 'switch'
      ? 'Switching account…'
      : s.step === 'confirm'
        ? `${s.pendingAction === 'switch' ? 'Continue with' : 'Sign out of'} ${s.providerLabel ?? accounts.find(a => a.id === s.accountId)?.alias ?? 'account'}?`
        : s.switchOnly
          ? 'Switch account'
          : s.logoutOnly
            ? 'Sign out'
            : s.step === 'method' && s.providerLabel
              ? `Sign in to ${s.providerLabel}`
              : (labels[s.step] ?? 'Connect');
  row(title, t.accent, t.overlayBackground, true);
  if (height < 7) {
    row(s.statusMessage ?? (s.step === 'secret' ? 'API key: •••' : s.draft || s.query || '↑↓ Enter · Esc'));
    return lines.slice(0, height);
  }
  row(
    s.step === 'confirm'
      ? s.pendingAction === 'switch'
        ? 'Your chat history will be sent with this account.'
        : 'You will need to sign in again.'
      : s.switchOnly
        ? 'Choose an account.'
        : s.logoutOnly
          ? 'Other accounts stay connected.'
          : s.step === 'provider'
            ? 'Choose your provider'
            : s.step === 'method'
              ? ''
              : (s.providerLabel ?? ''),
    t.foregroundMuted,
  );
  row('');
  if (s.step === 'provider' || s.step === 'accounts') row(`Search: ${s.query}▏`, t.foreground, t.backgroundElevated);
  else if (!choices.length && s.step !== 'busy')
    row(
      `${s.step === 'secret' || s.step === 'oauth' ? '•'.repeat(Math.min(24, s.secretDraft.length)) : s.draft}▏`,
      t.foreground,
      t.backgroundElevated,
    );
  else row('');
  if ((s.step === 'oauth' || s.step === 'busy') && s.authChallenge) {
    row(
      s.authChallenge.autoComplete
        ? 'Finish signing in in your browser. This screen updates automatically.'
        : 'Open this URL, then paste the one-time code:',
      t.info,
    );
    if (s.authChallenge.userCode) row(`Device code: ${s.authChallenge.userCode}`, t.accent, t.overlayBackground, true);
    const url = s.authChallenge.authorizationURL;
    const chunkWidth = Math.max(8, width - 4);
    for (let offset = 0; offset < url.length; offset += chunkWidth)
      row(url.slice(offset, offset + chunkWidth), t.accent);
    row('Keep this window open. Esc cancels sign-in.', t.foregroundMuted);
  }
  const room = Math.max(1, height - 8);
  const start = Math.max(0, Math.min(s.selectedIndex - room + 1, choices.length - room));
  for (const [offset, item] of choices.slice(start, start + room).entries()) {
    const selected = start + offset === s.selectedIndex;
    row(
      `${selected ? '›' : ' '} ${item.label}${item.id === activeAccountId ? '  ● active' : ''}`,
      item.disabled ? t.foregroundSubtle : selected ? t.selectionForeground : t.foreground,
      selected ? t.selection : t.overlayBackground,
      selected,
    );
  }
  if (s.step === 'accounts' && !choices.length) row('No accounts yet. Use /login to connect.', t.foregroundMuted);
  while (lines.length < height - 4 - errorRows) row('');
  const group = integrations.find(i => (i.providerIds ?? [i.provider.id]).includes(s.providerId!));
  const hint =
    s.step === 'method' && group?.notice
      ? group.notice
      : s.step === 'secret'
        ? 'Paste your API key. Input is hidden.'
        : s.step === 'env'
          ? 'Enter the variable name, not the key.'
          : '';
  if (statusLines.length) for (const line of statusLines.slice(0, 3)) row(line, t.warning);
  else row(hint, t.foregroundMuted);
  row(
    s.step === 'busy' && s.pendingAction === 'switch'
      ? 'Loading models…   Esc Cancel'
      : s.step === 'confirm'
        ? '↑↓ Choose   Enter Confirm   Esc Cancel'
        : s.switchOnly
          ? '↑↓ Select   Enter Continue   Esc Cancel'
          : s.logoutOnly
            ? '↑↓ Select   Enter Sign out   Esc Cancel'
            : s.step === 'provider'
              ? '↑↓ Select   Enter Continue   Ctrl+A Accounts'
              : s.step === 'accounts'
                ? '↑↓ Select   Enter Manage   Ctrl+A Add provider'
                : s.step === 'busy' && s.authChallenge
                  ? 'PgUp/PgDn Scroll link   Esc Cancel'
                  : 'Enter Continue   Esc Back',
    t.foregroundSubtle,
  );
  row('');
  if (lines.length <= height) return lines;
  const content = lines.slice(4, -3);
  const roomForContent = Math.max(0, height - 7);
  const offset = Math.max(0, Math.min(s.scrollOffset ?? 0, Math.max(0, content.length - roomForContent)));
  return [...lines.slice(0, 4), ...content.slice(offset, offset + roomForContent), ...lines.slice(-3)].slice(0, height);
}
