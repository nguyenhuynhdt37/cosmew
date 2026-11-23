/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {Box, renderToString} from 'ink';
import {cleanup} from 'ink-testing-library';
import type {McpManagedServer} from '@cosmew/sdk';
import type {ThemeTokens} from '@cosmew/contracts';
import {ThemeEngine} from '../../../theme/theme';
import {ThemeProvider} from '../../theme';
import {renderInk, settle} from '../../testing';
import {Overview, ServerDetails, ServerLabel} from './components';

afterEach(cleanup);

const server = (overrides: Partial<McpManagedServer> = {}): McpManagedServer => ({
  name: 'docs',
  transport: 'http',
  source: 'manual',
  enabled: true,
  connection: 'connected',
  auth: {state: 'not-required'},
  installation: {state: 'not-applicable'},
  toolCount: 5,
  tools: [],
  endpoint: 'https://example.test/mcp',
  ...overrides,
});

const states = [
  server(),
  server({name: 'login', connection: 'needs-auth', auth: {state: 'unknown'}}),
  server({name: 'failed', connection: 'failed'}),
  server({name: 'disabled', enabled: false}),
  server({name: 'pending', connection: 'connecting'}),
  server({name: 'unchecked', connection: 'stopped', auth: {state: 'unknown'}}),
];

test('disabled state overrides a stale connected flag in rows, overview and guidance', async () => {
  const disabled = server({enabled: false});
  const view = renderInk(
    <Box flexDirection="column">
      <Overview servers={[disabled]} />
      <ServerLabel server={disabled} />
      <ServerDetails server={disabled} advanced={false} configPath="/fixture/mcp.json" />
    </Box>,
  );
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('1 disabled');
  expect(frame).toContain('◯ docs');
  expect(frame).toContain('Disabled');
  expect(frame).toContain('Enable this server');
  expect(frame).not.toContain('5 tools');
  expect(frame).not.toContain('1 connected');
  expect(frame).not.toContain('Ready —');
});

test('a needs-auth connection requests sign-in while unknown auth alone remains unchecked', async () => {
  const view = renderInk(
    <Box flexDirection="column">
      <Overview servers={[states[1]!, states[5]!]} />
      <ServerLabel server={states[1]!} />
      <ServerLabel server={states[5]!} />
      <ServerDetails server={states[1]!} advanced={false} configPath="/fixture/mcp.json" />
    </Box>,
  );
  await settle();
  const frame = view.lastFrame()!;
  expect(frame).toContain('1 needs sign-in');
  expect(frame).toContain('1 not connected');
  expect(frame).toContain('⚠ login');
  expect(frame).toContain('◯ unchecked');
  expect(frame).toContain('Authentication: Not checked');
  expect(frame).toContain('Authenticate in browser');
});

test('NO_COLOR preserves distinct state markers and actionable text', async () => {
  const engine = new ThemeEngine({env: {NO_COLOR: '1', FORCE_COLOR: '3'}});
  const view = renderInk(
    <Box flexDirection="column">
      <Overview servers={states} />
      {states.map(item => (
        <ServerLabel key={item.name} server={item} />
      ))}
      <ServerDetails server={states[0]!} advanced={false} configPath="/fixture/mcp.json" />
    </Box>,
    {themeEngine: engine},
  );
  await settle();
  const frame = view.lastFrame()!;
  for (const text of ['✔ docs', '⚠ login', '✘ failed', '◯ disabled', '◌ pending', '◯ unchecked', '5 tools', 'Ready —'])
    expect(frame).toContain(text);
  expect(frame).not.toMatch(/\x1b\[[0-9;]*m/);
});

for (const columns of [40, 60]) {
  test(`overview, rows and advanced details fit ${columns} terminal columns`, () => {
    const long = server({
      name: 'documentation-server-with-a-long-name',
      endpoint: 'https://documentation.example.test/very/long/mcp/endpoint',
      diagnostic: 'Connection failed. Reconnect or open Advanced settings to run Doctor.',
      connection: 'failed',
    });
    const frame = renderToString(
      <ThemeProvider engine={new ThemeEngine({env: {NO_COLOR: '1'}})}>
        <Box flexDirection="column" width={columns}>
          <Overview servers={states} />
          <ServerLabel server={long} nameWidth={32} />
          <ServerDetails server={long} advanced configPath="/fixture/long-user-home/.cosmew/mcp.json" />
        </Box>
      </ThemeProvider>,
      {columns},
    );
    expect(frame).toContain('6 servers');
    expect(frame).toContain('Authentication: Not required');
    expect(frame).toContain('Config:');
    expect(frame).toContain('Doctor');
    for (const line of frame.split('\n')) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  });
}

// Color support is captured on import by Ink/Chalk. A fresh process verifies actual
// ANSI output without mutating the test runner's environment or assuming styles survive it.
function colorFrame(mode: 'dark' | 'light', noColor = false): {tokens: ThemeTokens; frame: string} {
  const code = `
    import React from 'react';
    import {Box, renderToString} from 'ink';
    import {ThemeEngine} from ${JSON.stringify(`${import.meta.dir}/../../../theme/theme.ts`)};
    import {ThemeProvider} from ${JSON.stringify(`${import.meta.dir}/../../theme/index.tsx`)};
    import {Overview, ServerLabel} from ${JSON.stringify(`${import.meta.dir}/components.tsx`)};
    const engine = new ThemeEngine({env: {FORCE_COLOR: '3', NO_COLOR: ${JSON.stringify(noColor ? '1' : '')}}});
    await engine.setTheme(${JSON.stringify(mode)});
    const servers = ${JSON.stringify(states)};
    const frame = renderToString(React.createElement(ThemeProvider, {engine},
      React.createElement(Box, {flexDirection: 'column'},
        React.createElement(Overview, {servers}),
        ...servers.map(server => React.createElement(ServerLabel, {server, key: server.name})))), {columns: 100});
    process.stdout.write(JSON.stringify({tokens: engine.getActiveTokens(), frame}));
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, '--eval', code],
    cwd: import.meta.dir,
    env: {...process.env, FORCE_COLOR: '3', NO_COLOR: ''},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

const paint = (hex: string, text: string) =>
  `\x1b[38;2;${[1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(';')}m${text}`;

function foregroundBefore(frame: string, text: string) {
  const at = frame.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  // Ink coalesces neighboring spans with identical colors (including separators).
  return [...frame.slice(0, at).matchAll(/\x1b\[(?:38;2;\d+;\d+;\d+|39)m/g)].at(-1)?.[0];
}

for (const mode of ['dark', 'light'] as const) {
  test(`${mode} paints actual terminal rows and overview counts with semantic theme colors`, () => {
    const {tokens, frame} = colorFrame(mode);
    for (const [tone, marker, summary] of [
      ['success', '✔', '1 connected'],
      ['warning', '⚠', '1 needs sign-in'],
      ['error', '✘', '1 failed'],
      ['foregroundMuted', '◯', '1 disabled'],
      ['info', '◌', '1 connecting'],
    ] as const) {
      expect(frame).toContain(paint(tokens[tone], marker));
      expect(foregroundBefore(frame, summary)).toBe(paint(tokens[tone], ''));
    }
    expect(frame).toContain(paint(tokens.accent, ' docs'));
  });
}

test('NO_COLOR suppresses color even in an ANSI-capable renderer', () => {
  const {frame} = colorFrame('dark', true);
  expect(frame).not.toMatch(/\x1b\[(?:[349][0-9]|10[0-7]|[34]8;[25](?:;\d+)+)m/);
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  expect(plain).toContain('✔ docs');
  expect(plain).toContain('⚠ login');
  expect(plain).toContain('1 disabled');
});
