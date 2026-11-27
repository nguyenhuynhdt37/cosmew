import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpHub, validateMcpMediaAttachment} from '@cosmew/mcp';
import {Redactor, SessionGrants} from '@cosmew/security';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {completionContext, getCompletions} from '../../apps/tui/src/ink/features/autocomplete';
import {routeCommand, type CommandHost} from '../../apps/tui/src/ink/features/commands';
import {fixtureServer, memoryVault} from '../fixtures';

/** Minimal valid 1x1 PNG with non-zero IHDR dimensions (width=1, height=1). */
const VALID_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]).toString('base64');

const VALID_PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF\n', 'latin1').toString('base64');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function writeDynamicMcpServerScript(dir: string): string {
  const scriptPath = join(dir, 'dynamic-mcp-server.ts');
  const source = `
import readline from 'node:readline';

const VALID_PNG = ${JSON.stringify(VALID_PNG_BASE64)};
const VALID_PDF = ${JSON.stringify(VALID_PDF_BASE64)};
const SECRET_PNG = Buffer.concat([Buffer.from(VALID_PNG, 'base64'), Buffer.from('LEAKED_MEDIA_SECRET')]).toString('base64');

let phase = 1;
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\\n');

rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const {id, method, params} = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {listChanged: true},
          prompts: {listChanged: true},
          resources: {listChanged: true},
        },
        serverInfo: {name: 'dynamic-fixture', version: '1.0.0'},
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    const tools = [
      {name: 'screenshot', description: 'Return a valid PNG', inputSchema: {type: 'object', properties: {kind: {type: 'string'}}}},
      {name: 'mutate_catalog', description: 'Trigger list_changed notifications', inputSchema: {type: 'object', properties: {}}},
      ...(phase >= 2 ? [{name: 'new_tool', description: 'Dynamically added tool', inputSchema: {type: 'object', properties: {}}}] : []),
    ];
    send({jsonrpc: '2.0', id, result: {tools}});
    return;
  }
  if (method === 'tools/call') {
    if (params.name === 'screenshot') {
      const kind = params.arguments?.kind ?? 'valid';
      if (kind === 'secret') {
        send({jsonrpc: '2.0', id, result: {content: [{type: 'image', data: SECRET_PNG, mimeType: 'image/png'}]}});
        return;
      }
      if (kind === 'fake') {
        send({jsonrpc: '2.0', id, result: {content: [{type: 'image', data: Buffer.from('not-a-png').toString('base64'), mimeType: 'image/png'}]}});
        return;
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {type: 'text', text: 'Captured UI frame'},
            {type: 'image', data: VALID_PNG, mimeType: 'image/png'},
          ],
        },
      });
      return;
    }
    if (params.name === 'mutate_catalog') {
      phase = 2;
      send({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: 'mutated'}]}});
      send({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
      send({jsonrpc: '2.0', method: 'notifications/prompts/list_changed'});
      return;
    }
    if (params.name === 'new_tool') {
      send({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: 'new tool ran'}]}});
      return;
    }
  }
  if (method === 'resources/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        resources: [
          {uri: 'fixture://img/valid.png', name: 'valid.png', mimeType: 'image/png'},
          {uri: 'fixture://doc/spec.pdf', name: 'spec.pdf', mimeType: 'application/pdf'},
        ],
      },
    });
    return;
  }
  if (method === 'resources/read') {
    if (params.uri === 'fixture://img/valid.png') {
      send({jsonrpc: '2.0', id, result: {contents: [{uri: params.uri, mimeType: 'image/png', blob: VALID_PNG}]}});
      return;
    }
    if (params.uri === 'fixture://doc/spec.pdf') {
      send({jsonrpc: '2.0', id, result: {contents: [{uri: params.uri, mimeType: 'application/pdf', blob: VALID_PDF}]}});
      return;
    }
  }
  if (method === 'prompts/list') {
    const prompts = [
      {
        name: 'review',
        description: 'Review target code',
        arguments: [
          {name: 'file', description: 'File path', required: true},
          {name: 'focus', description: 'Optional focus area'},
        ],
      },
      ...(phase >= 2
        ? [{name: 'release_notes', description: 'Draft release notes', arguments: []}]
        : []),
    ];
    send({jsonrpc: '2.0', id, result: {prompts}});
    return;
  }
  if (method === 'prompts/get') {
    if (params.name === 'review') {
      const file = params.arguments?.file ?? '';
      const focus = params.arguments?.focus ?? 'general';
      send({
        jsonrpc: '2.0',
        id,
        result: {
          description: 'Review prompt',
          messages: [
            {role: 'user', content: {type: 'text', text: 'Please review ' + file + ' focusing on ' + focus + ' (LEAKED_MEDIA_SECRET)'}},
            {role: 'user', content: {type: 'image', data: VALID_PNG, mimeType: 'image/png'}},
          ],
        },
      });
      return;
    }
    if (params.name === 'release_notes') {
      send({
        jsonrpc: '2.0',
        id,
        result: {messages: [{role: 'user', content: {type: 'text', text: 'Summarize recent commits.'}}]},
      });
      return;
    }
  }
  send({jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}});
});
`;
  writeFileSync(scriptPath, source);
  return scriptPath;
}

describe('Group C: MCP Media Attachments, Prompts, and Dynamic Notifications', () => {
  test('validateMcpMediaAttachment accepts real PNG/PDF and rejects fake, mismatched, or secret-bearing payloads', () => {
    const redactor = new Redactor();
    redactor.register('SUPER_SECRET_TOKEN');

    const okPng = validateMcpMediaAttachment({
      data: VALID_PNG_BASE64,
      mimeType: 'image/png',
      redact: t => redactor.text(t),
    });
    expect(okPng.ok).toBe(true);
    if (okPng.ok) expect(okPng.attachment.mime).toBe('image/png');

    const okPdf = validateMcpMediaAttachment({
      data: VALID_PDF_BASE64,
      mimeType: 'application/pdf',
      redact: t => redactor.text(t),
    });
    expect(okPdf.ok).toBe(true);

    const mismatched = validateMcpMediaAttachment({
      data: VALID_PNG_BASE64,
      mimeType: 'image/jpeg',
      redact: t => redactor.text(t),
    });
    expect(mismatched).toEqual({ok: false, reason: 'invalid'});

    const truncated = validateMcpMediaAttachment({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
      redact: t => redactor.text(t),
    });
    expect(truncated).toEqual({ok: false, reason: 'invalid'});

    const secretPng = Buffer.concat([
      Buffer.from(VALID_PNG_BASE64, 'base64'),
      Buffer.from('SUPER_SECRET_TOKEN'),
    ]).toString('base64');
    const leaked = validateMcpMediaAttachment({data: secretPng, mimeType: 'image/png', redact: t => redactor.text(t)});
    expect(leaked).toEqual({ok: false, reason: 'secret'});
  });

  test('MCP tools and mcp_resource attach validated PNG/PDF via ToolDispatcher, reject secret/fake media, and hot-refresh on list_changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosmew-mcp-c-'));
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
    const scriptPath = writeDynamicMcpServerScript(dir);
    const redactor = new Redactor();
    redactor.register('LEAKED_MEDIA_SECRET');

    let toolsChangedCount = 0;
    const hub = new McpHub(
      [{name: 'dyn', transport: 'stdio', command: process.execPath, args: [scriptPath], env: {}, enabled: true}],
      {
        configPath: join(dir, 'mcp.json'),
        redact: t => redactor.text(t),
        onToolsChanged: () => {
          toolsChangedCount++;
        },
      },
    );
    cleanups.push(() => hub.close());
    const snap = await hub.connect();
    expect(snap.servers[0]?.state).toBe('connected');
    expect(hub.prompts().map(p => p.qualifiedName)).toEqual(['mcp__dyn__review']);

    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(dir),
      grants: new SessionGrants(),
      sandbox: () => ({
        enabled: false,
        readOnly: false,
        autoAllowBash: false,
        excludedCommands: [],
        allowUnsandboxed: true,
        additionalDirectories: [],
        network: false,
        permissionMode: 'default',
      }),
      mcp: {
        tools: () => hub.tools(),
        call: (name, args, signal) => hub.call(name, args, signal),
        servers: () => hub.servers(),
        listResources: (server, signal) => hub.listResources(server, signal),
        listResourceTemplates: (server, signal) => hub.listResourceTemplates(server, signal),
        readResource: (server, uri, signal) => hub.readResource(server, uri, signal),
      },
      approve: async () => 'once',
      redact: t => redactor.text(t),
    });

    // 1. Valid PNG from MCP tool arrives as ToolResult.attachments.
    const validTool = await dispatcher.invoke({id: 'c1', name: 'mcp__dyn__screenshot', input: {kind: 'valid'}});
    expect(validTool.status).toBe('ok');
    expect(validTool.attachments).toHaveLength(1);
    expect(validTool.attachments![0]!.mime).toBe('image/png');

    // 2. Secret-bearing PNG is omitted and never attached.
    const secretTool = await dispatcher.invoke({id: 'c2', name: 'mcp__dyn__screenshot', input: {kind: 'secret'}});
    expect(secretTool.attachments).toBeUndefined();
    expect(secretTool.content).toContain('contained a registered secret');

    // 3. Fake PNG fails cleanly as error when image-only.
    const fakeTool = await dispatcher.invoke({id: 'c3', name: 'mcp__dyn__screenshot', input: {kind: 'fake'}});
    expect(fakeTool.status).toBe('error');
    expect(fakeTool.attachments).toBeUndefined();

    // 4. Valid PNG and PDF from mcp_resource become ToolResult.attachments.
    const resPng = await dispatcher.invoke({
      id: 'c4',
      name: 'mcp_resource',
      input: {action: 'read', server: 'dyn', uri: 'fixture://img/valid.png'},
    });
    expect(resPng.status).toBe('ok');
    expect(resPng.attachments?.[0]?.mime).toBe('image/png');

    const resPdf = await dispatcher.invoke({
      id: 'c5',
      name: 'mcp_resource',
      input: {action: 'read', server: 'dyn', uri: 'fixture://doc/spec.pdf'},
    });
    expect(resPdf.status).toBe('ok');
    expect(resPdf.attachments?.[0]?.mime).toBe('application/pdf');

    // 5. Dynamic notifications/tools/list_changed & prompts/list_changed refresh catalog and bump identity.
    const identityBefore = hub.tools()[0]!.identity;
    const mutateRes = await dispatcher.invoke({id: 'c6', name: 'mcp__dyn__mutate_catalog', input: {}});
    expect(mutateRes.status).toBe('ok');

    // Wait briefly for asynchronous single-flight refresh triggered by notifications.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (hub.tools().some(t => t.name === 'mcp__dyn__new_tool') && hub.prompts().some(p => p.name === 'release_notes'))
        break;
      await Bun.sleep(25);
    }
    expect(toolsChangedCount).toBeGreaterThanOrEqual(1);
    expect(hub.tools().some(t => t.name === 'mcp__dyn__new_tool')).toBe(true);
    expect(hub.tools()[0]!.identity).not.toBe(identityBefore);
    expect(hub.prompts().map(p => p.qualifiedName)).toContain('mcp__dyn__release_notes');
  });

  test('MCP prompts integrate into SDK, TUI autocomplete, and routeCommand with plan/deny enforcement and argument parsing', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cosmew-mcp-prompt-state-'));
    const workspace = mkdtempSync(join(tmpdir(), 'cosmew-mcp-prompt-ws-'));
    const scriptPath = writeDynamicMcpServerScript(stateDir);
    const fixture = fixtureServer();
    const app = startup(stateDir, {vault: memoryVault(), skillsHome: stateDir, memoriesHome: stateDir});
    cleanups.push(async () => {
      fixture.server.stop(true);
      await app.shutdownCommands();
      app.db.close();
      rmSync(stateDir, {recursive: true, force: true});
      rmSync(workspace, {recursive: true, force: true});
    });

    app.redactor.register('LEAKED_MEDIA_SECRET');
    const provider = fixture.provider('chat');
    app.registry.add(provider);
    const key = crypto.randomUUID();
    await app.vault.set(key, 'sk-mcp-prompt-test');
    const account = await app.accounts.add(provider.id, 'p', {kind: 'keyring', key}, 'sk-mcp-prompt-test');
    const client = app.createFutrynClient(workspace);
    client.addManualModel('fixture-model', account.id);
    client.selectModel('fixture-model');
    client.setToolsEnabled(true);

    await client.manageMcp({
      type: 'add',
      name: 'dyn',
      config: {transport: 'stdio', command: process.execPath, args: [scriptPath]},
    });

    // Autocomplete exposes /mcp__dyn__review with argument hints.
    const prompts = client.mcpPrompts();
    expect(prompts).toHaveLength(1);
    const completions = getCompletions(completionContext('/mcp__dyn', 9), [], [], prompts);
    expect(completions.some(c => c.label === '/mcp__dyn__review' && c.description.includes('<file>'))).toBe(true);

    // Missing required argument reports clear usage error.
    await expect(client.resolveMcpPrompt('/mcp__dyn__review')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('<file>'),
    });

    // Plan mode refuses MCP prompt execution.
    client.setPermissionMode('plan');
    await expect(client.resolveMcpPrompt('/mcp__dyn__review src/app.ts')).rejects.toMatchObject({code: 'POLICY'});
    client.setPermissionMode('default');

    // Deny rule blocks specific MCP prompt.
    client.addPermissionRule('deny', 'mcp__dyn__review', 'local');
    await expect(client.resolveMcpPrompt('/mcp__dyn__review src/app.ts')).rejects.toMatchObject({code: 'POLICY'});
    client.removePermissionRule('deny', 'mcp__dyn__review', 'local');

    // routeCommand expands prompt with named & positional args, redacts secrets, stages valid PNG attachment, and submits.
    const submitted: {text: string; label?: string}[] = [];
    const notices: string[] = [];
    const host: CommandHost = {
      client,
      busy: () => false,
      open: () => {},
      notice: text => notices.push(text),
      reset: () => {},
      submit: (text, label) => {
        submitted.push({text, label});
        return true;
      },
      exit: () => {},
    };
    await routeCommand(host, '/mcp__dyn__review src/index.ts focus="error handling"');
    expect(notices).toEqual([]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.text).toContain('untrusted MCP server prompt content');
    expect(submitted[0]!.text).toContain('src/index.ts');
    expect(submitted[0]!.text).toContain('error handling');
    expect(submitted[0]!.text).not.toContain('LEAKED_MEDIA_SECRET');
  });
});
