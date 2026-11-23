/** @jsxImportSource react */
import {MCP_OAUTH_ISSUES} from '@cosmew/contracts';
import {Box, Text} from 'ink';
import type {McpManagedServer} from '@cosmew/sdk';
import {useTheme} from '../../theme';
import {TextLine, safeText, stringCells} from '../../ui';
import {serverStatus, type ServerStatusKind} from './presentation';

export function Overview({servers}: {servers: McpManagedServer[]}) {
  const {color} = useTheme();
  const counts: Record<ServerStatusKind, number> = {
    connected: 0,
    auth: 0,
    failed: 0,
    disabled: 0,
    connecting: 0,
    stopped: 0,
  };
  for (const server of servers) counts[serverStatus(server).kind]++;
  const summaries = [
    {count: counts.connected, label: 'connected', tone: 'success'},
    {count: counts.auth, label: 'needs sign-in', tone: 'warning'},
    {count: counts.failed, label: 'failed', tone: 'error'},
    {count: counts.disabled, label: 'disabled', tone: 'foregroundMuted'},
    {count: counts.connecting, label: 'connecting', tone: 'info'},
    {count: counts.stopped, label: 'not connected', tone: 'foregroundMuted'},
  ] as const;
  const visible = summaries.filter(item => item.count > 0 || (!servers.length && item.label === 'connected'));
  return (
    <Box flexDirection="column" minWidth={0}>
      <TextLine>{`${servers.length} ${servers.length === 1 ? 'server' : 'servers'}`}</TextLine>
      <Text wrap="wrap">
        {visible.map((item, index) => (
          <Text key={item.label}>
            {index ? <Text color={color('foregroundMuted')}> · </Text> : null}
            <Text color={color(item.tone)}>{`${item.count} ${item.label}`}</Text>
          </Text>
        ))}
      </Text>
      <TextLine color={color('foregroundMuted')}>
        {servers.length ? 'User MCP servers' : 'No MCP servers yet. Add a URL or browse the registry.'}
      </TextLine>
    </Box>
  );
}

export function ServerLabel({server, nameWidth = 0}: {server: McpManagedServer; nameWidth?: number}) {
  const {color} = useTheme();
  const status = serverStatus(server);
  const name = safeText(server.name);
  // Pad by terminal cells, never truncate the server's identity.
  const padding = ' '.repeat(Math.max(0, Math.min(32, nameWidth) - stringCells(name)));
  return (
    <Text wrap="wrap">
      <Text color={color(status.tone)}>{status.icon}</Text>
      <Text bold color={color('accent')}>{` ${name}${padding}`}</Text>
      <Text color={color('foregroundMuted')}>{`  ${server.transport === 'http' ? 'HTTP' : 'stdio'} · `}</Text>
      <Text color={color(status.tone)}>
        {status.kind === 'connected' ? `${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}` : status.text}
      </Text>
    </Text>
  );
}

const authLabels = {
  'not-required': 'Not required',
  unknown: 'Not checked',
  'needs-login': 'Sign-in required',
  authorized: 'Signed in',
  expired: 'Sign-in expired',
};
const guidance: Record<ServerStatusKind, string> = {
  connected: 'Ready — ask Cosmew to use this server’s tools.',
  disabled: 'Enable this server to connect and discover its tools.',
  auth: 'Authenticate in browser or use a bearer token supplied by the provider.',
  failed: 'Open Connection diagnostics or reconnect to retry.',
  connecting: 'Connecting — wait for tool discovery, then refresh the list.',
  stopped: 'Choose Connect or Reconnect to discover this server’s tools.',
};

export function ServerDetails({
  server,
  advanced,
  configPath,
}: {
  server: McpManagedServer;
  advanced: boolean;
  configPath: string;
}) {
  const {color} = useTheme();
  const status = serverStatus(server);
  const authTone = ['needs-login', 'expired'].includes(server.auth.state)
    ? 'warning'
    : server.auth.state === 'authorized'
      ? 'success'
      : 'foregroundMuted';
  return (
    <Box flexDirection="column" minWidth={0}>
      <Text wrap="wrap">
        <Text color={color('foregroundMuted')}>Status: </Text>
        <Text color={color(status.tone)}>{`${status.icon} ${status.text}`}</Text>
        <Text
          color={color('foregroundMuted')}
        >{` · ${server.transport === 'http' ? 'HTTP' : 'stdio'} · User scope`}</Text>
      </Text>
      {server.endpoint ? <TextLine>{`Endpoint: ${server.endpoint}`}</TextLine> : null}
      <Text wrap="wrap">
        <Text color={color('foregroundMuted')}>Authentication: </Text>
        <Text color={color(authTone)}>{authLabels[server.auth.state]}</Text>
      </Text>
      <TextLine color={color(status.kind === 'connected' ? 'success' : 'info')}>
        {status.kind === 'auth' && server.auth.method === 'github-pat'
          ? 'Use Set GitHub personal access token to connect.'
          : status.kind === 'auth' && server.auth.issue
            ? 'Use a bearer token if the provider supplies one. Retry browser sign-in in Advanced settings.'
            : guidance[status.kind]}
      </TextLine>
      {server.auth.issue && status.kind !== 'connected' ? (
        <TextLine color={color('warning')}>{MCP_OAUTH_ISSUES[server.auth.issue]}</TextLine>
      ) : null}
      {advanced ? (
        <>
          <TextLine
            color={color('foregroundMuted')}
          >{`Source: ${server.source} · Installation: ${server.installation.state}${server.installation.version ? ` @${server.installation.version}` : ''}`}</TextLine>
          {configPath ? <TextLine color={color('foregroundMuted')}>{`Config: ${configPath}`}</TextLine> : null}
          {server.installation.id ? (
            <TextLine color={color('foregroundMuted')}>
              Managed installation: remove this server and install a pinned version to replace it. Editing is
              unavailable.
            </TextLine>
          ) : null}
        </>
      ) : null}
      {server.diagnostic ? (
        <TextLine color={color(status.kind === 'failed' ? 'error' : 'warning')}>{server.diagnostic}</TextLine>
      ) : null}
    </Box>
  );
}
