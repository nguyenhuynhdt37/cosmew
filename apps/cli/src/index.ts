#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { HannesError, providerSchema, type Account, type ModelInfo } from '@hannes/contracts';
import { ProviderAdapter, providerPresets } from '@hannes/models';
import { fetchModelsDev, terminalText, validateEndpoint } from '@hannes/security';
import { startup, type Application } from './bootstrap/startup';
import { ask, ChatInput, readSecretStdin, secretInput } from './input';
import { loginWizard } from './auth-wizard';

// Suppress third-party raw warning output; diagnostics are normalized by Hannes.
(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS: boolean }).AI_SDK_LOG_WARNINGS = false;
const HELP = `Hannes provider & authentication CLI

  providers list | add [id] | show <id> | test | remove <id>
    add --url <base-url> --protocol chat|responses|anthropic|gemini
        --catalog openai|anthropic|gemini|ollama|manual --auth api-key|none [--stream-usage]
  auth login --provider <id> --alias <alias> [--env KEY_VARIABLE | --key-stdin]
    [--method api-key|env|none] [--model <manual-model-id>]
  auth list | methods | status [--account <id-or-alias>] | logout --account <id-or-alias>
    login --account <existing-id-or-alias> reauthenticates and preserves its stable ID.
  accounts list | use <id-or-alias> | rename <id-or-alias> --alias <new> | remove <id-or-alias>
  models list | search <query> | info <model-id> | add <manual-model-id> | select <model-id>
    [--account <id-or-alias>] [--offline] [--capability streaming|tools|vision|reasoning]
    models sync-metadata: explicitly fetch advisory https://models.dev/api.json
  model doctor [--generate] [--account <id-or-alias>]
  hannes [chat] [--project] [--max-output-tokens <n>] [--max-estimated-cost-usd <n>]
  hannes run [--json] < message.txt

Options: --json, --help, --project, --timeout-ms <100..300000> (provider add).
API keys are entered hidden, from secret-manager stdin, or referenced by environment
variable NAME. Never pass a key as an argument. Default storage: ~/.hannes (0700).
Interactive commands: /login [account], /logout [account], /connect, /models,
  /accounts [alias], /model <model-id>, /status, /new, /exit.
Subscription OAuth/delegated-agent logins are not implemented; use API credentials
or the provider's official CLI separately. Local logout does not revoke API keys remotely.
`;
const stringOptions = ['provider', 'account', 'alias', 'name', 'url', 'protocol', 'catalog', 'auth', 'method', 'env', 'model', 'timeout-ms', 'capability', 'max-output-tokens', 'max-estimated-cost-usd'];
const booleanOptions = ['json', 'help', 'key-stdin', 'offline', 'project', 'generate', 'stream-usage'];
type Options = Record<string, string | boolean | undefined>;
const str = (options: Options, key: string) => typeof options[key] === 'string' ? options[key] as string : undefined;
const fail = (): never => { throw new HannesError('INVALID_INPUT'); };
function numberOption(options: Options, key: string, fallback: number): number {
  const value = str(options, key); if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(); return Number(value);
}
function output(app: Application, value: unknown, json = false) {
  const render = typeof value === 'string' && !json ? value : JSON.stringify(value, null, json ? 0 : 2);
  process.stdout.write(terminalText(app.redactor.text(render)) + '\n');
}
async function progress<T>(label: string, work: () => Promise<T>): Promise<T> {
  const active = process.stderr.isTTY;
  if (active) process.stderr.write(label + '…');
  try { return await work(); } finally { if (active) process.stderr.write('\n'); }
}
async function check(app: Application, account: Account, signal: AbortSignal, generate = false) {
  const p = app.registry.get(account.providerId); const catalog = app.catalog(account);
  try {
    const result = await catalog.discover(signal); if (result.stale) throw new HannesError('TRANSPORT');
    const modelId = account.defaultModel ?? result.models[0]?.id;
    if ((generate || p.catalog === 'manual') && !modelId) throw new HannesError('NOT_FOUND');
    if ((generate || p.catalog === 'manual') && modelId) {
      await new ProviderAdapter(app.transport(account), modelId).generate({ requestId: crypto.randomUUID(), modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], maxOutputTokens: 16, tools: [] }, signal);
    }
    app.accounts.validation(account.id, true, account);
    return { accountId: account.id, providerId: p.id, connection: 'validated', validation: generate || p.catalog === 'manual' ? 'generation' : 'model-discovery', models: result.models.length, checkedAt: new Date().toISOString() };
  } catch (e) {
    if (e instanceof HannesError && ['AUTH', 'FORBIDDEN'].includes(e.code)) app.accounts.validation(account.id, false, account);
    throw e;
  }
}
async function login(app: Application, options: Options, signal: AbortSignal) {
  if (str(options, 'method') && !['env', 'api-key', 'none'].includes(str(options, 'method')!)) throw new HannesError('UNSUPPORTED');
  const existing = str(options, 'account') ? app.accounts.get(str(options, 'account')!) : undefined;
  const providerId = str(options, 'provider') ?? existing?.providerId ?? await ask('Provider ID (openai, anthropic, gemini, openrouter, ollama or configured gateway)');
  if (existing && existing.providerId !== providerId) throw new HannesError('POLICY');
  let provider = app.registry.list().find(p => p.id === providerId);
  if (!provider) { const preset = providerPresets.find(p => p.id === providerId); if (!preset) throw new HannesError('NOT_FOUND'); provider = app.registry.add(preset); }
  const alias = str(options, 'alias') ?? existing?.alias ?? await ask('Account alias');
  const method = str(options, 'method') ?? (str(options, 'env') ? 'env' : provider.auth === 'none' ? 'none' : 'api-key');
  if (!['env', 'api-key', 'none'].includes(method)) throw new HannesError('UNSUPPORTED');
  if ((options['key-stdin'] && str(options, 'env')) || (method === 'none' && (options['key-stdin'] || str(options, 'env')))) fail();
  let account: Account;
  const save = (ref: Parameters<Application['accounts']['add']>[2], secret?: string) => existing ? app.accounts.reauthenticate(existing.id, ref, secret) : app.accounts.add(providerId, alias, ref, secret);
  if (method === 'none') account = await save({ kind: 'none' });
  else if (method === 'env') {
    const name = str(options, 'env') ?? await ask('Environment variable NAME (not the key)');
    account = await save({ kind: 'env', name });
  } else {
    const secret = options['key-stdin'] ? await readSecretStdin() : await secretInput();
    account = await save({ kind: 'keyring', key: crypto.randomUUID() }, secret);
  }
  if (str(options, 'model')) app.router.select(account, app.catalog(account).manual(str(options, 'model')!));
  output(app, { accountId: account.id, alias: account.alias, status: 'unvalidated', credentialStorage: account.credential.kind }, !!options.json);
  output(app, await progress('Validating account', () => check(app, app.accounts.get(account.id), signal)), !!options.json);
  return app.accounts.get(account.id);
}
function accountView(app: Application) {
  const state = app.settings.read(); return state.accounts.map(a => ({ id: a.id, providerId: a.providerId, alias: a.alias, authentication: a.credential.kind, status: a.status, validatedAt: a.validatedAt, defaultModel: a.defaultModel ?? null, active: state.activeAccountId === a.id }));
}
async function chat(app: Application, options: Options, signal: AbortSignal, single = false) {
  const maxOutput = numberOption(options, 'max-output-tokens', 4096); if (maxOutput < 1 || maxOutput > 32768) fail();
  const budgetInput = str(options, 'max-estimated-cost-usd'); const estimatedBudget = budgetInput === undefined ? undefined : Number(budgetInput);
  if (estimatedBudget !== undefined && (!Number.isFinite(estimatedBudget) || estimatedBudget <= 0 || estimatedBudget > 1000)) fail();
  const project = options.project ? resolve('.') : undefined;
  let conversation: ReturnType<Application['conversation']> | undefined;
  let conversationAccountId: string | undefined;
  const resetConversation = () => {
    conversation = undefined; conversationAccountId = undefined;
    try {
      const selection = app.router.resolve(project);
      conversation = app.conversation(project); conversationAccountId = selection.accountId;
    } catch (e) { if (single || !(e instanceof HannesError) || !['AUTH', 'POLICY', 'NOT_FOUND'].includes(e.code)) throw e; }
  };
  resetConversation();
  const send = async (message: string) => {
    if (!message.trim()) return;
    if (!conversation) { output(app, 'Chưa có tài khoản/model đang dùng. Gõ /login để bắt đầu.'); return; }
    let text = ''; let final: unknown;
    const streamRedactor = app.redactor.stream();
    for await (const event of conversation.send(message, signal, maxOutput, estimatedBudget)) {
      if (event.type === 'textDelta') {
        text += event.text;
        if (!options.json) process.stdout.write(terminalText(streamRedactor.push(event.text)));
      }
      if (event.type === 'completed') final = event;
    }
    if (options.json) output(app, { conversationId: conversation.id, text, result: final }, true);
    else { process.stdout.write(terminalText(streamRedactor.finish()) + '\n'); if (process.stderr.isTTY) process.stderr.write(JSON.stringify(final) + '\n'); }
  };
  if (single) {
    let message = '';
    for await (const chunk of process.stdin) { message += chunk.toString(); if (message.length > 262144) fail(); }
    if (!message.trim()) fail(); await send(message.trim()); return;
  }
  output(app, 'Hannes · /login /logout /models /accounts /model /status /new /exit. Ctrl-C cancels and exits.');
  if (!conversation) output(app, 'Chưa đăng nhập hoặc chưa chọn model. Gõ /login để bắt đầu.');
  const input = new ChatInput(signal);
  try {
    while (true) {
      const line = await input.line('hannes> ');
      if (signal.aborted) throw new HannesError('CANCELLED');
      if (line === undefined) break;
      const text = line.trim(); if (text === '/exit' || text === '/quit') break;
      try {
        if (text === '/login' || text.startsWith('/login ') || text === '/connect') {
          conversation = undefined; conversationAccountId = undefined;
          await loginWizard(app, input, signal, a => check(app, a, signal), project, text.startsWith('/login ') ? text.slice(7) : undefined);
          resetConversation();
        } else if (text === '/logout' || text.startsWith('/logout ')) {
          const target = text.startsWith('/logout ') ? text.slice(8) : conversationAccountId ?? app.settings.read().activeAccountId;
          if (!target) output(app, 'Bạn đã đăng xuất. Gõ /login để đăng nhập lại.');
          else {
            const account = app.accounts.get(target);
            if (account.id === conversationAccountId || account.id === app.settings.read().activeAccountId) { conversation = undefined; conversationAccountId = undefined; }
            await app.accounts.logout(account.id);
            output(app, `Đã đăng xuất ${account.alias} trên máy này. Gõ /login để đăng nhập lại.`);
          }
        } else if (text === '/status') {
          let selection = null; try { selection = app.router.resolve(project); } catch (e) { if (!(e instanceof HannesError) || !['AUTH', 'POLICY'].includes(e.code)) throw e; }
          output(app, { accounts: accountView(app), selection, conversationId: conversation?.id ?? null });
        }
        else if (text === '/models') output(app, await app.catalog(app.resolveAccount()).discover(signal));
        else if (text === '/accounts' || text.startsWith('/accounts ')) {
          output(app, accountView(app));
          const selected = text.startsWith('/accounts ') ? text.slice(10) : process.stdin.isTTY ? await input.ask('Account ID/alias (empty to keep current)') : '';
          if (selected) {
            conversation = undefined; conversationAccountId = undefined; app.accounts.use(selected);
            if (options.project) app.settings.update(s => { delete s.projects[resolve('.')]; });
            resetConversation(); output(app, conversation ? 'Account switched; started a fresh conversation.' : 'Tài khoản chưa có model. Gõ /login để chọn.');
          }
        } else if (text.startsWith('/model ')) {
          const account = app.resolveAccount(); const model = app.catalog(account).cached().find(m => m.id === text.slice(7)); if (!model) throw new HannesError('NOT_FOUND');
          app.router.select(account, model, project); resetConversation(); output(app, 'Model switched; started a fresh conversation.');
        } else if (text === '/model') { output(app, 'Use /models, then /model <model-id>.'); }
        else if (text.startsWith('/connect ')) {
          const [, provider, alias, env, model] = text.split(/\s+/); if (!provider || !alias || !env) fail();
          conversation = undefined; conversationAccountId = undefined; const added = await login(app, { provider, alias, env, model }, signal); app.accounts.use(added.id);
          output(app, 'Account connected. Use /models then /model <model-id> to start a fresh conversation.');
        }
        else if (text === '/new') { resetConversation(); output(app, conversation ? 'Started a fresh conversation.' : 'Gõ /login để bắt đầu.'); }
        else if (text.startsWith('/')) fail();
        else await send(line);
      } catch (e) {
        if (signal.aborted) throw e;
        const safe = e instanceof HannesError ? e : new HannesError('INVALID_INPUT');
        if (safe.code === 'CANCELLED') output(app, 'Đã hủy. Bạn vẫn ở trong Hannes; gõ /login để thử lại.');
        else process.stderr.write(JSON.stringify(safe) + '\n');
      }
    }
  } finally { input.close(); }
}

async function main() {
  let parsed;
  try { parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: Object.fromEntries([...stringOptions.map(name => [name, { type: 'string' as const }]), ...booleanOptions.map(name => [name, { type: 'boolean' as const }])]) }); }
  catch { throw new HannesError('INVALID_INPUT'); }
  const options = parsed.values as Options; const [group, action, argument] = parsed.positionals;
  if (options.help || group === 'help') { process.stdout.write(HELP); return; }
  const app = startup(); const controller = new AbortController();
  const interrupt = () => { controller.abort(); process.stdin.destroy(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const account = () => app.resolveAccount(str(options, 'account'));
  try {
    if (group === 'providers') {
      if (action === 'list') output(app, { configured: app.registry.list(), availablePresets: providerPresets.map(p => ({ ...p, liveVerified: false })), customGateway: 'URL + protocol + model ID; 9Router uses custom configuration.' }, !!options.json);
      else if (action === 'add') {
        const id = argument ?? await ask('Configuration ID'); const preset = providerPresets.find(p => p.id === id);
        const url = str(options, 'url') ?? preset?.baseURL ?? await ask('Provider base URL (e.g. https://gateway.example/v1)');
        const protocol = str(options, 'protocol') ?? preset?.protocol ?? await ask('Protocol: chat, responses, anthropic, gemini', 'chat');
        const config = providerSchema.parse({ id, name: str(options, 'name') ?? preset?.name ?? id, baseURL: validateEndpoint(url), protocol,
          catalog: str(options, 'catalog') ?? preset?.catalog ?? 'manual', auth: str(options, 'auth') ?? preset?.auth ?? 'api-key', metadataVersion: 1, timeoutMs: numberOption(options, 'timeout-ms', preset?.timeoutMs ?? 60000), streamUsage: options['stream-usage'] === true || preset?.streamUsage });
        output(app, app.registry.add(config), !!options.json);
      } else if (action === 'show') output(app, app.registry.get(argument ?? fail()), !!options.json);
      else if (action === 'remove') { app.registry.remove(argument ?? fail()); output(app, 'Provider removed.'); }
      else if (action === 'test') output(app, await progress('Testing connection', () => check(app, account(), controller.signal, !!options.generate)), !!options.json);
      else fail();
    } else if (group === 'auth') {
      if (action === 'login') await login(app, options, controller.signal);
      else if (action === 'list') output(app, accountView(app), !!options.json);
      else if (action === 'methods') output(app, { implemented: ['API key in OS keyring', 'Explicit environment variable reference', 'No authentication for configured local/public endpoints'], unsupportedRawSubscriptionAuth: ['ChatGPT/Codex', 'Claude subscription', 'Gemini CLI subscription', 'GitHub Copilot', 'Qwen Code subscription'], alternative: 'Use API credentials. Official delegated CLIs/SDKs require separate Hannes permission mediation; not implemented.' }, !!options.json);
      else if (action === 'status') {
        const a = account(); const present = a.status !== 'logged-out' && (a.credential.kind === 'none' || !!await app.vault.get(a.credential));
        output(app, { ...accountView(app).find(x => x.id === a.id), credentialAvailable: present, note: 'Stored validation is historical; providers test checks connectivity now.' }, !!options.json);
      } else if (action === 'logout') { await app.accounts.logout(account().id); output(app, 'Logged out locally. Revoke API keys in the provider console; environment values are not deleted from your shell.'); }
      else fail();
    } else if (group === 'accounts') {
      if (action === 'list') output(app, accountView(app), !!options.json);
      else if (action === 'use') output(app, { active: app.accounts.use(argument ?? str(options, 'account') ?? fail()).id }, !!options.json);
      else if (action === 'remove') { await app.accounts.logout(argument ?? str(options, 'account') ?? fail(), true); output(app, 'Account removed; local credentials deleted. Remote keys require console revocation.'); }
      else if (action === 'rename') { app.accounts.rename(argument ?? fail(), str(options, 'alias') ?? fail()); output(app, 'Account renamed.'); }
      else fail();
    } else if (group === 'models') {
      const a = account(); const catalog = app.catalog(a);
      if (action === 'add') output(app, catalog.manual(argument ?? str(options, 'model') ?? fail()), !!options.json);
      else if (action === 'sync-metadata') {
        const metadata = await progress('Fetching advisory metadata', () => fetchModelsDev(controller.signal));
        catalog.enrichModelsDev(metadata); output(app, 'Advisory metadata updated; model capabilities remain unverified.');
      } else {
        const result = options.offline ? { models: catalog.cached(), stale: true, warning: 'Offline cache; availability unverified.' } : await progress('Discovering models', () => catalog.discover(controller.signal));
        let models = action === 'search' ? catalog.search(argument ?? '', result.models) : result.models;
        const capability = str(options, 'capability');
        if (capability) { if (!['text', 'tools', 'streaming', 'vision', 'reasoning'].includes(capability)) fail(); models = models.filter(m => m.capabilities[capability as keyof ModelInfo['capabilities']] === 'supported'); }
        if (action === 'list' || action === 'search') output(app, { ...result, models }, !!options.json);
        else if (action === 'info' || action === 'select') {
          const id = argument ?? str(options, 'model') ?? (process.stdin.isTTY ? await ask('Model ID') : fail()); const model = models.find(m => m.id === id); if (!model) throw new HannesError('NOT_FOUND');
          output(app, action === 'select' ? app.router.select(a, model, options.project ? resolve('.') : undefined) : model, !!options.json);
        } else fail();
      }
    } else if (group === 'model' && action === 'doctor') {
      const a = account(); const selected = app.settings.read().selection;
      output(app, { selected, account: a.alias, protocol: app.registry.get(a.providerId).protocol, check: await progress('Diagnosing connection', () => check(app, a, controller.signal, !!options.generate)), fallback: 'disabled', tools: 'disabled', subscriptionAuth: 'not-implemented' }, !!options.json);
    } else if (!group || group === 'chat' || group === 'run') {
      await chat(app, options, controller.signal, group === 'run');
    } else fail();
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); app.db.close(); }
}
main().catch(e => {
  const safe = e instanceof HannesError ? e : new HannesError('INVALID_INPUT');
  process.stderr.write(JSON.stringify(safe) + '\n'); process.exitCode = safe.code === 'CANCELLED' ? 130 : 1;
});
