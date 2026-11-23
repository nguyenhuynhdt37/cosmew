import {closeSync, constants, openSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
  BYPASS_PERMISSIONS_WARNING,
  CONTRACT_VERSION,
  FutrynError,
  ProviderBillingError,
  type HeadlessEvent,
} from '@cosmew/contracts';
import {
  PERMISSION_CLI_OPTIONS,
  resolvePermissionFlags,
  startup,
  type Application,
  type LaunchPermissionFlags,
} from './bootstrap/startup';
import {writeMcpNotices} from './bootstrap/mcp';
import {ChatInput} from './input';

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'seq' | 'contractVersion'> : never;

export interface ExecOptions {
  prompt: string;
  workspace?: string;
  /** Claude Code launch flags (`--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`, `--disallowedTools`). */
  permissions?: LaunchPermissionFlags;
  json: boolean;
  account?: string;
  model?: string;
  outputLastMessage?: string;
}

const HELP = `cosmew exec <prompt|-> [--cd|-C <dir>] [--json]
  [--permission-mode default|acceptEdits|plan|bypassPermissions] [--dangerously-skip-permissions]
  [--allowedTools <rules>] [--disallowedTools <rules>]
  [--output-last-message|-o <file>] [--account <id-or-alias>] [--model <id>]
Explicit --cd grants folder consent. Like \`claude -p\`, there is no one to ask without a TTY: anything that would
prompt is denied (file edits in default mode, commands outside the sandbox, new network domains). --allowedTools /
--disallowedTools take comma or space separated rules such as "Bash(npm test:*) Edit". --dangerously-skip-permissions
(bypassPermissions) approves everything without asking; the OS sandbox and deny rules still apply. Settings come from
~/.cosmew/settings.json and the project's .cosmew/settings.json / settings.local.json; repository settings that loosen
anything are ignored here unless approved earlier in the TUI.
Exit: 0 complete, 1 turn failure/cancelled, 2 no tool-capable selection/consent, 3 provider billing, 64 invalid arguments.
`;

/** Own lifecycle so invalid exec arguments never open state or enter an interactive command. */
export async function execCli(args: string[]): Promise<number> {
  let options: ExecOptions;
  try {
    const {values, positionals} = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        cd: {type: 'string', short: 'C'},
        ...PERMISSION_CLI_OPTIONS,
        json: {type: 'boolean'},
        'output-last-message': {type: 'string', short: 'o'},
        account: {type: 'string'},
        model: {type: 'string'},
        help: {type: 'boolean', short: 'h'},
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (positionals.length !== 1 || !positionals[0]?.trim()) throw new FutrynError('INVALID_INPUT');
    const permissionFlags = resolvePermissionFlags(values);
    const workspace = values.cd === undefined ? undefined : realpathSync(resolve(values.cd));
    if (workspace && !statSync(workspace).isDirectory()) throw new FutrynError('INVALID_INPUT');
    for (const value of [values.cd, values.account, values.model, values['output-last-message']])
      if (value !== undefined && !value.trim()) throw new FutrynError('INVALID_INPUT');
    options = {
      prompt: positionals[0]!,
      workspace,
      permissions: permissionFlags,
      json: values.json ?? false,
      account: values.account,
      model: values.model,
      outputLastMessage: values['output-last-message'],
    };
  } catch {
    process.stderr.write(HELP);
    return 64;
  }
  const interactive = !!process.stdin.isTTY && options.prompt !== '-';
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    if (options.prompt === '-') process.stdin.destroy();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let app: Application | undefined;
  try {
    if (options.prompt === '-') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_048_576) throw new FutrynError('INVALID_INPUT');
        chunks.push(Buffer.from(chunk));
      }
      if (controller.signal.aborted) throw new FutrynError('CANCELLED');
      options.prompt = Buffer.concat(chunks).toString('utf8');
      if (!options.prompt.trim()) return 64;
    }
    app = startup(undefined, {permissions: options.permissions ?? {}});
    for (const notice of app.takeStartupNotices()) process.stderr.write(`Notice: ${notice}\n`);
    await app.migrationCleanup;
    return await runExec(app, options, controller.signal, interactive);
  } catch (error) {
    const safe = controller.signal.aborted
      ? new FutrynError('CANCELLED')
      : error instanceof FutrynError
        ? error
        : new FutrynError('STORAGE');
    process.stderr.write(JSON.stringify(safe) + '\n');
    return safe.code === 'INVALID_INPUT' ? 64 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await app?.shutdownCommands();
    } finally {
      app?.db.close();
    }
  }
}

/** Runs the SDK agent loop; filesystem/process/network tools remain owned by ToolDispatcher. */
export async function runExec(
  app: Application,
  options: ExecOptions,
  signal?: AbortSignal,
  interactive = false,
): Promise<number> {
  let seq = 0;
  const emit = (event: WithoutEnvelope<HeadlessEvent>) => {
    if (options.json)
      process.stdout.write(
        app.redactor.text(JSON.stringify({...event, contractVersion: CONTRACT_VERSION, seq: ++seq})) + '\n',
      );
  };
  const failed = (error: FutrynError) => {
    emit({type: 'turn.failed', error: {code: error.code, message: error.message}});
    if (!options.json) process.stderr.write(JSON.stringify(error) + '\n');
  };
  if (!options.workspace) {
    failed(new FutrynError('POLICY'));
    return 2;
  }
  const client = app.createFutrynClient(options.workspace);
  try {
    if (options.account) client.useAccount(options.account);
    if (options.model) client.selectModel(options.model);
  } catch {
    failed(new FutrynError('AUTH'));
    return 2;
  }
  const status = client.status();
  if (!status.activeAccount || status.activeAccount.status === 'logged-out' || !status.selection) {
    failed(new FutrynError('AUTH'));
    return 2;
  }
  const verification = await client.verifyAccount(signal);
  if (signal?.aborted) {
    failed(new FutrynError('CANCELLED'));
    return 1;
  }
  if (!verification.ok) {
    if (verification.reason === 'billing') {
      failed(new ProviderBillingError(verification.providerHint));
      return 3;
    }
    const codes = {auth: 'AUTH', 'no-account': 'AUTH', network: 'TRANSPORT', model: 'NOT_FOUND'} as const;
    failed(new FutrynError(codes[verification.reason]));
    return verification.reason === 'no-account' || verification.reason === 'model' ? 2 : 1;
  }
  const metadata = client.refreshModelMetadata({effortOnly: true});
  if (metadata) {
    let cancel: () => void = () => {};
    try {
      await Promise.race([
        metadata,
        new Promise<void>(resolve => {
          cancel = resolve;
          signal?.addEventListener('abort', cancel, {once: true});
          if (signal?.aborted) resolve();
        }),
      ]);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  client.setToolsEnabled(true);
  client.setUserInputAvailable(false);
  // A headless run never asks about repository settings: untrusted ones stay tightening-only.
  client.setSettingsTrustPrompts(false);
  client.setPromptsAvailable(interactive);
  const launchMode = options.permissions?.mode;
  if (launchMode) client.setPermissionMode(launchMode);
  // Warnings go to stderr: stdout stays the model's answer (or the JSON event stream).
  if (client.permissionMode() === 'bypassPermissions') process.stderr.write(`${BYPASS_PERMISSIONS_WARNING}\n`);
  for (const pending of client.permissionSettings().pendingTrust)
    process.stderr.write(
      `Notice: ignoring the loosening parts of ${pending.path} (untrusted repository settings: ${pending.grants.join('; ')}). Approve it once in the TUI to use them.\n`,
    );
  if (!client.status().toolsEnabled) {
    failed(new FutrynError('AUTH'));
    return 2;
  }
  try {
    writeMcpNotices(await app.connectMcp(signal));
  } catch (error) {
    if (signal?.aborted) {
      failed(error instanceof FutrynError ? error : new FutrynError('CANCELLED'));
      return 1;
    }
    process.stderr.write('Notice: MCP servers were not started.\n');
  }
  let input: ChatInput | undefined;
  let approvals = Promise.resolve();
  const unsubscribe = client.onInteractionEvent(event => {
    emit(event);
    if (event.type !== 'permission.requested') return;
    const request = event.request;
    approvals = approvals.then(async () => {
      let decision: 'once' | 'deny' = 'deny';
      if (interactive && !signal?.aborted) {
        input ??= new ChatInput(signal);
        try {
          const prefix = request.subagent
            ? `[Subagent ${request.subagent.agentType} (${request.subagent.description})] `
            : '';
          const answer = await input.ask(
            app.redactor.text(`${prefix}${request.action} → ${request.target}. Allow once? [y/N]`),
          );
          if (/^y(?:es)?$/i.test(answer) && !signal?.aborted) decision = 'once';
        } catch {
          // EOF/cancellation refuses the operation.
        }
      }
      try {
        client.resolvePermission(request.approvalId, request.scopeHash, decision);
      } catch {
        // Abort/expiry may already have settled it.
      }
    });
  });
  let finalText = '';
  try {
    const runTurn = async (message: string) => {
      for await (const event of client.sendMessage(message, {signal})) {
        if (event.type === 'started' || event.type === 'responseDiscarded') finalText = '';
        if (event.type === 'textDelta') finalText += event.text;
        if (event.type === 'context.compacted' && !options.json)
          process.stderr.write(
            `[context compacted (${event.strategy}): ~${event.tokensBefore} -> ~${event.tokensAfter} tokens]\n`,
          );
        emit(event);
      }
    };
    await runTurn(options.prompt);
    // Headless runs drain the same durable inbox for background shell and subagent completions.
    // Wait for existing tasks, then give their notifications to the parent through its normal next turn.
    let noticed = false;
    let wake: (() => void) | undefined;
    const stopNotices = client.onSubagentNotice(() => {
      noticed = true;
      wake?.();
    });
    const stopTaskNotices = client.onBackgroundTaskEvent(event => {
      if (event.type !== 'task.finished') return;
      noticed = true;
      wake?.();
    });
    const abortWake = () => wake?.();
    signal?.addEventListener('abort', abortWake);
    try {
      while (!signal?.aborted) {
        const queued = client.takeQueuedMessage();
        if (queued !== undefined) {
          await runTurn(queued);
          continue;
        }
        if (!client.backgroundTasks().some(task => task.status === 'running')) break;
        await new Promise<void>(resolve => {
          wake = resolve;
          const timer = setTimeout(resolve, 500);
          if (noticed) resolve();
          void Promise.resolve().then(() => timer.unref?.());
        });
        wake = undefined;
        noticed = false;
      }
    } finally {
      stopNotices();
      stopTaskNotices();
      signal?.removeEventListener('abort', abortWake);
    }
    if (signal?.aborted) throw new FutrynError('CANCELLED');
    const text = app.redactor.text(finalText);
    if (options.outputLastMessage) {
      // User-chosen path relative to the caller's cwd (as `codex exec -o`). A repository-planted
      // symlink must not redirect this host-side write, so the final component is never followed.
      const fd = openSync(
        resolve(options.outputLastMessage),
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, text + '\n');
      } finally {
        closeSync(fd);
      }
    }
    if (!options.json) process.stdout.write(text + '\n');
    emit({type: 'turn.completed'});
    return 0;
  } catch (error) {
    failed(
      signal?.aborted
        ? new FutrynError('CANCELLED')
        : error instanceof FutrynError
          ? error
          : new FutrynError('STORAGE'),
    );
    return 1;
  } finally {
    unsubscribe();
    input?.close();
    await approvals;
  }
}
