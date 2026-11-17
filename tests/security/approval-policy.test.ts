import {afterEach, beforeAll, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decideApproval, permissionModeDecision, type CommandRuntime, type PermissionMode} from '@futryn/contracts';
import {SessionGrants, classifyCommand, dangerousCommandMatch, evaluateExec, evaluateStdin} from '@futryn/security';
import {ToolDispatcher} from '@futryn/tools';
import {WorkspaceRoot} from '@futryn/workspace';
import {startup} from '../../apps/cli/src/bootstrap/startup';
import {toolPermissionRequest} from '../../apps/cli/src/bootstrap/approvals';
import {approvalPolicyFromEnv, permissionModeFromEnv} from '../../apps/cli/src/bootstrap/commands';
import {analyzeShell, ensureShellParser} from '../../packages/tools/src/exec/shell-parse';
import {memoryVault} from '../fixtures';

/**
 * ADR 0040: Codex approval policies (pinned openai/codex 090be4df, core/src/exec_policy.rs:868-950,
 * core/src/safety.rs assess_patch_safety, shell-command/.../is_dangerous_command.rs).
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
beforeAll(async () => {
  expect(await ensureShellParser()).toBe(true);
});

const classify = (script: string) => classifyCommand(analyzeShell(script), analyzeShell);

describe('tree-sitter classification', () => {
  test('Codex forced-rm variants are dangerous, through wrappers and nested scripts', () => {
    for (const script of [
      'rm -rf /',
      'rm -f x',
      '/bin/rm -fr /tmp/example',
      'rm -r -f /tmp/example',
      'rm --force /tmp/example',
      'rm /tmp/example -f',
      'sudo rm -rf /tmp/example',
      'env TARGET=/tmp/example rm -rf /tmp/example',
      'npm test && rm -rf build',
      'printf x | rm -rf /tmp/example',
      'if test -d /tmp/example; then rm --force /tmp/example; fi',
      'rm -rf "$TARGET" >/dev/null',
      'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
      "bash -c 'rm -rf /tmp/example'",
      "bash -lc 'echo hi; rm -rf /tmp/example'",
      "trap 'rm -rf /tmp/example' EXIT",
      'echo "$(rm -rf /tmp/example)"',
    ])
      expect({script, dangerous: classify(script).dangerous}).toEqual({script, dangerous: 'forced-rm'});
  });

  test('non-forced or non-literal rm is not dangerous (Codex)', () => {
    for (const script of [
      'rm -r /tmp/example',
      'rm -- -f',
      "echo 'rm -rf /tmp/example'",
      'env TARGET=/tmp/example rm -r /tmp/example',
      "trap 'echo rm -rf /tmp/example' EXIT",
    ])
      expect({script, dangerous: classify(script).dangerous}).toEqual({script, dangerous: null});
  });

  test('more than 8 nested wrappers fail closed', () => {
    const at = (depth: number) => [...Array(depth).fill('env'), 'rm', '-rf', '/tmp/x'];
    expect(dangerousCommandMatch(at(8), analyzeShell)).toBe('forced-rm');
    expect(dangerousCommandMatch(at(9), analyzeShell)).toBe('other');
  });

  test('ordinary commands are verified; parse errors, substitutions, eval and dynamic programs are not', () => {
    for (const script of [
      'ls -la',
      'bun test',
      'npm test && npm run lint',
      'git status | head -5',
      'cat <<EOF\nhi\nEOF',
    ])
      expect({script, ...classify(script)}).toEqual({script, dangerous: null, uncertain: false});
    for (const script of [
      'if then rm -rf x',
      'echo $(date)',
      'echo `date`',
      'diff <(ls a) <(ls b)',
      'cmd=rm; $cmd -rf /tmp/example',
      'eval "$X"',
      'bash -c "$SCRIPT"',
      "bash -c 'echo $(id)'",
    ])
      expect({script, uncertain: classify(script).uncertain}).toEqual({script, uncertain: true});
    // A parser that is unavailable classifies nothing as safe.
    expect(classifyCommand(null, () => null)).toEqual({dangerous: null, uncertain: true});
  });

  test('exec policy reasons follow the classification; missing classification is unverified', () => {
    const ctx = {
      sandbox: {mode: 'workspace-write' as const, network: false},
      configuredMode: 'workspace-write' as const,
    };
    expect(evaluateExec('ls', '.', '/ws', {...ctx, classification: classify('ls')}).reason).toBe('process-execute');
    expect(evaluateExec('rm -rf x', '.', '/ws', {...ctx, classification: classify('rm -rf x')}).reason).toBe(
      'dangerous-command',
    );
    expect(evaluateExec('ls', '.', '/ws', ctx).reason).toBe('unverified-command');
    const net = {...ctx, sandbox: {mode: 'workspace-write' as const, network: true}, classification: classify('ls')};
    expect(evaluateExec('curl x', '.', '/ws', net).reason).toBe('network-escalation');
    expect(evaluateExec('curl x', '.', '/ws', {...net, networkGranted: true}).reason).toBe('process-execute');
    expect(evaluateExec('curl x', '.', '/ws', {...net, escalation: 'never'}).effect).toBe('deny');
  });
});

describe('approval table', () => {
  test('3 policies x request kinds (Codex render_decision_for_unmatched_command + assess_patch_safety)', () => {
    const table = {
      execute: ['ask', 'allow', 'allow'],
      dangerous: ['ask', 'ask', 'deny'],
      uncertain: ['ask', 'ask', 'allow'],
      network: ['ask', 'ask', 'deny'],
      escalation: ['ask', 'ask', 'deny'],
      edit: ['ask', 'allow', 'allow'],
      stdin: ['ask', 'allow', 'allow'],
      secret: ['ask', 'ask', 'deny'],
      read: ['allow', 'allow', 'allow'],
    } as const;
    for (const [kind, expected] of Object.entries(table))
      expect([
        decideApproval('untrusted', kind as never),
        decideApproval('on-request', kind as never),
        decideApproval('never', kind as never),
      ]).toEqual([...expected]);
    expect(decideApproval('untrusted', 'edit', {autoApproveEdits: true})).toBe('allow');
  });

  test('legacy modes map onto policies; plan stays read-only', () => {
    expect(permissionModeDecision('default', 'execute')).toBe('ask');
    expect(permissionModeDecision('acceptEdits', 'edit')).toBe('allow');
    expect(permissionModeDecision('acceptEdits', 'execute')).toBe('ask');
    expect(permissionModeDecision('auto', 'execute')).toBe('allow');
    expect(permissionModeDecision('auto', 'dangerous')).toBe('ask');
    expect(permissionModeDecision('bypassPermissions', 'dangerous')).toBe('deny');
    expect(permissionModeDecision('bypassPermissions', 'secret')).toBe('deny');
    for (const kind of ['edit', 'execute', 'dangerous', 'uncertain', 'stdin'] as const)
      expect(permissionModeDecision('plan', kind)).toBe('deny');
    expect(permissionModeDecision('plan', 'secret')).toBe('ask');
  });

  test('FUTRYN_APPROVAL_POLICY selects the starting mode; legacy escalation never maps to never; invalid fails closed', () => {
    expect(approvalPolicyFromEnv({})).toBe('on-request');
    expect(permissionModeFromEnv({})).toBe('auto');
    expect(permissionModeFromEnv({FUTRYN_APPROVAL_POLICY: 'never'})).toBe('bypassPermissions');
    expect(permissionModeFromEnv({FUTRYN_APPROVAL_POLICY: 'untrusted'})).toBe('default');
    expect(approvalPolicyFromEnv({FUTRYN_SANDBOX_ESCALATION: 'never'})).toBe('never');
    expect(approvalPolicyFromEnv({FUTRYN_APPROVAL_POLICY: 'yolo'})).toBe('untrusted');
  });

  test('stdin inside the launch sandbox is plain input; retained network and drift escalate', () => {
    const ws = {mode: 'workspace-write' as const, network: false};
    expect(evaluateStdin({chars: 'y\n', interrupt: false, tty: true, launch: ws, current: ws}).reason).toBe(
      'stdin-input',
    );
    expect(
      evaluateStdin({chars: 'y\n', interrupt: false, tty: true, launch: {...ws, network: true}, current: ws}).reason,
    ).toBe('stdin-retained-escalation');
  });
});

/** The production chain: dispatcher → toolPermissionRequest → FutrynClient.requestPermission (rules, mode). */
async function chain(options: {sandboxMode?: 'read-only' | 'workspace-write'} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'futryn-policy-home-'));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'futryn-policy-ws-')));
  cleanup.push(
    () => rmSync(home, {recursive: true, force: true}),
    () => rmSync(root, {recursive: true, force: true}),
  );
  const app = startup(home, {vault: memoryVault()});
  cleanup.push(async () => {
    await app.shutdownCommands();
    await app.subscriptions.shutdown();
    app.db.close();
  });
  const client = app.createFutrynClient(root);
  client.setToolsEnabled(true);
  const ran: string[] = [];
  const runtime: CommandRuntime = {
    id: 'policy-fixture',
    label: 'fixture',
    availability: () => ({ok: true}),
    capabilities: () => ({
      modes: ['read-only', 'workspace-write'],
      network: true,
      tty: false,
      shells: ['bash'],
      tools: [],
    }),
    run: async request => {
      ran.push(request.command);
      return {kind: 'exited', exitCode: 0, signal: null, output: '', omittedBytes: 0, durationMs: 1};
    },
  };
  let turn: string | undefined;
  const grants = new SessionGrants();
  const dispatcher = new ToolDispatcher({
    workspace: new WorkspaceRoot(root),
    grants,
    commands: runtime,
    stateDirectory: join(home, 'state-not-in-ws'),
    sandbox: () => ({mode: options.sandboxMode ?? 'workspace-write', escalation: 'on-request'}),
    turnId: () => turn,
    redact: t => t,
    approve: (request, signal) => client.requestPermission(toolPermissionRequest(request), signal),
  });
  /** Run one call; a prompt is recorded and then answered with `answer` (deny by default). */
  async function attempt(
    name: string,
    input: unknown,
    answer: 'deny' | 'once' | 'session' = 'deny',
  ): Promise<{outcome: 'ran' | 'prompt' | 'refused'; status: string; prompts: number; content: string}> {
    let settled = false;
    let prompts = 0;
    const pending = dispatcher.invoke({id: crypto.randomUUID(), name, input}).finally(() => (settled = true));
    const end = Date.now() + 3000;
    while (!settled && Date.now() < end) {
      const waiting = client.listPendingPermissions();
      if (waiting.length) {
        prompts++;
        const request = waiting[0]!;
        if (answer === 'deny') client.dismissPermissionDialog(request.approvalId);
        else client.resolvePermission(request.approvalId, request.scopeHash, answer);
      }
      await Bun.sleep(2);
    }
    const result = await pending;
    return {
      outcome: prompts ? 'prompt' : result.status === 'ok' ? 'ran' : 'refused',
      status: result.status,
      prompts,
      content: result.content,
    };
  }
  return {client, dispatcher, grants, root, ran, attempt, setTurn: (id: string | undefined) => (turn = id)};
}

const exec = (cmd: string, network = false) =>
  network
    ? {
        cmd,
        sandbox_permissions: 'with_additional_permissions',
        additional_permissions: {network: {enabled: true}},
        justification: 'download',
      }
    : {cmd};

describe('policy matrix through the production permission chain', () => {
  const modes: [PermissionMode, string][] = [
    ['default', 'untrusted'],
    ['auto', 'on-request'],
    ['bypassPermissions', 'never'],
  ];
  type Outcome = 'prompt' | 'ran' | 'refused';
  const expected: Record<string, [Outcome, Outcome, Outcome]> = {
    'ls -la': ['prompt', 'ran', 'ran'],
    'rm -rf build': ['prompt', 'prompt', 'refused'],
    'npm test && rm -rf build': ['prompt', 'prompt', 'refused'],
    'echo $(id)': ['prompt', 'prompt', 'ran'],
    'curl https://example.com': ['prompt', 'prompt', 'refused'],
  };
  for (const [index, [mode, policy]] of modes.entries())
    test(`${policy}: commands, network, writes and secrets`, async () => {
      const c = await chain();
      c.client.setPermissionMode(mode);
      for (const [command, outcomes] of Object.entries(expected)) {
        const result = await c.attempt('exec_command', exec(command, command.startsWith('curl')));
        expect({command, outcome: result.outcome}).toEqual({command, outcome: outcomes[index]!});
      }
      // Only commands that ran reached the runtime.
      for (const command of c.ran) expect(expected[command]![index]).toBe('ran');
      const write = await c.attempt('write', {path: 'notes.md', content: 'x\n'});
      expect(write.outcome).toBe((['prompt', 'ran', 'ran'] as const)[index]!);
      expect(existsSync(join(c.root, 'notes.md'))).toBe(index > 0);
      writeFileSync(join(c.root, '.env'), 'TOKEN=secret\n');
      const secret = await c.attempt('read', {path: '.env'});
      expect(secret.outcome).toBe((['prompt', 'prompt', 'refused'] as const)[index]!);
      expect(secret.content).not.toContain('TOKEN=secret');
      // `.env.example` is a template, not a secret.
      writeFileSync(join(c.root, '.env.example'), 'TOKEN=\n');
      expect((await c.attempt('read', {path: '.env.example'})).outcome).toBe('ran');
      // Outside the workspace is denied by every policy, without a prompt.
      expect((await c.attempt('write', {path: '../escape.md', content: 'x'})).outcome).toBe('refused');
      expect((await c.attempt('exec_command', {cmd: 'ls', workdir: '..'})).outcome).toBe('refused');
    });

  test('never never prompts: not even for an ask rule (Codex prompt_is_rejected_by_policy)', async () => {
    const c = await chain();
    c.client.setPermissionMode('bypassPermissions');
    c.client.addPermissionRule('ask', 'Bash(git push:*)');
    const result = await c.attempt('exec_command', exec('git push origin main'));
    expect(result).toMatchObject({outcome: 'refused', prompts: 0});
    expect(c.ran).toEqual([]);
  });

  test('deny rules win over every policy; allow rules answer only their own sub-commands', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions'] as const) {
      const c = await chain();
      c.client.setPermissionMode(mode);
      c.client.addPermissionRule('deny', 'Bash(ls:*)');
      c.client.addPermissionRule('deny', 'Edit(locked/**)');
      expect((await c.attempt('exec_command', exec('ls -la'))).outcome).toBe('refused');
      expect((await c.attempt('write', {path: 'locked/a.md', content: 'x'})).outcome).toBe('refused');
      expect(c.ran).toEqual([]);
    }
    const c = await chain();
    c.client.setPermissionMode('default');
    c.client.addPermissionRule('allow', 'Bash(npm test:*)');
    expect((await c.attempt('exec_command', exec('npm test'))).outcome).toBe('ran');
    // The rule covers `npm test` only: the forced rm still asks.
    expect((await c.attempt('exec_command', exec('npm test && rm -rf build'))).outcome).toBe('prompt');
    expect(c.ran).toEqual(['npm test']);
  });

  test('read-only sandbox: writes are an escalation (ask under on-request, refused under never)', async () => {
    const c = await chain({sandboxMode: 'read-only'});
    c.client.setPermissionMode('auto');
    expect((await c.attempt('write', {path: 'a.md', content: 'x'})).outcome).toBe('prompt');
    c.client.setPermissionMode('bypassPermissions');
    expect((await c.attempt('write', {path: 'a.md', content: 'x'})).outcome).toBe('refused');
    expect(existsSync(join(c.root, 'a.md'))).toBe(false);
  });
});

describe('request_permissions', () => {
  test('network grant: once lasts for the turn, session for the session; never refuses', async () => {
    const c = await chain();
    c.client.setPermissionMode('auto');
    c.setTurn('turn-1');
    const grant = await c.attempt(
      'request_permissions',
      {permissions: {network: {enabled: true}}, reason: 'npm i'},
      'once',
    );
    expect(grant).toMatchObject({status: 'ok', prompts: 1});
    expect(grant.content).toContain('for the rest of this turn');
    // Same turn: the network command runs without a second prompt.
    expect((await c.attempt('exec_command', exec('curl https://example.com', true))).outcome).toBe('ran');
    // Next turn: the turn grant is gone.
    c.setTurn('turn-2');
    expect((await c.attempt('exec_command', exec('curl https://example.com', true))).outcome).toBe('prompt');
    const session = await c.attempt('request_permissions', {permissions: {network: {enabled: true}}}, 'session');
    expect(session.content).toContain('for this session');
    c.setTurn('turn-3');
    expect((await c.attempt('exec_command', exec('curl https://example.com', true))).outcome).toBe('ran');
    // A dangerous command still asks even with network granted.
    expect((await c.attempt('exec_command', exec('rm -rf build', true))).outcome).toBe('prompt');
    // Revoking session grants (/permissions Ctrl+X clears the dispatcher grants, as the CLI port does) removes it.
    c.grants.clear();
    expect((await c.attempt('exec_command', exec('curl https://example.com', true))).outcome).toBe('prompt');

    const never = await chain();
    never.client.setPermissionMode('bypassPermissions');
    expect(
      await never.attempt('request_permissions', {permissions: {network: {enabled: true}}}, 'session'),
    ).toMatchObject({
      outcome: 'refused',
      prompts: 0,
    });
  });

  test('a denied request grants nothing; paths outside the project and read access are refused without asking', async () => {
    const c = await chain();
    c.setTurn('t');
    expect((await c.attempt('request_permissions', {permissions: {network: {enabled: true}}})).status).toBe('denied');
    expect((await c.attempt('exec_command', exec('curl https://example.com', true))).outcome).toBe('prompt');
    for (const input of [
      {permissions: {file_system: {write: ['../outside']}}},
      {permissions: {file_system: {write: ['/etc']}}},
      {permissions: {file_system: {read: ['/etc/passwd']}}},
      {permissions: {}},
    ])
      expect(await c.attempt('request_permissions', input)).toMatchObject({prompts: 0, outcome: 'refused'});
  });

  test('writable path grant makes writes inside it ordinary edits in a read-only sandbox', async () => {
    const c = await chain({sandboxMode: 'read-only'});
    c.client.setPermissionMode('auto');
    c.setTurn('t');
    mkdirSync(join(c.root, 'gen'));
    expect(
      (await c.attempt('request_permissions', {permissions: {file_system: {write: ['gen']}}}, 'once')).status,
    ).toBe('ok');
    expect((await c.attempt('write', {path: 'gen/out.txt', content: 'x\n'})).outcome).toBe('ran');
    expect(readFileSync(join(c.root, 'gen/out.txt'), 'utf8')).toBe('x\n');
    // Outside the granted root it still escalates; protected paths stay denied.
    expect((await c.attempt('write', {path: 'other.txt', content: 'x'})).outcome).toBe('prompt');
    expect(
      (await c.attempt('request_permissions', {permissions: {file_system: {write: ['.git']}}}, 'session')).status,
    ).toBe('ok');
    expect((await c.attempt('write', {path: '.git/config', content: 'x'})).outcome).toBe('refused');
  });
});
