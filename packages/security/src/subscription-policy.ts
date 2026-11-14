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
export const SUBSCRIPTION_RECIPES: Record<SubscriptionRuntime, SubscriptionRecipe> = {
  codex: { runtime: 'codex', command: 'codex', args: ['app-server'], framing: 'lines', profileEnv: 'CODEX_HOME', credentialFiles: ['auth.json'], settingsFiles: { 'config.toml': codexConfig }, installHint: 'Install the official OpenAI Codex CLI (codex).' },
  copilot: { runtime: 'copilot', command: 'copilot', args: ['--headless', '--stdio', '--no-auto-update', '--disable-builtin-mcps'], framing: 'content-length', profileEnv: 'COPILOT_HOME', credentialFiles: ['config.json'], settingsFiles: {}, installHint: 'Install the official GitHub Copilot CLI (copilot).' },
  'gemini-cli': { runtime: 'gemini-cli', command: 'gemini', args: ['--acp'], framing: 'lines', profileEnv: 'GEMINI_CLI_HOME', authMethod: 'oauth-personal', credentialFiles: ['.gemini/oauth_creds.json', '.gemini/google_accounts.json'], settingsFiles: { '.gemini/settings.json': JSON.stringify({ tools: { core: [] }, mcpServers: {}, context: { fileName: [] }, hooksConfig: { enabled: false }, security: { auth: { selectedType: 'oauth-personal' } }, telemetry: { enabled: false } }) }, installHint: 'Install the official Google Gemini CLI (gemini).' },
  'qwen-code': { runtime: 'qwen-code', command: 'qwen', args: ['--acp'], framing: 'lines', profileEnv: 'QWEN_HOME', authMethod: 'qwen-oauth', credentialFiles: ['oauth_creds.json'], settingsFiles: { 'settings.json': JSON.stringify({ tools: { core: ['__futryn_no_builtin_tools__'], exclude: ['*'], toolSearch: { enabled: false } }, permissions: { deny: ['*'] }, mcpServers: {}, disableAllHooks: true, context: { fileName: [] }, security: { auth: { selectedType: 'qwen-oauth' } }, telemetry: { enabled: false } }) }, installHint: 'Install an official Qwen Code CLI exposing qwen-oauth over ACP (qwen).' },
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
  return env;
}
export function authorizeSubscription(provider: Provider): SubscriptionRecipe {
  const runtime = provider.runtime;
  const expected: Record<SubscriptionRuntime, [string, string]> = {
    codex: ['chatgpt', 'https://chatgpt.com'], copilot: ['github-copilot', 'https://api.githubcopilot.com'],
    'gemini-cli': ['google-subscription', 'https://cloudcode-pa.googleapis.com'], 'qwen-code': ['qwen-subscription', 'https://api.qwen.ai'],
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
