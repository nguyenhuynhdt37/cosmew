import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {
  type CommandRuntime,
  type HookRanEvent,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type PermissionMode,
  type PermissionSettingsSnapshot,
} from '@cosmew/contracts';
import {Conversation} from '@cosmew/core';
import {openPrivateDatabase, SqliteConversations, SqliteSettings} from '@cosmew/persistence';
import {Redactor, SessionGrants, matchesHookMatcher, parseSettings} from '@cosmew/security';
import {HookExecutor, ToolDispatcher} from '@cosmew/tools';
import {WorkspaceRoot} from '@cosmew/workspace';
import {FilePermissionSettings} from '../../apps/cli/src/bootstrap/permission-settings';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'cosmew-hooks-ws-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'cosmew-hooks-state-'));
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)');
  const store = new SqliteSettings(db);
  cleanups.push(() => {
    db.close();
    rmSync(root, {recursive: true, force: true});
    rmSync(stateDir, {recursive: true, force: true});
  });
  return {root, stateDir, db, store};
}

test('settings parser validates hooks, lists them in pendingTrust, and ignores untrusted repo hooks until approved by hash', () => {
  const {root, stateDir, store} = makeWorkspace();
  const repoDir = join(root, '.cosmew');
  mkdirSync(repoDir, {recursive: true});
  const settingsPath = join(repoDir, 'settings.json');
  const v1 = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Edit',
          hooks: [{type: 'command', command: 'echo repo-hook-v1', timeout: 5}],
        },
      ],
    },
  });
  writeFileSync(settingsPath, v1);

  const settings = new FilePermissionSettings({workspace: root, stateDirectory: stateDir, store});
  const untrusted = settings.snapshot();
  expect(untrusted.hooks).toEqual([]);
  expect(untrusted.untrustedHooksCount).toBe(1);
  expect(untrusted.pendingTrust).toHaveLength(1);
  expect(untrusted.pendingTrust[0]!.grants.some(line => line.includes('hook (PreToolUse, matcher: Bash|Edit)'))).toBe(
    true,
  );

  // Approve exact SHA-256 hash.
  settings.trust(untrusted.pendingTrust[0]!.path, untrusted.pendingTrust[0]!.hash, true);
  const trusted = settings.snapshot();
  expect(trusted.untrustedHooksCount).toBe(0);
  expect(trusted.hooks).toHaveLength(1);
  expect(trusted.hooks![0]).toMatchObject({
    scope: 'project',
    event: 'PreToolUse',
    matcher: 'Bash|Edit',
    command: 'echo repo-hook-v1',
    timeoutMs: 5000,
  });

  // Modifying even 1 character revokes trust immediately.
  writeFileSync(settingsPath, v1.replace('repo-hook-v1', 'repo-hook-v2'));
  const changed = settings.snapshot();
  expect(changed.hooks).toEqual([]);
  expect(changed.untrustedHooksCount).toBe(1);
  expect(changed.pendingTrust).toHaveLength(1);

  // Invalid hook entries are dropped with diagnostics rather than widening matchers.
  const bad = parseSettings(
    JSON.stringify({
      hooks: {
        UnknownEvent: [],
        PreToolUse: [{matcher: 'bad\nmatcher', hooks: [{type: 'command', command: 'echo oops'}]}],
        PostToolUse: [{hooks: [{type: 'command', command: 'echo bad-timeout', timeout: 999}]}],
      },
    }),
  );
  expect(bad.settings.hooks).toEqual({});
  expect(bad.diagnostics.length).toBeGreaterThanOrEqual(3);

  // Linear wildcard & Claude Code alias matching.
  expect(matchesHookMatcher('Bash|Edit', 'exec_command')).toBe(true);
  expect(matchesHookMatcher('Bash|Edit', 'apply_patch')).toBe(true);
  expect(matchesHookMatcher('mcp__github__*', 'mcp__github__list_issues')).toBe(true);
  expect(matchesHookMatcher('Read', 'edit')).toBe(false);
});

test('PreToolUse can block tools via exit 2 or JSON decision, and NEVER grants permissions or bypasses approval', async () => {
  const {root, stateDir, store} = makeWorkspace();
  writeFileSync(
    join(stateDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [{type: 'command', command: 'echo "blocked by policy hook" >&2; exit 2'}],
          },
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: 'printf \'{"decision":"allow","hookSpecificOutput":{"permissionDecision":"allow"}}\'',
              },
            ],
          },
        ],
      },
    }),
  );
  const settings = new FilePermissionSettings({workspace: root, stateDirectory: stateDir, store});
  const redactor = new Redactor();
  const executor = new HookExecutor({
    workspace: root,
    getSettings: () => settings.snapshot(),
    getPermissionMode: () => 'default',
    redact: t => redactor.text(t),
  });
  let approvalCalls = 0;
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    hooks: executor,
    sandbox: () => ({
      enabled: false,
      autoAllowBash: false,
      excludedCommands: [],
      allowUnsandboxed: true,
      additionalDirectories: [],
      network: false,
      permissionMode: 'default',
    }),
    approve: async () => {
      approvalCalls++;
      return 'deny';
    },
    redact: t => redactor.text(t),
  });

  // 1. PreToolUse exit 2 blocks `read` cleanly and emits hook.ran with blocked: true.
  const hookEvents: HookRanEvent[] = [];
  const blockedRead = await dispatcher.invoke(
    {id: 'call-read', name: 'read', input: {path: 'hello.txt'}},
    undefined,
    undefined,
    ev => {
      if (ev.type === 'hook.ran') hookEvents.push(ev);
    },
  );
  expect(blockedRead.status).toBe('denied');
  expect(blockedRead.code).toBe('HOOK_BLOCKED');
  expect(blockedRead.content).toContain('blocked by policy hook');
  expect(hookEvents).toHaveLength(1);
  expect(hookEvents[0]).toMatchObject({type: 'hook.ran', event: 'PreToolUse', blocked: true});

  // 2. PreToolUse returning "allow" still goes through normal approval and is denied when user denies.
  const writeResult = await dispatcher.invoke({
    id: 'call-write',
    name: 'write',
    input: {path: 'new-file.txt', content: 'should not be written'},
  });
  expect(approvalCalls).toBe(1);
  expect(writeResult.status).toBe('denied');
  expect(writeResult.code).not.toBe('HOOK_BLOCKED');
});

test('PostToolUse appends redacted additionalContext and scrubs sensitive environment variables', async () => {
  const {root, stateDir, store} = makeWorkspace();
  const prevApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-super-secret-env-leak-check';
  cleanups.push(() => {
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
  });

  writeFileSync(
    join(stateDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: 'cat >/dev/null; printf "post-note env=%s secret=TOP_SECRET_VALUE" "$OPENAI_API_KEY"',
              },
            ],
          },
        ],
      },
    }),
  );
  const settings = new FilePermissionSettings({workspace: root, stateDirectory: stateDir, store});
  const redactor = new Redactor();
  redactor.register('TOP_SECRET_VALUE');
  const executor = new HookExecutor({
    workspace: root,
    getSettings: () => settings.snapshot(),
    getPermissionMode: () => 'default',
    redact: t => redactor.text(t),
  });
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants: new SessionGrants(),
    hooks: executor,
    approve: async () => 'once',
    redact: t => redactor.text(t),
  });

  const events: HookRanEvent[] = [];
  const result = await dispatcher.invoke(
    {id: 'call-post', name: 'read', input: {path: 'hello.txt'}},
    undefined,
    undefined,
    ev => {
      if (ev.type === 'hook.ran') events.push(ev);
    },
  );
  expect(result.status).toBe('ok');
  expect(result.content).toContain('[Hook context]');
  expect(result.content).toContain('post-note env= ');
  expect(result.content).not.toContain('sk-super-secret-env-leak-check');
  expect(result.content).not.toContain('TOP_SECRET_VALUE');
  expect(events).toHaveLength(1);
  expect(events[0]!.event).toBe('PostToolUse');
  expect(events[0]!.summary).not.toContain('TOP_SECRET_VALUE');
});

test('plan mode disables command hooks, and sandbox-enabled never silently falls back to unsandboxed execution', async () => {
  const {root, stateDir, store} = makeWorkspace();
  const marker = join(root, 'ran.txt');
  writeFileSync(
    join(stateDir, 'settings.json'),
    JSON.stringify({
      sandbox: {enabled: true},
      hooks: {
        PreToolUse: [{matcher: '*', hooks: [{type: 'command', command: `touch "${marker}"`}]}],
      },
    }),
  );
  const settings = new FilePermissionSettings({workspace: root, stateDirectory: stateDir, store});
  let mode: PermissionMode = 'plan';
  const unavailableRuntime: CommandRuntime = {
    id: 'fake-unavailable',
    label: 'fake-unavailable',
    availability: () => ({ok: false, reason: 'no OS sandbox in test'}),
    run: async () => {
      throw new Error('must not run');
    },
  };
  const executor = new HookExecutor({
    workspace: root,
    getSettings: () => settings.snapshot(),
    getPermissionMode: () => mode,
    redact: t => t,
    commands: unavailableRuntime,
  });

  expect(executor.snapshot()).toMatchObject({
    supported: true,
    enabled: false,
    disabledReason: 'Hooks are disabled in plan mode (read-only).',
  });
  const planOutcome = await executor.run({event: 'PreToolUse', toolName: 'read'});
  expect(planOutcome).toEqual({action: 'continue', events: []});

  // Switch out of plan mode while sandbox.enabled is true and runtime is unavailable -> skips, never runs direct.
  mode = 'default';
  const sandboxOutcome = await executor.run({event: 'PreToolUse', toolName: 'read'});
  expect(sandboxOutcome.action).toBe('continue');
  expect(sandboxOutcome.events[0]?.summary).toContain('sandbox unavailable');
  expect(await Bun.file(marker).exists()).toBe(false);
});

test('Conversation runs SessionStart once, enforces UserPromptSubmit block, and caps Stop hook continuations at 2', async () => {
  const {root, stateDir, store} = makeWorkspace();
  const stopFlag = join(root, 'stop-runs.log');
  const startFlag = join(root, 'start-runs.log');
  writeFileSync(
    join(stateDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {hooks: [{type: 'command', command: `echo started >> "${startFlag}"; echo "session-boot-note"`}]},
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  "node -e \"const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(d.prompt.includes('FORBIDDEN')){console.error('prompt blocked'); process.exit(2);} console.log('prompt-note');\"",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `echo stop >> "${stopFlag}"; printf '{"decision":"block","reason":"verify tests"}'`,
              },
            ],
          },
        ],
      },
    }),
  );
  const settings = new FilePermissionSettings({workspace: root, stateDirectory: stateDir, store});
  const executor = new HookExecutor({
    workspace: root,
    getSettings: () => settings.snapshot(),
    getPermissionMode: () => 'default',
    redact: t => t,
  });

  let modelRequests: ModelRequest[] = [];
  const fakeModel: ModelPort = {
    async *stream(req): AsyncIterable<ModelEvent> {
      modelRequests.push(req);
      yield {type: 'started', requestId: req.requestId};
      yield {type: 'textDelta', text: `Answer #${modelRequests.length}`};
      yield {type: 'completed', finishReason: 'stop', usage: {inputTokens: 10, outputTokens: 5, costUSD: null}};
    },
    async generate() {
      throw new Error('unused');
    },
  };
  const convDb = openPrivateDatabase(join(stateDir, 'conv.sqlite'));
  cleanups.push(() => convDb.close());
  const convStore = new SqliteConversations(convDb);
  const conversation = new Conversation(
    {accountId: crypto.randomUUID(), modelId: 'm'},
    fakeModel,
    convStore,
    undefined,
    undefined,
    undefined,
    undefined,
    {hooks: executor},
  );

  // Turn 1: SessionStart runs once, UserPromptSubmit adds context, Stop hook blocks at most twice -> 3 model calls total.
  const events1 = await Array.fromAsync(conversation.send('hello normal'));
  expect(modelRequests).toHaveLength(3);
  expect(JSON.stringify(modelRequests[0]!.messages)).toContain('session-boot-note');
  expect(JSON.stringify(modelRequests[0]!.messages)).toContain('prompt-note');
  expect(events1.filter(e => e.type === 'hook.ran' && e.event === 'SessionStart')).toHaveLength(1);
  expect(events1.filter(e => e.type === 'hook.ran' && e.event === 'Stop')).toHaveLength(2);
  expect(events1.at(-1)?.type).toBe('completed');

  // Turn 2: UserPromptSubmit blocks FORBIDDEN prompt before calling model, and SessionStart does not re-run.
  const callsBefore = modelRequests.length;
  const collected2: ModelEvent[] = [];
  await expect(
    (async () => {
      for await (const ev of conversation.send('FORBIDDEN prompt')) collected2.push(ev);
    })(),
  ).rejects.toMatchObject({code: 'POLICY', message: 'prompt blocked'});
  expect(modelRequests.length).toBe(callsBefore);
  expect(collected2.some(e => e.type === 'hook.ran' && e.event === 'UserPromptSubmit' && e.blocked)).toBe(true);
  expect(collected2.some(e => e.type === 'hook.ran' && e.event === 'SessionStart')).toBe(false);
  expect((await Bun.file(startFlag).text()).trim().split('\n')).toHaveLength(1);
});

test('HookExecutor enforces timeout and AbortSignal cancellation cleanly', async () => {
  const {root} = makeWorkspace();
  const snap: PermissionSettingsSnapshot = {
    rules: {allow: [], ask: [], deny: []},
    additionalDirectories: [],
    sandbox: {
      enabled: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: true,
      allowedDomains: [],
    },
    hooks: [{scope: 'user', event: 'PreToolUse', matcher: '*', command: 'sleep 5', timeoutMs: 150}],
    untrustedHooksCount: 0,
    files: [],
    pendingTrust: [],
    diagnostics: [],
  };
  const executor = new HookExecutor({
    workspace: root,
    getSettings: () => snap,
    getPermissionMode: () => 'default',
    redact: t => t,
  });
  const timedOut = await executor.run({event: 'PreToolUse', toolName: 'read'});
  expect(timedOut.action).toBe('continue');
  expect(timedOut.events[0]?.summary).toContain('Timed out');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  await expect(executor.run({event: 'PreToolUse', toolName: 'read'}, controller.signal)).rejects.toMatchObject({
    code: 'CANCELLED',
  });
});
