import {closeSync, constants, openSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {
  BYPASS_PERMISSIONS_WARNING,
  CONTRACT_VERSION,
  FutrynError,
  ProviderBillingError,
  type HeadlessEvent,
} from '@cosmew/contracts';
import {compileOutputJsonSchema, extractStructuredJson, type CompiledOutputSchema} from '@cosmew/models';
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
  /** Optional fallback model ID used once if the primary model fails with RATE_LIMIT/TRANSPORT before any tool executes. */
  fallbackModel?: string;
  outputLastMessage?: string;
  /** Raw JSON Schema string (or `@path/to/schema.json` resolved by CLI) enforced on the final answer (ADR 0124). */
  jsonSchema?: string;
  /** Maximum model/tool steps (`TurnBudget.maxSteps`). */
  maxTurns?: number;
  /** Maximum estimated/reported spend in USD (`TurnBudget.maxCostUSD` & pre-flight cap). */
  maxBudgetUsd?: number;
  /** Additional task-specific system guidance for CI/CD runs (stays below host/security rules). */
  systemPrompt?: string;
  /** Appended task-specific system guidance for CI/CD runs (stays below host/security rules). */
  appendSystemPrompt?: string;
  /** Additional working directories granted for this headless session. */
  addDirs?: string[];
  /** Resume a specific workspace session ID before sending the prompt. */
  resume?: string;
  /** Resume the most recent workspace session before sending the prompt. */
  continueLatest?: boolean;
}

const HELP = `cosmew exec <prompt|-> [--cd|-C <dir>] [--json]
  [--permission-mode default|acceptEdits|plan|bypassPermissions] [--dangerously-skip-permissions]
  [--allowedTools <rules>] [--disallowedTools <rules>]
  [--output-last-message|-o <file>] [--account <id-or-alias>] [--model <id>] [--fallback-model <id>]
  [--json-schema <json-or-@file>] [--max-turns <1..200>] [--max-budget-usd <usd>]
  [--system-prompt <text>] [--append-system-prompt <text>]
  [--add-dir <dir>]... [--resume <session-id> | --continue]
Explicit --cd grants folder consent. Like \`claude -p\`, there is no one to ask without a TTY: anything that would
prompt is denied (file edits in default mode, commands outside the sandbox, new network domains). --allowedTools /
--disallowedTools take comma or space separated rules such as "Bash(npm test:*) Edit". --dangerously-skip-permissions
(bypassPermissions) approves everything without asking; the OS sandbox and deny rules still apply. Settings come from
~/.cosmew/settings.json and the project's .cosmew/settings.json / settings.local.json; repository settings that loosen
anything are ignored here unless approved earlier in the TUI.
Exit: 0 complete, 1 turn failure/cancelled, 2 no tool-capable selection/consent, 3 provider billing, 64 invalid arguments.
`;

function loadJsonSchemaArg(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new FutrynError('INVALID_INPUT');
  if (!trimmed.startsWith('@')) return trimmed;
  const filePath = resolve(trimmed.slice(1));
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new FutrynError('INVALID_INPUT');
    return content;
  } finally {
    closeSync(fd);
  }
}

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
        'fallback-model': {type: 'string'},
        'json-schema': {type: 'string'},
        'max-turns': {type: 'string'},
        'max-budget-usd': {type: 'string'},
        'system-prompt': {type: 'string'},
        'append-system-prompt': {type: 'string'},
        'add-dir': {type: 'string', multiple: true},
        resume: {type: 'string'},
        continue: {type: 'boolean'},
        help: {type: 'boolean', short: 'h'},
      },
    });
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (positionals.length !== 1 || !positionals[0]?.trim()) throw new FutrynError('INVALID_INPUT');
    if (values.resume && values.continue) throw new FutrynError('INVALID_INPUT');
    const permissionFlags = resolvePermissionFlags(values);
    const workspace = values.cd === undefined ? undefined : realpathSync(resolve(values.cd));
    if (workspace && !statSync(workspace).isDirectory()) throw new FutrynError('INVALID_INPUT');
    for (const value of [
      values.cd,
      values.account,
      values.model,
      values['fallback-model'],
      values['output-last-message'],
      values['system-prompt'],
      values['append-system-prompt'],
      values.resume,
    ])
      if (value !== undefined && !value.trim()) throw new FutrynError('INVALID_INPUT');
    const addDirs = values['add-dir']?.map(dir => dir.trim());
    if (addDirs?.some(dir => !dir)) throw new FutrynError('INVALID_INPUT');
    let maxTurns: number | undefined;
    if (values['max-turns'] !== undefined) {
      if (!/^\d+$/.test(values['max-turns'].trim())) throw new FutrynError('INVALID_INPUT');
      maxTurns = Number(values['max-turns'].trim());
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) throw new FutrynError('INVALID_INPUT');
    }
    let maxBudgetUsd: number | undefined;
    if (values['max-budget-usd'] !== undefined) {
      maxBudgetUsd = Number(values['max-budget-usd'].trim());
      if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 1000)
        throw new FutrynError('INVALID_INPUT');
    }
    const jsonSchema = values['json-schema'] !== undefined ? loadJsonSchemaArg(values['json-schema']) : undefined;
    if (jsonSchema !== undefined) compileOutputJsonSchema(jsonSchema);
    options = {
      prompt: positionals[0]!,
      workspace,
      permissions: permissionFlags,
      json: values.json ?? false,
      account: values.account,
      model: values.model,
      fallbackModel: values['fallback-model'],
      outputLastMessage: values['output-last-message'],
      jsonSchema,
      maxTurns,
      maxBudgetUsd,
      systemPrompt: values['system-prompt'],
      appendSystemPrompt: values['append-system-prompt'],
      addDirs,
      resume: values.resume,
      continueLatest: values.continue ?? false,
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

/**
 * Normalize JSON-serializable values (invoking `toJSON()` and stripping non-JSON fields)
 * before redacting every key and leaf string so escaped quotes or backslashes cannot corrupt JSON.
 */
export function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return undefined;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, entry]) => [redact(key), walk(entry)]));
    }
    return node;
  };
  return walk(JSON.parse(serialized));
}

/** Runs the SDK agent loop; filesystem/process/network tools remain owned by ToolDispatcher. */
export async function runExec(
  app: Application,
  options: ExecOptions,
  signal?: AbortSignal,
  interactive = false,
): Promise<number> {
  let seq = 0;
  const redact = (text: string) => app.redactor.text(text);
  const emit = (event: WithoutEnvelope<HeadlessEvent>) => {
    if (options.json)
      process.stdout.write(
        JSON.stringify(redactJsonValue({...event, contractVersion: CONTRACT_VERSION, seq: ++seq}, redact)) + '\n',
      );
  };
  const failed = (error: FutrynError) => {
    emit({type: 'turn.failed', error: {code: error.code, message: error.message}});
    if (!options.json) process.stderr.write(JSON.stringify(redactJsonValue(error, redact)) + '\n');
  };
  let compiledSchema: CompiledOutputSchema | undefined;
  if (options.jsonSchema !== undefined) {
    try {
      compiledSchema = compileOutputJsonSchema(options.jsonSchema);
    } catch {
      failed(new FutrynError('INVALID_INPUT'));
      return 64;
    }
  }
  if (!options.workspace) {
    failed(new FutrynError('POLICY'));
    return 2;
  }
  const client = app.createFutrynClient(options.workspace);
  try {
    if (options.resume) {
      client.resumeSession(options.resume);
    } else if (options.continueLatest) {
      const latest = client.listSessions()[0];
      if (latest) client.resumeSession(latest.id);
    }
  } catch {
    failed(new FutrynError('NOT_FOUND'));
    return 2;
  }
  try {
    if (options.account) client.useAccount(options.account);
    if (options.model) client.selectModel(options.model);
  } catch {
    failed(new FutrynError('AUTH'));
    return 2;
  }
  if (options.addDirs?.length) {
    try {
      for (const dir of options.addDirs) client.addAdditionalDirectory(dir, {persist: false});
    } catch (error) {
      failed(error instanceof FutrynError ? error : new FutrynError('INVALID_INPUT'));
      return error instanceof FutrynError && error.code === 'POLICY' ? 2 : 64;
    }
  }
  if (options.maxTurns !== undefined || options.maxBudgetUsd !== undefined) {
    try {
      client.setTurnBudget({
        ...(options.maxTurns !== undefined ? {maxSteps: options.maxTurns} : {}),
        ...(options.maxBudgetUsd !== undefined ? {maxCostUSD: options.maxBudgetUsd} : {}),
      });
    } catch {
      failed(new FutrynError('INVALID_INPUT'));
      return 64;
    }
  }
  const extraInstructionParts = [
    options.systemPrompt?.trim(),
    options.appendSystemPrompt?.trim(),
    compiledSchema
      ? `Output format requirement: your final answer MUST be a single raw JSON value (no prose, no markdown fences) strictly conforming to this JSON Schema:\n${JSON.stringify(compiledSchema.schema)}`
      : undefined,
  ].filter((part): part is string => !!part);
  if (extraInstructionParts.length) {
    try {
      client.setAdditionalInstructions(extraInstructionParts.join('\n\n'));
    } catch {
      failed(new FutrynError('INVALID_INPUT'));
      return 64;
    }
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
  let fallbackUsed = false;
  try {
    const runTurn = async (message: string) => {
      let sawToolActivity = false;
      const execute = async () => {
        for await (const event of client.sendMessage(message, {
          signal,
          ...(options.maxBudgetUsd !== undefined ? {maxEstimatedCostUSD: options.maxBudgetUsd} : {}),
        })) {
          if (event.type === 'started' || event.type === 'responseDiscarded') finalText = '';
          if (event.type === 'toolCallComplete' || event.type === 'toolResult') sawToolActivity = true;
          if (event.type === 'textDelta') finalText += event.text;
          if (event.type === 'context.compacted' && !options.json)
            process.stderr.write(
              `[context compacted (${event.strategy}): ~${event.tokensBefore} -> ~${event.tokensAfter} tokens]\n`,
            );
          emit(event);
        }
      };
      try {
        await execute();
      } catch (error) {
        const retryableForFallback =
          error instanceof FutrynError && (error.code === 'RATE_LIMIT' || error.code === 'TRANSPORT');
        if (
          options.fallbackModel &&
          !fallbackUsed &&
          !sawToolActivity &&
          !signal?.aborted &&
          retryableForFallback &&
          options.fallbackModel !== client.status().selection?.modelId
        ) {
          fallbackUsed = true;
          process.stderr.write(
            `Notice: primary model failed (${error.code}); retrying once with fallback model ${app.redactor.text(options.fallbackModel)}.\n`,
          );
          client.selectModel(options.fallbackModel);
          finalText = '';
          await execute();
          return;
        }
        throw error;
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
    if (compiledSchema) {
      const checkOutput = () => {
        const extracted = extractStructuredJson(finalText);
        if (!extracted.ok) return {ok: false as const, reason: extracted.reason};
        const valid = compiledSchema.validate(extracted.value);
        if (!valid.ok) return {ok: false as const, reason: valid.summary};
        return {ok: true as const, canonicalText: extracted.canonicalText};
      };
      let checked = checkOutput();
      if (!checked.ok && !signal?.aborted) {
        await runTurn(
          `Your previous answer did not satisfy the required JSON Schema (${checked.reason}). Return ONLY a valid raw JSON value matching the schema, with no prose or markdown fences.`,
        );
        checked = checkOutput();
      }
      if (!checked.ok) {
        const err = new FutrynError('PROTOCOL');
        err.message = `Structured output failed JSON Schema validation: ${checked.reason}`;
        throw err;
      }
      finalText = checked.canonicalText;
    }
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
