import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpHub, parseMcpConfig, qualifiedMcpName, WebSearchClient} from '@cosmew/mcp';
import {SessionGrants} from '@cosmew/security';
import {DEFAULT_SANDBOX_CONFIG, ToolDispatcher, type ApprovalRequest} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function makeLargeMcpFixture(toolCount: number) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-defer-'));
  cleanups.push(() => rmSync(root, {recursive: true, force: true}));
  let sessionId = 'session-a';
  let permissionMode: 'default' | 'plan' = 'default';
  let readOnly = false;
  let analysisOnly = false;
  const approvals: ApprovalRequest[] = [];
  const calls: {name: string; args: Record<string, unknown>}[] = [];
  const tools = Array.from({length: toolCount}, (_, index) => {
    const server = index % 2 === 0 ? 'alpha' : 'beta';
    const topic = index === 3 ? 'search_issues' : index === 11 ? 'create_ticket' : `op_${index}`;
    return {
      name: `mcp__${server}__${topic}`,
      description:
        index === 3
          ? 'Search GitHub issues and pull requests with secret TOP_SECRET_META'
          : index === 11
            ? 'Create a Jira ticket for release tracking'
            : `Operation ${index} on ${server}`,
      inputSchema: {
        type: 'object',
        properties: {query: {type: 'string'}, limit: {type: 'integer'}},
        required: ['query'],
        additionalProperties: false,
      },
      readOnlyHint: index === 3,
      identity: `id:${server}:1`,
    };
  });
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    sessionId: () => sessionId,
    analysisOnly: () => analysisOnly,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode, readOnly}),
    approve: async req => {
      approvals.push(req);
      return 'once';
    },
    redact: text => text.replaceAll('TOP_SECRET_META', '[REDACTED]'),
    mcp: {
      tools: () => tools,
      call: async (name, args) => {
        calls.push({name, args});
        return `called:${name}:${String(args.query ?? '')}`;
      },
    },
  });
  return {
    dispatcher,
    approvals,
    calls,
    setSession(id: string) {
      sessionId = id;
    },
    setMode(next: {permissionMode?: 'default' | 'plan'; readOnly?: boolean; analysisOnly?: boolean}) {
      if (next.permissionMode !== undefined) permissionMode = next.permissionMode;
      if (next.readOnly !== undefined) readOnly = next.readOnly;
      if (next.analysisOnly !== undefined) analysisOnly = next.analysisOnly;
    },
  };
}

describe('Deferred MCP tool loading (tool_search)', () => {
  test('small MCP catalogs stay eagerly loaded without offering tool_search', () => {
    const f = makeLargeMcpFixture(4);
    const names = f.dispatcher.descriptors().map(d => d.name);
    expect(names).not.toContain('tool_search');
    expect(names.filter(n => n.startsWith('mcp__'))).toHaveLength(4);
  });

  test('large MCP catalogs defer schemas behind tool_search with per-session activation and full permission enforcement', async () => {
    const f = makeLargeMcpFixture(20);
    const initial = f.dispatcher.descriptors();
    const searchDesc = initial.find(d => d.name === 'tool_search');
    expect(searchDesc).toBeDefined();
    expect(searchDesc!.description).toContain('20 tools across 2 server(s)');
    expect(searchDesc!.description).toContain('alpha (10)');
    expect(searchDesc!.description).toContain('beta (10)');
    expect(searchDesc!.description).not.toContain('TOP_SECRET_META');
    // No deferred MCP tool is eagerly attached before search.
    expect(initial.filter(d => d.name.startsWith('mcp__'))).toHaveLength(0);

    // Keyword + required search activates matching tools for session-a only and redacts metadata.
    const found = await f.dispatcher.invoke({
      id: 'search-1',
      name: 'tool_search',
      input: {query: '+github issues', max_results: 5},
    });
    expect(found.status).toBe('ok');
    expect(found.content).toContain('mcp__beta__search_issues');
    expect(found.content).toContain('[REDACTED]');
    expect(found.content).not.toContain('TOP_SECRET_META');
    expect(f.dispatcher.descriptors().map(d => d.name)).toContain('mcp__beta__search_issues');

    // Exact select: loads specific tools cleanly.
    const selected = await f.dispatcher.invoke({
      id: 'search-2',
      name: 'tool_search',
      input: {query: 'select:mcp__beta__create_ticket,mcp__alpha__op_0'},
    });
    expect(selected.status).toBe('ok');
    const afterSelect = f.dispatcher.descriptors().map(d => d.name);
    expect(afterSelect).toContain('mcp__beta__create_ticket');
    expect(afterSelect).toContain('mcp__alpha__op_0');

    // Session isolation: switching to session-b sees zero activated MCP tools from session-a.
    f.setSession('session-b');
    expect(f.dispatcher.descriptors().filter(d => d.name.startsWith('mcp__'))).toHaveLength(0);

    // Calling a loaded MCP tool still goes through ToolDispatcher approval.
    f.setSession('session-a');
    const callResult = await f.dispatcher.invoke({
      id: 'call-1',
      name: 'mcp__beta__search_issues',
      input: {query: 'bug'},
    });
    expect(callResult.status).toBe('ok');
    expect(callResult.content).toContain('called:mcp__beta__search_issues:bug');
    expect(f.approvals.map(a => a.target)).toEqual(['mcp__beta__search_issues']);

    // Plan mode, readOnly and analysisOnly hide and refuse tool_search.
    f.setMode({permissionMode: 'plan'});
    expect(f.dispatcher.descriptors().some(d => d.name === 'tool_search')).toBe(false);
    const planDenied = await f.dispatcher.invoke({id: 'search-plan', name: 'tool_search', input: {query: 'issues'}});
    expect(planDenied.status).toBe('error');
    expect(planDenied.code).toBe('TOOL_UNAVAILABLE');

    f.setMode({permissionMode: 'default', readOnly: true});
    expect(f.dispatcher.descriptors().some(d => d.name === 'tool_search')).toBe(false);

    f.setMode({readOnly: false, analysisOnly: true});
    expect(f.dispatcher.descriptors().some(d => d.name === 'tool_search')).toBe(false);
  });
});

describe('MCP resources & templates (mcp_resource)', () => {
  test('lists resources/templates, reads text with redaction, omits binary blobs, enforces approvals and denies plan mode over real stdio McpHub', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-res-'));
    cleanups.push(() => rmSync(root, {recursive: true, force: true}));
    const hub = new McpHub(
      [
        {
          name: 'fixture',
          transport: 'stdio',
          command: process.execPath,
          args: ['tests/fixtures/mcp-stdio-server.ts'],
          env: {TOKEN: 'SECRET_RESOURCE_TOKEN'},
        },
      ],
      {
        configPath: join(root, 'mcp.json'),
        redact: text => text.replaceAll('SECRET_RESOURCE_TOKEN', '[REDACTED]'),
      },
    );
    cleanups.push(() => hub.close());
    await hub.connect();

    let permissionMode: 'default' | 'plan' = 'default';
    let readOnly = false;
    const approvals: ApprovalRequest[] = [];
    const grants = new SessionGrants();
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants,
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode, readOnly}),
      approve: async req => {
        approvals.push(req);
        return 'session';
      },
      redact: text => text.replaceAll('SECRET_RESOURCE_TOKEN', '[REDACTED]'),
      mcp: {
        tools: () => hub.tools(),
        call: (name, args, signal) => hub.call(name, args, signal),
        servers: () => hub.servers(),
        listResources: (server, signal) => hub.listResources(server, signal),
        listResourceTemplates: (server, signal) => hub.listResourceTemplates(server, signal),
        readResource: (server, uri, signal) => hub.readResource(server, uri, signal),
      },
    });

    expect(dispatcher.descriptors().some(d => d.name === 'mcp_resource')).toBe(true);

    // List resources (auto-selects single connected server) and approves via mcp__fixture__resources_list.
    const listed = await dispatcher.invoke({id: 'res-list', name: 'mcp_resource', input: {action: 'list'}});
    expect(listed.status).toBe('ok');
    expect(listed.content).toContain('fixture://docs/guide.md');
    expect(listed.content).toContain('fixture://bin/logo.png');
    expect(approvals.at(-1)?.target).toBe('mcp__fixture__resources_list');

    // List templates.
    const templates = await dispatcher.invoke({
      id: 'res-tpl',
      name: 'mcp_resource',
      input: {action: 'templates', server: 'fixture'},
    });
    expect(templates.status).toBe('ok');
    expect(templates.content).toContain('fixture://docs/{slug}.md');
    expect(approvals.at(-1)?.target).toBe('mcp__fixture__resources_templates');

    // Read text resource: redacted secret, never leaks raw token.
    const textRes = await dispatcher.invoke({
      id: 'res-read-text',
      name: 'mcp_resource',
      input: {action: 'read', server: 'fixture', uri: 'fixture://docs/guide.md'},
    });
    expect(textRes.status).toBe('ok');
    expect(textRes.content).toContain('# Fixture Guide');
    expect(textRes.content).toContain('[REDACTED]');
    expect(textRes.content).not.toContain('SECRET_RESOURCE_TOKEN');
    expect(approvals.at(-1)?.target).toBe('mcp__fixture__resources_read');

    // Session grant avoids re-asking on same identity for read.
    const countBefore = approvals.length;
    const binRes = await dispatcher.invoke({
      id: 'res-read-bin',
      name: 'mcp_resource',
      input: {action: 'read', server: 'fixture', uri: 'fixture://bin/logo.png'},
    });
    expect(binRes.status).toBe('ok');
    expect(binRes.content).toContain('[MCP binary resource content (image/png) is unsupported; content was omitted.]');
    expect(approvals.length).toBe(countBefore);

    // Missing resource returns NOT_FOUND cleanly.
    const missing = await dispatcher.invoke({
      id: 'res-missing',
      name: 'mcp_resource',
      input: {action: 'read', server: 'fixture', uri: 'fixture://docs/nope.md'},
    });
    expect(missing.status).toBe('error');
    expect(missing.code).toBe('NOT_FOUND');

    // Reconnect rotates server identity -> prior session grant no longer authorizes read.
    await hub.reconnect('fixture');
    await dispatcher.invoke({
      id: 'res-after-reconnect',
      name: 'mcp_resource',
      input: {action: 'read', server: 'fixture', uri: 'fixture://docs/guide.md'},
    });
    expect(approvals.length).toBe(countBefore + 1);

    // Plan mode and readOnly refuse mcp_resource.
    permissionMode = 'plan';
    expect(dispatcher.descriptors().some(d => d.name === 'mcp_resource')).toBe(false);
    expect((await dispatcher.invoke({id: 'res-plan', name: 'mcp_resource', input: {action: 'list'}})).code).toBe(
      'TOOL_UNAVAILABLE',
    );
    permissionMode = 'default';
    readOnly = true;
    expect(dispatcher.descriptors().some(d => d.name === 'mcp_resource')).toBe(false);
  });

  test('server returning JSON-RPC -32601 for resources yields empty list cleanly and config rejects double-underscore server names', async () => {
    expect(qualifiedMcpName('bad__server', 'tool')).toBeNull();
    const parsed = parseMcpConfig(JSON.stringify({mcpServers: {bad__server: {command: 'echo'}}}));
    expect(parsed.servers).toHaveLength(0);
    expect(parsed.problems[0]).toContain('__');

    // WebSearchClient trims surrounding whitespace on API keys before attaching them.
    let seenUrl = '';
    const client = new WebSearchClient({
      keys: {EXA_API_KEY: '  trimmed-key  '},
      redact: t => t,
      fetch: (async (input: string | URL | Request) => {
        seenUrl = input instanceof Request ? input.url : String(input);
        return new Response(null, {status: 500});
      }) as unknown as typeof fetch,
    });
    await expect(client.search('test')).rejects.toThrow();
    expect(new URL(seenUrl).searchParams.get('exaApiKey')).toBe('trimmed-key');
    await client.close();

    // HTTP server without resources (-32601) returns empty resources/templates.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (req.method !== 'POST') return new Response(null, {status: 405});
        const rpc = (await req.json()) as {id?: number; method: string};
        if (rpc.id === undefined) return new Response(null, {status: 202});
        if (rpc.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {tools: {}},
              serverInfo: {name: 'nores', version: '1'},
            },
          });
        }
        if (rpc.method === 'tools/list') return Response.json({jsonrpc: '2.0', id: rpc.id, result: {tools: []}});
        return Response.json({jsonrpc: '2.0', id: rpc.id, error: {code: -32601, message: 'Method not found'}});
      },
    });
    cleanups.push(() => server.stop(true));
    const hub = new McpHub([{name: 'nores', transport: 'http', url: `${server.url.origin}/mcp`, headers: {}}], {
      configPath: '/tmp/mcp.json',
      redact: t => t,
    });
    cleanups.push(() => hub.close());
    await hub.connect();
    expect(await hub.listResources('nores')).toEqual([]);
    expect(await hub.listResourceTemplates('nores')).toEqual([]);
  });
});
