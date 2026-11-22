import {parseArgs} from 'node:util';
import {FutrynError, permissionModeSchema, type PermissionMode} from '@cosmew/contracts';
import {splitRuleList} from '@cosmew/security';
import {UnsupportedRuntime, commandBackendFromEnv, platformCommandRuntime, type CommandRuntime} from '@cosmew/tools';

/**
 * Claude Code launch flags shared by the interactive TUI/CLI entry points and `cosmew exec`
 * (`claude --permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`, `--disallowedTools`;
 * ADR 0061). They apply to the launched session only and never touch a settings file.
 */
export const PERMISSION_CLI_OPTIONS = {
  'permission-mode': {type: 'string' as const},
  'dangerously-skip-permissions': {type: 'boolean' as const},
  allowedTools: {type: 'string' as const, multiple: true},
  'allowed-tools': {type: 'string' as const, multiple: true},
  disallowedTools: {type: 'string' as const, multiple: true},
  'disallowed-tools': {type: 'string' as const, multiple: true},
} as const;

export interface LaunchPermissionFlags {
  mode?: PermissionMode;
  /** Rules from `--allowedTools`. */
  allow?: string[];
  /** Rules from `--disallowedTools`. */
  deny?: string[];
}

/** Validate and resolve parsed CLI permission flags (ADR 0061). */
export function resolvePermissionFlags(values: {
  'permission-mode'?: unknown;
  'dangerously-skip-permissions'?: unknown;
  allowedTools?: unknown;
  'allowed-tools'?: unknown;
  disallowedTools?: unknown;
  'disallowed-tools'?: unknown;
}): LaunchPermissionFlags {
  const skip = values['dangerously-skip-permissions'] === true;
  let mode: PermissionMode | undefined;
  if (values['permission-mode'] !== undefined) {
    const parsed = permissionModeSchema.safeParse(values['permission-mode']);
    if (!parsed.success) throw new FutrynError('INVALID_INPUT');
    mode = parsed.data;
  }
  // The skip flag is the bypassPermissions mode; naming another mode as well is a contradiction.
  if (skip && mode !== undefined && mode !== 'bypassPermissions') throw new FutrynError('INVALID_INPUT');
  if (skip) mode = 'bypassPermissions';
  const list = (...inputs: unknown[]) =>
    inputs.flatMap(input =>
      Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [],
    );
  const allow = splitRuleList(list(values.allowedTools, values['allowed-tools']));
  const deny = splitRuleList(list(values.disallowedTools, values['disallowed-tools']));
  if (allow.invalid.length || deny.invalid.length) throw new FutrynError('INVALID_INPUT');
  return {
    ...(mode !== undefined ? {mode} : {}),
    ...(allow.rules.length ? {allow: allow.rules} : {}),
    ...(deny.rules.length ? {deny: deny.rules} : {}),
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
 * The command runtime for this host (ADR 0035, 0062): the OS sandbox, or nothing when disabled.
 * `COSMEW_COMMAND_BACKEND` is canonical; `FUTRYN_COMMAND_BACKEND` and `HANNES_COMMAND_BACKEND` remain fallbacks.
 */
export function createCommandRuntime(
  workspaceRoot: string,
  stateDirectory: string,
  env = process.env,
  skillDirectories: readonly string[] = [],
  readOnlySkillDirectories: readonly string[] = [],
): CommandRuntime {
  const requested = env.COSMEW_COMMAND_BACKEND ?? env.FUTRYN_COMMAND_BACKEND ?? env.HANNES_COMMAND_BACKEND;
  if (requested === 'docker')
    return new UnsupportedRuntime('The Docker command backend was removed (ADR 0062). Unset COSMEW_COMMAND_BACKEND.');
  const backend = commandBackendFromEnv(requested);
  if (backend === 'none') return new UnsupportedRuntime('Commands are disabled (COSMEW_COMMAND_BACKEND).');
  return platformCommandRuntime({
    workspaceRoot,
    stateDirectory,
    backend,
    skillDirectories,
    readOnlySkillDirectories,
    hideSecrets:
      (env.COSMEW_SANDBOX_HIDE_SECRETS ?? env.FUTRYN_SANDBOX_HIDE_SECRETS ?? env.HANNES_SANDBOX_HIDE_SECRETS) === '1',
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
