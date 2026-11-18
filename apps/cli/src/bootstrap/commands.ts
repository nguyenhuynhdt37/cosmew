import {
  FutrynError,
  MODE_FOR_APPROVAL_POLICY,
  type ApprovalPolicy,
  type PermissionMode,
  type SandboxModeSetting,
} from '@futryn/contracts';
import {UnsupportedRuntime, commandBackendFromEnv, platformCommandRuntime, type CommandRuntime} from '@futryn/tools';

type Env = Record<string, string | undefined>;
/** Permission defaults from the user-level config (ADR 0055); the environment and CLI flags override them. */
export interface PermissionDefaults {
  sandboxMode?: SandboxModeSetting;
  approvalPolicy?: ApprovalPolicy;
  networkAccess?: boolean;
}

/**
 * Codex approval policy (ADR 0040): FUTRYN_APPROVAL_POLICY = untrusted | on-request (default) | never,
 * else the config `approval_policy`. The legacy FUTRYN_SANDBOX_ESCALATION=never means `never`. An
 * invalid environment value fails closed to `untrusted`.
 */
export function approvalPolicyFromEnv(env: Env = process.env, config: PermissionDefaults = {}): ApprovalPolicy {
  const value = env.FUTRYN_APPROVAL_POLICY;
  if (value === undefined || value === '') {
    if (config.approvalPolicy) return config.approvalPolicy;
    return env.FUTRYN_SANDBOX_ESCALATION !== undefined && env.FUTRYN_SANDBOX_ESCALATION !== 'on-request'
      ? 'never'
      : 'on-request';
  }
  return value === 'on-request' || value === 'never' ? value : 'untrusted';
}

/** The permission mode a session starts in for the configured approval policy. */
export function permissionModeFromEnv(env: Env = process.env, config: PermissionDefaults = {}): PermissionMode {
  return MODE_FOR_APPROVAL_POLICY[approvalPolicyFromEnv(env, config)];
}

/** `FUTRYN_SANDBOX_NETWORK`: 1/true opens the network for sandboxed commands, 0/false closes it; else the config decides. */
function networkFromEnv(env: Env, config: PermissionDefaults): boolean {
  const value = env.FUTRYN_SANDBOX_NETWORK?.trim().toLowerCase();
  if (value === undefined || value === '') return config.networkAccess === true;
  return value === '1' || value === 'true';
}

/**
 * Configured command sandbox (ADR 0034/0055): FUTRYN_SANDBOX_MODE (else config `sandbox_mode`, else
 * workspace-write), FUTRYN_SANDBOX_NETWORK (else config `network_access`) and FUTRYN_SANDBOX_ESCALATION.
 * An unknown mode fails closed to read-only.
 */
export function sandboxSettingsFromEnv(
  env: Env = process.env,
  config: PermissionDefaults = {},
): {
  mode: SandboxModeSetting;
  escalation: 'on-request' | 'never';
  network: boolean;
} {
  const mode = env.FUTRYN_SANDBOX_MODE || config.sandboxMode || 'workspace-write';
  const escalation = env.FUTRYN_SANDBOX_ESCALATION ?? 'on-request';
  return {
    mode: mode === 'workspace-write' || mode === 'danger-full-access' ? mode : 'read-only',
    escalation: escalation === 'on-request' && approvalPolicyFromEnv(env, config) !== 'never' ? 'on-request' : 'never',
    network: networkFromEnv(env, config),
  };
}

/**
 * The command runtime for this host (ADR 0035): the native OS sandbox by default, Docker only when
 * selected, nothing when disabled. Selecting a backend grants nothing; availability still requires
 * the runtime's real self-test.
 */
export function createCommandRuntime(workspaceRoot: string, stateDirectory: string, env = process.env): CommandRuntime {
  const backend = commandBackendFromEnv(env.FUTRYN_COMMAND_BACKEND);
  if (backend === 'none') return new UnsupportedRuntime('Commands are disabled (FUTRYN_COMMAND_BACKEND).');
  return platformCommandRuntime({
    workspaceRoot,
    stateDirectory,
    backend,
    hideSecrets: env.FUTRYN_SANDBOX_HIDE_SECRETS === '1',
  });
}

/** Owned command runtimes; shutdown closes admission once and settles each runtime exactly once. */
export class CommandRuntimes {
  private readonly owned = new Set<CommandRuntime>();
  private shutdownPromise?: Promise<void>;

  get closed(): boolean {
    return this.shutdownPromise !== undefined;
  }

  add(runtime: CommandRuntime): void {
    this.owned.add(runtime);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const owned = [...this.owned];
    return (this.shutdownPromise = (async () => {
      try {
        const results = await Promise.allSettled(
          owned.map(runtime => Promise.resolve().then(() => runtime.shutdown?.())),
        );
        if (results.some(result => result.status === 'rejected')) throw new FutrynError('TRANSPORT');
      } finally {
        for (const runtime of owned) this.owned.delete(runtime);
      }
    })());
  }
}
