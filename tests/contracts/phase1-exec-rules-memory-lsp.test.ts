import {afterEach, describe, expect, test} from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CONTRACT_VERSION,
  providerSchema,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type ProjectInstructionReader,
} from '@cosmew/contracts';
import {
  ProjectContextLoader,
  SkillCatalog,
  WorkspaceRoot,
  expandCommandArguments,
  extractAtImports,
  matchRuleGlob,
  parseCommandDocument,
  parseRuleFrontmatter,
  skillInvocations,
} from '@cosmew/workspace';
import {extractAutoMemories, looksLikeSensitiveMemory, parseExtractedMemories} from '@cosmew/core';
import {SERVERS, buildServerSpecs, specFor, trustedServerProgram} from '@cosmew/code-intel';
import {compileOutputJsonSchema, extractStructuredJson} from '@cosmew/models';
import {HostConfigStore} from '../../apps/cli/src/bootstrap/host-config';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {runExec} from '../../apps/cli/src/exec';
import {memoryVault} from '../fixtures';

const cleanups: (() => void | Promise<void>)[] = [];

function makeTempDir(prefix = 'cosmew-p1-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function workspaceReader(workspace: WorkspaceRoot): ProjectInstructionReader {
  return {
    async read(path, maxBytes) {
      try {
        const resolved = workspace.resolve(path);
        if (resolved.kind !== 'file') return {status: 'missing', code: 'NOT_FOUND'};
        const {bytes, size} = workspace.readBytes(resolved, maxBytes + 1);
        const truncated = size > maxBytes;
        const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
        return {
          status: 'ok',
          content: new TextDecoder('utf-8').decode(slice),
          canonicalPath: resolved.absolute,
          fileBytes: size,
          truncated,
        };
      } catch {
        return {status: 'missing', code: 'NOT_FOUND'};
      }
    },
  };
}

function sseChatText(text: string): Response {
  const payload = [
    `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {content: text}, finish_reason: null}]})}`,
    `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 40, completion_tokens: 15, total_tokens: 55}})}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
  return new Response(payload, {status: 200, headers: {'content-type': 'text/event-stream'}});
}

async function setupHeadlessApp(
  handler: (url: string, body: Record<string, unknown>, call: number) => Response | Promise<Response>,
  configToml?: string,
) {
  const state = makeTempDir('cosmew-exec-state-');
  const ws = makeTempDir('cosmew-exec-ws-');
  const memHome = makeTempDir('cosmew-exec-mem-');
  if (configToml) {
    const cfgPath = join(state, 'config.toml');
    writeFileSync(cfgPath, configToml, {mode: 0o600});
    chmodSync(cfgPath, 0o600);
  }
  const seenRequests: Array<{url: string; body: Record<string, unknown>}> = [];
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = req.url;
    if (req.method === 'GET' || url.endsWith('/models')) {
      return Response.json({
        data: [
          {id: 'primary-model', context_length: 128000, supports_tools: true},
          {id: 'backup-model', context_length: 128000, supports_tools: true},
        ],
      });
    }
    const body = (await req.json()) as Record<string, unknown>;
    if (!body.stream && !JSON.stringify(body).includes('Extract at most 3 durable')) {
      return Response.json({
        id: 'verify-1',
        object: 'chat.completion',
        choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 5, completion_tokens: 1, total_tokens: 6},
      });
    }
    seenRequests.push({url, body});
    return handler(url, body, ++calls);
  }) as typeof fetch;

  const vault = memoryVault();
  const app = startup(state, {vault, offline: true, fetch: fetchImpl, memoriesHome: memHome});
  cleanups.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add(
    providerSchema.parse({
      id: 'test-gw',
      name: 'Test Gateway',
      baseURL: 'https://gateway.example/v1',
      protocol: 'chat',
      auth: 'none',
      catalog: 'openai',
      metadataVersion: 1,
    }),
  );
  const account = await app.accounts.add('test-gw', 'ci', {kind: 'none'});
  const client = app.createFutrynClient(ws);
  client.useAccount(account.id);
  await client.discoverModels();
  client.selectModel('primary-model');
  return {app, ws, state, memHome, seenRequests};
}

describe('Phase 1 (Contract 1.69) — 1A: cosmew exec CI/CD upgrades', () => {
  test('contract version is 1.70 and output JSON schema compiler rejects external $ref and oversized schemas', () => {
    expect(CONTRACT_VERSION).toBe('1.70');
    const compiled = compileOutputJsonSchema(
      JSON.stringify({
        type: 'object',
        properties: {ok: {type: 'boolean'}, count: {type: 'integer'}},
        required: ['ok', 'count'],
        additionalProperties: false,
      }),
    );
    expect(compiled.validate({ok: true, count: 3})).toEqual({ok: true});
    expect(compiled.validate({ok: 'yes'}).ok).toBe(false);
    expect(extractStructuredJson('```json\n{"ok":true,"count":2}\n```')).toEqual({
      ok: true,
      value: {ok: true, count: 2},
      canonicalText: '{"ok":true,"count":2}',
    });
    expect(() => compileOutputJsonSchema('{"$ref":"https://evil.example/schema.json"}')).toThrow();
    expect(() => compileOutputJsonSchema('not-json')).toThrow();
  });

  test('exec --json-schema validates output, repairs fenced/invalid response once, and fails closed when still invalid', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {status: {enum: ['pass', 'fail']}, score: {type: 'number'}},
      required: ['status', 'score'],
      additionalProperties: false,
    });
    const outFile = join(makeTempDir('cosmew-exec-out-'), 'result.json');
    const {app, ws, seenRequests} = await setupHeadlessApp((_url, _body, call) => {
      if (call === 1) return sseChatText('Here is my answer: not valid json');
      return sseChatText('```json\n{"status":"pass","score":98}\n```');
    });

    const code = await runExec(app, {
      prompt: 'Evaluate build',
      workspace: ws,
      json: false,
      jsonSchema: schema,
      systemPrompt: 'Follow strict CI rules.',
      outputLastMessage: outFile,
    });
    expect(code).toBe(0);
    expect(seenRequests.length).toBe(2); // initial + 1 repair turn
    expect(JSON.parse(readFileSync(outFile, 'utf8').trim())).toEqual({status: 'pass', score: 98});
    expect(JSON.stringify(seenRequests[0]!.body)).toContain('Follow strict CI rules.');

    // Fail closed when output remains invalid after 1 repair attempt
    const failing = await setupHeadlessApp(() => sseChatText('{"status":"invalid"}'));
    const failCode = await runExec(failing.app, {
      prompt: 'Evaluate build',
      workspace: failing.ws,
      json: false,
      jsonSchema: schema,
    });
    expect(failCode).toBe(1);
    expect(failing.seenRequests.length).toBe(2);
  });

  test('exec supports --fallback-model on RATE_LIMIT, --add-dir validation, and --continue session resume', async () => {
    const extraDir = makeTempDir('cosmew-extra-dir-');
    const out1 = join(makeTempDir('cosmew-out1-'), 'first.txt');
    const out2 = join(makeTempDir('cosmew-out2-'), 'second.txt');
    const {app, ws, seenRequests} = await setupHeadlessApp((_url, body) => {
      if (body.model === 'primary-model') {
        return new Response(JSON.stringify({error: {message: 'rate limited'}}), {
          status: 429,
          headers: {'content-type': 'application/json', 'retry-after': '0'},
        });
      }
      const promptCount = Array.isArray(body.messages) ? body.messages.length : 0;
      return sseChatText(`model=${String(body.model)} msgs=${promptCount}`);
    });

    const code1 = await runExec(app, {
      prompt: 'First CI step',
      workspace: ws,
      json: false,
      model: 'primary-model',
      fallbackModel: 'backup-model',
      addDirs: [extraDir],
      maxTurns: 5,
      outputLastMessage: out1,
    });
    expect(code1).toBe(0);
    expect(readFileSync(out1, 'utf8').trim()).toContain('model=backup-model');

    // --continue resumes the previous workspace session with prior history preserved
    const code2 = await runExec(app, {
      prompt: 'Second CI step',
      workspace: ws,
      json: false,
      model: 'backup-model',
      continueLatest: true,
      outputLastMessage: out2,
    });
    expect(code2).toBe(0);
    const secondMessages = seenRequests.at(-1)!.body.messages as Array<{content?: unknown}>;
    expect(JSON.stringify(secondMessages)).toContain('First CI step');
    expect(JSON.stringify(secondMessages)).toContain('Second CI step');

    // --add-dir refuses .git directory
    mkdirSync(join(ws, '.git'));
    const blockedCode = await runExec(app, {
      prompt: 'Should reject .git',
      workspace: ws,
      json: false,
      addDirs: [join(ws, '.git')],
    });
    expect(blockedCode).toBe(2);
  });
});

describe('Phase 1 — 1B: Path-scoped Rules, @import, and Custom Commands', () => {
  test('matchRuleGlob and parseRuleFrontmatter handle globs linearly without ReDoS', () => {
    expect(matchRuleGlob('src/**/*.ts', 'src/app.ts')).toBe(true);
    expect(matchRuleGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchRuleGlob('src/**/*.ts', 'tests/app.ts')).toBe(false);
    expect(matchRuleGlob('packages/*/src/*.tsx', 'packages/ui/src/App.tsx')).toBe(true);
    expect(matchRuleGlob('packages/*/src/*.tsx', 'packages/ui/src/sub/App.tsx')).toBe(false);

    // Hostile glob pattern must stay linear and finish well under 50ms
    const start = performance.now();
    expect(matchRuleGlob('a/**/a/**/a/**/a/**/b', 'a/'.repeat(60) + 'c')).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);

    const parsedInline = parseRuleFrontmatter('---\npaths: ["src/**/*.ts", "lib/*.ts"]\n---\nUse strict types.');
    expect(parsedInline.paths).toEqual(['src/**/*.ts', 'lib/*.ts']);
    expect(parsedInline.body.trim()).toBe('Use strict types.');

    const parsedList = parseRuleFrontmatter('---\npaths:\n  - "docs/**/*.md"\n  - README.md\n---\nWrite clear docs.');
    expect(parsedList.paths).toEqual(['docs/**/*.md', 'README.md']);
    expect(parsedList.body.trim()).toBe('Write clear docs.');
  });

  test('ProjectContextLoader loads @import safely (cycle/traversal safe) and activates path-scoped .cosmew/rules', async () => {
    const wsDir = makeTempDir('cosmew-ctx-ws-');
    const outsideDir = makeTempDir('cosmew-ctx-outside-');
    writeFileSync(join(outsideDir, 'secret.md'), 'OUTSIDE_SECRET');
    mkdirSync(join(wsDir, 'docs'), {recursive: true});
    mkdirSync(join(wsDir, '.cosmew', 'rules'), {recursive: true});
    mkdirSync(join(wsDir, 'src'), {recursive: true});

    writeFileSync(
      join(wsDir, 'CLAUDE.md'),
      [
        'Root instruction.',
        'See @docs/style.md and ignore code `@docs/ignored.md` and email user@example.com.',
        'Attempt escape @../secret.md.',
      ].join('\n'),
    );
    writeFileSync(join(wsDir, 'docs', 'style.md'), 'Style guide.\nCycle back to @../CLAUDE.md and @sub.md.');
    writeFileSync(join(wsDir, 'docs', 'sub.md'), 'Nested import content.');
    writeFileSync(join(wsDir, '.cosmew', 'rules', 'always.md'), 'Always-on rule for all files.');
    writeFileSync(
      join(wsDir, '.cosmew', 'rules', 'ts-only.md'),
      '---\npaths:\n  - "src/**/*.ts"\n---\nTypeScript rule: avoid any.',
    );

    const workspace = new WorkspaceRoot(wsDir);
    const loader = new ProjectContextLoader(workspace, workspaceReader(workspace));

    // Without active src/*.ts files: global rule and @imports load, path-scoped rule stays inactive
    const snap1 = await loader.load();
    expect(snap1.content).toContain('Root instruction.');
    expect(snap1.content).toContain('Style guide.');
    expect(snap1.content).toContain('Nested import content.');
    expect(snap1.content).toContain('Always-on rule for all files.');
    expect(snap1.content).not.toContain('TypeScript rule: avoid any.');
    expect(snap1.content).not.toContain('OUTSIDE_SECRET');
    expect(snap1.sources.some(s => s.path === 'docs/style.md' && s.kind === 'import')).toBe(true);
    expect(snap1.sources.some(s => s.path === '.cosmew/rules/always.md' && s.kind === 'rule')).toBe(true);
    expect(extractAtImports('```\n@docs/codeblock.md\n```\n@docs/real.md')).toEqual(['docs/real.md']);

    // When a matching TS file is active: path-scoped rule activates cleanly
    const matched = await loader.matchingRules('src/index.ts', new Set());
    expect(matched.map(r => r.path)).toEqual(['.cosmew/rules/ts-only.md']);
    const snap2 = await loader.load(undefined, [], ['src/index.ts']);
    expect(snap2.content).toContain('TypeScript rule: avoid any.');
    expect(snap2.sources.find(s => s.path === '.cosmew/rules/ts-only.md')?.paths).toEqual(['src/**/*.ts']);
  });

  test('SkillCatalog discovers .cosmew/commands/**/*.md with namespaces, optional frontmatter, and argument expansion', () => {
    const wsDir = makeTempDir('cosmew-cmd-ws-');
    const homeDir = makeTempDir('cosmew-cmd-home-');
    mkdirSync(join(wsDir, '.cosmew', 'commands', 'git'), {recursive: true});
    mkdirSync(join(wsDir, '.claude', 'commands'), {recursive: true});
    writeFileSync(
      join(wsDir, '.cosmew', 'commands', 'git', 'pr-check.md'),
      '---\ndescription: Review PR changes\nargument-hint: "<branch> [focus]"\n---\nInspect branch $1 focusing on $2. All: $ARGUMENTS',
    );
    writeFileSync(
      join(wsDir, '.claude', 'commands', 'quick-fix.md'),
      '# Fix lint errors\nRun formatter and fix issues in $ARGUMENTS.',
    );

    const catalog = new SkillCatalog({workspace: new WorkspaceRoot(wsDir), home: homeDir});
    const report = catalog.report();
    const prCheck = report.skills.find(s => s.name === 'git:pr-check');
    const quickFix = report.skills.find(s => s.name === 'quick-fix');
    expect(prCheck?.kind).toBe('command');
    expect(prCheck?.description).toBe('Review PR changes');
    expect(quickFix?.kind).toBe('command');
    expect(quickFix?.description).toBe('Fix lint errors');

    const invokes = skillInvocations('/git:pr-check main "security checks"', report.skills);
    expect(invokes).toEqual([{name: 'git:pr-check', args: 'main "security checks"'}]);

    const readDoc = parseCommandDocument(catalog.read('git:pr-check').content, 'git:pr-check');
    expect(expandCommandArguments(readDoc.body, invokes[0]!.args)).toBe(
      'Inspect branch main focusing on security checks. All: main "security checks"',
    );
  });
});

describe('Phase 1 — 1C: Guarded Auto-Memory Extraction', () => {
  test('extractAutoMemories saves valid entries, rejects secret-bearing candidates, and never overwrites existing memories', async () => {
    expect(looksLikeSensitiveMemory('Use Bun 1.4.4 for tests')).toBe(false);
    expect(looksLikeSensitiveMemory('API key is sk-ant-api03-abcdef1234567890abcdef')).toBe(true);
    expect(looksLikeSensitiveMemory('AWS_KEY AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSensitiveMemory('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')).toBe(true);

    let trackedUsage = 0;
    const fakeModel: ModelPort = {
      async generate() {
        throw new Error('stream expected');
      },
      async *stream(_req: ModelRequest): AsyncIterable<ModelEvent> {
        yield {
          type: 'textDelta',
          text: JSON.stringify({
            memories: [
              {
                name: 'prefer-bun-test',
                type: 'feedback',
                description: 'Always run bun test instead of jest',
                content: 'User prefers running bun test directly for fast feedback.',
              },
              {
                name: 'leaked-token',
                type: 'reference',
                description: 'Staging API token',
                content: 'Use Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue123',
              },
              {
                name: 'existing-note',
                type: 'project',
                description: 'Attempt to overwrite existing memory',
                content: 'Should be skipped because existing-note already exists.',
              },
            ],
          }),
        };
        yield {
          type: 'completed',
          finishReason: 'stop',
          usage: {inputTokens: 120, outputTokens: 60, costUSD: 0.001},
        };
      },
    };

    const result = await extractAutoMemories({
      model: fakeModel,
      selection: {accountId: crypto.randomUUID(), modelId: 'small-model'},
      messages: [
        {role: 'user', content: 'Remember to always run bun test instead of jest.'},
        {role: 'assistant', content: 'Got it, I will always use bun test.'},
      ],
      existing: [
        {
          name: 'existing-note',
          type: 'project',
          description: 'Original note',
          usage_count: 1,
          last_usage: null,
          updated_at: new Date().toISOString(),
          unused: false,
        },
      ],
      onUsage: u => {
        trackedUsage += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      },
    });

    expect(result.candidates.map(c => c.name)).toEqual(['prefer-bun-test']);
    expect(result.rejectedSensitive).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(trackedUsage).toBe(180);
    expect(parseExtractedMemories('invalid-json')).toEqual([]);
  });

  test('startup runs auto_extract after completed chat turn when enabled in user config and skips in plan mode', async () => {
    let callNum = 0;
    const {app, ws} = await setupHeadlessApp((_url, body) => {
      callNum++;
      // Extraction request streams SSE just like real chat/gateway requests
      if (JSON.stringify(body).includes('Extract at most 3 durable')) {
        return sseChatText(
          JSON.stringify({
            memories: [
              {
                name: 'release-branch-policy',
                type: 'project',
                description: 'Release commits target dev first',
                content: 'All feature work lands on dev before cutting a release tag.',
              },
            ],
          }),
        );
      }
      return sseChatText(`Completed turn #${callNum}`);
    }, '[memories]\nauto_extract = true\n');

    const client = app.createFutrynClient(ws);
    client.setToolsEnabled(true);
    // In plan mode, auto-extract must NOT run
    client.setMode('plan');
    for await (const _ev of client.sendMessage('Inspect project layout')) {
      /* drain */
    }
    expect(client.memories()).toHaveLength(0);

    // In chat mode, auto-extract runs once after completion and saves the safe memory
    client.setMode('chat');
    for await (const _ev of client.sendMessage('Note that all release commits target dev first.')) {
      /* drain */
    }
    const saved = client.memories();
    expect(saved.map(m => m.name)).toEqual(['release-branch-policy']);
  });
});

describe('Phase 1 — 1D: Extended LSP Presets & User-Level [lsp.<id>] Config', () => {
  test('built-in LSP specs cover 13 languages and user [lsp.<id>] rejects workspace-local binaries', () => {
    expect(SERVERS.length).toBeGreaterThanOrEqual(13);
    expect(specFor('main.cpp')?.id).toBe('cpp');
    expect(specFor('App.java')?.id).toBe('java');
    expect(specFor('Program.cs')?.id).toBe('csharp');
    expect(specFor('index.php')?.id).toBe('php');
    expect(specFor('Gemfile.rb')?.id).toBe('ruby');
    expect(specFor('App.swift')?.id).toBe('swift');
    expect(specFor('Main.kt')?.id).toBe('kotlin');
    expect(specFor('ci.yaml')?.id).toBe('yaml');
    expect(specFor('package.json')?.id).toBe('json');

    const stateDir = makeTempDir('cosmew-lsp-cfg-');
    const wsDir = makeTempDir('cosmew-lsp-ws-');
    const outsideBinDir = makeTempDir('cosmew-lsp-bin-');
    const safeBin = join(outsideBinDir, 'zls');
    const plantedBin = join(wsDir, 'evil-lsp');
    const symlinkToWorkspace = join(outsideBinDir, 'sneaky-link');
    writeFileSync(safeBin, '#!/bin/sh\nexit 0\n', {mode: 0o755});
    writeFileSync(plantedBin, '#!/bin/sh\nexit 0\n', {mode: 0o755});
    symlinkSync(plantedBin, symlinkToWorkspace);

    const cfgPath = join(stateDir, 'config.toml');
    writeFileSync(
      cfgPath,
      [
        '[lsp.zig]',
        'extensions = [".zig"]',
        'roots = ["build.zig"]',
        `command = "${safeBin.replace(/\\/g, '\\\\')}"`,
        'args = ["--stdio"]',
        'language_id = "zig"',
        '',
        '[lsp.planted]',
        'extensions = [".evil"]',
        `command = "${plantedBin.replace(/\\/g, '\\\\')}"`,
        '',
        '[lsp.bad_entry]',
        'extensions = ["no-dot"]',
        'command = "foo"',
      ].join('\n'),
      {mode: 0o600},
    );
    chmodSync(cfgPath, 0o600);

    const loaded = new HostConfigStore(stateDir).load();
    expect(loaded.usable).toBe(true);
    expect(loaded.lspServers.map(s => s.id)).toEqual(['zig', 'planted']);
    expect(loaded.diagnostics.some(d => d.message.includes('[lsp.bad_entry]'))).toBe(true);

    const merged = buildServerSpecs(loaded.lspServers);
    const zigSpec = specFor('src/main.zig', merged);
    expect(zigSpec?.id).toBe('zig');
    expect(zigSpec?.commands(wsDir, wsDir)).toEqual([[safeBin, '--stdio']]);

    // Binaries inside workspace or symlinks resolving into workspace are strictly refused
    const plantedSpec = specFor('src/a.evil', merged);
    expect(plantedSpec?.commands(wsDir, wsDir)).toEqual([]);
    expect(trustedServerProgram(symlinkToWorkspace, wsDir)).toBeNull();
    expect(trustedServerProgram(safeBin, wsDir)).toBe(safeBin);
  });
});
