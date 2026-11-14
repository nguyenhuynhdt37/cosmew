#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HannesError,
  providerSchema,
  type Account,
  type AnimationConfig,
  type ModelInfo,
  type ThemeMode,
} from '@hannes/contracts';
import { providerPresets } from '@hannes/models';
import { fetchModelsDev, terminalText, validateEndpoint } from '@hannes/security';
import { SLASH_COMMANDS, ThemeEngine, runInteractiveTui, type ThemePickerTab } from '@hannes/tui';
import { loginWizard } from './auth-wizard';
import { startup, type Application } from './bootstrap/startup';
import { ChatInput, ask, readSecretStdin, secretInput } from './input';

// Suppress third-party raw warning output; diagnostics are normalized by Hannes.
(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS: boolean }).AI_SDK_LOG_WARNINGS = false;

const HELP = `Hannes / FUTRYN provider, authentication & TUI CLI

  providers list | add [id] | show <id> | test | remove <id>
    add --url <base-url> --protocol chat|responses|anthropic|gemini
        --catalog openai|anthropic|gemini|ollama|manual --auth api-key|none [--stream-usage]
  login --provider <id> (alias of auth login)
  logout [--account <id-or-alias>] | status | doctor
  auth login --provider <id> --alias <alias> [--env KEY_VARIABLE | --key-stdin]
    [--method api-key|env|none] [--model <manual-model-id>]
  auth list | methods | status [--account <id-or-alias>] | logout --account <id-or-alias>
    login --account <existing-id-or-alias> reauthenticates and preserves its stable ID.
  accounts list | use <id-or-alias> | rename <id-or-alias> --alias <new> | remove <id-or-alias>
  models list | search <query> | info <model-id> | add <manual-model-id> | select <model-id>
    [--account <id-or-alias>] [--offline] [--capability streaming|tools|vision|reasoning]
    models sync-metadata: explicitly fetch advisory https://models.dev/api.json
  model doctor [--generate] [--account <id-or-alias>]
  themes list [--tab featured|colors|live|my-themes|all] [--query <q>] [--json]
  themes get [<theme-id>] | set <theme-id> [--project] | mode <dark|light|system> [--project]
  themes wallpaper <preset-id|off> [--project] | animation [--speed <n>] [--motion smooth|grid]
    [--cell-size <1..4>] [--veil <0..0.95>] [--enabled true|false] [--reduced-motion true|false]
  themes import <file.json> [--css <file.css>] [--id <custom-id>] | export [<theme-id>]
  themes remove <custom-theme-id> | reset [--project]
  hannes tui
  hannes [chat] [--project] [--max-output-tokens <n>] [--max-estimated-cost-usd <n>]
  hannes run [--json] < message.txt

Options: --json, --help, --project, --timeout-ms <100..300000> (provider add).
API keys are entered hidden, from secret-manager stdin, or referenced by environment
variable NAME. Never pass a key as an argument. Default storage: ~/.hannes (0700).
Canonical TUI commands: /login (/connect), /logout, /model (/models), /status,
  /config (/settings), /permissions, /mcp, /plugin, /theme (/themes), /resume,
  /clear, /compact, /help, /doctor, /exit. Unsupported backends report diagnostics.
Start FUTRYN: bun run futryn. Existing administration commands remain supported.
OpenRouter OAuth PKCE is available in /login and the guided chat wizard. Consumer
subscription/delegated-agent logins are not implemented; use provider API access. Local logout does not revoke API keys remotely.
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
];
const booleanOptions = ['json', 'help', 'key-stdin', 'offline', 'project', 'generate', 'stream-usage', 'tui'];
type Options = Record<string, string | boolean | undefined>;
const str = (options: Options, key: string) =>
  typeof options[key] === 'string' ? (options[key] as string) : undefined;
const fail = (): never => {
  throw new HannesError('INVALID_INPUT');
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
  if (str(options, 'method') && !['env', 'api-key', 'none'].includes(str(options, 'method')!)) {
    throw new HannesError('UNSUPPORTED');
  }
  const existing = str(options, 'account') ? app.accounts.get(str(options, 'account')!) : undefined;
  const providerId =
    str(options, 'provider') ??
    existing?.providerId ??
    (await ask('Provider ID (openai, anthropic, gemini, openrouter, ollama or configured gateway)'));
  if (existing && existing.providerId !== providerId) throw new HannesError('POLICY');
  let provider = app.registry.list().find(p => p.id === providerId);
  if (!provider) {
    const preset = providerPresets.find(p => p.id === providerId);
    if (!preset) throw new HannesError('NOT_FOUND');
    provider = app.registry.add(preset);
  }
  const alias = str(options, 'alias') ?? existing?.alias ?? (await ask('Account alias'));
  const method =
    str(options, 'method') ?? (str(options, 'env') ? 'env' : provider.auth === 'none' ? 'none' : 'api-key');
  if (!['env', 'api-key', 'none'].includes(method)) throw new HannesError('UNSUPPORTED');
  if ((options['key-stdin'] && str(options, 'env')) || (method === 'none' && (options['key-stdin'] || str(options, 'env')))) {
    fail();
  }
  let account: Account;
  const save = (ref: Parameters<Application['accounts']['add']>[2], secret?: string) =>
    existing
      ? app.accounts.reauthenticate(existing.id, ref, secret)
      : app.accounts.add(providerId, alias, ref, secret);
  if (method === 'none') account = await save({ kind: 'none' });
  else if (method === 'env') {
    const name = str(options, 'env') ?? (await ask('Environment variable NAME (not the key)'));
    account = await save({ kind: 'env', name });
  } else {
    const secret = options['key-stdin'] ? await readSecretStdin() : await secretInput();
    account = await save({ kind: 'keyring', key: crypto.randomUUID() }, secret);
  }
  if (str(options, 'model')) app.router.select(account, app.catalog(account).manual(str(options, 'model')!));
  output(
    app,
    { accountId: account.id, alias: account.alias, status: 'unvalidated', credentialStorage: account.credential.kind },
    !!options.json,
  );
  try {
    output(app, await progress('Validating account', () => check(app, app.accounts.get(account.id), signal)), !!options.json);
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

async function handleThemesCli(app: Application, action: string | undefined, argument: string | undefined, options: Options) {
  const client = app.createFutrynClient(resolve('.'));
  const engine = new ThemeEngine({ client });
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
    if (!manifest) throw new HannesError('NOT_FOUND');
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
    output(app, { scope, appearance: updated, manifest: engine.getActiveThemeManifest() }, !!options.json);
    return;
  }

  if (sub === 'mode') {
    const modeVal = argument ?? fail();
    if (!['dark', 'light', 'system'].includes(modeVal)) fail();
    const updated = await engine.setMode(modeVal as ThemeMode, scope);
    output(app, { scope, appearance: updated, effectiveMode: engine.getEffectiveMode() }, !!options.json);
    return;
  }

  if (sub === 'wallpaper') {
    const wallVal = argument ?? fail();
    const isOff = wallVal === 'off' || wallVal === 'none' || wallVal === 'disable';
    const updated = await engine.setWallpaper(isOff ? null : wallVal, !isOff, scope);
    output(app, { scope, appearance: updated, activeWallpaper: engine.getActiveWallpaperPresetId() }, !!options.json);
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
    output(app, { scope, appearance: updated }, !!options.json);
    return;
  }

  if (sub === 'import') {
    const filePath = argument ?? fail();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
    } catch {
      throw new HannesError('INVALID_INPUT');
    }
    let externalCss: string | undefined;
    if (str(options, 'css')) {
      try {
        externalCss = readFileSync(resolve(str(options, 'css')!), 'utf8');
      } catch {
        throw new HannesError('INVALID_INPUT');
      }
    }
    const res = await engine.importTheme(parsedJson, {
      externalCss,
      suggestedId: str(options, 'id'),
      save: true,
    });
    if (!res.report.compatible || !res.manifest) {
      output(app, { imported: false, report: res.report }, !!options.json);
      throw new HannesError('INVALID_INPUT');
    }
    output(app, { imported: true, manifest: res.manifest, report: res.report }, !!options.json);
    return;
  }

  if (sub === 'export') {
    const exported = engine.exportTheme(argument);
    output(app, exported, !!options.json);
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    const id = argument ?? fail();
    await engine.removeCustomTheme(id);
    output(app, { removed: id, activeTheme: engine.getActiveAppearance().theme }, !!options.json);
    return;
  }

  if (sub === 'reset') {
    const updated = await engine.resetAppearance(scope);
    output(app, { scope, appearance: updated }, !!options.json);
    return;
  }

  fail();
}

async function chat(app: Application, options: Options, signal: AbortSignal, single = false) {
  const maxOutput = numberOption(options, 'max-output-tokens', 4096);
  if (maxOutput < 1 || maxOutput > 32768) fail();
  const budgetInput = str(options, 'max-estimated-cost-usd');
  const estimatedBudget = budgetInput === undefined ? undefined : Number(budgetInput);
  if (estimatedBudget !== undefined && (!Number.isFinite(estimatedBudget) || estimatedBudget <= 0 || estimatedBudget > 1000)) {
    fail();
  }
  const project = options.project ? resolve('.') : undefined;
  let conversation: ReturnType<Application['conversation']> | undefined;
  let conversationAccountId: string | undefined;
  const resetConversation = () => {
    conversation = undefined;
    conversationAccountId = undefined;
    try {
      const selection = app.router.resolve(project);
      conversation = app.conversation(project);
      conversationAccountId = selection.accountId;
    } catch (e) {
      if (single || !(e instanceof HannesError) || !['AUTH', 'POLICY', 'NOT_FOUND'].includes(e.code)) throw e;
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
    let final: unknown;
    const streamRedactor = app.redactor.stream();
    for await (const event of conversation.send(message, signal, maxOutput, estimatedBudget)) {
      if (event.type === 'textDelta') {
        text += event.text;
        if (!options.json) process.stdout.write(terminalText(streamRedactor.push(event.text)));
      }
      if (event.type === 'completed') final = event;
    }
    if (options.json) output(app, { conversationId: conversation.id, text, result: final }, true);
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
  output(app, 'Hannes · /login /logout /models /accounts /model /themes /status /new /exit. Ctrl-C cancels and exits.');
  if (!conversation) output(app, 'Chưa đăng nhập hoặc chưa chọn model. Gõ /login để bắt đầu.');
  const input = new ChatInput(signal);
  try {
    while (true) {
      const line = await input.line('hannes> ');
      if (signal.aborted) throw new HannesError('CANCELLED');
      if (line === undefined) break;
      const text = line.trim();
      if (text === '/exit' || text === '/quit') break;
      try {
        if (text === '/login' || text.startsWith('/login ') || text === '/connect') {
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
            : conversationAccountId ?? app.settings.read().activeAccountId;
          if (!target) output(app, 'Bạn đã đăng xuất. Gõ /login để đăng nhập lại.');
          else {
            const account = app.accounts.get(target);
            if (account.id === conversationAccountId || account.id === app.settings.read().activeAccountId) {
              conversation = undefined;
              conversationAccountId = undefined;
            }
            await app.accounts.logout(account.id);
            output(app, `Đã đăng xuất ${account.alias} trên máy này. Gõ /login để đăng nhập lại.`);
          }
        } else if (text === '/status') {
          let selection = null;
          try {
            selection = app.router.resolve(project);
          } catch (e) {
            if (!(e instanceof HannesError) || !['AUTH', 'POLICY'].includes(e.code)) throw e;
          }
          output(app, { accounts: accountView(app), selection, conversationId: conversation?.id ?? null });
        } else if (text === '/models') {
          output(app, await app.catalog(app.resolveAccount()).discover(signal));
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
            if (options.project) app.settings.update(s => { delete s.projects[resolve('.')]; });
            resetConversation();
            output(
              app,
              conversation ? 'Account switched; started a fresh conversation.' : 'Tài khoản chưa có model. Gõ /login để chọn.',
            );
          }
        } else if (text.startsWith('/model ')) {
          const account = app.resolveAccount();
          const model = app.catalog(account).cached().find(m => m.id === text.slice(7));
          if (!model) throw new HannesError('NOT_FOUND');
          app.router.select(account, model, project);
          resetConversation();
          output(app, 'Model switched; started a fresh conversation.');
        } else if (text === '/model') {
          output(app, 'Use /models, then /model <model-id>.');
        } else if (text === '/themes' || text.startsWith('/themes ')) {
          const arg = text.slice(7).trim();
          const client = app.createFutrynClient(resolve('.'));
          const engine = new ThemeEngine({ client });
          await engine.initialize();
          if (arg) {
            const updated = await engine.setTheme(arg, options.project ? 'project' : 'global');
            output(app, { activeTheme: updated.theme, mode: updated.mode, wallpaper: updated.wallpaper });
          } else {
            output(
              app,
              {
                activeTheme: engine.getActiveAppearance().theme,
                themes: engine.listThemes('all').map(t => ({ id: t.id, name: t.name, category: t.category })),
              },
            );
          }
        } else if (text.startsWith('/connect ')) {
          const [, provider, alias, env, model] = text.split(/\s+/);
          if (!provider || !alias || !env) fail();
          conversation = undefined;
          conversationAccountId = undefined;
          const added = await login(app, { provider, alias, env, model }, signal);
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
            await runInteractiveTui({ client: app.createFutrynClient(resolve('.')), initialCommand: text });
            resetConversation();
          } else output(app, 'Interactive dialog requires a terminal. Start bun run futryn, or use the documented administration commands.');
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
        const safe = e instanceof HannesError ? e : new HannesError('INVALID_INPUT');
        if (safe.code === 'CANCELLED') output(app, 'Đã hủy. Bạn vẫn ở trong Hannes; gõ /login để thử lại.');
        else process.stderr.write(JSON.stringify(safe) + '\n');
      }
    }
  } finally {
    input.close();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...stringOptions.map(name => [name, { type: 'string' as const }]),
        ...booleanOptions.map(name => [name, { type: 'boolean' as const }]),
      ]),
    });
  } catch {
    throw new HannesError('INVALID_INPUT');
  }
  const options = parsed.values as Options;
  const [group, action, argument] = parsed.positionals;
  if (options.help || group === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const app = startup();
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
    process.stdin.destroy();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const account = () => app.resolveAccount(str(options, 'account'));
  try {
    if (group === 'status') {
      const status = app.createFutrynClient(resolve('.')).status();
      output(app, { account: status.activeAccount?.alias ?? null, provider: status.activeProvider?.id ?? null, model: status.selection?.modelId ?? null, validatedAt: status.activeAccount?.validatedAt ?? null, connectivity: 'Historical validation only; run doctor for a live check.', capabilities: status.capabilities }, !!options.json);
    } else if (group === 'doctor') {
      output(app, await app.createFutrynClient(resolve('.')).diagnose(controller.signal), !!options.json);
    } else if (['mcp', 'plugin', 'plugins', 'compact'].includes(group ?? '')) {
      throw new HannesError('UNSUPPORTED');
    } else if (group === 'logout') {
      await app.accounts.logout(account().id);
      output(app, 'Logged out locally; remote keys require provider-console revocation.');
    } else if (group === 'login' && str(options, 'provider')) {
      await login(app, options, controller.signal);
    } else if ((['login', 'connect', 'model', 'config', 'permissions', 'resume', 'clear'].includes(group ?? '') && !(group === 'model' && action === 'doctor')) || (!group && process.stdin.isTTY && process.stdout.isTTY)) {
      await runInteractiveTui({ client: app.createFutrynClient(resolve('.')), initialCommand: group ? `/${group}${action ? ' ' + action : ''}` : undefined });
    } else if (group === 'exit') {
      return;
    } else if (group === 'providers') {
      if (action === 'list') {
        output(
          app,
          {
            configured: app.registry.list(),
            availablePresets: providerPresets.map(p => ({ ...p, liveVerified: false })),
            customGateway: 'URL + protocol + model ID; 9Router uses custom configuration.',
          },
          !!options.json,
        );
      } else if (action === 'add') {
        const id = argument ?? (await ask('Configuration ID'));
        const preset = providerPresets.find(p => p.id === id);
        const url = str(options, 'url') ?? preset?.baseURL ?? (await ask('Provider base URL (e.g. https://gateway.example/v1)'));
        const protocol =
          str(options, 'protocol') ?? preset?.protocol ?? (await ask('Protocol: chat, responses, anthropic, gemini', 'chat'));
        const config = providerSchema.parse({
          id,
          name: str(options, 'name') ?? preset?.name ?? id,
          baseURL: validateEndpoint(url),
          protocol,
          catalog: str(options, 'catalog') ?? preset?.catalog ?? 'manual',
          auth: str(options, 'auth') ?? preset?.auth ?? 'api-key',
          metadataVersion: 1,
          timeoutMs: numberOption(options, 'timeout-ms', preset?.timeoutMs ?? 60000),
          streamUsage: options['stream-usage'] === true || preset?.streamUsage,
        });
        output(app, app.registry.add(config), !!options.json);
      } else if (action === 'show') {
        output(app, app.registry.get(argument ?? fail()), !!options.json);
      } else if (action === 'remove') {
        app.registry.remove(argument ?? fail());
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
            integrations: app.integrations.list().map(i => ({ provider: i.provider.id, methods: i.methods, notice: i.notice })),
            unsupportedRawSubscriptionAuth: ['ChatGPT/Codex', 'Claude subscription', 'Gemini CLI subscription', 'GitHub Copilot', 'Qwen Code subscription'],
            alternative: 'Use API credentials. Official delegated CLIs/SDKs require separate Hannes permission mediation; not implemented.',
          },
          !!options.json,
        );
      } else if (action === 'status') {
        const a = account();
        const present = a.status !== 'logged-out' && (a.credential.kind === 'none' || !!(await app.vault.get(a.credential)));
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
        await app.accounts.logout(account().id);
        output(app, 'Logged out locally. Revoke API keys in the provider console; environment values are not deleted from your shell.');
      } else {
        fail();
      }
    } else if (group === 'accounts') {
      if (action === 'list') output(app, accountView(app), !!options.json);
      else if (action === 'use') output(app, { active: app.accounts.use(argument ?? str(options, 'account') ?? fail()).id }, !!options.json);
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
          ? { models: catalog.cached(), stale: true, warning: 'Offline cache; availability unverified.' }
          : await progress('Discovering models', () => catalog.discover(controller.signal));
        let models = action === 'search' ? catalog.search(argument ?? '', result.models) : result.models;
        const capability = str(options, 'capability');
        if (capability) {
          if (!['text', 'tools', 'streaming', 'vision', 'reasoning'].includes(capability)) fail();
          models = models.filter(m => m.capabilities[capability as keyof ModelInfo['capabilities']] === 'supported');
        }
        if (action === 'list' || action === 'search') output(app, { ...result, models }, !!options.json);
        else if (action === 'info' || action === 'select') {
          const id = argument ?? str(options, 'model') ?? (process.stdin.isTTY ? await ask('Model ID') : fail());
          const model = models.find(m => m.id === id);
          if (!model) throw new HannesError('NOT_FOUND');
          output(app, action === 'select' ? app.router.select(a, model, options.project ? resolve('.') : undefined) : model, !!options.json);
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
          subscriptionAuth: 'not-implemented',
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
    app.db.close();
  }
}

main().catch(e => {
  const safe = e instanceof HannesError ? e : new HannesError('INVALID_INPUT');
  process.stderr.write(JSON.stringify(safe) + '\n');
  process.exitCode = safe.code === 'CANCELLED' ? 130 : 1;
});
