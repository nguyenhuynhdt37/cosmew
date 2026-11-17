import {FutrynError, MODE_FOR_APPROVAL_POLICY, type ApprovalPolicy, type PermissionMode} from '@futryn/contracts';
import {UnsupportedRuntime, commandBackendFromEnv, platformCommandRuntime, type CommandRuntime} from '@futryn/tools';

/**
 * Codex approval policy (ADR 0040): FUTRYN_APPROVAL_POLICY = untrusted | on-request (default) | never.
 * The legacy FUTRYN_SANDBOX_ESCALATION=never means `never`. An invalid value fails closed to `untrusted`.
 */
export function approvalPolicyFromEnv(env: Record<string, string | undefined> = process.env): ApprovalPolicy {
  const value = env.FUTRYN_APPROVAL_POLICY;
  if (value === undefined || value === '')
    return env.FUTRYN_SANDBOX_ESCALATION !== undefined && env.FUTRYN_SANDBOX_ESCALATION !== 'on-request'
      ? 'never'
      : 'on-request';
  return value === 'on-request' || value === 'never' ? value : 'untrusted';
}

/** The permission mode a session starts in for the configured approval policy. */
export function permissionModeFromEnv(env: Record<string, string | undefined> = process.env): PermissionMode {
  return MODE_FOR_APPROVAL_POLICY[approvalPolicyFromEnv(env)];
}

/** Configured command sandbox (ADR 0034): FUTRYN_SANDBOX_MODE and FUTRYN_SANDBOX_ESCALATION. Invalid values fail closed. */
export function sandboxSettingsFromEnv(env: Record<string, string | undefined> = process.env): {
  mode: 'read-only' | 'workspace-write';
  escalation: 'on-request' | 'never';
} {
  const mode = env.FUTRYN_SANDBOX_MODE ?? 'workspace-write';
  const escalation = env.FUTRYN_SANDBOX_ESCALATION ?? 'on-request';
  return {
    mode: mode === 'workspace-write' ? 'workspace-write' : 'read-only',
    escalation: escalation === 'on-request' && approvalPolicyFromEnv(env) !== 'never' ? 'on-request' : 'never',
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
