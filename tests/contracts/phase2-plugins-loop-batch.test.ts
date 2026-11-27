import {afterEach, describe, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CONTRACT_VERSION,
  FutrynError,
  formatDurationMs,
  parseBatchCommand,
  parseDurationMs,
  parseLoopCommand,
  parseScheduleCommand,
  type SubagentExecutionPort,
} from '@cosmew/contracts';
import {SessionScheduler} from '@cosmew/core';
import {BatchRunner} from '@cosmew/agents';
import {parseSlashCommand} from '@cosmew/sdk';
import {computePluginDirectoryHash, parsePluginDirectory} from '@cosmew/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {PluginManager} from '../../apps/cli/src/bootstrap/plugin-manager';
import {pluginCli} from '../../apps/cli/src/plugin-cli';
import {memoryVault} from '../fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function createSamplePluginDir(
  parentDir: string,
  options: {
    name?: string;
    hookMarkerFile?: string;
    mcpServerName?: string;
    includeAssets?: boolean;
  } = {},
): string {
  const name = options.name ?? 'demo-pack';
  const dir = join(parentDir, name);
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name,
        version: '1.2.3',
        description: 'Demo plugin package with skills, commands, agents, hooks and MCP',
        author: 'Cosmew Tests',
      },
      null,
      2,
    ),
  );
  if (options.includeAssets !== false) {
    mkdirSync(join(dir, 'skills', 'pack-helper'), {recursive: true});
    writeFileSync(
      join(dir, 'skills', 'pack-helper', 'SKILL.md'),
      `---\nname: pack-helper\ndescription: Helper skill from demo-pack\n---\nAlways greet concisely.\n`,
    );
    mkdirSync(join(dir, 'commands'), {recursive: true});
    writeFileSync(
      join(dir, 'commands', 'quick-check.md'),
      `---\ndescription: Run a quick check command\n---\nCheck $ARGUMENTS carefully.\n`,
    );
    mkdirSync(join(dir, 'agents'), {recursive: true});
    writeFileSync(
      join(dir, 'agents', 'pack-auditor.md'),
      `---\nname: pack-auditor\ndescription: Custom auditor from demo-pack\ntools: [read, grep]\n---\nAudit only.\n`,
    );
  }
  if (options.hookMarkerFile) {
    mkdirSync(join(dir, 'hooks'), {recursive: true});
    writeFileSync(
      join(dir, 'hooks', 'hooks.json'),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `printf "ran\\n" >> ${JSON.stringify(options.hookMarkerFile)}`,
                    timeout: 5,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  }
  if (options.mcpServerName) {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify(
        {
          mcpServers: {
            [options.mcpServerName]: {
              url: 'https://plugin-mcp.example/mcp',
            },
          },
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

describe('Phase 2 (Contract 1.70) — 2A: User-scoped Plugin Host & SHA-256 Trust', () => {
  test('installs plugin safely, gates hooks/MCP behind exact SHA-256 trust, and auto-revokes on tamper', async () => {
    expect(CONTRACT_VERSION).toBe('1.70');
    const sourceParent = createTempDir('cosmew-plugin-src-');
    const stateDir = createTempDir('cosmew-plugin-state-');
    const workspace = createTempDir('cosmew-plugin-ws-');
    const markerFile = join(stateDir, 'hook-marker.txt');

    const srcDir = createSamplePluginDir(sourceParent, {
      name: 'demo-pack',
      hookMarkerFile: markerFile,
      mcpServerName: 'plugin_docs',
    });

    const sseFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.method === 'GET') return Response.json({data: [{id: 'test-model', supports_tools: true}]});
      if (req.url.includes('plugin-mcp.example')) {
        return new Response('offline', {status: 503});
      }
      const sse = [
        `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {content: 'OK'}, finish_reason: null}]})}`,
        `data: ${JSON.stringify({id: 'c1', object: 'chat.completion.chunk', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12}})}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, {status: 200, headers: {'content-type': 'text/event-stream'}});
    }) as typeof fetch;

    const app = startup(stateDir, {
      vault: memoryVault(),
      offline: true,
      fetch: sseFetch,
      skillsHome: stateDir,
      memoriesHome: stateDir,
    });
    cleanups.push(() => {
      void app.shutdownCommands();
      app.db.close();
    });
    app.registry.add({
      id: 'local-gw',
      name: 'Local GW',
      baseURL: 'https://local-gw.example/v1',
      protocol: 'chat',
      auth: 'none',
      catalog: 'openai',
      metadataVersion: 1,
    });
    const account = await app.accounts.add('local-gw', 'local', {kind: 'none'});
    const client = app.createFutrynClient(workspace);
    client.useAccount(account.id);
    await client.discoverModels();
    client.selectModel('test-model');
    client.setToolsEnabled(true);

    expect(client.capabilities().pluginHost).toBe('implemented');

    // 1. Install plugin: text assets (skills, commands, agents) become visible; hooks/MCP stay blocked until trusted.
    const installRes = await client.managePlugin({type: 'install', sourcePath: srcDir});
    expect(installRes.ok).toBe(true);
    expect(installRes.plugin?.trustState).toBe('untrusted');
    expect(installRes.plugin?.counts).toEqual({skills: 1, commands: 1, agents: 1, hooks: 1, mcpServers: 1});
    expect(installRes.plugin?.grants.length).toBe(2);

    const skillNames = client.skills().skills.map(s => s.name);
    expect(skillNames).toContain('pack-helper');
    expect(skillNames).toContain('quick-check');
    expect(client.agentTypes().types.some(t => t.name === 'pack-auditor')).toBe(true);

    // Untrusted hooks are counted as pending and NEVER executed.
    expect(client.hooks().hooks.some(h => h.scope === 'plugin')).toBe(false);
    expect(client.hooks().untrustedPendingCount).toBe(1);
    for await (const _ of client.sendMessage('hello untrusted')) {
      /* drain */
    }
    expect(existsSync(markerFile)).toBe(false);

    // 2. TOCTOU protection: trusting with a mismatched SHA-256 must fail with POLICY.
    await expect(client.managePlugin({type: 'trust', id: 'demo-pack', hash: '0'.repeat(64)})).rejects.toMatchObject({
      code: 'POLICY',
    });
    expect(existsSync(markerFile)).toBe(false);

    // 3. Trust with the exact SHA-256 hash: plugin hook activates and executes on normal turn.
    const expectedHash = installRes.plugin!.contentHash;
    const trustRes = await client.managePlugin({type: 'trust', id: 'demo-pack', hash: expectedHash});
    expect(trustRes.plugin?.trustState).toBe('trusted');
    expect(client.hooks().hooks.some(h => h.scope === 'plugin' && h.pluginId === 'demo-pack')).toBe(true);
    expect(client.hooks().untrustedPendingCount).toBe(0);

    for await (const _ of client.sendMessage('hello trusted')) {
      /* drain */
    }
    expect(existsSync(markerFile)).toBe(true);
    expect(readFileSync(markerFile, 'utf8').trim()).toBe('ran');

    // 4. Plan mode invariant: even a trusted plugin hook does NOT run in read-only plan mode.
    client.setMode('plan');
    for await (const _ of client.sendMessage('hello plan')) {
      /* drain */
    }
    expect(readFileSync(markerFile, 'utf8').trim().split('\n').length).toBe(1);
    client.setMode('chat');

    // 5. Tampering with 1 byte inside the installed plugin invalidates trust immediately on reload.
    const installedHooksPath = join(stateDir, 'plugins', 'demo-pack', 'hooks', 'hooks.json');
    writeFileSync(installedHooksPath, readFileSync(installedHooksPath, 'utf8') + '\n');
    const reloaded = await client.reloadPlugins();
    const afterTamper = reloaded.plugins.find(p => p.id === 'demo-pack')!;
    expect(afterTamper.trustState).toBe('trust-changed');
    expect(afterTamper.contentHash).not.toBe(expectedHash);
    expect(client.hooks().hooks.some(h => h.scope === 'plugin')).toBe(false);

    for await (const _ of client.sendMessage('hello tampered')) {
      /* drain */
    }
    expect(readFileSync(markerFile, 'utf8').trim().split('\n').length).toBe(1);

    // 6. Disable / enable / uninstall lifecycle cleanly updates catalogs.
    await client.managePlugin({type: 'disable', id: 'demo-pack'});
    expect(client.skills().skills.some(s => s.name === 'pack-helper')).toBe(false);
    expect(client.agentTypes().types.some(t => t.name === 'pack-auditor')).toBe(false);

    await client.managePlugin({type: 'enable', id: 'demo-pack'});
    expect(client.skills().skills.some(s => s.name === 'pack-helper')).toBe(true);

    await client.managePlugin({type: 'uninstall', id: 'demo-pack'});
    expect(client.plugins().plugins.length).toBe(0);
    expect(existsSync(join(stateDir, 'plugins', 'demo-pack'))).toBe(false);

    // 7. Scheduled job wired through startup() executes live turn and stops cleanly on session switch.
    const startedJob = client.startScheduledJob({
      kind: 'loop',
      prompt: 'ping loop',
      intervalMs: 60_000,
      runImmediately: true,
      maxIterations: 2,
      untilSubstring: 'OK',
    });
    expect(startedJob.id).toMatch(/^loop-/);
    // Wait briefly for the immediate first iteration to complete against the mock SSE fetch.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const latest = client.scheduledJobs().find(j => j.id === startedJob.id);
      if (latest?.status === 'completed') break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(client.scheduledJobs().find(j => j.id === startedJob.id)?.status).toBe('completed');

    // Switching sessions automatically stops active scheduled jobs from the prior session.
    const pendingJob = client.startScheduledJob({
      kind: 'schedule',
      prompt: 'later',
      intervalMs: 60_000,
      runImmediately: false,
      maxIterations: 5,
    });
    const prevSessionId = pendingJob.sessionId;
    client.createSession();
    expect(client.scheduledJobs(prevSessionId).find(j => j.id === pendingJob.id)?.status).toBe('stopped');
  });

  test('rejects symlinks and invalid manifests, isolates broken plugins, and supports cosmew plugin CLI', async () => {
    const sourceParent = createTempDir('cosmew-plugin-sec-');
    const stateDir = createTempDir('cosmew-plugin-sec-state-');

    // Symlink escape inside plugin source must be rejected.
    const evilDir = createSamplePluginDir(sourceParent, {name: 'evil-sym', includeAssets: false});
    const outsideFile = join(sourceParent, 'outside.txt');
    writeFileSync(outsideFile, 'secret');
    symlinkSync(outsideFile, join(evilDir, 'leak.txt'));

    expect(() => parsePluginDirectory(evilDir)).toThrow(/Symlinks are forbidden/i);
    const manager = new PluginManager({directory: stateDir});
    expect(() => manager.install(evilDir)).toThrow(FutrynError);

    // Valid plugin + broken plugin placed directly in plugins dir: broken one is isolated without breaking valid one.
    const goodDir = createSamplePluginDir(sourceParent, {name: 'good-pack'});
    manager.install(goodDir);
    const brokenDir = join(stateDir, 'plugins', 'broken-pack');
    mkdirSync(brokenDir, {recursive: true});
    writeFileSync(join(brokenDir, 'plugin.json'), '{not-valid-json');

    const snap = manager.reload();
    expect(snap.plugins.find(p => p.id === 'good-pack')?.enabled).toBe(true);
    const broken = snap.plugins.find(p => p.id === 'broken-pack');
    expect(broken?.enabled).toBe(false);
    expect(broken?.diagnostics[0]).toContain('not valid JSON');

    // Verify deterministic SHA-256 hashing.
    const h1 = computePluginDirectoryHash(join(stateDir, 'plugins', 'good-pack'));
    const h2 = computePluginDirectoryHash(join(stateDir, 'plugins', 'good-pack'));
    expect(h1.hash).toBe(h2.hash);
    expect(h1.hash).toMatch(/^[a-f0-9]{64}$/);

    // Verify CLI subcommand `cosmew plugin list --json`.
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      await pluginCli(['list', '--json'], stateDir);
    } finally {
      process.stdout.write = origWrite;
    }
    const parsedOut = JSON.parse(output);
    expect(parsedOut.supported).toBe(true);
    expect(parsedOut.plugins.some((p: {id: string}) => p.id === 'good-pack')).toBe(true);
  });
});

describe('Phase 2 (Contract 1.70) — 2B: Autonomous Loop, Schedule & Parallel Batch', () => {
  test('parses durations and /loop, /schedule, /batch commands with strict bounds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('1h30m')).toBe(5_400_000);
    expect(parseDurationMs('1s')).toBeUndefined(); // below 5s min
    expect(parseDurationMs('48h')).toBeUndefined(); // above 24h max
    expect(formatDurationMs(5_400_000)).toBe('1h30m');

    const loop = parseLoopCommand('30s --max 5 --max-cost 0.5 --until "ALL GREEN" check CI');
    expect(loop.action).toBe('start');
    if (loop.action === 'start') {
      expect(loop.spec).toMatchObject({
        kind: 'loop',
        intervalMs: 30_000,
        runImmediately: true,
        maxIterations: 5,
        maxEstimatedCostUSD: 0.5,
        untilSubstring: 'ALL GREEN',
        prompt: 'check CI',
      });
    }
    expect(parseLoopCommand('--max 101 hello').action).toBe('error');

    const schedIn = parseScheduleCommand('in 10m verify deploy');
    expect(schedIn.action).toBe('start');
    if (schedIn.action === 'start') {
      expect(schedIn.spec).toMatchObject({
        kind: 'schedule',
        intervalMs: 600_000,
        runImmediately: false,
        maxIterations: 1,
        oneShot: true,
        prompt: 'verify deploy',
      });
    }

    const batchTargets = parseBatchCommand(
      '--isolation worktree --agent worker --concurrency 2 --targets "a, b" test {{target}}',
    );
    expect(batchTargets.ok).toBe(true);
    if (batchTargets.ok) {
      expect(batchTargets.request.isolation).toBe('worktree');
      expect(batchTargets.request.concurrency).toBe(2);
      expect(batchTargets.request.items.map(i => i.prompt)).toEqual(['test a', 'test b']);
    }

    const batchSemi = parseBatchCommand('task one ;; task two ;; task three');
    expect(batchSemi.ok).toBe(true);
    if (batchSemi.ok) expect(batchSemi.request.items.length).toBe(3);

    const tooMany = parseBatchCommand(Array.from({length: 13}, (_, i) => `t${i}`).join(' ;; '));
    expect(tooMany.ok).toBe(false);
  });

  test('SessionScheduler enforces maxIterations, --until, --max-cost, no re-entrancy, and 3-error stop', async () => {
    let now = 1_000_000;
    const timers = new Map<number, {at: number; fn: () => void}>();
    let timerId = 1;
    const flushNext = async () => {
      const entries = [...timers.entries()].sort((a, b) => a[1].at - b[1].at);
      if (!entries.length) return false;
      const [id, entry] = entries[0]!;
      timers.delete(id);
      now = Math.max(now, entry.at);
      entry.fn();
      await Promise.resolve();
      await Promise.resolve();
      return true;
    };

    let busy = false;
    const ran: number[] = [];
    const responses = ['still building', 'ALL GREEN'];
    const scheduler = new SessionScheduler({
      isBusy: () => busy,
      execute: async (_job, iteration) => {
        ran.push(iteration);
        return {text: responses[iteration - 1] ?? 'done', costUSD: 0.05};
      },
      now: () => now,
      setTimer: (fn, ms) => {
        const id = timerId++;
        timers.set(id, {at: now + ms, fn});
        return id;
      },
      clearTimer: handle => {
        timers.delete(handle as number);
      },
      minIntervalMs: 100,
      busyRecheckMs: 50,
    });

    // 1. Busy deferral + --until early stop
    busy = true;
    const job = scheduler.start('s1', {
      kind: 'loop',
      prompt: 'check ci',
      intervalMs: 1_000,
      runImmediately: true,
      maxIterations: 10,
      untilSubstring: 'ALL GREEN',
    });
    await flushNext(); // tick while busy -> deferred
    expect(ran).toEqual([]);
    busy = false;
    scheduler.notifyIdle('s1');
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toEqual([1]);
    await flushNext(); // second iteration hits ALL GREEN -> completes
    expect(ran).toEqual([1, 2]);
    expect(scheduler.list('s1').find(j => j.id === job.id)?.status).toBe('completed');
    expect(timers.size).toBe(0);

    // 2. Cost cap enforcement
    let costRuns = 0;
    const costScheduler = new SessionScheduler({
      isBusy: () => false,
      execute: async () => {
        costRuns++;
        return {text: 'ok', costUSD: 0.6};
      },
      now: () => now,
      setTimer: (fn, ms) => {
        const id = timerId++;
        timers.set(id, {at: now + ms, fn});
        return id;
      },
      clearTimer: handle => timers.delete(handle as number),
      minIntervalMs: 100,
    });
    const budgetJob = costScheduler.start('s2', {
      kind: 'loop',
      prompt: 'spend',
      intervalMs: 1_000,
      runImmediately: true,
      maxIterations: 10,
      maxEstimatedCostUSD: 0.5,
    });
    await flushNext();
    expect(costRuns).toBe(1);
    expect(costScheduler.list('s2').find(j => j.id === budgetJob.id)?.status).toBe('budget_exceeded');

    // 3. Consecutive 3-error auto-stop
    const errScheduler = new SessionScheduler({
      isBusy: () => false,
      execute: async () => {
        throw new Error('upstream timeout');
      },
      now: () => now,
      setTimer: (fn, ms) => {
        const id = timerId++;
        timers.set(id, {at: now + ms, fn});
        return id;
      },
      clearTimer: handle => timers.delete(handle as number),
      minIntervalMs: 100,
    });
    const errJob = errScheduler.start('s3', {
      kind: 'loop',
      prompt: 'flaky',
      intervalMs: 1_000,
      runImmediately: true,
      maxIterations: 10,
    });
    await flushNext();
    await flushNext();
    await flushNext();
    expect(errScheduler.list('s3').find(j => j.id === errJob.id)?.status).toBe('failed');
    expect(timers.size).toBe(0);
  });

  test('BatchRunner respects concurrency cap, combines usage, enforces plan-mode policy, and cancels cleanly', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const seenTypes: string[] = [];

    const fakeSubagents: SubagentExecutionPort = {
      available: () => true,
      async run(callId, input, signal, onEvent) {
        const parsed = input as {agent_type: string; prompt: string};
        seenTypes.push(parsed.agent_type);
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        onEvent?.({
          type: 'subagent.started',
          callId,
          agentId: `agent-${callId}`,
          agentType: parsed.agent_type,
          description: parsed.prompt,
          modelId: 'm1',
        });
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 15);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new FutrynError('CANCELLED'));
            },
            {once: true},
          );
        });
        inFlight--;
        onEvent?.({
          type: 'subagent.finished',
          callId,
          agentId: `agent-${callId}`,
          agentType: parsed.agent_type,
          description: parsed.prompt,
          status: 'completed',
          toolCount: 2,
          usage: {inputTokens: 100, outputTokens: 20, costUSD: null},
          durationMs: 15,
          summary: `done:${parsed.prompt}`,
        });
        return {status: 'ok', content: `done:${parsed.prompt}`};
      },
    };

    const runner = new BatchRunner({
      subagents: fakeSubagents,
      maxThreads: () => 2,
      isAnalysisOnly: () => false,
      redact: t => t,
    });

    const result = await runner.run({
      concurrency: 4, // clamped to maxThreads() = 2
      items: [
        {label: 't1', prompt: 'p1'},
        {label: 't2', prompt: 'p2'},
        {label: 't3', prompt: 'p3'},
        {label: 't4', prompt: 'p4'},
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.completedCount).toBe(4);
    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(result.usage?.inputTokens).toBe(400);
    expect(result.usage?.outputTokens).toBe(80);

    // Plan mode blocks worktree isolation and forces read-only explore agent type.
    const planRunner = new BatchRunner({
      subagents: fakeSubagents,
      maxThreads: () => 2,
      isAnalysisOnly: () => true,
      redact: t => t,
    });
    await expect(planRunner.run({isolation: 'worktree', items: [{label: 'w1', prompt: 'edit'}]})).rejects.toMatchObject(
      {code: 'POLICY'},
    );

    seenTypes.length = 0;
    const planRes = await planRunner.run({agentType: 'worker', items: [{label: 'r1', prompt: 'inspect'}]});
    expect(planRes.status).toBe('completed');
    expect(seenTypes).toEqual(['explore']);

    // Cancellation marks remaining items cancelled.
    const ac = new AbortController();
    ac.abort();
    const cancelled = await runner.run(
      {
        items: [
          {label: 'c1', prompt: 'never'},
          {label: 'c2', prompt: 'never2'},
        ],
      },
      {signal: ac.signal},
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledCount).toBe(2);
  });
});

describe('Phase 2 (Contract 1.70) — 2C: Slash command registry & cloud setup routes', () => {
  test('/plugin, /reload-plugins, /loop, /schedule, /batch, /setup-bedrock and /setup-vertex are active commands', () => {
    for (const raw of [
      '/plugin',
      '/plugins list',
      '/reload-plugins',
      '/loop 30s check',
      '/schedule every 5m check',
      '/batch task 1 ;; task 2',
      '/setup-bedrock',
      '/setup-vertex',
    ]) {
      const parsed = parseSlashCommand(raw);
      expect(parsed.error).toBeUndefined();
      expect(parsed.definition).toBeDefined();
      expect(parsed.definition?.handler).not.toBe('unavailable');
      expect(parsed.definition?.unavailable).toBeUndefined();
    }
  });
});
