import {afterEach, expect, spyOn, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {providerSchema, type CommandRuntime, type CommandSandbox, type ModelEvent} from '@futryn/contracts';
import {FileMemories} from '@futryn/persistence';
import {openInk} from '../../apps/tui/src/ink/testing/ink-session';
import {runExec} from '../../apps/cli/src/exec';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {memoryVault, scriptedView, type ScriptedReply, type ScriptedView} from '../fixtures';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type ExtendedScriptedView = ScriptedView & {user: string[]};
type ExtendedScriptedReply = Omit<ScriptedReply, 'calls'> & {
  calls?: {id?: string; name: string; input: unknown}[];
  usage?: {inputTokens: number; outputTokens: number};
  status?: number;
};

interface SetupOptions {
  /** Make the project a Git repository with one commit before startup. */
  git?: boolean;
  config?: string;
  files?: Record<string, string>;
  models?: {id: string; context_length?: number}[];
  script: (
    view: ExtendedScriptedView,
    rawBody: any,
    signal: AbortSignal,
  ) => ExtendedScriptedReply | Promise<ExtendedScriptedReply>;
}

async function setup(options: SetupOptions) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fyn-subagents-e2e-')));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const project = join(root, 'project');
  const home = join(root, 'home');
  const state = join(home, '.futryn');
  mkdirSync(project, {recursive: true});
  mkdirSync(state, {recursive: true, mode: 0o700});
  if (options.config) {
    writeFileSync(join(state, 'config.toml'), options.config, {mode: 0o600});
  }
  for (const [rel, text] of Object.entries(options.files ?? {})) {
    const abs = join(project, rel);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, text);
  }

  if (options.git) {
    const git = (...args: string[]) =>
      Bun.spawnSync(
        [
          'git',
          '-C',
          project,
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {stdout: 'ignore', stderr: 'ignore'},
      );
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    cleanup.push(() => {
      git('worktree', 'prune');
    });
  }

  const requests: {body: any; view: ExtendedScriptedView}[] = [];
  const executedCommands: {command: string; cwd: string; sandbox?: CommandSandbox}[] = [];

  const commandRuntime: CommandRuntime = {
    id: 'test-sandbox',
    label: 'Test Sandbox',
    availability: () => ({ok: true}),
    capabilities: () => ({
      modes: ['read-only', 'workspace-write', 'danger-full-access'],
      network: true,
      tty: false,
      unsandboxed: true,
      shells: ['bash', 'sh'],
      tools: [],
    }),
    async run(req, signal) {
      signal?.throwIfAborted();
      executedCommands.push({command: req.command, cwd: req.cwd, sandbox: req.sandbox});
      return {
        kind: 'exited',
        exitCode: 0,
        signal: null,
        output: `ran: ${req.command} (${req.sandbox?.mode ?? 'default'})\n`,
        omittedBytes: 0,
        durationMs: 5,
      };
    },
  };

  let callCounter = 0;
  const fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      return Response.json({
        data: (options.models ?? [{id: 'fixture-model'}, {id: 'fast-explore-model'}]).map(m => ({
          id: m.id,
          ...(m.context_length ? {context_length: m.context_length} : {}),
          supported_parameters: ['tools', 'reasoning'],
        })),
      });
    }
    const body = await request.json();
    const user = (body.messages ?? [])
      .filter((m: any) => m.role === 'user')
      .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    const view: ExtendedScriptedView = {...scriptedView('chat', body), user};
    requests.push({body, view});
    const reply = await options.script(view, body, request.signal);
    if (reply.status && reply.status >= 400) {
      return Response.json({error: {message: reply.text ?? 'provider failure'}}, {status: reply.status});
    }
    if (!body.stream) {
      return Response.json({
        id: 'gen-1',
        object: 'chat.completion',
        created: 123,
        model: body.model ?? 'fixture-model',
        choices: [{index: 0, message: {role: 'assistant', content: reply.text ?? 'Summary.'}, finish_reason: 'stop'}],
        usage: {
          prompt_tokens: reply.usage?.inputTokens ?? 10,
          completion_tokens: reply.usage?.outputTokens ?? 5,
          total_tokens: (reply.usage?.inputTokens ?? 10) + (reply.usage?.outputTokens ?? 5),
        },
      });
    }
    const base = {
      id: `chunk-${++callCounter}`,
      object: 'chat.completion.chunk',
      created: 123,
      model: body.model ?? 'fixture-model',
    };
    const toolCalls = reply.calls?.map((c, index) => ({
      index,
      id: c.id ?? `call-${callCounter}-${index + 1}`,
      type: 'function',
      function: {name: c.name, arguments: JSON.stringify(c.input)},
    }));
    const promptTokens = reply.usage?.inputTokens ?? 10;
    const completionTokens = reply.usage?.outputTokens ?? 5;
    const packets = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              ...(reply.text ? {content: reply.text} : {}),
              ...(toolCalls?.length ? {tool_calls: toolCalls} : {}),
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{index: 0, delta: {}, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop'}],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
    ];
    return new Response(packets.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: {'content-type': 'text/event-stream'},
    });
  }) as typeof globalThis.fetch;

  const app = startup(state, {
    permissions: {sandbox: 'workspace-write', approval: 'on-request'},
    vault: memoryVault(),
    fetch,
    skillsHome: home,
    memoriesHome: home,
    commands: () => commandRuntime,
  });
  cleanup.push(async () => {
    await app.shutdownCommands();
    app.db.close();
  });
  app.registry.add(
    providerSchema.parse({
      id: 'fixture',
      name: 'Fixture',
      protocol: 'chat',
      baseURL: 'https://fixture.invalid/v1',
      auth: 'none',
      catalog: 'openai',
      metadataVersion: 1,
    }),
  );
  await app.accounts.add('fixture', 'main', {kind: 'none'});
  const client = app.createFutrynClient(project);
  await client.discoverModels();
  client.selectModel('fixture-model');
  client.setToolsEnabled(true);

  return {root, project, home, state, app, client, requests, executedCommands, fetch, commandRuntime};
}

test('explore subagent is read-only (exec_command runs in read-only sandbox, writes/questions/memories are blocked)', async () => {
  let childOfferedTools: string[] = [];
  let childSystemPrompt = '';
  let childUserMessages = '';

  const h = await setup({
    files: {'src/auth.ts': 'export const token = "ok";\n'},
    script: view => {
      const isChild = view.system.includes('You are an explore subagent');
      if (!isChild) {
        if (!view.results.length) {
          return {
            calls: [
              {
                id: 'spawn-explore',
                name: 'agent',
                input: {
                  agent_type: 'explore',
                  description: 'inspect auth module',
                  prompt: 'Check src/auth.ts and try forbidden tools.',
                },
              },
            ],
          };
        }
        return {text: `Parent received: ${view.results[0]!.content}`};
      }
      childOfferedTools = view.tools;
      childSystemPrompt = view.system;
      childUserMessages = view.user.join('\n');
      if (view.results.length === 0) {
        return {
          calls: [
            {id: 'e-read', name: 'read', input: {path: 'src/auth.ts'}},
            {id: 'e-exec', name: 'exec_command', input: {cmd: 'ls -la'}},
          ],
        };
      }
      if (view.results.length === 2) {
        // Also verify explore cannot request_escalated on exec_command.
        return {
          calls: [
            {
              id: 'e-escalate',
              name: 'exec_command',
              input: {cmd: 'whoami', sandbox_permissions: 'require_escalated', justification: 'try escape'},
            },
          ],
        };
      }
      return {
        text: `Explore summary: results=${view.results.map(r => `${r.name}:${r.content.slice(0, 30)}`).join(' | ')}`,
      };
    },
  });

  // Seed a user memory to verify the child never loads it.
  const memStore = new FileMemories(join(h.home, '.futryn'), h.project, s => s);
  memStore.write({
    name: 'secret-memory',
    description: 'PARENT_ONLY_MEMORY_MARKER',
    type: 'project',
    content: 'Detailed memory content',
  });
  h.client.setUserInputAvailable(true);

  const events: ModelEvent[] = [];
  for await (const event of h.client.sendMessage('Run explore')) {
    events.push(event);
  }

  // Child offered tools never include write, edit, apply_patch, request_user_input, agent, or memory.
  expect(childOfferedTools).toContain('read');
  expect(childOfferedTools).toContain('exec_command');
  expect(childOfferedTools).not.toContain('edit');
  expect(childOfferedTools).not.toContain('write');
  expect(childOfferedTools).not.toContain('apply_patch');
  expect(childOfferedTools).not.toContain('request_user_input');
  expect(childOfferedTools).not.toContain('agent');
  expect(childOfferedTools).not.toContain('memory');

  // Child did not load parent memories.
  expect(childSystemPrompt).not.toContain('PARENT_ONLY_MEMORY_MARKER');
  expect(childUserMessages).not.toContain('PARENT_ONLY_MEMORY_MARKER');

  // exec_command inside explore ran with sandbox mode clamped to 'read-only', even though parent is 'workspace-write'.
  expect(h.executedCommands).toHaveLength(1);
  expect(h.executedCommands[0]!.sandbox?.mode).toBe('read-only');
  expect(h.executedCommands[0]!.sandbox?.network).toBe(false);

  // Writes/questions are not even offered (the provider adapter refuses hidden tools, ADR 0029); escalation is denied.
  const finalChildView = h.requests.filter(r => r.view.system.includes('You are an explore subagent')).at(-1)!.view;
  const byName = Object.fromEntries(finalChildView.results.map(r => [r.callId, r.content]));
  expect(byName['e-read']).toContain('export const token = "ok"');
  expect(byName['e-exec']).toContain('ran: ls -la (read-only)');
  expect(byName['e-escalate']).toMatch(/^\[denied: DENIED\]/);
  expect(h.client.listPendingQuestions()).toHaveLength(0);
});

test('worker is not offered agent at depth 1 and can edit assigned files', async () => {
  let workerOfferedTools: string[] = [];
  const h = await setup({
    files: {'src/target.ts': 'export const count = 1;\n'},
    script: view => {
      const isWorker = view.system.includes('You are a worker subagent');
      if (!isWorker) {
        if (!view.results.length) {
          return {
            calls: [
              {
                id: 'spawn-worker',
                name: 'agent',
                input: {
                  agent_type: 'worker',
                  description: 'update count in target',
                  prompt: 'Change count to 2 in src/target.ts.',
                },
              },
            ],
          };
        }
        return {text: `Worker finished: ${view.results[0]!.content}`};
      }
      workerOfferedTools = view.tools;
      if (!view.results.length) {
        return {
          calls: [{id: 'w-read', name: 'read', input: {path: 'src/target.ts'}}],
        };
      }
      if (view.results.length === 1) {
        return {
          calls: [
            {
              id: 'w-edit',
              name: 'edit',
              input: {
                path: 'src/target.ts',
                old_string: 'export const count = 1;',
                new_string: 'export const count = 2;',
              },
            },
          ],
        };
      }
      return {text: 'Updated src/target.ts to count = 2.'};
    },
  });

  for await (const _ of h.client.sendMessage('Delegate to worker')) {
  }

  expect(workerOfferedTools).toContain('edit');
  expect(workerOfferedTools).toContain('write');
  expect(workerOfferedTools).toContain('apply_patch');
  expect(workerOfferedTools).not.toContain('agent');
  expect(workerOfferedTools).not.toContain('request_user_input');

  expect(readFileSync(join(h.project, 'src/target.ts'), 'utf8')).toBe('export const count = 2;\n');
});

test('parallel agent calls run concurrently up to max_threads = 6; the 7th is rejected with AGENT_LIMIT_REACHED', async () => {
  let activeChildren = 0;
  let peakConcurrentChildren = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => {
    releaseGate = resolve;
  });

  const h = await setup({
    config: '[agents.explore]\nmodel = "fast-explore-model"\nreasoning_effort = "low"\n',
    script: async (view, rawBody) => {
      const isChild = view.system.includes('You are an explore subagent');
      if (!isChild) {
        if (!view.results.length) {
          return {
            calls: Array.from({length: 7}, (_, idx) => ({
              id: `parallel-${idx + 1}`,
              name: 'agent',
              input: {
                agent_type: 'explore',
                description: `task ${idx + 1}`,
                prompt: `Task number ${idx + 1}`,
              },
            })),
          };
        }
        return {text: 'All 7 parallel calls settled.'};
      }
      // Verify role model override from config.toml took effect.
      expect(rawBody.model).toBe('fast-explore-model');
      activeChildren++;
      peakConcurrentChildren = Math.max(peakConcurrentChildren, activeChildren);
      if (activeChildren >= 6) {
        releaseGate();
      }
      await Promise.race([gate, Bun.sleep(300)]);
      await Bun.sleep(20);
      activeChildren--;
      return {text: `Completed child (${view.user.at(-1)})`};
    },
  });

  const events: ModelEvent[] = [];
  for await (const event of h.client.sendMessage('Spawn 7 explorers in parallel')) {
    events.push(event);
  }

  expect(peakConcurrentChildren).toBe(6);
  const toolResults = events.flatMap(e => (e.type === 'toolResult' ? [e.result] : []));
  expect(toolResults).toHaveLength(7);
  const okResults = toolResults.filter(r => r.status === 'ok');
  const limitResults = toolResults.filter(r => r.status === 'error' && r.code === 'AGENT_LIMIT_REACHED');
  expect(okResults).toHaveLength(6);
  expect(limitResults).toHaveLength(1);
  expect(limitResults[0]!.content).toContain('max_threads = 6');
});

test('fork_context: true copies parent conversation history into the child; fork_context: false starts fresh', async () => {
  const childHistories: {forked: boolean; userTexts: string[]}[] = [];

  const h = await setup({
    script: view => {
      const isChild = view.system.includes('You are a general-purpose subagent');
      if (!isChild) {
        // Turn 1: plain conversation establishing a fact in parent history.
        if (view.user.some(u => u.includes('SECRET_CODE_IS_ORCHID')) && !view.user.some(u => u.includes('NOW_SPAWN'))) {
          return {text: 'Noted: the code is ORCHID.'};
        }
        // Turn 2: spawn one child with fork_context: true and one with fork_context: false.
        if (!view.results.length) {
          return {
            calls: [
              {
                id: 'forked-child',
                name: 'agent',
                input: {
                  agent_type: 'general',
                  description: 'with forked context',
                  prompt: 'CHILD_FORKED_PROMPT: What was the secret code?',
                  fork_context: true,
                },
              },
              {
                id: 'fresh-child',
                name: 'agent',
                input: {
                  agent_type: 'general',
                  description: 'without forked context',
                  prompt: 'CHILD_FRESH_PROMPT: What was the secret code?',
                  fork_context: false,
                },
              },
            ],
          };
        }
        return {text: 'Both children reported back.'};
      }
      const isForked = view.user.some(u => u.includes('CHILD_FORKED_PROMPT'));
      childHistories.push({forked: isForked, userTexts: [...view.user]});
      return {text: isForked ? 'Saw ORCHID' : 'Fresh context'};
    },
  });

  for await (const _ of h.client.sendMessage('Remember this: SECRET_CODE_IS_ORCHID')) {
  }
  for await (const _ of h.client.sendMessage('NOW_SPAWN children')) {
  }

  expect(childHistories).toHaveLength(2);
  const forked = childHistories.find(c => c.forked)!;
  const fresh = childHistories.find(c => !c.forked)!;
  expect(forked.userTexts.join('\n')).toContain('SECRET_CODE_IS_ORCHID');
  expect(forked.userTexts.join('\n')).toContain('Inherited parent conversation context');
  expect(fresh.userTexts.join('\n')).not.toContain('SECRET_CODE_IS_ORCHID');
});

test('child inherits fs.read session grants, does NOT inherit other session grants, obeys parent deny rules, and attributes permission prompts in TUI', async () => {
  const h = await setup({
    files: {
      '.env': 'PUBLIC_HINT=allowed_after_parent_grant\n',
      'locked/forbidden.txt': 'never-readable\n',
      'src/app.ts': 'export const v = 1;\n',
    },
    script: view => {
      const isWorker = view.system.includes('You are a worker subagent');
      if (!isWorker) {
        // Turn 1: parent reads .env and fetches https://example.com (user approves both for session).
        if (view.user.at(-1)!.includes('PARENT_WARMUP')) {
          if (!view.results.length) {
            return {
              calls: [
                {id: 'p-read-env', name: 'read', input: {path: '.env'}},
                {id: 'p-web', name: 'web_fetch', input: {url: 'https://example.com/'}},
              ],
            };
          }
          return {text: 'Parent warmup done.'};
        }
        // Turn 2: parent spawns worker.
        if (!view.results.some(r => r.callId === 'spawn-worker-perm')) {
          return {
            calls: [
              {
                id: 'spawn-worker-perm',
                name: 'agent',
                input: {
                  agent_type: 'worker',
                  description: 'check permissions and rules',
                  prompt: 'Read .env, read locked/forbidden.txt, and fetch https://example.com/.',
                },
              },
            ],
          };
        }
        return {text: `Worker result: ${view.results.find(r => r.callId === 'spawn-worker-perm')!.content}`};
      }
      if (!view.results.length) {
        return {
          calls: [
            {id: 'c-read-env', name: 'read', input: {path: '.env'}},
            {id: 'c-read-denied', name: 'read', input: {path: 'locked/forbidden.txt'}},
            {id: 'c-web', name: 'web_fetch', input: {url: 'https://example.com/'}},
          ],
        };
      }
      return {
        text: `Child results: env=${view.results.find(r => r.callId === 'c-read-env')?.content.trim()} | denied=${view.results.find(r => r.callId === 'c-read-denied')?.content} | web=${view.results.find(r => r.callId === 'c-web')?.content}`,
      };
    },
  });

  // Add a project deny rule on the parent: must apply to the child too.
  h.client.addPermissionRule('deny', 'Read(locked/**)');

  const tui = await openInk(h.client, {width: 110});
  cleanup.push(() => tui.shutdown());

  // Turn 1: approve parent's .env read and web_fetch for 'session'.
  await tui.submitPrompt('PARENT_WARMUP');
  const approveNextForSession = async () => {
    await tui.nextPermission(8000);
    const pending = h.client.listPendingPermissions()[0]!;
    expect(pending).toBeDefined();
    h.client.resolvePermission(pending.approvalId, pending.scopeHash, 'session');
  };
  await approveNextForSession();
  await approveNextForSession();
  await tui.idle();

  // Turn 2: child runs.
  // - c-read-env (.env) MUST succeed without prompting because child inherits fs.read session grants!
  // - c-read-denied (locked/forbidden.txt) MUST be denied by parent's project deny rule without prompting!
  // - c-web (https://example.com/) MUST prompt because child does NOT inherit parent's web_fetch session grant!
  const childTurnPromise = tui.submitPrompt('RUN_CHILD');
  await tui.nextPermission(8000);
  const childPrompt = h.client.listPendingPermissions()[0]!;
  expect(childPrompt).toBeDefined();
  expect(childPrompt.capability).toBe('network.connect');
  expect(childPrompt.subagent).toEqual({
    agentId: expect.any(String),
    agentType: 'worker',
    description: 'check permissions and rules',
  });

  // Verify TUI permission dialog displays the subagent type and description.
  const overlayText = tui.computeFrameSnapshot().plainText;
  expect(overlayText).toContain('Subagent: worker · check permissions and rules');

  // Deny the child's web_fetch prompt so the turn finishes cleanly.
  h.client.resolvePermission(childPrompt.approvalId, childPrompt.scopeHash, 'deny');
  await childTurnPromise;
  await tui.idle();

  const workerLastView = h.requests.filter(r => r.view.system.includes('You are a worker subagent')).at(-1)!.view;
  expect(workerLastView.results.find(r => r.callId === 'c-read-env')?.content).toContain('allowed_after_parent_grant');
  expect(workerLastView.results.find(r => r.callId === 'c-read-denied')?.content).toMatch(/^\[denied: DENIED\]/);
  expect(workerLastView.results.find(r => r.callId === 'c-web')?.content).toMatch(/^\[denied: (DENIED|POLICY)\]/);
});

test('cancelling parent turn cancels running child subagent and records cancelled status', async () => {
  let childAborted = false;
  let notifyChildStarted!: () => void;
  const childStarted = new Promise<void>(resolve => {
    notifyChildStarted = resolve;
  });

  const h = await setup({
    script: async (view, _body, signal) => {
      const isChild = view.system.includes('You are an explore subagent');
      if (!isChild) {
        return {
          calls: [
            {
              id: 'cancel-child',
              name: 'agent',
              input: {agent_type: 'explore', description: 'long running search', prompt: 'Wait until aborted'},
            },
          ],
        };
      }
      notifyChildStarted();
      await new Promise<void>(resolve => {
        signal.addEventListener(
          'abort',
          () => {
            childAborted = true;
            resolve();
          },
          {once: true},
        );
      });
      throw new Error('aborted');
    },
  });

  const controller = new AbortController();
  const events: ModelEvent[] = [];
  const runPromise = (async () => {
    for await (const event of h.client.sendMessage('Start and cancel', {signal: controller.signal})) {
      events.push(event);
    }
  })();

  await childStarted;
  controller.abort();
  await expect(runPromise).rejects.toThrow();
  expect(childAborted).toBe(true);

  const subagents = h.client.subagents();
  expect(subagents).toHaveLength(1);
  expect(subagents[0]!.status).toBe('cancelled');
});

test('child usage is accumulated into parent turn usage, child errors become tool errors without breaking parent, and compaction works in child', async () => {
  let childRound = 0;
  let childCompactionCalled = false;
  const h = await setup({
    models: [{id: 'fixture-model', context_length: 8000}],
    files: {'src/big.txt': 'x'.repeat(4800) + '\n'},
    script: view => {
      if (view.user.some(u => u.includes('CONTEXT CHECKPOINT'))) {
        childCompactionCalled = true;
        return {
          usage: {inputTokens: 50, outputTokens: 20},
          text: '1. Goal: read big.txt.\n2. Done: read src/big.txt.\n3. Next: finish.\n4. Refs: src/big.txt.',
        };
      }
      const isExplore = view.system.includes('You are an explore subagent');
      const isPlan = view.system.includes('You are a read-only planning subagent');
      if (!isExplore && !isPlan) {
        if (!view.results.length) {
          return {
            usage: {inputTokens: 100, outputTokens: 20},
            calls: [
              {
                id: 'ok-child',
                name: 'agent',
                input: {
                  agent_type: 'explore',
                  description: 'compact and summarize',
                  prompt: 'Read big.txt and finish.',
                },
              },
              {
                id: 'failing-child',
                name: 'agent',
                input: {
                  agent_type: 'plan',
                  description: 'failing plan agent',
                  prompt: 'Trigger provider failure.',
                },
              },
            ],
          };
        }
        return {
          usage: {inputTokens: 150, outputTokens: 30},
          text: 'Parent handled both ok child and failing child.',
        };
      }
      if (isPlan) {
        return {status: 400, text: 'synthetic child failure'};
      }
      childRound++;
      if (childRound === 1) {
        return {
          usage: {inputTokens: 7300, outputTokens: 40},
          calls: [{id: 'c-big-read', name: 'read', input: {path: 'src/big.txt'}}],
        };
      }
      return {
        usage: {inputTokens: 200, outputTokens: 50},
        text: 'Child compacted and completed.',
      };
    },
  });

  h.app.settings.update(settings => {
    const model = settings.catalogs[0]!.models.find(m => m.id === 'fixture-model')!;
    model.contextLimit = 8000; // auto compaction starts at 90% of the window (ADR 0054)
    model.outputLimit = 1024;
  });
  const events: ModelEvent[] = [];
  for await (const event of h.client.sendMessage('Test usage, error handling, and child compaction')) {
    events.push(event);
  }

  expect(childCompactionCalled).toBe(true);
  // Parent turn completed cleanly despite `failing-child` throwing a provider error!
  const completed = events.find((e): e is Extract<ModelEvent, {type: 'completed'}> => e.type === 'completed');
  expect(completed).toBeDefined();

  // Failing child returned a toolResult with status === 'error', while ok-child returned 'ok'.
  const toolResults = events.flatMap(e => (e.type === 'toolResult' ? [e.result] : []));
  expect(toolResults.find(r => r.callId === 'ok-child')?.status).toBe('ok');
  expect(toolResults.find(r => r.callId === 'failing-child')?.status).toBe('error');

  // Parent usage includes parent rounds (100+150=250 in, 20+30=50 out) PLUS child rounds (7300+200+50=7550 in, 40+50+20=110 out).
  expect(completed!.usage!.inputTokens).toBeGreaterThanOrEqual(250 + 7550);
  expect(completed!.usage!.outputTokens).toBeGreaterThanOrEqual(50 + 110);

  // Separate per-subagent usage and status are preserved via `client.subagents()`.
  const subs = h.client.subagents();
  expect(subs).toHaveLength(2);
  const okSub = subs.find(s => s.callId === 'ok-child')!;
  const failSub = subs.find(s => s.callId === 'failing-child')!;
  expect(okSub.status).toBe('completed');
  expect(okSub.usage?.inputTokens).toBeGreaterThanOrEqual(7550);
  expect(failSub.status).toBe('failed');
});

test('subagent events emit in order (started -> progress -> finished), render in TUI (collapsed & expanded), recover after restart, and stream in fyn exec --json', async () => {
  const h = await setup({
    files: {'src/index.ts': 'export const app = "futryn";\n'},
    script: view => {
      const isChild = view.system.includes('You are an explore subagent');
      if (!isChild) {
        if (!view.results.length) {
          return {
            calls: [
              {
                id: 'ui-agent-call',
                name: 'agent',
                input: {
                  agent_type: 'explore',
                  description: 'check entrypoint',
                  prompt: 'Read src/index.ts and summarize.',
                },
              },
            ],
          };
        }
        return {text: 'Entrypoint verified.'};
      }
      if (!view.results.length) {
        return {calls: [{id: 'child-read-idx', name: 'read', input: {path: 'src/index.ts'}}]};
      }
      return {text: 'src/index.ts exports app = "futryn".'};
    },
  });

  const tui = await openInk(h.client, {width: 110});
  cleanup.push(() => tui.shutdown());

  const observedSubagentEvents: string[] = [];
  const unsub = h.client.onReactiveEvent(ev => {
    if (ev.kind.startsWith('subagent.')) observedSubagentEvents.push(ev.kind);
  });
  await tui.submitPrompt('Inspect entrypoint');
  unsub();

  // Order of reactive notifications: started -> one or more progress -> finished.
  expect(observedSubagentEvents[0]).toBe('subagent.started');
  expect(observedSubagentEvents.at(-1)).toBe('subagent.finished');
  expect(observedSubagentEvents.filter(k => k === 'subagent.progress').length).toBeGreaterThanOrEqual(1);

  // TUI collapsed view shows `⏺ Agent(check entrypoint)` and `[explore] Done · 1 tool · ... tokens`.
  const collapsedFrame = tui.computeFrameSnapshot().plainText;
  expect(collapsedFrame).toContain('⏺ agent(check entrypoint) · ok');
  expect(collapsedFrame).toContain('explore: check entrypoint · completed');

  // Pressing Ctrl+O expands the subagent transcript to show child tool steps and summary.
  await tui.handleKey('Ctrl+O');
  const expandedFrame = tui.computeFrameSnapshot().plainText;
  expect(expandedFrame).toContain('read src/index.ts [ok]');

  // Session recovery after restart: child is not in listSessions(), but is inspectable and renders in resumed TUI.
  const sessionId = h.client.activeSession()!.id;
  expect(h.client.listSessions().map(s => s.id)).toEqual([sessionId]);
  const resumedClient = h.app.createFutrynClient(h.project);
  resumedClient.setToolsEnabled(true);
  resumedClient.resumeSession(sessionId);
  expect(resumedClient.subagents(sessionId)).toHaveLength(1);
  expect(resumedClient.subagents(sessionId)[0]!.status).toBe('completed');

  const resumedTui = await openInk(resumedClient, {width: 110});
  cleanup.push(() => resumedTui.shutdown());
  await resumedTui.handleKey('Ctrl+O');
  const resumedFrame = resumedTui.computeFrameSnapshot().plainText;
  expect(resumedFrame).toContain('agent(check entrypoint)');
  expect(resumedFrame).toContain('read src/index.ts [ok]');

  // Headless `fyn exec --json` emits subagent.started, subagent.progress, subagent.finished with contractVersion 1.35.
  const lines: string[] = [];
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
    lines.push(String(chunk));
    return true;
  });
  try {
    expect(
      await runExec(h.app, {
        prompt: 'Inspect entrypoint headless',
        workspace: h.project,
        approval: 'never',
        json: true,
      }),
    ).toBe(0);
  } finally {
    stdoutSpy.mockRestore();
  }
  const headlessEvents = lines
    .join('')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const subTypes = headlessEvents.filter(e => e.type.startsWith('subagent.')).map(e => e.type);
  expect(subTypes[0]).toBe('subagent.started');
  expect(subTypes.at(-1)).toBe('subagent.finished');
  expect(subTypes).toContain('subagent.progress');
  expect(headlessEvents.every(e => e.contractVersion === '1.35')).toBe(true);
});

test('S5c: isolation worktree edits stay out of the main checkout; unchanged worktrees vanish; non-git is refused', async () => {
  const kept: string[] = [];
  const h = await setup({
    git: true,
    files: {'src/target.ts': 'export const count = 1;\n'},
    script: view => {
      const isWorker = view.system.includes('You are a worker subagent');
      const isExplore = view.system.includes('You are an explore subagent');
      if (!isWorker && !isExplore) {
        if (!view.results.length)
          return {
            calls: [
              {
                id: 'w',
                name: 'agent',
                input: {agent_type: 'worker', description: 'edit', prompt: 'change it', isolation: 'worktree'},
              },
              {
                id: 'x',
                name: 'agent',
                input: {agent_type: 'explore', description: 'look', prompt: 'look', isolation: 'worktree'},
              },
            ],
          };
        return {text: 'parent done:' + view.results.map(r => r.content).join('\n---\n')};
      }
      if (isExplore)
        return view.results.length
          ? {text: 'nothing changed'}
          : {calls: [{id: 'r', name: 'read', input: {path: 'src/target.ts'}}]};
      if (!view.results.length) return {calls: [{id: 'r', name: 'read', input: {path: 'src/target.ts'}}]};
      if (view.results.length === 1)
        return {
          calls: [
            {
              id: 'e',
              name: 'edit',
              input: {path: 'src/target.ts', old_string: 'count = 1', new_string: 'count = 2'},
            },
          ],
        };
      return {text: 'edited in worktree'};
    },
  });
  for await (const _ of h.client.sendMessage('Use isolated children')) {
  }
  const parentFinal = h.requests
    .at(-1)!
    .view.results.map(r => r.content)
    .join('\n---\n');
  const match = /Worktree kept with changes: (\S+) \(branch (\S+)\)/.exec(parentFinal);
  expect(match).not.toBeNull();
  const [, path, branch] = match!;
  kept.push(path!);
  cleanup.push(() => {
    Bun.spawnSync(['git', '-C', h.project, 'worktree', 'remove', '--force', path!]);
    Bun.spawnSync(['git', '-C', h.project, 'branch', '-D', branch!]);
  });
  expect(readFileSync(join(path!, 'src/target.ts'), 'utf8')).toBe('export const count = 2;\n');
  expect(readFileSync(join(h.project, 'src/target.ts'), 'utf8')).toBe('export const count = 1;\n'); // main checkout untouched
  expect(path!.startsWith(h.project)).toBe(false);
  expect(parentFinal).toContain('had no changes and was removed'); // the explore child's worktree is gone
  expect(
    Bun.spawnSync(['git', '-C', h.project, 'worktree', 'list', '--porcelain'])
      .stdout.toString()
      .match(/^worktree /gm),
  ).toHaveLength(2);
});

test('S5c: isolation worktree outside a Git repository is refused with a clear error', async () => {
  const h = await setup({
    files: {'a.txt': 'x\n'},
    script: view =>
      view.system.includes('You are a worker subagent')
        ? {text: 'should not run'}
        : view.results.length
          ? {text: 'parent:' + view.results[0]!.content}
          : {
              calls: [
                {
                  id: 'g',
                  name: 'agent',
                  input: {agent_type: 'worker', description: 'iso', prompt: 'p', isolation: 'worktree'},
                },
              ],
            },
  });
  for await (const _ of h.client.sendMessage('isolate')) {
  }
  const result = h.requests.at(-1)!.view.results[0]!.content;
  expect(result).toContain('needs a Git repository');
  expect(h.requests.some(r => r.view.system.includes('You are a worker subagent'))).toBe(false);
});

test('S5c: a child turn inherits the parent turn output cap', async () => {
  const caps: Record<string, number | undefined> = {};
  const h = await setup({
    script: (view, body) => {
      const isChild = view.system.includes('You are an explore subagent');
      const cap = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
      if (isChild) {
        caps.child = cap;
        return {text: 'child done'};
      }
      caps.parent ??= cap;
      return view.results.length
        ? {text: 'parent done'}
        : {calls: [{id: 'a', name: 'agent', input: {agent_type: 'explore', description: 'd', prompt: 'p'}}]};
    },
  });
  for await (const _ of h.client.sendMessage('go', {maxOutputTokens: 4000})) {
  }
  expect(caps.parent).toBe(4000);
  expect(caps.child).toBeGreaterThan(0);
  expect(caps.child!).toBeLessThanOrEqual(4000);
});

test('S5c: fyn exec waits for a background child and gives its result to the parent as the next turn', async () => {
  const h = await setup({
    files: {'a.txt': 'x\n'},
    script: view => {
      const isChild = view.system.includes('You are an explore subagent');
      if (isChild) return {text: 'CHILD-RESULT-42'};
      if (!view.results.length && !view.user.some(u => u.includes('CHILD-RESULT-42')))
        return {
          calls: [
            {
              id: 'bg',
              name: 'agent',
              input: {agent_type: 'explore', description: 'bg job', prompt: 'p', background: true},
            },
          ],
        };
      if (view.user.some(u => u.includes('CHILD-RESULT-42'))) return {text: 'FINAL: child said CHILD-RESULT-42'};
      return {text: 'started the job'};
    },
  });
  const lines: string[] = [];
  const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(chunk => {
    lines.push(String(chunk));
    return true;
  });
  try {
    expect(
      await runExec(h.app, {prompt: 'run it in the background', workspace: h.project, approval: 'never', json: false}),
    ).toBe(0);
  } finally {
    stdoutSpy.mockRestore();
  }
  expect(lines.join('')).toContain('FINAL: child said CHILD-RESULT-42');
  expect(h.client.subagents().every(s => s.status !== 'running')).toBe(true);
});
