import {parseArgs} from 'node:util';
import {
  approvalPolicySchema,
  FutrynError,
  MODE_FOR_APPROVAL_POLICY,
  sandboxModeSchema,
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
 * Codex launch flags shared by interactive TUI/CLI entry points and `fyn exec`
 * (`codex-rs/utils/cli/src/shared_options.rs`, `codex-rs/tui/src/cli.rs`, pinned 090be4df).
 */
export const PERMISSION_CLI_OPTIONS = {
  approval: {type: 'string' as const, short: 'a'},
  'ask-for-approval': {type: 'string' as const},
  sandbox: {type: 'string' as const, short: 's'},
  'full-auto': {type: 'boolean' as const},
  'dangerously-bypass-approvals-and-sandbox': {type: 'boolean' as const},
  yolo: {type: 'boolean' as const},
} as const;

export interface LaunchPermissionFlags {
  sandbox?: SandboxModeSetting;
  approval?: ApprovalPolicy;
}

/** Validate and resolve parsed CLI permission flags with Codex conflict rules (ADR 0055). */
export function resolvePermissionFlags(values: {
  approval?: unknown;
  'ask-for-approval'?: unknown;
  sandbox?: unknown;
  'full-auto'?: unknown;
  'dangerously-bypass-approvals-and-sandbox'?: unknown;
  yolo?: unknown;
}): LaunchPermissionFlags {
  if (values.approval !== undefined && values['ask-for-approval'] !== undefined) {
    throw new FutrynError('INVALID_INPUT');
  }
  const explicitApproval = values.approval ?? values['ask-for-approval'];
  const yolo = values['dangerously-bypass-approvals-and-sandbox'] === true || values.yolo === true;
  const fullAuto = values['full-auto'] === true;
  if ((yolo && fullAuto) || ((yolo || fullAuto) && (values.sandbox !== undefined || explicitApproval !== undefined))) {
    throw new FutrynError('INVALID_INPUT');
  }
  let sandbox: SandboxModeSetting | undefined;
  if (values.sandbox !== undefined) {
    const parsed = sandboxModeSchema.safeParse(values.sandbox);
    if (!parsed.success) throw new FutrynError('INVALID_INPUT');
    sandbox = parsed.data;
  } else if (yolo) {
    sandbox = 'danger-full-access';
  } else if (fullAuto) {
    sandbox = 'workspace-write';
  }
  let approval: ApprovalPolicy | undefined;
  if (explicitApproval !== undefined) {
    const parsed = approvalPolicySchema.safeParse(explicitApproval);
    if (!parsed.success) throw new FutrynError('INVALID_INPUT');
    approval = parsed.data;
  } else if (yolo) {
    approval = 'never';
  } else if (fullAuto) {
    approval = 'on-request';
  }
  return {
    ...(sandbox !== undefined ? {sandbox} : {}),
    ...(approval !== undefined ? {approval} : {}),
  };
}

/** Parse raw CLI arguments containing only shared launch permission flags. */
export function parsePermissionFlags(args: string[]): LaunchPermissionFlags {
  let values: Record<string, unknown>;
  try {
    ({values} = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: PERMISSION_CLI_OPTIONS,
    }));
  } catch {
    throw new FutrynError('INVALID_INPUT');
  }
  return resolvePermissionFlags(values);
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
