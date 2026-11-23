/** @jsxImportSource react */
import {afterEach, expect, test} from 'bun:test';
import {cleanup} from 'ink-testing-library';
import {Text} from 'ink';
import type {McpManagementAction, McpManagerSnapshot, McpCatalogItem} from '@cosmew/sdk';
import {renderInk, settle} from '../../testing';
import {dialogFixture} from '../picker/test-fixture';
import {McpManagerDialog} from './index';
afterEach(cleanup);
const snapshot: McpManagerSnapshot = {
  supported: true,
  configPath: '/fixture/mcp.json',
  problems: [],
  servers: [
    {
      name: 'remote',
      transport: 'http',
      source: 'manual',
      enabled: true,
      connection: 'stopped',
      auth: {state: 'needs-login'},
      installation: {state: 'not-applicable'},
      toolCount: 0,
      tools: [],
      diagnostic: 'Not connected',
    },
  ],
};
const entry: McpCatalogItem = {
  id: 'fixture',
  name: 'Fixture package',
  description: 'Local fixture only',
  registryListed: true,
  tested: false,
  sourceUrl: 'https://example.test/source',
  recipes: [{kind: 'npm', packageName: '@fixture/mcp', version: '1.0.0', integrity: 'sha512-fixture'}],
};
const key = async (view: ReturnType<typeof renderInk>, text: string) => {
  view.stdin.write(text);
  await settle();
};
const down = '\x1b[B';
const enter = '\r';
const choose = async (view: ReturnType<typeof renderInk>, label: string) => {
  await key(view, '\x1b[A'.repeat(24));
  for (let n = 0; n < 32; n++) {
    const active = view
      .lastFrame()
      ?.split('\n')
      .find(line => line.trimStart().startsWith('❯'));
    if (active?.includes(label)) {
      await key(view, enter);
      return;
    }
    await key(view, down);
  }
  throw new Error(`Menu choice missing: ${label}\n${view.lastFrame()}`);
};
const replaceField = async (view: ReturnType<typeof renderInk>, value: string) => {
  await key(view, '\x7f'.repeat(80));
  await key(view, value);
};

test('configured details preserve independent states and disabling uses selected server', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {
        snapshot: {
          ...snapshot,
          servers: snapshot.servers.map(server => ({...server, enabled: false, connection: 'disabled'})),
        },
      };
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  expect(view.lastFrame()).toContain('Authentication: Sign-in required');
  await choose(view, 'Disable');
  expect(actions).toEqual([{type: 'disable', name: 'remote'}]);
  expect(view.lastFrame()).toContain('◯ Disabled');
});

test('metadata browsing never installs; pinned recipe needs a name and explicit confirmation', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot, entries: action.type === 'recommended' ? [entry] : undefined};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, 'r');
  expect(actions).toEqual([{type: 'recommended'}]);
  await key(view, enter);
  expect(view.lastFrame()).toContain('Cosmew-tested: false');
  expect(actions).toHaveLength(1);
  await key(view, enter);
  await key(view, 'chosen');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Install @fixture/mcp@1.0.0 as chosen');
  expect(actions).toHaveLength(1);
  await key(view, down);
  await key(view, enter);
  expect(actions[1]).toEqual({
    type: 'install',
    name: 'chosen',
    packageName: '@fixture/mcp',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    catalogId: 'fixture',
  });
});

test('credential entry is masked and requires separate confirmation; failures do not print raw secrets', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      throw new Error('Bearer private-secret https://auth.test/?code=private-secret');
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'Advanced settings');
  await choose(view, 'Set bearer credential');
  await key(view, 'private-secret');
  expect(view.lastFrame()).toContain('••••');
  expect(view.lastFrame()).not.toContain('private-secret');
  await key(view, enter);
  expect(actions).toHaveLength(0);
  expect(view.lastFrame()).not.toContain('private-secret');
  await key(view, down);
  await key(view, enter);
  expect(actions).toEqual([{type: 'credentials', name: 'remote', bearer: 'private-secret'}]);
  expect(view.lastFrame()).toContain('MCP action failed');
  expect(view.frames.join('\n')).not.toContain('private-secret');
});

test('GitHub sign-in opens a masked PAT prompt and confirms before saving', async () => {
  const actions: McpManagementAction[] = [];
  const github: McpManagerSnapshot = {
    ...snapshot,
    servers: [{...snapshot.servers[0]!, auth: {state: 'needs-login', method: 'github-pat'}}],
  };
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => github,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot: github};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  expect(view.lastFrame()).not.toContain('Authenticate in browser');
  await choose(view, 'Set GitHub personal access token');
  await key(view, 'fixture-pat');
  await key(view, enter);
  expect(actions).toEqual([]);
  await key(view, down);
  await key(view, enter);
  expect(actions).toEqual([{type: 'login', name: 'remote', bearer: 'fixture-pat'}]);
  expect(view.frames.join('\n')).not.toContain('fixture-pat');
});

test('a server requiring registered OAuth exposes a masked bearer fallback in details', async () => {
  const actions: McpManagementAction[] = [];
  const remote: McpManagerSnapshot = {
    ...snapshot,
    servers: [
      {
        ...snapshot.servers[0]!,
        endpoint: 'https://fixture.test/mcp',
        auth: {state: 'needs-login', issue: 'client-registration-required'},
      },
    ],
  };
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => remote,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot: remote};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  expect(view.lastFrame()).toContain('requires a registered OAuth client');
  expect(view.lastFrame()).not.toContain('Authenticate in browser');
  await choose(view, 'Set bearer credential');
  await key(view, 'fixture-user-token');
  await key(view, enter);
  expect(actions).toEqual([]);
  await key(view, down);
  await key(view, enter);
  expect(actions).toEqual([
    {
      type: 'credentials',
      name: 'remote',
      bearer: 'fixture-user-token',
      expectedEndpoint: 'https://fixture.test/mcp',
    },
  ]);
  expect(view.frames.join('\n')).not.toContain('fixture-user-token');
});

test('Esc aborts once and drains pending operation before permitting another action', async () => {
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  let calls = 0;
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async (_action, currentSignal) => {
      calls++;
      signal = currentSignal;
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'Connect');
  expect(view.lastFrame()).toContain('reconnect…');
  await key(view, '\x1b');
  expect(signal?.aborted).toBe(true);
  expect(view.lastFrame()).toContain('waiting for cleanup');
  await key(view, enter);
  expect(calls).toBe(1);
  finish();
  await settle();
  expect(view.lastFrame()).toContain('Cancelled. Check current state');
});

test('manual remote setup and removal each show the concrete target before mutation', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await choose(view, 'Add server');
  await choose(view, 'Remote server');
  await key(view, 'https://example.test/mcp');
  await key(view, enter);
  await replaceField(view, 'added');
  await key(view, enter);
  expect(actions).toHaveLength(0);
  expect(view.lastFrame()).toContain('Add remote added at https://example.test/mcp');
  await choose(view, 'Confirm');
  expect(actions[0]).toEqual({
    type: 'add',
    name: 'added',
    config: {transport: 'http', url: 'https://example.test/mcp'},
  });
  await key(view, '\x1b');
  await choose(view, 'remote');
  await choose(view, 'Advanced settings');
  await choose(view, 'Remove server');
  expect(view.lastFrame()).toContain('Remove remote and its exclusively owned installation');
  expect(actions).toHaveLength(1);
  await key(view, enter); // Default Cancel.
  expect(actions).toHaveLength(1);
  await choose(view, 'Remove server');
  await choose(view, 'Confirm');
  expect(actions[1]).toEqual({type: 'remove', name: 'remote'});
});

test('Discover sends only an explicit metadata query and manual local setup preserves argument boundaries', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot, entries: []};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, 'd');
  await key(view, 'fixture query');
  expect(actions).toHaveLength(0);
  await key(view, enter);
  expect(actions).toEqual([{type: 'search', query: 'fixture query'}]);
  await key(view, 'c');
  await choose(view, 'Add server');
  await choose(view, 'Local server');
  await key(view, 'local');
  await key(view, enter);
  await key(view, '/fixture/server');
  await key(view, enter);
  await key(view, '["argument with spaces", "--flag"]');
  await key(view, enter);
  expect(actions).toHaveLength(1);
  await key(view, down);
  await key(view, enter);
  expect(actions[1]).toEqual({
    type: 'add',
    name: 'local',
    config: {transport: 'stdio', command: '/fixture/server', args: ['argument with spaces', '--flag']},
  });
});

test('edit remote endpoint keeps identity, omits secret config and confirms full replacement', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => ({
      ...snapshot,
      servers: snapshot.servers.map(server => ({...server, endpoint: 'https://example.test/old'})),
    }),
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'Advanced settings');
  await choose(view, 'Edit remote endpoint');
  expect(view.lastFrame()).toContain('https://example.test/old');
  await key(view, enter);
  expect(actions).toHaveLength(0);
  expect(view.lastFrame()).toContain('Old headers are cleared');
  await key(view, down);
  await key(view, enter);
  expect(actions[0]).toEqual({
    type: 'edit',
    name: 'remote',
    config: {transport: 'http', url: 'https://example.test/old', enabled: true},
  });
  expect(view.frames.join('\n')).not.toContain('Bearer');
});

test('invalid dotted or oversized names stay editable and never reach the backend', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  for (const name of ['invalid.name', 'a'.repeat(33)]) {
    const view = renderInk(<McpManagerDialog width={100} />, {fixture});
    await settle();
    await choose(view, 'Add server');
    await choose(view, 'Remote server');
    await key(view, 'https://example.test/mcp');
    await key(view, enter);
    await replaceField(view, name);
    await key(view, enter);
    expect(view.lastFrame()).toContain('Use 1–32 letters');
    expect(view.lastFrame()).toContain(name);
    expect(actions).toHaveLength(0);
    view.unmount();
  }
});

test('registry Next page uses the current query and opaque cursor without installing', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot, entries: [], ...(actions.length === 1 ? {nextCursor: 'opaque:page2'} : {})};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, 'd');
  await key(view, 'docs');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Next page');
  await key(view, down);
  await key(view, enter);
  expect(actions).toEqual([
    {type: 'search', query: 'docs'},
    {type: 'search', query: 'docs', cursor: 'opaque:page2'},
  ]);
  expect(view.lastFrame()).not.toContain('Next page');
});

test('local edit requests new arguments without exposing old environment and preserves disabled state', async () => {
  const actions: McpManagementAction[] = [];
  const local: McpManagerSnapshot = {
    ...snapshot,
    servers: snapshot.servers.map(server => ({
      ...server,
      transport: 'stdio',
      enabled: false,
      installation: {state: 'unmanaged'},
    })),
  };
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => local,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot: local};
    },
  });
  const view = renderInk(<McpManagerDialog width={100} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'Advanced settings');
  await choose(view, 'Replace local executable');
  expect(view.lastFrame()).toContain('Replacement local executable');
  await key(view, '/fixture/replacement');
  await key(view, enter);
  await key(view, '["space here"]');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Old environment is cleared');
  expect(actions).toHaveLength(0);
  await key(view, down);
  await key(view, enter);
  expect(actions).toEqual([
    {
      type: 'edit',
      name: 'remote',
      config: {transport: 'stdio', command: '/fixture/replacement', args: ['space here'], enabled: false},
    },
  ]);
});

test('MCP opens the Claude-style server list without a tabbed manager header', async () => {
  const fixture = dialogFixture({mcpManagerSnapshot: async () => snapshot});
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('MCP servers');
  expect(view.lastFrame()).toContain('1 server');
  expect(view.lastFrame()).toContain('User MCP servers');
  expect(view.lastFrame()).toContain('remote');
  expect(view.lastFrame()).toContain('needs sign-in');
  expect(view.lastFrame()).not.toContain('c Configured · d Discover');
  expect(view.lastFrame()).toContain('Enter to view');
});

test('remote setup asks for URL first, suggests a name, and retains invalid input for correction', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => ({...snapshot, servers: []}),
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  await key(view, enter); // Add server.
  await key(view, enter); // Remote URL.
  expect(view.lastFrame()).toContain('Server URL');
  expect(view.lastFrame()).toContain('https://developers.openai.com/mcp');
  await key(view, 'not-a-url');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Enter a valid http:// or https:// URL');
  expect(view.lastFrame()).toContain('not-a-url');
  expect(actions).toHaveLength(0);
  for (let n = 0; n < 9; n++) await key(view, '\x7f');
  await key(view, 'https://developers.openai.com/mcp');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Server name');
  expect(view.lastFrame()).toContain('developers-openai-com');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Add remote developers-openai-com');
  expect(actions).toHaveLength(0);
  await key(view, enter); // Cancel selected by default.
  expect(actions).toHaveLength(0);
});

test('auth-free server details put tools first and hide credential controls in Advanced settings', async () => {
  const connected: McpManagerSnapshot = {
    ...snapshot,
    servers: snapshot.servers.map(server => ({
      ...server,
      connection: 'connected',
      auth: {state: 'not-required'},
      toolCount: 5,
      endpoint: 'https://developers.openai.com/mcp',
    })),
  };
  const fixture = dialogFixture({mcpManagerSnapshot: async () => connected});
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('✔ remote');
  expect(view.lastFrame()).toContain('5 tools');
  await key(view, enter);
  expect(view.lastFrame()).toContain('✔ Connected');
  expect(view.lastFrame()).toContain('Authentication: Not required');
  expect(view.lastFrame()).toContain('https://developers.openai.com/mcp');
  expect(view.lastFrame()).not.toContain('Set bearer credential');
  expect(view.lastFrame()).toContain('Advanced settings');
  expect(view.lastFrame()).toContain('View tools');
});

test('Tab navigation preserves fields and cannot skip URL validation before confirming', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => ({...snapshot, servers: []}),
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={60} />, {fixture});
  await settle();
  await choose(view, 'Add server');
  await choose(view, 'Remote server');
  await key(view, '\t');
  await key(view, 'chosen');
  await key(view, enter);
  expect(view.lastFrame()).toContain('Enter a valid http:// or https:// URL');
  expect(view.lastFrame()).toContain('Server name: chosen');
  expect(actions).toHaveLength(0);
  await key(view, 'https://example.test/mcp');
  await key(view, enter);
  await key(view, '\x1b[Z'); // Shift+Tab returns to URL.
  expect(view.lastFrame()).toContain('❯ Server URL: https://example.test/mcp');
  await key(view, enter);
  await key(view, enter);
  expect(view.lastFrame()).toContain('Add remote chosen');
  expect(actions).toHaveLength(0);
});

test('duplicate server names are explained inline, and list navigation stops at the last action', async () => {
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => snapshot,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={80} visibleRows={3} />, {fixture});
  await settle();
  await choose(view, 'Add server');
  await key(view, down.repeat(20));
  await key(view, enter); // Still selects the final local-server choice.
  expect(view.lastFrame()).toContain('Local executable');
  await key(view, 'remote');
  await key(view, enter);
  expect(view.lastFrame()).toContain('That server name already exists');
  expect(view.lastFrame()).toContain('Server name: remote');
  expect(actions).toHaveLength(0);
});

test('Escape backs out of tools and advanced settings to the server before returning to the list', async () => {
  const fixture = dialogFixture({mcpManagerSnapshot: async () => snapshot});
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'View tools');
  expect(view.lastFrame()).toContain('remote tools');
  await key(view, '\x1b');
  expect(view.lastFrame()).toContain('View tools');
  await choose(view, 'Advanced settings');
  await key(view, '\x1b');
  expect(view.lastFrame()).toContain('View tools');
  await key(view, '\x1b');
  expect(view.lastFrame()).toContain('MCP servers');
});

test('overview summarizes connection states and local search filters servers without calling the backend', async () => {
  const actions: McpManagementAction[] = [];
  const mixed: McpManagerSnapshot = {
    ...snapshot,
    servers: [
      {...snapshot.servers[0]!, name: 'docs', connection: 'connected', auth: {state: 'not-required'}, toolCount: 5},
      {...snapshot.servers[0]!, name: 'github'},
      {...snapshot.servers[0]!, name: 'offline', enabled: false, connection: 'disabled'},
    ],
  };
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => mixed,
    manageMcp: async action => {
      actions.push(action);
      return {snapshot: mixed};
    },
  });
  const view = renderInk(<McpManagerDialog width={90} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('1 connected');
  expect(view.lastFrame()).toContain('1 needs sign-in');
  expect(view.lastFrame()).toContain('1 disabled');
  await key(view, '/');
  await key(view, 'docs');
  expect(view.lastFrame()).toContain('1 of 3 servers');
  expect(view.lastFrame()).not.toContain('⚠ github');
  expect(actions).toHaveLength(0);
  await key(view, enter); // Finish typing, do not select or invoke.
  await key(view, enter);
  expect(view.lastFrame()).toContain('Ready — ask Cosmew');
  await choose(view, 'View tools');
  expect(actions).toHaveLength(0);
});

test('tools filter by name and description, and Esc clears a filter before leaving the tool list', async () => {
  const connected: McpManagerSnapshot = {
    ...snapshot,
    servers: [
      {
        ...snapshot.servers[0]!,
        connection: 'connected',
        auth: {state: 'not-required'},
        toolCount: 2,
        tools: [
          {name: 'mcp__remote__search', description: 'Find documentation pages'},
          {name: 'mcp__remote__fetch', description: 'Read a page URL'},
        ],
      },
    ],
  };
  const fixture = dialogFixture({mcpManagerSnapshot: async () => connected});
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'View tools');
  await key(view, '/');
  await key(view, 'documentation');
  expect(view.lastFrame()).toContain('mcp__remote__search');
  expect(view.lastFrame()).not.toContain('mcp__remote__fetch');
  await key(view, '\x1b');
  expect(view.lastFrame()).toContain('mcp__remote__fetch');
  expect(view.lastFrame()).toContain('remote tools');
});

test('refresh reads fresh manager state without reconnecting or installing anything', async () => {
  let reads = 0;
  const actions: McpManagementAction[] = [];
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => {
      reads++;
      return snapshot;
    },
    manageMcp: async action => {
      actions.push(action);
      return {snapshot};
    },
  });
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  await key(view, 'f');
  expect(reads).toBe(2);
  expect(actions).toHaveLength(0);
  expect(view.lastFrame()).toContain('Status refreshed');
});

test('managed installations do not advertise unsupported executable replacement, and removal explains sign-out', async () => {
  const managed: McpManagerSnapshot = {
    ...snapshot,
    servers: [
      {
        ...snapshot.servers[0]!,
        transport: 'stdio',
        installation: {state: 'ready', id: 'managed-1', packageName: '@fixture/mcp', version: '1.0.0'},
      },
    ],
  };
  const fixture = dialogFixture({mcpManagerSnapshot: async () => managed});
  const view = renderInk(<McpManagerDialog width={90} />, {fixture});
  await settle();
  await key(view, enter);
  await choose(view, 'Advanced settings');
  expect(view.lastFrame()).not.toContain('Replace local executable');
  expect(view.lastFrame()).toContain('1.0.0');
  await choose(view, 'Remove server');
  expect(view.lastFrame()).toContain('remote sign-out may be attempted');
});

test('all configuration problems are reachable rather than silently truncating to two', async () => {
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => ({...snapshot, problems: ['First issue', 'Second issue', 'Third issue']}),
  });
  const view = renderInk(<McpManagerDialog width={80} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('3 configuration issues');
  await choose(view, 'Configuration diagnostics');
  expect(view.lastFrame()).toContain('Third issue');
  await key(view, '\x1b');
  expect(view.lastFrame()).toContain('MCP servers');
});

test('temporary load errors offer retry instead of falsely showing an unsupported backend', async () => {
  let reads = 0;
  const fixture = dialogFixture({
    mcpManagerSnapshot: async () => {
      if (++reads === 1) throw new Error('private endpoint error');
      return snapshot;
    },
  });
  const view = renderInk(<McpManagerDialog width={80} fallback={<Text>Legacy read-only fallback</Text>} />, {fixture});
  await settle();
  expect(view.lastFrame()).toContain('Could not load MCP servers');
  expect(view.lastFrame()).not.toContain('Legacy read-only fallback');
  expect(view.lastFrame()).not.toContain('private endpoint');
  await key(view, 'f');
  expect(view.lastFrame()).toContain('remote');
  expect(view.lastFrame()).not.toContain('Could not load MCP servers');
});
