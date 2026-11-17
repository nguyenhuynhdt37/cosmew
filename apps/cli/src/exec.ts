import {closeSync, constants, openSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
  CONTRACT_VERSION,
  FutrynError,
  MODE_FOR_APPROVAL_POLICY,
  approvalPolicySchema,
  type ApprovalPolicy,
  type HeadlessEvent,
} from '@futryn/contracts';
import {startup, type Application} from './bootstrap/startup';
import {ChatInput} from './input';

type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'seq' | 'contractVersion'> : never;

export interface ExecOptions {
  prompt: string;
  workspace?: string;
  approval: ApprovalPolicy;
  json: boolean;
  account?: string;
  model?: string;
  outputLastMessage?: string;
}

const HELP = `fyn exec <prompt|-> [--cd|-C <dir>] [--json]
  [--approval untrusted|on-request|never] [--sandbox read-only|workspace-write]
  [--output-last-message|-o <file>] [--account <id-or-alias>] [--model <id>]
Explicit --cd grants folder consent. Without a TTY approvals default to never.
Exit: 0 complete, 1 turn failure/cancelled, 2 no tool-capable selection/consent, 64 invalid arguments.
`;

/** Own lifecycle so invalid exec arguments never open state or enter an interactive command. */
export async function execCli(args: string[]): Promise<number> {
  let options: ExecOptions;
  let sandbox: string | undefined;
  try {
    const {values, positionals} = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        cd: {type: 'string', short: 'C'},
        approval: {type: 'string'},
        sandbox: {type: 'string'},
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
    sandbox = values.sandbox;
    if (sandbox !== undefined && sandbox !== 'read-only' && sandbox !== 'workspace-write')
      throw new FutrynError('INVALID_INPUT');
    const workspace = values.cd === undefined ? undefined : realpathSync(resolve(values.cd));
    if (workspace && !statSync(workspace).isDirectory()) throw new FutrynError('INVALID_INPUT');
    for (const value of [values.cd, values.account, values.model, values['output-last-message']])
      if (value !== undefined && !value.trim()) throw new FutrynError('INVALID_INPUT');
    options = {
      prompt: positionals[0]!,
      workspace,
      approval: approvalPolicySchema.parse(values.approval ?? (process.stdin.isTTY ? 'on-request' : 'never')),
      json: values.json ?? false,
      account: values.account,
      model: values.model,
      outputLastMessage: values['output-last-message'],
    };
  } catch {
    process.stderr.write(HELP);
    return 64;
  }
  // These process-local settings are read by the existing composition root/runtime. No new tool path.
  process.env.FUTRYN_APPROVAL_POLICY = options.approval;
  if (sandbox) process.env.FUTRYN_SANDBOX_MODE = sandbox;
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
    app = startup();
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
  client.setToolsEnabled(true);
  client.setUserInputAvailable(false);
  client.setPermissionMode(MODE_FOR_APPROVAL_POLICY[options.approval]);
  const status = client.status();
  if (
    !status.activeAccount ||
    status.activeAccount.status === 'logged-out' ||
    !status.selection ||
    !status.toolsEnabled
  ) {
    failed(new FutrynError('AUTH'));
    return 2;
  }
  let input: ChatInput | undefined;
  let approvals = Promise.resolve();
  const unsubscribe = client.onInteractionEvent(event => {
    emit(event);
    if (event.type !== 'permission.requested') return;
    const request = event.request;
    approvals = approvals.then(async () => {
      let decision: 'once' | 'deny' = 'deny';
      if (interactive && !signal?.aborted && options.approval !== 'never') {
        input ??= new ChatInput(signal);
        try {
          const answer = await input.ask(app.redactor.text(`${request.action} → ${request.target}. Allow once? [y/N]`));
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
    for await (const event of client.sendMessage(options.prompt, {signal})) {
      if (event.type === 'started' || event.type === 'responseDiscarded') finalText = '';
      if (event.type === 'textDelta') finalText += event.text;
      emit(event);
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
