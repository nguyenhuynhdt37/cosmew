import { createHash } from 'node:crypto';
import { HannesError, type Provider, type SubscriptionRuntime } from '@hannes/contracts';

export interface SubscriptionRecipe {
  runtime: SubscriptionRuntime;
  command: string;
  args: string[];
  framing: 'lines' | 'content-length';
  authMethod?: string;
  credentialFiles: readonly string[];
  settingsFiles: Record<string, string>;
  profileEnv: string;
  installHint: string;
  /** Runtime-native tools inside the consented workspace (ADR 0027). Absent: chat-only. */
  workspace?: { args: string[]; settingsFiles: Record<string, string>; env: Record<string, string> };
}
const codexConfig = `cli_auth_credentials_store = "file"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[features]
shell_tool = false
unified_exec = false
code_mode = false
js_repl = false
multi_agent = false
view_image = false
apps = false
plugins = false
[history]
persistence = "none"
`;
/** Grok Build 1.0.77 config keys (bundled user guide 05/22/26, 2026-11-15).
 * A bare `*` deny rule matches every tool, including the read-only tools the
 * CLI otherwise auto-approves; server tools, subagents, memory, plugins and
 * Claude/Codex/Cursor config discovery are off. */
const grokIsolation = `[managed_mcps]
enabled = false
[cli]
auto_update = false
[relay]
enabled = false
[telemetry]
trace_upload = false
[diagnostics]
error_reporting = false
[compat.claude]
agents = false
hooks = false
mcps = false
rules = false
skills = false
[compat.codex]
hooks = false
skills = false
[compat.cursor]
agents = false
hooks = false
mcps = false
rules = false
skills = false
`;
const grokConfig = `disable_web_search = true
[permission]
deny = ["*"]
[features]
backend_tools = false
web_fetch = false
telemetry = "off"
campaigns = false
[subagents]
enabled = false
[memory]
enabled = false
${grokIsolation}`;
/** Native-tool mode (ADR 0027): after workspace consent Grok uses its own tools in the project.
 * Grok auto-approves ordinary reads; edits, commands and the sensitive reads below arrive as ACP
 * permission requests that Hannes answers by the session permission mode. */
const grokWorkspaceConfig = `[permission]
ask = ["Read(**/.env)", "Read(**/.env.*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/id_ed25519*)", "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.config/gcloud/**)", "Read(~/.netrc)", "Read(~/.npmrc)"]
deny = ["Read(~/.hannes/**)", "Edit(~/.hannes/**)", "Edit(**/.git/**)"]
[features]
web_fetch = true
telemetry = "off"
campaigns = false
[sandbox]
profile = "off"
${grokIsolation}`;
/** Native-tool Codex (ADR 0027): shell/edits/web in the consented project; `untrusted` sends every
 * non-trivial command and file change to Hannes for a decision by the permission mode. */
const codexFullConfig = `cli_auth_credentials_store = "file"
sandbox_mode = "danger-full-access"
web_search = "live"
[history]
persistence = "none"
`;
const geminiSettings = (full: boolean) => JSON.stringify({ ...(full ? {} : { tools: { core: [] } }), mcpServers: {}, context: { fileName: [] }, hooksConfig: { enabled: false }, security: { auth: { selectedType: 'oauth-personal' } }, telemetry: { enabled: false } });
const qwenSettings = (full: boolean) => JSON.stringify({ ...(full ? {} : { tools: { core: ['__futryn_no_builtin_tools__'], exclude: ['*'], toolSearch: { enabled: false } }, permissions: { deny: ['*'] } }), mcpServers: {}, disableAllHooks: true, context: { fileName: [] }, security: { auth: { selectedType: 'qwen-oauth' } }, telemetry: { enabled: false } });
export const SUBSCRIPTION_RECIPES: Record<SubscriptionRuntime, SubscriptionRecipe> = {
  codex: { runtime: 'codex', command: 'codex', args: ['app-server'], framing: 'lines', profileEnv: 'CODEX_HOME', credentialFiles: ['auth.json'], settingsFiles: { 'config.toml': codexConfig }, installHint: 'Install the official OpenAI Codex CLI (codex).',
    workspace: { args: ['app-server'], settingsFiles: { 'config.toml': codexFullConfig }, env: {} } },
  copilot: { runtime: 'copilot', command: 'copilot', args: ['--headless', '--stdio', '--no-auto-update', '--disable-builtin-mcps'], framing: 'content-length', profileEnv: 'COPILOT_HOME', credentialFiles: ['config.json'], settingsFiles: {}, installHint: 'Install the official GitHub Copilot CLI (copilot).',
    workspace: { args: ['--headless', '--stdio', '--no-auto-update'], settingsFiles: {}, env: { COPILOT_ALLOW_ALL: 'false' } } },
  'gemini-cli': { runtime: 'gemini-cli', command: 'gemini', args: ['--acp'], framing: 'lines', profileEnv: 'GEMINI_CLI_HOME', authMethod: 'oauth-personal', credentialFiles: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'], settingsFiles: { '.gemini/settings.json': geminiSettings(false) }, installHint: 'Install the official Google Gemini CLI (gemini).',
    workspace: { args: ['--acp'], settingsFiles: { '.gemini/settings.json': geminiSettings(true) }, env: {} } },
  'qwen-code': { runtime: 'qwen-code', command: 'qwen', args: ['--acp'], framing: 'lines', profileEnv: 'QWEN_HOME', authMethod: 'qwen-oauth', credentialFiles: ['oauth_creds.json'], settingsFiles: { 'settings.json': qwenSettings(false) }, installHint: 'Install an official Qwen Code CLI exposing qwen-oauth over ACP (qwen).',
    workspace: { args: ['--acp'], settingsFiles: { 'settings.json': qwenSettings(true) }, env: {} } },
  'grok-build': { runtime: 'grok-build', command: 'grok', args: ['agent', '--no-leader', 'stdio'], framing: 'lines', profileEnv: 'GROK_HOME', authMethod: 'grok.com', credentialFiles: ['auth.json'], settingsFiles: { 'config.toml': grokConfig }, installHint: 'Install the official xAI Grok Build CLI (grok) from https://x.ai/cli.',
    workspace: { args: ['agent', '--no-leader', 'stdio'], settingsFiles: { 'config.toml': grokWorkspaceConfig }, env: { GROK_SANDBOX: 'off' } } },
};

/** No inherited provider tokens, injected runtimes, hooks, proxies, debug output
 * or auto-approval environment. These are provider-only sessions, not tools. */
export function subscriptionEnvironment(recipe: SubscriptionRecipe, profile: string, environment = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TERM']) if (environment[key]) env[key] = environment[key]!;
  env[recipe.profileEnv] = profile;
  // Restore only the account saved inside this private COPILOT_HOME.
  // Disabling auto-login would ignore it. Isolate gh/XDG fallbacks instead.
  env.GH_CONFIG_DIR = profile + '/gh';
  env.XDG_CONFIG_HOME = profile + '/xdg-config';
  env.XDG_CACHE_HOME = profile + '/xdg-cache';
  env.COPILOT_DISABLE_KEYTAR = '1';
  env.COPILOT_AUTO_UPDATE = 'false';
  env.COPILOT_ALLOW_ALL = 'false';
  env.NO_COLOR = '1';
  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = profile + '/empty-system-settings.json';
  env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = profile + '/empty-system-settings.json';
  if (recipe.runtime === 'grok-build') {
    // Grok also scans $HOME (~/.claude, ~/.cursor, rules); keep it inside the profile.
    env.HOME = profile;
    env.GROK_DISABLE_AUTOUPDATER = '1';
    env.GROK_DISABLE_EXPERIMENTS = '1';
    env.GROK_CAMPAIGNS = '0';
    env.DISABLE_ERROR_REPORTING = '1';
  }
  return env;
}
/** Native-tool child environment (ADR 0027): the user's own environment, so project
 * commands see their real HOME/toolchains; only the runtime profile and its update/telemetry
 * switches are pinned, and API keys that would bypass the subscription are dropped. */
export function subscriptionWorkspaceEnvironment(recipe: SubscriptionRecipe, profile: string, environment = process.env): Record<string, string> {
  if (!recipe.workspace) throw new HannesError('POLICY');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined) env[key] = value;
  for (const key of ['XAI_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NODE_OPTIONS']) delete env[key];
  env[recipe.profileEnv] = profile;
  env.NO_COLOR = '1';
  if (recipe.runtime === 'grok-build') { env.GROK_DISABLE_AUTOUPDATER = '1'; env.GROK_DISABLE_EXPERIMENTS = '1'; env.GROK_CAMPAIGNS = '0'; env.DISABLE_ERROR_REPORTING = '1'; }
  // The account still comes only from the private profile, not the user's own CLI login.
  if (recipe.runtime === 'copilot') { env.GH_CONFIG_DIR = profile + '/gh'; env.COPILOT_DISABLE_KEYTAR = '1'; env.COPILOT_AUTO_UPDATE = 'false'; }
  if (recipe.runtime === 'gemini-cli') { env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = profile + '/empty-system-settings.json'; env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = profile + '/empty-system-settings.json'; }
  return { ...env, ...recipe.workspace.env };
}
export function authorizeSubscription(provider: Provider): SubscriptionRecipe {
  const runtime = provider.runtime;
  const expected: Record<SubscriptionRuntime, [string, string]> = {
    codex: ['chatgpt', 'https://chatgpt.com'], copilot: ['github-copilot', 'https://api.githubcopilot.com'],
    'gemini-cli': ['google-subscription', 'https://cloudcode-pa.googleapis.com'], 'qwen-code': ['qwen-subscription', 'https://api.qwen.ai'],
    'grok-build': ['grok-subscription', 'https://api.x.ai'],
  };
  if (!runtime || provider.id !== expected[runtime][0] || provider.baseURL !== expected[runtime][1] || provider.auth !== 'api-key') throw new HannesError('POLICY');
  return SUBSCRIPTION_RECIPES[runtime];
}

export function denyRuntimeRequest(method: string): unknown {
  if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
  if (method === 'permission.request') return { kind: 'denied-by-rules' };
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  throw new HannesError('POLICY');
}

/** A runtime permission request as Hannes shows it (ADR 0027). */
export interface RuntimeApproval {
  kind: 'secret' | 'edit' | 'execute' | 'network' | 'other'; label: string;
  /** SHA-256 of the complete, unclipped request; a session grant binds to exactly this request. */
  fingerprint: string;
  /**
   * The exact, unclipped command/path/URL from a structured field, for project rules (ADR 0028).
   * Null when the request carries only a display title or an oversized value: rules never apply then.
   */
  ruleTarget: string | null;
}
const structured = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 65536 ? value : null;
const fingerprint = (method: string, params: unknown) => createHash('sha256').update(method + '\0' + (JSON.stringify(params) ?? 'null')).digest('hex');
const clip = (value: unknown) => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300) || 'runtime tool';
/** Classify a runtime->client permission request; null means it is not a permission request. */
export function classifyRuntimeApproval(method: string, params: any): RuntimeApproval | null {
  if (method === 'session/request_permission') {
    const call = params?.toolCall ?? {};
    // Runtimes auto-approve ordinary reads; a read that still asks matched a sensitive-path rule.
    const kind = ({ read: 'secret', search: 'secret', edit: 'edit', delete: 'edit', move: 'edit', execute: 'execute', fetch: 'network' } as Record<string, RuntimeApproval['kind']>)[call.kind] ?? 'other';
    // Prefer the raw command/path over a display title so project rules (`Bash(npm test:*)`) can match.
    const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput.command ?? call.rawInput.path ?? call.rawInput.file_path ?? call.rawInput.target_file : undefined;
    return { kind, label: clip(raw ?? call.title ?? call.kind), ruleTarget: kind === 'other' ? null : structured(raw), fingerprint: fingerprint(method, { kind: call.kind, title: call.title, rawInput: call.rawInput, locations: call.locations }) };
  }
  if (method === 'item/commandExecution/requestApproval') return { kind: 'execute', label: clip(params?.command ?? params?.reason), ruleTarget: structured(params?.command), fingerprint: fingerprint(method, params) };
  // Codex sends no paths with a file-change approval, so no Edit rule can vouch for it.
  if (method === 'item/fileChange/requestApproval') return { kind: 'edit', label: clip(params?.reason ?? 'apply file changes'), ruleTarget: null, fingerprint: fingerprint(method, params) };
  if (method === 'permission.request') {
    const request = params?.permissionRequest ?? params ?? {};
    const kind = ({ shell: 'execute', write: 'edit', read: 'secret', url: 'network' } as Record<string, RuntimeApproval['kind']>)[request.kind] ?? 'other';
    return { kind, label: clip(request.fullCommandText ?? request.fileName ?? request.path ?? request.url ?? request.intention ?? request.kind), ruleTarget: kind === 'execute' ? structured(request.fullCommandText) : kind === 'edit' || kind === 'secret' ? structured(request.fileName ?? request.path) : kind === 'network' ? structured(request.url) : null, fingerprint: fingerprint(method, request) };
  }
  return null;
}
/** Protocol answer for a decided runtime permission request. */
export function answerRuntimeApproval(method: string, params: any, allow: boolean): unknown {
  if (method === 'session/request_permission') {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const option = options.find(o => o?.kind === (allow ? 'allow_once' : 'reject_once')) ?? (allow ? options.find(o => o?.kind === 'allow_always') : undefined);
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: allow ? 'accept' : 'decline' };
  if (method === 'permission.request') return allow ? { kind: 'approved' } : { kind: 'denied-by-rules' };
  return denyRuntimeRequest(method);
}
