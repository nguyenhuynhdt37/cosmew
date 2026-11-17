#!/usr/bin/env -S bun --config=/dev/null --no-env-file
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {FutrynError, type Account, type AnimationConfig, type ModelInfo, type ThemeMode} from '@futryn/contracts';
import {parseSlashCommand} from '@futryn/sdk';
import {loadHostConfig, providerPresets, reservedProviderIds} from '@futryn/models';
import {fetchModelsDev, terminalText} from '@futryn/security';
import {reportRows, SLASH_COMMANDS, ThemeEngine, runInteractiveTui, type ThemePickerTab} from '@futryn/tui';
import {loginOAuth} from './subscriptions/login';
import {loginWizard} from './auth-wizard';
import {startup, type Application} from './bootstrap/startup';
import {ChatInput, ask, readSecretStdin, secretInput} from './input';
import {execCli} from './exec';

// Suppress third-party raw warning output; diagnostics are normalized by Futryn.
(globalThis as typeof globalThis & {AI_SDK_LOG_WARNINGS: boolean}).AI_SDK_LOG_WARNINGS = false;

const HELP = `Futryn (fyn) provider, authentication & TUI CLI

  providers list | add [id] | show <id> | test | remove <id>
    add --url <base-url> --protocol chat|responses|anthropic|gemini [--name <label>]
        --catalog openai|anthropic|gemini|ollama|manual [--models a,b] [--catalog-url <url>] [--no-auth]
        [--env-key NAME] [--header Name=Value]... [--env-header Name=ENV_NAME]... [--query name=value]...
        [--auth-command <exe> [--auth-arg <arg>]...] [--idle-timeout-ms n] [--request-retries n]
        [--stream-retries n] [--replay-reasoning]
        Writes [model_providers.<id>] in ~/.futryn/config.toml (user-level only; no tokens in the file).
  login --provider <id> (alias of auth login)
  logout [--account <id-or-alias>] | status | doctor
  auth login --provider <id> [--alias <alias>] [--env KEY_VARIABLE | --key-stdin]
    [--method api-key|env|none|oauth-browser] [--model <manual-model-id>]
  auth list | methods | status [--account <id-or-alias>] | logout --account <id-or-alias>
    login --account <existing-id-or-alias> reauthenticates and preserves its stable ID.
  accounts list | use <id-or-alias> | rename <id-or-alias> --alias <new> | remove <id-or-alias>
  models list | search <query> | info <model-id> | add <manual-model-id> | select <model-id>
    [--account <id-or-alias>] [--offline] [--capability streaming|tools|vision|reasoning]
    models sync-metadata: explicitly fetch advisory https://models.dev/api.json
  model doctor [--generate] [--account <id-or-alias>]
  themes list [--json] | get | set <auto|dark|light> [--project]
  themes mode <auto|dark|light> [--project] | animation [--speed <n>] [--motion smooth|grid]
    [--cell-size <1..4>] [--veil <0..0.95>] [--enabled true|false] [--reduced-motion true|false]
  themes export [<theme-id>]
  themes remove <custom-theme-id> | reset [--project]
  fyn tui
  fyn [chat] [--project] [--max-output-tokens <n>] [--max-estimated-cost-usd <n>]
  fyn run [--json] < message.txt
  fyn exec <prompt|-> --cd|-C <dir> [--json] [--approval untrusted|on-request|never]
    [--sandbox read-only|workspace-write] [--output-last-message|-o <file>] [--account <id>] [--model <id>]

Options: --json, --help, --project.
API keys are entered hidden, from secret-manager stdin, or referenced by environment
variable NAME. Never pass a key as an argument. Default storage: ~/.futryn (0700); existing ~/.hannes is reused.
FUTRYN_HOME overrides storage; HANNES_HOME remains compatible.
Canonical TUI commands: /login (/connect), /logout, /model, /status,
  /config, /permissions, /mcp, /plugin, /theme, /resume,
  /usage (/cost), /context, /effort <level|auto|status>,
  /clear, /compact, /help, /doctor, /exit. Unsupported backends report diagnostics.
Start Futryn in any project: fyn (or futryn). From source: bun run fyn. Existing administration commands remain supported.
Sign in via /login: one row per vendor, then subscription or API key. Account names
are automatic. ChatGPT signs in through the API (OAuth); Futryn runs every request itself,
no external agent runtime is started. Claude subscription
sign-in requires Anthropic approval. OpenRouter OAuth uses OpenRouter API credits.
Local logout deletes FUTRYN credentials; remote revocation is provider-managed.
`;

const stringOptions = [
  'provider',
  'account',
  'alias',
  'name',
  'url',
  'protocol',
  'catalog',
  'auth',
  'method',
  'env',
  'model',
  'timeout-ms',
  'capability',
  'max-output-tokens',
  'max-estimated-cost-usd',
  'tab',
  'query',
  'speed',
  'motion',
  'cell-size',
  'veil',
  'enabled',
  'reduced-motion',
  'css',
  'id',
  'models',
  'env-key',
  'auth-command',
  'catalog-url',
  'idle-timeout-ms',
  'request-retries',
  'stream-retries',
];
/** Repeatable `Name=Value` options of `providers add`. */
const listOptions = ['header', 'env-header', 'query', 'auth-arg'];
const booleanOptions = [
  'json',
  'help',
  'key-stdin',
  'offline',
  'project',
  'generate',
  'stream-usage',
  'tui',
  'no-auth',
  'replay-reasoning',
];
type Options = Record<string, string | string[] | boolean | undefined>;
const list = (options: Options, key: string): string[] =>
  Array.isArray(options[key]) ? (options[key] as string[]) : [];
const pairs = (values: string[]): Record<string, string> =>
  Object.fromEntries(
    values.map(value => {
      const at = value.indexOf('=');
      if (at <= 0) throw new FutrynError('INVALID_INPUT');
      return [value.slice(0, at), value.slice(at + 1)];
    }),
  );
const str = (options: Options, key: string) =>
  typeof options[key] === 'string' ? (options[key] as string) : undefined;
const fail = (): never => {
  throw new FutrynError('INVALID_INPUT');
};

function numberOption(options: Options, key: string, fallback: number): number {
  const value = str(options, key);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail();
  return Number(value);
}

function output(app: Application, value: unknown, json = false) {
  const render = typeof value === 'string' && !json ? value : JSON.stringify(value, null, json ? 0 : 2);
  process.stdout.write(terminalText(app.redactor.text(render)) + '\n');
}

async function progress<T>(label: string, work: () => Promise<T>): Promise<T> {
  const active = process.stderr.isTTY;
  if (active) process.stderr.write(label + '…');
  try {
    return await work();
  } finally {
    if (active) process.stderr.write('\n');
  }
}

async function check(app: Application, account: Account, signal: AbortSignal, generate = false) {
  return app.validateAccount(account, signal, generate);
}

async function login(app: Application, options: Options, signal: AbortSignal) {
  if (str(options, 'method') && !['env', 'api-key', 'none', 'oauth-browser'].includes(str(options, 'method')!)) {
    throw new FutrynError('UNSUPPORTED');
  }
  const existing = str(options, 'account') ? app.accounts.get(str(options, 'account')!) : undefined;
  let providerId =
    str(options, 'provider') ??
    existing?.providerId ??
    (await ask('Provider ID (openai, anthropic, gemini, xai, openrouter, ollama or configured gateway)'));
  if (existing && existing.providerId !== providerId) throw new FutrynError('POLICY');
  let provider = app.registry.list().find(p => p.id === providerId);
  if (!provider) {
    const preset = providerPresets.find(p => p.id === providerId);
    if (!preset) throw new FutrynError('NOT_FOUND');
    provider = app.registry.add(preset);
  }
  const requestedMethod = str(options, 'method');
  const group = app.integrations.list().find(i => (i.providerIds ?? [i.provider.id]).includes(provider!.id));
  const target = group?.methods.find(method => method.id === requestedMethod)?.providerId;
  if (target && target !== provider.id) {
    if (existing) throw new FutrynError('POLICY');
    providerId = target;
    provider =
      app.registry.list().find(p => p.id === target) ?? app.registry.add(app.integrations.get(target).provider);
  }
  let alias = str(options, 'alias') ?? existing?.alias ?? provider.id.slice(0, 90);
  if (!str(options, 'alias') && !existing) {
    let suffix = 2;
    while (app.accounts.list().some(account => account.alias === alias))
      alias = `${provider.id.slice(0, 90)}-${suffix++}`;
  }
  if (provider.auth === 'oauth') {
    if (options['key-stdin'] || str(options, 'env') || (requestedMethod && requestedMethod !== 'oauth-browser')) fail();
    const account = await loginOAuth(app, provider, alias, signal, existing);
    output(app, {accountId: account.id, alias: account.alias, status: account.status}, !!options.json);
    return account;
  }
  // A host-config provider can name its key variable (Codex env_key): use it when it is set.
  const hintedEnv =
    provider.envKey && !options['key-stdin'] && !str(options, 'method') && !str(options, 'env')
      ? provider.envKey
      : undefined;
  if (hintedEnv && !process.env[hintedEnv])
    process.stderr.write(
      provider.envKeyInstructions
        ? `${provider.envKeyInstructions}\n`
        : `Tip: set ${hintedEnv} to skip the key prompt.\n`,
    );
  if (hintedEnv && process.env[hintedEnv]) options.env = hintedEnv;
  const method =
    str(options, 'method') ?? (str(options, 'env') ? 'env' : provider.auth !== 'api-key' ? 'none' : 'api-key');
  if (!['env', 'api-key', 'none'].includes(method)) throw new FutrynError('UNSUPPORTED');
  if (
    (options['key-stdin'] && str(options, 'env')) ||
    (method === 'none' && (options['key-stdin'] || str(options, 'env')))
  ) {
    fail();
  }
  let account: Account;
  const save = (ref: Parameters<Application['accounts']['add']>[2], secret?: string) =>
    existing ? app.accounts.reauthenticate(existing.id, ref, secret) : app.accounts.add(providerId, alias, ref, secret);
  if (method === 'none') account = await save({kind: 'none'});
  else if (method === 'env') {
    const name = str(options, 'env') ?? (await ask('Environment variable NAME (not the key)'));
    account = await save({kind: 'env', name});
  } else {
    const secret = options['key-stdin'] ? await readSecretStdin() : await secretInput();
    account = await save({kind: 'keyring', key: crypto.randomUUID()}, secret);
  }
  if (str(options, 'model')) app.router.select(account, app.catalog(account).manual(str(options, 'model')!));
  output(
    app,
    {accountId: account.id, alias: account.alias, status: 'unvalidated', credentialStorage: account.credential.kind},
    !!options.json,
  );
  try {
    output(
      app,
      await progress('Validating account', () => check(app, app.accounts.get(account.id), signal)),
      !!options.json,
    );
  } catch (error) {
    await app.accounts.logout(account.id, !existing);
    throw error;
  }
  return app.accounts.get(account.id);
}

function accountView(app: Application) {
  const state = app.settings.read();
  return state.accounts.map(a => ({
    id: a.id,
    providerId: a.providerId,
    alias: a.alias,
    authentication: a.credential.kind,
    status: a.status,
    validatedAt: a.validatedAt,
    defaultModel: a.defaultModel ?? null,
    active: state.activeAccountId === a.id,
  }));
}

async function handleThemesCli(
  app: Application,
  action: string | undefined,
  argument: string | undefined,
  options: Options,
) {
  const client = app.createFutrynClient(resolve('.'));
  const engine = new ThemeEngine({client});
  await engine.initialize();
  const scope = options.project ? 'project' : 'global';
  const sub = action ?? 'list';

  if (sub === 'list') {
    const tabRaw = str(options, 'tab') ?? 'all';
    if (!['featured', 'colors', 'live', 'my-themes', 'all'].includes(tabRaw)) fail();
    const list = engine.listThemes(tabRaw as ThemePickerTab, str(options, 'query') ?? '');
    const active = engine.getActiveAppearance();
    output(
      app,
      {
        activeTheme: active.theme,
        mode: active.mode,
        effectiveMode: engine.getEffectiveMode(),
        wallpaper: engine.getActiveWallpaperPresetId(),
        animations: active.animations,
        themes: list.map(t => ({
          id: t.id,
          name: t.name,
          category: t.category,
          builtIn: t.builtIn,
          wallpaper: t.wallpaper,
          description: t.description,
          attribution: t.attribution ?? null,
          active: t.id === active.theme,
        })),
      },
      !!options.json,
    );
    return;
  }

  if (sub === 'get' || sub === 'show') {
    const targetId = argument ?? engine.getActiveAppearance().theme;
    const manifest = engine.getTheme(targetId);
    if (!manifest) throw new FutrynError('NOT_FOUND');
    output(
      app,
      {
        appearance: engine.getActiveAppearance(),
        effectiveMode: engine.getEffectiveMode(),
        manifest,
      },
      !!options.json,
    );
    return;
  }

  if (sub === 'set' || sub === 'use') {
    const targetId = argument ?? fail();
    const updated = await engine.setTheme(targetId, scope);
    output(app, {scope, appearance: updated, manifest: engine.getActiveThemeManifest()}, !!options.json);
    return;
  }

  if (sub === 'mode') {
    const modeVal = argument ?? fail();
    if (!['auto', 'dark', 'light', 'system'].includes(modeVal)) fail();
    const updated = await engine.setMode((modeVal === 'auto' ? 'system' : modeVal) as ThemeMode, scope);
    output(app, {scope, appearance: updated, effectiveMode: engine.getEffectiveMode()}, !!options.json);
    return;
  }

  if (sub === 'wallpaper') {
    const wallVal = argument ?? fail();
    const isOff = wallVal === 'off' || wallVal === 'none' || wallVal === 'disable';
    const updated = await engine.setWallpaper(isOff ? null : wallVal, !isOff, scope);
    output(app, {scope, appearance: updated, activeWallpaper: engine.getActiveWallpaperPresetId()}, !!options.json);
    return;
  }

  if (sub === 'animation' || sub === 'animations') {
    const patch: Partial<AnimationConfig> = {};
    if (str(options, 'enabled') !== undefined) {
      const v = str(options, 'enabled')!;
      if (v !== 'true' && v !== 'false') fail();
      patch.enabled = v === 'true';
    }
    if (str(options, 'reduced-motion') !== undefined) {
      const v = str(options, 'reduced-motion')!;
      if (v !== 'true' && v !== 'false') fail();
      patch.reducedMotion = v === 'true';
    }
    if (str(options, 'motion') !== undefined) {
      const v = str(options, 'motion')!;
      if (v !== 'smooth' && v !== 'grid') fail();
      patch.motion = v === 'grid' ? 'grid' : 'smooth';
    }
    if (str(options, 'speed') !== undefined) {
      const n = Number(str(options, 'speed'));
      if (!Number.isFinite(n) || n < 0.1 || n > 16) fail();
      patch.speed = n;
    }
    if (str(options, 'cell-size') !== undefined) {
      const n = Number(str(options, 'cell-size'));
      if (!Number.isInteger(n) || n < 1 || n > 4) fail();
      patch.cellSize = n;
    }
    if (str(options, 'veil') !== undefined) {
      const n = Number(str(options, 'veil'));
      if (!Number.isFinite(n) || n < 0 || n > 0.95) fail();
      patch.veil = n;
    }
    const updated = await engine.updateAnimation(patch, scope);
    output(app, {scope, appearance: updated}, !!options.json);
    return;
  }

  if (sub === 'import') {
    output(app, 'Custom themes are unavailable. Choose auto, dark, or light.');
    throw new FutrynError('UNSUPPORTED');
  }

  if (sub === 'export') {
    const exported = engine.exportTheme(argument);
    output(app, exported, !!options.json);
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    const id = argument ?? fail();
    await engine.removeCustomTheme(id);
    output(app, {removed: id, activeTheme: engine.getActiveAppearance().theme}, !!options.json);
    return;
  }

  if (sub === 'reset') {
    const updated = await engine.resetAppearance(scope);
    output(app, {scope, appearance: updated}, !!options.json);
    return;
  }

  fail();
}

async function chat(app: Application, options: Options, signal: AbortSignal, single = false) {
  // Absent: the model's own output limit (Codex sends no cap).
  const maxOutput =
    str(options, 'max-output-tokens') === undefined ? undefined : numberOption(options, 'max-output-tokens', 0);
  if (maxOutput !== undefined && maxOutput < 1) fail();
  const budgetInput = str(options, 'max-estimated-cost-usd');
  const estimatedBudget = budgetInput === undefined ? undefined : Number(budgetInput);
  if (
    estimatedBudget !== undefined &&
    (!Number.isFinite(estimatedBudget) || estimatedBudget <= 0 || estimatedBudget > 1000)
  ) {
    fail();
  }
  const project = options.project ? resolve('.') : undefined;
  let conversation: ReturnType<Application['conversation']> | undefined;
  let conversationAccountId: string | undefined;
  const telemetryClient = () => {
    const client = app.createFutrynClient(resolve('.'));
    if (conversation) client.resumeSession(conversation.id);
    return client;
  };
  const resetConversation = () => {
    conversation = undefined;
    conversationAccountId = undefined;
    try {
      const selection = app.router.resolve(project);
      conversation = app.conversation(project);
      conversationAccountId = selection.accountId;
    } catch (e) {
      if (single || !(e instanceof FutrynError) || !['AUTH', 'POLICY', 'NOT_FOUND'].includes(e.code)) throw e;
    }
  };
  resetConversation();
  const send = async (message: string) => {
    if (!message.trim()) return;
    if (!conversation) {
      output(app, 'Chưa có tài khoản/model đang dùng. Gõ /login để bắt đầu.');
      return;
    }
    let text = '';
    let responseStart = 0;
    let final: unknown;
    const streamRedactor = app.redactor.stream();
    for await (const event of conversation.send(
      message,
      signal,
      maxOutput,
      estimatedBudget,
      telemetryClient().status().reasoningEffort ?? undefined,
    )) {
      if (event.type === 'started') responseStart = text.length;
      if (event.type === 'textDelta') {
        text += event.text;
        if (!options.json) process.stdout.write(terminalText(streamRedactor.push(event.text)));
      }
      // Printed text cannot be unprinted: mark it void so it is never read as part of the answer (ADR 0033).
      if (event.type === 'responseDiscarded') {
        text = text.slice(0, responseStart);
        if (!options.json)
          process.stdout.write(
            terminalText(streamRedactor.finish()) +
              `\n[${event.reason === 'retry' ? `Reconnecting... ${event.attempt ?? 1}/${event.maxRetries ?? '?'}; partial output above discarded` : 'preempted; partial output above discarded'}]\n`,
          );
      }
      if (event.type === 'inputDeferred' && process.stderr.isTTY)
        process.stderr.write(
          `[${event.steerIds.length} accepted instruction(s) deferred to the next turn: ${event.reason}]\n`,
        );
      if (event.type === 'completed') final = event;
    }
    if (options.json) output(app, {conversationId: conversation.id, text, result: final}, true);
    else {
      process.stdout.write(terminalText(streamRedactor.finish()) + '\n');
      if (process.stderr.isTTY) process.stderr.write(JSON.stringify(final) + '\n');
    }
  };
  if (single) {
    let message = '';
    for await (const chunk of process.stdin) {
      message += chunk.toString();
      if (message.length > 262144) fail();
    }
    if (!message.trim()) fail();
    await send(message.trim());
    return;
  }
  output(app, 'Futryn · /login /logout /model /theme /status /clear /exit. Ctrl-C cancels and exits.');
  if (!conversation) output(app, 'Chưa đăng nhập hoặc chưa chọn model. Gõ /login để bắt đầu.');
  const input = new ChatInput(signal);
  try {
    while (true) {
      const line = await input.line('fyn> ');
      if (signal.aborted) throw new FutrynError('CANCELLED');
      if (line === undefined) break;
      const parsedCommand = line.trim().startsWith('/') ? parseSlashCommand(line) : null;
      // Legacy scripted /connect provider alias ENV model remains supported.
      const legacyConnect = line.trim().startsWith('/connect ');
      if (parsedCommand?.error && !legacyConnect) {
        output(app, parsedCommand.error);
        continue;
      }
      const text = legacyConnect ? line.trim() : (parsedCommand?.input ?? line.trim());
      if (text === '/exit' || text === '/quit') break;
      try {
        if (parsedCommand?.definition?.unavailable) {
          output(app, parsedCommand.definition.unavailable);
        } else if (text === '/usage' || text === '/context') {
          output(app, reportRows(telemetryClient(), text.slice(1) as 'usage' | 'context', '', true).join('\n'));
        } else if (text === '/effort' || text.startsWith('/effort ')) {
          const client = telemetryClient();
          if (parsedCommand?.args && parsedCommand.args !== 'status')
            client.setReasoningEffort(parsedCommand.args === 'auto' ? 'default' : parsedCommand.args);
          output(app, {
            effort: client.status().reasoningEffort,
            available: client.status().activeModel?.reasoningEfforts ?? [],
          });
        } else if (text === '/switch' || text.startsWith('/switch ')) {
          const client = telemetryClient();
          if (!parsedCommand?.args)
            output(
              app,
              client
                .listAccounts()
                .filter(a => a.status !== 'logged-out')
                .map((a, i) => ({index: i + 1, alias: a.alias, provider: a.providerId})),
            );
          else {
            if (
              process.stdin.isTTY &&
              (
                await input.ask('Continue using another account and transfer committed chat history? [y/N]')
              ).toLowerCase() !== 'y'
            ) {
              output(app, 'Cancelled.');
              continue;
            }
            const account = await client.switchAccount(parsedCommand.args, true);
            const session = client.activeSession();
            conversation = session ? app.resumeConversation(session.id) : app.conversation(project);
            conversationAccountId = account.id;
            output(app, `Using ${account.alias}; original session preserved.`);
          }
        } else if (text.startsWith('/resume ')) {
          conversation = app.resumeConversation(parsedCommand!.args);
          conversationAccountId = app.conversations.get(conversation.id)?.selection.accountId;
          output(app, 'Session resumed.');
        } else if (text === '/login' || text.startsWith('/login ') || text === '/connect') {
          conversation = undefined;
          conversationAccountId = undefined;
          await loginWizard(
            app,
            input,
            signal,
            a => check(app, a, signal),
            project,
            text.startsWith('/login ') ? text.slice(7) : undefined,
          );
          resetConversation();
        } else if (text === '/logout' || text.startsWith('/logout ')) {
          const target = text.startsWith('/logout ')
            ? text.slice(8)
            : (conversationAccountId ?? app.settings.read().activeAccountId);
          if (!target) output(app, 'Bạn đã đăng xuất. Gõ /login để đăng nhập lại.');
          else {
            const account = app.accounts.get(target);
            if (
              process.stdin.isTTY &&
              (await input.ask(`Sign out of ${account.alias}? Deletes the local credential. [y/N]`)).toLowerCase() !==
                'y'
            ) {
              output(app, 'Cancelled.');
              continue;
            }
            if (account.id === conversationAccountId || account.id === app.settings.read().activeAccountId) {
              conversation = undefined;
              conversationAccountId = undefined;
            }
            await app.accounts.logout(account.id, true);
            output(app, `Đã đăng xuất ${account.alias} trên máy này. Gõ /login để đăng nhập lại.`);
          }
        } else if (text === '/status') {
          let selection = null;
          try {
            selection = app.router.resolve(project);
          } catch (e) {
            if (!(e instanceof FutrynError) || !['AUTH', 'POLICY'].includes(e.code)) throw e;
          }
          output(app, {
            accounts: accountView(app),
            selection,
            conversationId: conversation?.id ?? null,
            details: reportRows(telemetryClient(), 'status', '', true),
          });
        } else if (line.trim() === '/models') {
          output(app, await app.discoverModels(app.resolveAccount(), signal));
        } else if (text === '/accounts' || text.startsWith('/accounts ')) {
          output(app, accountView(app));
          const selected = text.startsWith('/accounts ')
            ? text.slice(10)
            : process.stdin.isTTY
              ? await input.ask('Account ID/alias (empty to keep current)')
              : '';
          if (selected) {
            conversation = undefined;
            conversationAccountId = undefined;
            app.accounts.use(selected);
            if (options.project)
              app.settings.update(s => {
                delete s.projects[resolve('.')];
              });
            resetConversation();
            output(
              app,
              conversation
                ? 'Account switched; started a fresh conversation.'
                : 'Tài khoản chưa có model. Gõ /login để chọn.',
            );
          }
        } else if (text.startsWith('/model ')) {
          const account = app.resolveAccount();
          const model = app
            .catalog(account)
            .cached()
            .find(m => m.id === text.slice(7));
          if (!model) throw new FutrynError('NOT_FOUND');
          app.router.select(account, model, project);
          resetConversation();
          output(app, 'Model switched; started a fresh conversation.');
        } else if (text === '/model') {
          output(app, 'Use /model in the FUTRYN TUI to choose, or /model <model-id>.');
        } else if (text === '/theme') {
          const engine = new ThemeEngine({client: app.createFutrynClient(resolve('.'))});
          await engine.initialize();
          output(app, {
            activeTheme: engine.getActiveAppearance().theme,
            themes: engine.listThemes('all').map(t => ({id: t.id, name: t.name, category: t.category})),
          });
        } else if (text.startsWith('/connect ')) {
          const [, provider, alias, env, model] = text.split(/\s+/);
          if (!provider || !alias || !env) fail();
          conversation = undefined;
          conversationAccountId = undefined;
          const added = await login(app, {provider, alias, env, model}, signal);
          app.accounts.use(added.id);
          output(app, 'Account connected. Use /models then /model <model-id> to start a fresh conversation.');
        } else if (['/mcp', '/plugin', '/plugins', '/compact'].some(c => text === c || text.startsWith(c + ' '))) {
          output(app, `${text.split(' ')[0]}: Not implemented in PA1/TUI1. No backend operation was performed.`);
        } else if (text === '/doctor') {
          output(app, await app.createFutrynClient(resolve('.')).diagnose(signal));
        } else if (text === '/help' || text === '/?') {
          output(app, SLASH_COMMANDS.map(c => `${c.command}: ${c.description}`).join('\n'));
        } else if (['/config', '/settings', '/theme', '/permissions', '/resume'].includes(text)) {
          if (process.stdin.isTTY && process.stdout.isTTY) {
            await runInteractiveTui({client: app.createFutrynClient(resolve('.')), initialCommand: text});
            resetConversation();
          } else
            output(
              app,
              'Interactive dialog requires a terminal. Start bun run futryn, or use the documented administration commands.',
            );
        } else if (text === '/new' || text === '/clear') {
          resetConversation();
          output(app, conversation ? 'Started a fresh conversation.' : 'Gõ /login để bắt đầu.');
        } else if (text.startsWith('/')) {
          fail();
        } else {
          await send(line);
        }
      } catch (e) {
        if (signal.aborted) throw e;
        const safe = e instanceof FutrynError ? e : new FutrynError('INVALID_INPUT');
        if (safe.code === 'CANCELLED') output(app, 'Đã hủy. Bạn vẫn ở trong Futryn; gõ /login để thử lại.');
        else process.stderr.write(JSON.stringify(safe) + '\n');
      }
    }
  } finally {
    input.close();
  }
}

async function main() {
  if (process.argv[2] === 'exec') {
    process.exitCode = await execCli(process.argv.slice(3));
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...stringOptions.map(name => [name, {type: 'string' as const}]),
        ...listOptions.map(name => [name, {type: 'string' as const, multiple: true}]),
        ...booleanOptions.map(name => [name, {type: 'boolean' as const}]),
      ]),
    });
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
  const options = parsed.values as Options;
  const [group, action, argument] = parsed.positionals;
  if (options.help || group === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const app = startup();
  // One-time migration notices (ADR 0045) go to stderr so --json output stays clean.
  for (const notice of app.takeStartupNotices()) process.stderr.write(`Notice: ${notice}\n`);
  await app.migrationCleanup;
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const account = () => app.resolveAccount(str(options, 'account'));
  try {
    if (group === 'usage' || group === 'cost' || group === 'context') {
      const client = app.createFutrynClient(resolve('.'));
      if (action) client.resumeSession(action);
      output(app, reportRows(client, group === 'context' ? 'context' : 'usage', '', true).join('\n'), !!options.json);
    } else if (group === 'status') {
      const client = app.createFutrynClient(resolve('.'));
      if (action) client.resumeSession(action);
      const status = client.status();
      output(
        app,
        {
          usage: client.usage(),
          context: client.context(),
          reasoningEffort: status.reasoningEffort,
          sessionId: status.activeSessionId,
          account: status.activeAccount?.alias ?? null,
          provider: status.activeProvider?.id ?? null,
          model: status.selection?.modelId ?? null,
          validatedAt: status.activeAccount?.validatedAt ?? null,
          connectivity: 'Historical validation only; run doctor for a live check.',
          capabilities: status.capabilities,
        },
        !!options.json,
      );
    } else if (group === 'doctor') {
      output(app, await app.createFutrynClient(resolve('.')).diagnose(controller.signal), !!options.json);
    } else if (['mcp', 'plugin', 'plugins', 'compact'].includes(group ?? '')) {
      throw new FutrynError('UNSUPPORTED');
    } else if (group === 'logout') {
      await app.accounts.logout(account().id, true);
      output(app, 'Logged out locally; remote keys require provider-console revocation.');
    } else if (group === 'login' && str(options, 'provider')) {
      await login(app, options, controller.signal);
    } else if (
      (['login', 'connect', 'model', 'config', 'permissions', 'resume', 'clear', 'switch'].includes(group ?? '') &&
        !(group === 'model' && action === 'doctor')) ||
      (!group && process.stdin.isTTY && process.stdout.isTTY)
    ) {
      await runInteractiveTui({
        client: app.createFutrynClient(resolve('.')),
        initialCommand: group ? `/${group}${action ? ' ' + action : ''}` : undefined,
      });
    } else if (group === 'exit') {
      return;
    } else if (group === 'providers') {
      if (action === 'list') {
        output(
          app,
          {
            configured: app.registry.list(),
            availablePresets: providerPresets.map(p => ({...p, liveVerified: false})),
            hostConfig: {path: app.hostConfig.path, problems: app.hostConfigDiagnostics()},
            customGateway: `Gateways such as 9Router: providers add <id> --url <base-url> --header Name=Value; see ${app.hostConfig.path}.`,
          },
          !!options.json,
        );
      } else if (action === 'add') {
        // Writes `[model_providers.<id>]` in the user-level config.toml (ADR 0046), the same file a user edits by hand.
        const id = argument ?? (await ask('Configuration ID'));
        const preset = providerPresets.find(p => p.id === id);
        const url =
          str(options, 'url') ?? preset?.baseURL ?? (await ask('Provider base URL (e.g. https://gateway.example/v1)'));
        const protocol =
          str(options, 'protocol') ??
          preset?.protocol ??
          (await ask('Protocol: chat, responses, anthropic, gemini', 'chat'));
        const authCommand = str(options, 'auth-command');
        const raw: Record<string, unknown> = {
          name: str(options, 'name') ?? preset?.name ?? id,
          base_url: url,
          wire_api: protocol,
          ...(str(options, 'catalog') ? {catalog: str(options, 'catalog')} : {}),
          ...(str(options, 'env-key') ? {env_key: str(options, 'env-key')} : {}),
          ...(str(options, 'models')
            ? {
                models: str(options, 'models')!
                  .split(',')
                  .map(m => m.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(str(options, 'catalog-url') ? {model_catalog_url: str(options, 'catalog-url')} : {}),
          ...(list(options, 'header').length ? {http_headers: pairs(list(options, 'header'))} : {}),
          ...(list(options, 'env-header').length ? {env_http_headers: pairs(list(options, 'env-header'))} : {}),
          ...(list(options, 'query').length ? {query_params: pairs(list(options, 'query'))} : {}),
          ...(str(options, 'idle-timeout-ms')
            ? {stream_idle_timeout_ms: numberOption(options, 'idle-timeout-ms', 0)}
            : {}),
          ...(str(options, 'request-retries')
            ? {request_max_retries: numberOption(options, 'request-retries', 0)}
            : {}),
          ...(str(options, 'stream-retries') ? {stream_max_retries: numberOption(options, 'stream-retries', 0)} : {}),
          ...(options['no-auth'] === true || str(options, 'auth') === 'none' ? {requires_auth: false} : {}),
          ...(options['replay-reasoning'] === true ? {replay_reasoning: true} : {}),
          ...(authCommand ? {auth: {command: authCommand, args: list(options, 'auth-arg')}} : {}),
        };
        const loaded = loadHostConfig({model_providers: {[id]: raw}}, reservedProviderIds);
        const entry = loaded.providers[0];
        if (!entry) {
          process.stderr.write(`Provider not added: ${loaded.diagnostics.map(d => d.message).join('; ')}\n`);
          throw new FutrynError('INVALID_INPUT');
        }
        output(app, app.addHostProvider(entry), !!options.json);
      } else if (action === 'show') {
        output(app, app.registry.get(argument ?? fail()), !!options.json);
      } else if (action === 'remove') {
        app.removeProvider(argument ?? fail());
        output(app, 'Provider removed.');
      } else if (action === 'test') {
        output(
          app,
          await progress('Testing connection', () => check(app, account(), controller.signal, !!options.generate)),
          !!options.json,
        );
      } else {
        fail();
      }
    } else if (group === 'auth') {
      if (action === 'login') await login(app, options, controller.signal);
      else if (action === 'list') output(app, accountView(app), !!options.json);
      else if (action === 'methods') {
        output(
          app,
          {
            integrations: app.integrations
              .list()
              .map(i => ({provider: i.provider.id, methods: i.methods, notice: i.notice})),
            unsupportedSubscriptionMethods: [
              {
                provider: 'Claude',
                reason: 'Third-party subscription sign-in requires Anthropic approval; use API access.',
              },
            ],
            note: 'Futryn calls provider APIs only; no external agent runtime is started. Account entitlements apply.',
          },
          !!options.json,
        );
      } else if (action === 'status') {
        const a = account();
        const present =
          a.status !== 'logged-out' && (a.credential.kind === 'none' || !!(await app.vault.get(a.credential)));
        output(
          app,
          {
            ...accountView(app).find(x => x.id === a.id),
            credentialAvailable: present,
            note: 'Stored validation is historical; providers test checks connectivity now.',
          },
          !!options.json,
        );
      } else if (action === 'logout') {
        await app.accounts.logout(account().id, true);
        output(
          app,
          'Logged out locally. Revoke API keys in the provider console; environment values are not deleted from your shell.',
        );
      } else {
        fail();
      }
    } else if (group === 'accounts') {
      if (action === 'list') output(app, accountView(app), !!options.json);
      else if (action === 'use')
        output(app, {active: app.accounts.use(argument ?? str(options, 'account') ?? fail()).id}, !!options.json);
      else if (action === 'remove') {
        await app.accounts.logout(argument ?? str(options, 'account') ?? fail(), true);
        output(app, 'Account removed; local credentials deleted. Remote keys require console revocation.');
      } else if (action === 'rename') {
        app.accounts.rename(argument ?? fail(), str(options, 'alias') ?? fail());
        output(app, 'Account renamed.');
      } else {
        fail();
      }
    } else if (group === 'models') {
      const a = account();
      const catalog = app.catalog(a);
      if (action === 'add') output(app, catalog.manual(argument ?? str(options, 'model') ?? fail()), !!options.json);
      else if (action === 'sync-metadata') {
        const metadata = await progress('Fetching advisory metadata', () => fetchModelsDev(controller.signal));
        catalog.enrichModelsDev(metadata);
        output(app, 'Advisory metadata updated; model capabilities remain unverified.');
      } else {
        const result = options.offline
          ? {models: catalog.cached(), stale: true, warning: 'Offline cache; availability unverified.'}
          : await progress('Discovering models', () => app.discoverModels(a, controller.signal));
        let models = action === 'search' ? catalog.search(argument ?? '', result.models) : result.models;
        const capability = str(options, 'capability');
        if (capability) {
          if (!['text', 'tools', 'streaming', 'vision', 'reasoning'].includes(capability)) fail();
          models = models.filter(m => m.capabilities[capability as keyof ModelInfo['capabilities']] === 'supported');
        }
        if (action === 'list' || action === 'search') output(app, {...result, models}, !!options.json);
        else if (action === 'info' || action === 'select') {
          const id = argument ?? str(options, 'model') ?? (process.stdin.isTTY ? await ask('Model ID') : fail());
          const model = models.find(m => m.id === id);
          if (!model) throw new FutrynError('NOT_FOUND');
          output(
            app,
            action === 'select' ? app.router.select(a, model, options.project ? resolve('.') : undefined) : model,
            !!options.json,
          );
        } else {
          fail();
        }
      }
    } else if (group === 'model' && action === 'doctor') {
      const a = account();
      const selected = app.settings.read().selection;
      output(
        app,
        {
          selected,
          account: a.alias,
          protocol: app.registry.get(a.providerId).protocol,
          check: await progress('Diagnosing connection', () => check(app, a, controller.signal, !!options.generate)),
          fallback: 'disabled',
          tools: 'disabled',
          subscriptionAuth: app.registry.get(a.providerId).auth === 'oauth' ? 'oauth' : 'api-key',
        },
        !!options.json,
      );
    } else if (group === 'themes' || group === 'theme') {
      await handleThemesCli(app, action, argument, options);
    } else if (group === 'tui' || options.tui) {
      const client = app.createFutrynClient(resolve('.'));
      await runInteractiveTui({
        client,
        initialCommand: action ? `/${action}` : undefined,
      });
    } else if (!group || group === 'chat' || group === 'run') {
      await chat(app, options, controller.signal, group === 'run');
    } else {
      fail();
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await app.shutdownCommands();
    } finally {
      app.db.close();
    }
  }
}

main().catch(e => {
  const safe = e instanceof FutrynError ? e : new FutrynError('INVALID_INPUT');
  process.stderr.write(JSON.stringify(safe) + '\n');
  process.exitCode = safe.code === 'CANCELLED' ? 130 : 1;
});
