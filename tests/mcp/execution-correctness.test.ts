import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {DEFAULT_SANDBOX_CONFIG} from '@cosmew/tools';
import {SessionGrants} from '@cosmew/security';
import {SqliteToolOutputArchive} from '@cosmew/persistence';
import {ExecutionGate} from '../../packages/core/src/agent/tool-runtime';

function fixture(schema: Record<string, unknown>, readOnlyHint?: boolean, validSibling = false) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-correct-'));
  let asked = 0,
    calls = 0;
  const db = new Database(':memory:');
  const grants = new SessionGrants();
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
    approve: async () => {
      asked++;
      return 'once';
    },
    redact: text => text.replaceAll('SECRET', '[REDACTED]'),
    outputArchive: {
      store: new SqliteToolOutputArchive(db),
      permissionContext: () => 'initial',
      scope: () => ({workspace: root, session: 'test'}),
    },
    mcp: {
      tools: () => [
        {name: 'mcp__fixture__run', description: 'run', inputSchema: schema, readOnlyHint},
        ...(validSibling
          ? [{name: 'mcp__fixture__valid', description: 'valid sibling', inputSchema: {type: 'object'}}]
          : []),
      ],
      call: async () => {
        calls++;
        return 'a'.repeat(61000) + '\nSENTINEL SECRET';
      },
    },
  });
  return {
    dispatcher,
    grants,
    get asked() {
      return asked;
    },
    get calls() {
      return calls;
    },
    close() {
      db.close();
      rmSync(root, {recursive: true, force: true});
    },
  };
}

test('MCP advertised schema rejects malformed arguments before approval or remote execution', async () => {
  const f = fixture({type: 'object', properties: {n: {type: 'integer'}}, required: ['n'], additionalProperties: false});
  try {
    for (const input of [{}, {n: '1'}, {n: 1, extra: true}]) {
      expect((await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input})).code).toBe(
        'INVALID_INPUT',
      );
    }
    expect(f.asked).toBe(0);
    expect(f.calls).toBe(0);
    expect((await f.dispatcher.invoke({id: 'valid', name: 'mcp__fixture__run', input: {n: 1}})).status).toBe('ok');
    expect(f.asked).toBe(1);
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});

test('MCP oversized, invalid and costly schemas stay hidden and direct calls explicitly refuse without approval', async () => {
  for (const schema of [
    {type: 'object', description: 'x'.repeat(9000)},
    {type: 'object', properties: {n: {type: 'bogus'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '(a+)+$'}}},
  ]) {
    const f = fixture(schema, undefined, true);
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(false);
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__valid')).toBe(true);
      const result = await f.dispatcher.invoke({id: 'bad-schema', name: 'mcp__fixture__run', input: {}});
      expect(result.code).toBe('INVALID_INPUT');
      expect(result.content).toContain('schema');
      expect(f.asked).toBe(0);
      expect(f.calls).toBe(0);
    } finally {
      f.close();
    }
  }
});

test('MCP captured tail is retrieved under current authority without replaying the call', async () => {
  const f = fixture({type: 'object'});
  try {
    const result = await f.dispatcher.invoke({id: 'large', name: 'mcp__fixture__run', input: {}});
    const output_id = result.content.match(/output_id=([\w-]+)/)?.[1];
    expect(output_id).toBeDefined();
    const page = await f.dispatcher.invoke({
      id: 'retrieve',
      name: 'tool_output',
      input: {output_id, query: 'SENTINEL'},
    });
    expect(page.status).toBe('ok');
    expect(page.content).toContain('SENTINEL [REDACTED]');
    expect(f.calls).toBe(1);
    expect(f.asked).toBe(2);
    f.grants.clear();
    expect((await f.dispatcher.invoke({id: 'revoked', name: 'tool_output', input: {output_id}})).status).toBe('denied');
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});

test('MCP unknown tools take exclusive slots; explicit readonly tools overlap but cannot skip approvals', async () => {
  for (const readonly of [undefined, false, true]) {
    const f = fixture({type: 'object'}, readonly);
    try {
      const gate = new ExecutionGate(4),
        events: string[] = [];
      const desc = f.dispatcher.descriptors().find(d => d.name === 'mcp__fixture__run')!;
      const run = async (id: string, parallel: boolean) => {
        const release = await gate.acquire(!parallel);
        events.push(id + ':start');
        await new Promise(resolve => setTimeout(resolve, 5));
        if (id !== 'builtin-read') await f.dispatcher.invoke({id, name: desc.name, input: {}});
        events.push(id + ':end');
        release();
      };
      await Promise.all([
        run('one', desc.parallel === true),
        run('two', desc.parallel === true),
        run('builtin-read', true),
      ]);
      if (readonly === true) expect(events.slice(0, 3)).toEqual(['one:start', 'two:start', 'builtin-read:start']);
      else
        expect(events).toEqual([
          'one:start',
          'one:end',
          'two:start',
          'two:end',
          'builtin-read:start',
          'builtin-read:end',
        ]);
      expect(f.asked).toBe(2);
      expect(f.calls).toBe(2);
    } finally {
      f.close();
    }
  }
});

test('MCP application errors retain redacted bounded repair guidance separately from transport errors', async () => {
  const {McpHub} = await import('@cosmew/mcp');
  const root = mkdtempSync(join(tmpdir(), 'mcp-error-'));
  const fixturePath = join(root, 'server.ts');
  const {readFileSync, writeFileSync} = await import('node:fs');
  let source = readFileSync('tests/fixtures/mcp-stdio-server.ts', 'utf8');
  source = source.replace(
    "result: {content: [{type: 'text', text: `echo:${message.params.arguments?.text ?? ''}`}]}",
    "result: {isError: true, content: [{type: 'text', text: 'Use fully-qualified name SECRET ' + 'x'.repeat(70000)}]}",
  );
  writeFileSync(fixturePath, source);
  const hub = new McpHub(
    [{name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixturePath], env: {}}],
    {configPath: join(root, 'mcp.json'), redact: text => text.replaceAll('SECRET', '[REDACTED]')},
  );
  try {
    await hub.connect();
    const result = await hub.call('mcp__fixture__echo', {});
    expect(typeof result).toBe('object');
    if (typeof result !== 'object') throw new Error('lost application error');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Use fully-qualified name [REDACTED]');
    expect(result.text).not.toContain('SECRET');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536);
  } finally {
    await hub.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('MCP discovery refuses an oversized schema explicitly instead of replacing it with unrestricted input', async () => {
  const {McpHub} = await import('@cosmew/mcp');
  const root = mkdtempSync(join(tmpdir(), 'mcp-schema-'));
  const fixturePath = join(root, 'server.ts');
  const {readFileSync, writeFileSync} = await import('node:fs');
  const source = readFileSync('tests/fixtures/mcp-stdio-server.ts', 'utf8')
    .replace("description: 'Echo text',", "description: 'Echo text', annotations: {readOnlyHint: true},")
    .replace('additionalProperties: false}', "additionalProperties: false, description: 'x'.repeat(9000)}");
  writeFileSync(fixturePath, source);
  const hub = new McpHub(
    [{name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixturePath], env: {}}],
    {configPath: join(root, 'mcp.json'), redact: text => text},
  );
  try {
    const status = await hub.connect();
    expect(status.servers[0]?.state).toBe('connected');
    expect(status.problems.join(' ')).toContain('schema');
    expect(hub.tools()).toHaveLength(0);
  } finally {
    await hub.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('changed MCP schemas invalidate a pending approval instead of executing an old registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-change-'));
  let schema: Record<string, unknown> = {type: 'object'},
    calls = 0;
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
    approve: async () => {
      schema = {type: 'object', properties: {newField: {type: 'string'}}, required: ['newField']};
      return 'once';
    },
    redact: text => text,
    mcp: {
      tools: () => [{name: 'mcp__fixture__run', description: 'run', inputSchema: schema}],
      call: async () => {
        calls++;
        return 'bad';
      },
    },
  });
  try {
    const result = await dispatcher.invoke({id: 'pending', name: 'mcp__fixture__run', input: {}});
    expect(result.status).toBe('denied');
    expect(calls).toBe(0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('MCP application failure is distinct from hidden transport exception details at dispatcher boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-failure-'));
  let transport = false;
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
    approve: async () => 'once',
    redact: text => text.replaceAll('SECRET', '[REDACTED]'),
    mcp: {
      tools: () => [{name: 'mcp__fixture__run', description: 'run', inputSchema: {type: 'object'}}],
      call: async () => {
        if (transport) throw new Error('SECRET endpoint headers');
        return {text: 'Use fully-qualified name SECRET', isError: true};
      },
    },
  });
  try {
    const app = await dispatcher.invoke({id: 'app', name: 'mcp__fixture__run', input: {}});
    expect(app.status).toBe('error');
    expect(app.code).toBe('MCP_TOOL_ERROR');
    expect(app.content).toContain('Use fully-qualified name [REDACTED]');
    transport = true;
    const failed = await dispatcher.invoke({id: 'transport', name: 'mcp__fixture__run', input: {}});
    expect(failed.code).toBe('TRANSPORT');
    expect(failed.content).not.toContain('endpoint');
    expect(failed.content).not.toContain('SECRET');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('MCP stdio discovery carries explicit readonly scheduling metadata to approved dispatcher calls', async () => {
  const {McpHub} = await import('@cosmew/mcp');
  const {readFileSync, writeFileSync} = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'mcp-readonly-'));
  const fixturePath = join(root, 'server.ts');
  writeFileSync(
    fixturePath,
    readFileSync('tests/fixtures/mcp-stdio-server.ts', 'utf8').replace(
      "description: 'Echo text',",
      "description: 'Echo text', annotations: {readOnlyHint: true},",
    ),
  );
  const hub = new McpHub(
    [{name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixturePath], env: {}}],
    {configPath: join(root, 'mcp.json'), redact: text => text},
  );
  let asked = 0;
  try {
    await hub.connect();
    const dispatcher = new ToolDispatcher({
      workspace: new WorkspaceRoot(root),
      grants: new SessionGrants(),
      sandbox: () => ({...DEFAULT_SANDBOX_CONFIG, permissionMode: 'default', readOnly: false}),
      approve: async () => {
        asked++;
        return 'once';
      },
      redact: text => text,
      mcp: hub,
    });
    expect(dispatcher.descriptors().find(d => d.name === 'mcp__fixture__echo')?.parallel).toBe(true);
    const result = await dispatcher.invoke({id: 'readonly', name: 'mcp__fixture__echo', input: {text: 'hello'}});
    expect(result.status).toBe('ok');
    expect(result.content).toContain('echo:hello');
    expect(asked).toBe(1);
  } finally {
    await hub.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('MCP schema keyword restrictions do not reject ordinary argument names or annotation data', async () => {
  const f = fixture({
    type: 'object',
    properties: {
      pattern: {type: 'string'},
      format: {type: 'string'},
      contains: {type: 'boolean'},
      payload: {
        type: 'object',
        enum: [{pattern: 'value'}],
        default: {format: 'annotation'},
        examples: [{contains: true}],
      },
    },
    additionalProperties: false,
  });
  try {
    const result = await f.dispatcher.invoke({
      id: 'keyword-fields',
      name: 'mcp__fixture__run',
      input: {pattern: 'foo', format: 'json', contains: true, payload: {pattern: 'value'}},
    });
    expect(result.status).toBe('ok');
    expect(f.asked).toBe(1);
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});

test('OpenAI Docs 2020-12 search schema exposes the tool and validates arguments before approval', async () => {
  const f = fixture({
    type: 'object',
    properties: {
      query: {type: 'string', minLength: 1},
      limit: {type: 'integer', minimum: 1, maximum: 50},
      cursor: {type: 'string'},
    },
    required: ['query'],
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  });
  try {
    expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(true);
    for (const input of [{}, {query: ''}, {query: 'Responses API', limit: 51}, {query: 'API', limit: '2'}]) {
      const result = await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input});
      expect(result.code).toBe('INVALID_INPUT');
    }
    expect(f.asked).toBe(0);
    expect(f.calls).toBe(0);
    const result = await f.dispatcher.invoke({
      id: 'openai-docs-search',
      name: 'mcp__fixture__run',
      input: {query: 'Responses API', limit: 2},
    });
    expect(result.status).toBe('ok');
    expect(f.asked).toBe(1);
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});

test('2020-12 validates dependentRequired instead of treating the schema as draft-07', async () => {
  const f = fixture({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {query: {type: 'string'}, cursor: {type: 'string'}},
    dependentRequired: {cursor: ['query']},
  });
  try {
    expect(
      (await f.dispatcher.invoke({id: 'missing-query', name: 'mcp__fixture__run', input: {cursor: 'next'}})).code,
    ).toBe('INVALID_INPUT');
    expect(f.calls).toBe(0);
    expect(
      (await f.dispatcher.invoke({id: 'valid-query', name: 'mcp__fixture__run', input: {cursor: 'next', query: 'API'}}))
        .status,
    ).toBe('ok');
    expect(f.calls).toBe(1);
  } finally {
    f.close();
  }
});

test('2020-12 schema positions retain costly keyword restrictions and unknown dialects are refused', async () => {
  for (const schema of [
    {$schema: 'https://example.com/unknown-schema', type: 'object'},
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      unevaluatedProperties: {type: 'string', pattern: '(a+)+$'},
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {args: {type: 'array', prefixItems: [{type: 'string', pattern: '(a+)+$'}], minItems: 1, maxItems: 1}},
    },
  ]) {
    const f = fixture(schema);
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(false);
      expect((await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input: {}})).code).toBe(
        'INVALID_INPUT',
      );
      expect(f.asked).toBe(0);
      expect(f.calls).toBe(0);
    } finally {
      f.close();
    }
  }
});

test('Zod and FastMCP schemas with local $ref, format, uniqueItems and ReDoS-safe pattern are exposed and enforced', async () => {
  const draft07ZodSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    definitions: {
      Tag: {
        type: 'string',
        pattern: '^[a-z0-9_-]{1,32}$',
      },
      Filter: {
        type: 'object',
        properties: {
          id: {type: 'string', format: 'uuid'},
          kind: {type: 'string', pattern: '^(foo|bar|baz)$'},
          createdAfter: {type: 'string', format: 'date-time'},
          date: {type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$'},
          homepage: {type: 'string', pattern: '^https?://[^\\s/$.?#].[^\\s]*$'},
          active: {type: 'boolean'},
          tags: {type: 'array', items: {$ref: '#/definitions/Tag'}, uniqueItems: true},
        },
        required: ['id', 'tags'],
        additionalProperties: false,
      },
    },
    properties: {
      filter: {$ref: '#/definitions/Filter', description: 'Primary query filter'},
      secondary: {$ref: '#/definitions/Tag', title: 'Secondary tag', default: 'main'},
      callbackUrl: {type: 'string', format: 'uri'},
    },
    required: ['filter'],
    additionalProperties: false,
  };

  const draft2020FastMcpSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    $defs: {
      'Scope/Rule~v1': {
        type: 'string',
        pattern: '^[a-z0-9_-]{1,32}$',
      },
      Filter: {
        type: 'object',
        properties: {
          ownerEmail: {type: 'string', format: 'email'},
          endpoint: {type: 'string', format: 'uri'},
          requestId: {type: 'string', format: 'uuid'},
          since: {type: 'string', format: 'date-time'},
          scopes: {
            type: 'array',
            items: {$ref: '#/$defs/Scope~1Rule~0v1'},
            uniqueItems: true,
          },
          enabled: {type: 'boolean'},
        },
        required: ['scopes', 'enabled'],
        additionalProperties: false,
      },
    },
    properties: {
      filter: {$ref: '#/$defs/Filter', description: 'FastMCP filter model'},
      labels: {type: 'array', items: {type: 'string', pattern: '^[a-z0-9_-]{1,32}$'}, uniqueItems: true},
    },
    required: ['filter'],
    additionalProperties: false,
  };

  {
    const f = fixture(draft07ZodSchema);
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(true);
      for (const badInput of [
        {filter: {id: '123', tags: ['BAD PATTERN!']}},
        {filter: {id: '123', tags: ['dup', 'dup']}},
        {filter: {id: '123', tags: ['ok'], active: 'not-bool'}},
        {filter: {id: '123', tags: ['ok'], kind: 'qux'}},
        {filter: {id: '123', tags: ['ok']}, secondary: 'bad space'},
      ]) {
        const res = await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input: badInput});
        expect(res.code).toBe('INVALID_INPUT');
      }
      expect(f.asked).toBe(0);
      expect(f.calls).toBe(0);

      const ok = await f.dispatcher.invoke({
        id: 'zod-valid',
        name: 'mcp__fixture__run',
        input: {
          filter: {
            id: '550e8400-e29b-41d4-a716-446655440000',
            kind: 'bar',
            createdAfter: '2026-01-01T00:00:00Z',
            date: '2026-01-01',
            homepage: 'https://example.com/docs',
            active: true,
            tags: ['alpha-1', 'beta_2'],
          },
          secondary: 'release-1',
          callbackUrl: 'https://example.com/hook',
        },
      });
      expect(ok.status).toBe('ok');
      expect(f.asked).toBe(1);
      expect(f.calls).toBe(1);
    } finally {
      f.close();
    }
  }

  {
    const f = fixture(draft2020FastMcpSchema);
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(true);
      for (const badInput of [
        {filter: {scopes: ['INVALID!'], enabled: true}},
        {filter: {scopes: ['read', 'read'], enabled: true}},
        {filter: {scopes: ['read'], enabled: 'true'}},
        {filter: {scopes: ['read'], enabled: true}, labels: ['bad label']},
      ]) {
        const res = await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input: badInput});
        expect(res.code).toBe('INVALID_INPUT');
      }
      expect(f.asked).toBe(0);
      expect(f.calls).toBe(0);

      const ok = await f.dispatcher.invoke({
        id: 'fastmcp-valid',
        name: 'mcp__fixture__run',
        input: {
          filter: {
            ownerEmail: 'dev@example.com',
            endpoint: 'https://api.example.com/v1',
            requestId: '550e8400-e29b-41d4-a716-446655440000',
            since: '2026-01-01T00:00:00Z',
            scopes: ['read_1', 'write-2'],
            enabled: false,
          },
          labels: ['prod', 'mcp_v1'],
        },
      });
      expect(ok.status).toBe('ok');
      expect(f.asked).toBe(1);
      expect(f.calls).toBe(1);
    } finally {
      f.close();
    }
  }

  // Depth-8 local $ref chain, sibling reuse, 2020-12 sibling validation keywords, and $ref as argument name
  const depth8Defs: Record<string, unknown> = {D8: {type: 'string', minLength: 1}};
  for (let i = 7; i >= 1; i--) depth8Defs[`D${i}`] = {$ref: `#/$defs/D${i + 1}`};
  {
    const f = fixture({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: depth8Defs,
      properties: {
        a: {$ref: '#/$defs/D1', maxLength: 8, description: 'Bounded via 2020-12 sibling keyword'},
        b: {$ref: '#/$defs/D8'},
        $ref: {type: 'string', pattern: '^(?:[a-z]+)$'},
        unicode: {type: 'string', pattern: '^\\p{L}+$'},
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(true);
      expect(
        (await f.dispatcher.invoke({id: 'too-long', name: 'mcp__fixture__run', input: {a: '123456789', b: 'ok'}})).code,
      ).toBe('INVALID_INPUT');
      expect(
        (
          await f.dispatcher.invoke({
            id: 'bad-unicode',
            name: 'mcp__fixture__run',
            input: {a: 'ok', b: 'ok', unicode: '123'},
          })
        ).code,
      ).toBe('INVALID_INPUT');
      expect(f.calls).toBe(0);
      expect(
        (
          await f.dispatcher.invoke({
            id: 'depth8-ok',
            name: 'mcp__fixture__run',
            input: {a: 'ok', b: 'yes', $ref: 'safe', unicode: 'XinChao'},
          })
        ).status,
      ).toBe('ok');
      expect(f.calls).toBe(1);
    } finally {
      f.close();
    }
  }
});

test('External, cyclic, deep, or bomb $ref and ReDoS or invalid schema features are safely refused', async () => {
  const expansionBombDefs: Record<string, unknown> = {
    L8: {type: 'object', properties: {leaf: {type: 'string'}}},
  };
  for (let i = 7; i >= 0; i--) {
    expansionBombDefs[`L${i}`] = {
      type: 'object',
      properties: {a: {$ref: `#/$defs/L${i + 1}`}, b: {$ref: `#/$defs/L${i + 1}`}},
    };
  }

  const deepChainDefs: Record<string, unknown> = {
    D9: {type: 'string'},
  };
  for (let i = 8; i >= 1; i--) {
    deepChainDefs[`D${i}`] = {$ref: `#/$defs/D${i + 1}`};
  }

  const rejectedSchemas: Record<string, unknown>[] = [
    // External & invalid local $ref
    {type: 'object', properties: {x: {$ref: 'https://example.com/s.json'}}},
    {type: 'object', properties: {x: {$ref: 'file:///etc/passwd'}}},
    {type: 'object', properties: {x: {$ref: '#'}}},
    {type: 'object', properties: {a: {type: 'string'}, b: {$ref: '#/properties/a'}}},
    {type: 'object', properties: {x: {$ref: '#/$defs/Missing'}}},
    {type: 'object', properties: {x: {$ref: '#/$defs/toString'}}},
    // Cyclic $ref (direct & indirect, including unused hidden cycle in $defs)
    {
      type: 'object',
      $defs: {A: {$ref: '#/$defs/B'}, B: {$ref: '#/$defs/A'}},
      properties: {x: {$ref: '#/$defs/A'}},
    },
    {
      type: 'object',
      $defs: {A: {$ref: '#/$defs/A'}},
      properties: {ok: {type: 'string'}},
    },
    // $ref nesting depth > 8
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: deepChainDefs,
      properties: {x: {$ref: '#/$defs/D1'}},
    },
    // Expansion bomb (> 512 nodes / > 16384 bytes after inline while input < 8192 bytes)
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: expansionBombDefs,
      properties: {root: {$ref: '#/$defs/L0'}},
    },
    // ReDoS patterns & backreferences & lookarounds
    {type: 'object', properties: {s: {type: 'string', pattern: '^(a+)+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '(foo|fo)+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '([a-z]*)*$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^((a+)b)+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^((a|b))+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^(a?)*$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^(?:[a-z]+)+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^([a-z]+)\\1$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^(?=a+b)[a-z]+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: '^(?<=a)[a-z]+$'}}},
    {type: 'object', properties: {s: {type: 'string', pattern: ''}}},
    {type: 'object', properties: {s: {type: 'string', pattern: 'a'.repeat(257)}}},
    // Invalid format / uniqueItems & forbidden keywords (including inside unused $defs)
    {type: 'object', properties: {s: {type: 'string', format: 'f'.repeat(65)}}},
    {type: 'object', properties: {s: {type: 'string', format: 123}}},
    {type: 'object', properties: {a: {type: 'array', uniqueItems: 'true'}}},
    {type: 'object', $defs: {Evil: {type: 'object', patternProperties: {'^a': {type: 'string'}}}}},
    {type: 'object', properties: {a: {type: 'array', contains: {type: 'string'}}}},
    {type: 'object', properties: {a: {$dynamicRef: '#node'}}},
    {type: 'object', properties: {a: {$recursiveRef: '#'}}},
    {type: 'object', $async: true},
  ];

  for (const schema of rejectedSchemas) {
    const f = fixture(schema, undefined, true);
    try {
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__run')).toBe(false);
      expect(f.dispatcher.descriptors().some(d => d.name === 'mcp__fixture__valid')).toBe(true);
      const res = await f.dispatcher.invoke({id: crypto.randomUUID(), name: 'mcp__fixture__run', input: {}});
      expect(res.code).toBe('INVALID_INPUT');
      expect(f.asked).toBe(0);
      expect(f.calls).toBe(0);
    } finally {
      f.close();
    }
  }
});
