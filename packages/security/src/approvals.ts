import {decideApproval, type ApprovalPolicy, type PermissionKind} from '@futryn/contracts';

/**
 * Command classification for the approval policy (ADR 0040), ported from Codex at
 * openai/codex 090be4df0724cdef5758e6a0934ba557af8b6bbe (read 2026-11-17):
 * - `core/src/exec_policy.rs` `commands_for_exec_policy`: a script that parses as plain commands
 *   (`try_parse_word_only_commands_sequence`) is judged per sub-command; anything else is one
 *   opaque command;
 * - `shell-command/src/command_safety/is_dangerous_command.rs`: `rm` with force, through `sudo`,
 *   `env`, a `trap` action and the literal commands of a `bash|zsh|sh -c|-lc` script.
 *
 * The dangerous check is a best-effort guard, as in Codex, NOT a security boundary: the boundary
 * is the sandbox (workspace-write, `.git` read-only, Futryn state denied, home hidden, no network).
 */

export {decideApproval, type ApprovalPolicy};

/** Codex `MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`. */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

/** Tree-sitter parsers supplied by `@futryn/tools` (Codex `bash.rs`); null = cannot parse. */
export interface ShellParsers {
  /** `try_parse_word_only_commands_sequence`: allowlist; null when anything else appears. */
  plain(script: string): string[][] | null;
  /** `parse_shell_lc_literal_commands` on a script: literal words of every command node. */
  literal(script: string): string[][] | null;
}

export type DangerousCommandMatch = 'forced-rm' | 'other';

const basename = (word: string) => word.split('/').filter(Boolean).at(-1) ?? '';

/** Codex `extract_bash_command`: exactly `[bash|zsh|sh, -c|-lc, script]`. */
export function extractShellScript(argv: string[]): string | null {
  if (argv.length !== 3) return null;
  const [shell, flag, script] = argv as [string, string, string];
  if (flag !== '-c' && flag !== '-lc') return null;
  return ['bash', 'zsh', 'sh'].includes(basename(shell)) ? script : null;
}

/** Codex `rm_args_include_force_option`. */
function rmForces(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--force') return true;
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('f')) return true;
  }
  return false;
}

/** Codex `dangerous_command_match_with_depth` (POSIX). */
export function dangerousCommandMatch(argv: string[], parsers: ShellParsers, depth = 0): DangerousCommandMatch | null {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return 'other';
  const name = argv[0] === undefined ? '' : basename(argv[0]);
  if (name === 'rm' && rmForces(argv.slice(1))) return 'forced-rm';
  if (name === 'sudo') return dangerousCommandMatch(argv.slice(1), parsers, depth + 1);
  if (name === 'env') {
    let index = 1;
    while (index < argv.length) {
      const arg = argv[index]!;
      if (arg === '--') {
        index++;
        break;
      }
      const eq = arg.indexOf('=');
      if (arg === '-i' || arg === '--ignore-environment' || (eq > 0 && !arg.startsWith('-'))) {
        index++;
        continue;
      }
      break;
    }
    return dangerousCommandMatch(argv.slice(index), parsers, depth + 1);
  }
  if (name === 'trap') {
    const action = argv[1] === '--' ? argv[2] : argv[1];
    if (action === undefined || action.startsWith('-')) return null;
    return dangerousCommandMatch(['sh', '-c', action], parsers, depth + 1);
  }
  // Any literal command inside a `bash -lc` script, including control flow and substitutions.
  const script = extractShellScript(argv);
  if (script !== null) {
    for (const command of parsers.literal(script) ?? []) {
      const match = dangerousCommandMatch(command, parsers, depth + 1);
      if (match) return match;
    }
  }
  return null;
}

export interface CommandClassification {
  /**
   * The parsed sub-commands (Codex `commands_for_exec_policy`), or null when the script is
   * unparsed: then it is one opaque command that no allow rule can match.
   */
  commands: string[][] | null;
  dangerous: DangerousCommandMatch | null;
  /** The parser could not load: nothing was checked (fail closed). */
  parserUnavailable?: boolean;
}

/**
 * Classify the script `exec_command` runs as `<shell> -c <script>`. A plain script is split into
 * sub-commands; a single `bash|zsh|sh -c|-lc <script>` sub-command is unwrapped the same way, as
 * Codex parses `bash -lc` invocations. Every sub-command (or the opaque `<shell> -c <script>`) goes
 * through the dangerous heuristic.
 */
export function classifyCommand(
  script: string,
  shell: string,
  parsers: ShellParsers,
  ready = true,
): CommandClassification {
  if (!ready) return {commands: null, dangerous: null, parserUnavailable: true};
  let commands = parsers.plain(script);
  if (commands && commands.length === 1) {
    const inner = extractShellScript(commands[0]!);
    // Codex parses `bash -lc <script>` only when the script is plain; otherwise it stays opaque.
    if (inner !== null) commands = parsers.plain(inner);
  }
  if (commands && !commands.length) commands = null;
  const judged = commands ?? [[shell, '-c', script]];
  let dangerous: DangerousCommandMatch | null = null;
  for (const command of judged) dangerous ??= dangerousCommandMatch(command, parsers);
  return {commands, dangerous};
}

/** A sub-command as text for project rules (`Bash(npm test:*)`); quoted when needed. */
export function commandText(argv: string[]): string {
  return argv.map(word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Permission kind for a policy reason, so every tool shares one approval table. */
export const APPROVAL_KIND_FOR_REASON: Record<string, PermissionKind> = {
  'secret-file': 'secret',
  'workspace-patch': 'edit',
  'outside-writable-roots': 'escalation',
  'process-execute': 'execute',
  'dangerous-command': 'dangerous',
  'shell-parser-unavailable': 'dangerous',
  'network-escalation': 'network',
  'stdin-input-approval-required': 'stdin',
  'stdin-policy-drift': 'escalation',
  'stdin-retained-escalation': 'network',
  'request-permissions': 'escalation',
};
