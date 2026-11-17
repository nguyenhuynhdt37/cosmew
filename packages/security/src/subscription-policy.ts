import {FutrynError, type Provider, type SubscriptionRuntime} from '@futryn/contracts';

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
  codex: {
    runtime: 'codex',
    command: 'codex',
    args: ['app-server'],
    framing: 'lines',
    profileEnv: 'CODEX_HOME',
    credentialFiles: ['auth.json'],
    settingsFiles: {'config.toml': codexConfig},
    installHint: 'Install the official OpenAI Codex CLI (codex).',
  },
};

/** No inherited provider tokens, injected runtimes, hooks, proxies, debug output
 * or auto-approval environment. These are provider-only sessions, not tools. */
export function subscriptionEnvironment(
  recipe: SubscriptionRecipe,
  profile: string,
  environment = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TERM'])
    if (environment[key]) env[key] = environment[key]!;
  env[recipe.profileEnv] = profile;
  env.XDG_CONFIG_HOME = profile + '/xdg-config';
  env.XDG_CACHE_HOME = profile + '/xdg-cache';
  env.NO_COLOR = '1';
  return env;
}
export function authorizeSubscription(provider: Provider): SubscriptionRecipe {
  const runtime = provider.runtime;
  const expected: Record<SubscriptionRuntime, [string, string]> = {
    codex: ['chatgpt', 'https://chatgpt.com'],
  };
  if (
    !runtime ||
    provider.id !== expected[runtime][0] ||
    provider.baseURL !== expected[runtime][1] ||
    provider.auth !== 'api-key'
  )
    throw new FutrynError('POLICY');
  return SUBSCRIPTION_RECIPES[runtime];
}

export function denyRuntimeRequest(method: string): unknown {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')
    return {decision: 'decline'};
  throw new FutrynError('POLICY');
}
