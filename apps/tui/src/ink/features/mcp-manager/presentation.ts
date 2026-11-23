import type {McpManagedServer} from '@cosmew/sdk';

export type ServerStatusKind = 'disabled' | 'connected' | 'failed' | 'auth' | 'connecting' | 'stopped';
export function serverStatus(server: McpManagedServer): {
  icon: string;
  text: string;
  tone: 'foregroundMuted' | 'success' | 'error' | 'warning' | 'info';
  kind: ServerStatusKind;
} {
  if (!server.enabled || server.connection === 'disabled')
    return {icon: '◯', text: 'Disabled', tone: 'foregroundMuted', kind: 'disabled'};
  if (server.connection === 'connected') return {icon: '✔', text: 'Connected', tone: 'success', kind: 'connected'};
  if (server.connection === 'failed') return {icon: '✘', text: 'Connection failed', tone: 'error', kind: 'failed'};
  if (server.connection === 'needs-auth' || ['needs-login', 'expired'].includes(server.auth.state))
    return {icon: '⚠', text: 'needs sign-in', tone: 'warning', kind: 'auth'};
  if (server.connection === 'connecting' || server.connection === 'reconnecting')
    return {icon: '◌', text: 'Connecting…', tone: 'info', kind: 'connecting'};
  return {icon: '◯', text: 'Not connected', tone: 'foregroundMuted', kind: 'stopped'};
}

export function serverRow(server: McpManagedServer): string {
  const status = serverStatus(server);
  const detail =
    status.kind === 'connected' ? `${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}` : status.text;
  return `${status.icon} ${server.name}   ${detail}`;
}

export function suggestedServerName(endpoint: string, existing: readonly string[]): string {
  let base: string;
  try {
    base = new URL(endpoint).hostname;
  } catch {
    base = 'mcp-server';
  }
  base =
    base
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'mcp-server';
  let name = base;
  let suffix = 2;
  while (existing.includes(name)) {
    const ending = `-${suffix++}`;
    name = base.slice(0, 32 - ending.length) + ending;
  }
  return name;
}

export function remoteUrlError(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    if (url.username || url.password || url.search || url.hash)
      return 'Use an endpoint without credentials, query parameters or a fragment.';
  } catch {
    return 'Enter a valid http:// or https:// URL, for example https://developers.openai.com/mcp';
  }
}
