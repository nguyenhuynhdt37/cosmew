import {realpathSync} from 'node:fs';
import type {PermissionKind} from '@cosmew/contracts';

/**
 * Command classification for the approval policy (ADR 0040), ported from Codex at
 * openai/codex 090be4df0724cdef5758e6a0934ba557af8b6bbe (read 2026-11-17):
 * - `core/src/exec_policy.rs` `commands_for_exec_policy`: a script that parses as plain commands
 *   (`try_parse_word_only_commands_sequence`) is judged per sub-command; anything else is one
 *   opaque command;
 * - `shell-command/src/command_safety/is_dangerous_command.rs`: `rm` with force, through `sudo`,
 *   `env`, a `trap` action and the literal commands of a `bash|zsh|sh -c|-lc` script.
 *
 * The dangerous check is a best-effort display hint, as in Codex, NOT a security boundary: the
 * boundary is the sandbox (writes only in the working directory, `.git` read-only, Cosmew state and
 * credential directories denied, network only through the domain-filtering proxy).
 */

/** Codex `MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`. */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

/** Tree-sitter parsers supplied by `@cosmew/tools` (Codex `bash.rs`); null = cannot parse. */
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
  const wrapped = unwrapPlainWrapper(argv);
  if (wrapped === null) return 'other';
  if (wrapped !== undefined) return wrapped.length ? dangerousCommandMatch(wrapped, parsers, depth + 1) : null;
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

/** System directories a shell named by absolute path must resolve into to be unwrapped. */
export const TRUSTED_SHELL_DIRECTORIES = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'] as const;

/**
 * Cosmew deviation from Codex (`shell_detect.rs:39` matches the file stem, so `./bash` counts): a
 * `-c` script is unwrapped for project rules only when the shell is the bare name `bash|zsh|sh`
 * or an absolute path whose real path is a `bash|zsh|sh` in a system directory outside the
 * workspace. A repository-planted `./bash` stays one opaque sub-command, so `Bash(npm test:*)`
 * never covers `./bash -lc "npm test"`.
 */
export function trustedShell(word: string, workspaceRoot?: string): boolean {
  if (['bash', 'zsh', 'sh'].includes(word)) return true;
  if (!word.startsWith('/')) return false;
  let real: string;
  try {
    real = realpathSync.native(word);
  } catch {
    return false;
  }
  if (workspaceRoot && (real === workspaceRoot || real.startsWith(workspaceRoot.replace(/\/+$/, '') + '/')))
    return false;
  const directory = real.slice(0, real.lastIndexOf('/'));
  // Symlinks such as /bin/sh → dash resolve to another shell: accept any system shell binary.
  return (
    (TRUSTED_SHELL_DIRECTORIES as readonly string[]).includes(directory) &&
    ['bash', 'zsh', 'sh', 'dash'].includes(basename(real))
  );
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

/** A single allowlisted wrapper grammar shared by inspection and ambiguity checks. */
function unwrapPlainWrapper(argv: string[]): string[] | null | undefined {
  const name = basename(argv[0] ?? '');
  let offset: number | undefined;
  if (name === 'sudo') {
    offset = 1;
    while (offset < argv.length) {
      const word = argv[offset]!;
      if (word === '--') {
        offset++;
        break;
      }
      if (word === '-u' || word === '-g') {
        if (!argv[offset + 1]) return null;
        offset += 2;
        continue;
      }
      if (word.startsWith('-')) return null;
      break;
    }
  } else if (name === 'nohup' || name === 'exec' || name === 'command') {
    if (name === 'command' && (argv[1] === '-v' || argv[1] === '-V')) return [];
    offset = argv[1] === '--' ? 2 : 1;
    if (argv[offset]?.startsWith('-')) return null;
  } else if (name === 'env') {
    offset = 1;
    while (offset < argv.length) {
      const word = argv[offset]!;
      if (word === '--') {
        offset++;
        break;
      }
      if (word === '-u') {
        if (!argv[offset + 1]) return null;
        offset += 2;
        continue;
      }
      if (
        word === '-i' ||
        word === '--ignore-environment' ||
        word.startsWith('--unset=') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)
      ) {
        offset++;
        continue;
      }
      if (word.startsWith('-')) return null;
      break;
    }
  } else if (name === 'nice') {
    offset = 1;
    if (argv[offset] === '-n') {
      if (!/^[+-]?\d+$/.test(argv[offset + 1] ?? '')) return null;
      offset += 2;
    } else if (argv[offset]?.startsWith('-')) return null;
  } else if (name === 'timeout') {
    offset = 1;
    while (offset < argv.length) {
      const word = argv[offset]!;
      if (word === '--') {
        offset++;
        break;
      }
      if (word === '--foreground' || word === '--preserve-status') {
        offset++;
        continue;
      }
      if (word === '-k' || word === '-s' || word === '--kill-after' || word === '--signal') {
        if (!argv[offset + 1]) return null;
        offset += 2;
        continue;
      }
      if (word.startsWith('-')) return null;
      break;
    }
    if (!/^\d+(?:\.\d+)?[smhd]?$/.test(argv[offset] ?? '')) return null;
    offset++;
  }
  return offset === undefined ? undefined : offset < argv.length ? argv.slice(offset) : null;
}

const SHELL_PROGRAMS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish']);
/** Unknown wrapper/interpreter forms must not be mistaken for a checked plain command. */
function ambiguousCommand(
  argv: string[],
  parsers: ShellParsers,
  workspaceRoot: string | undefined,
  depth = 0,
): boolean {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH || !argv.length) return true;
  const name = basename(argv[0]!);
  if (SHELL_PROGRAMS.has(name)) {
    if (!trustedShell(argv[0]!, workspaceRoot)) return true;
    const script = extractShellScript(argv);
    if (script === null) return true;
    const nested = parsers.plain(script);
    return !nested || nested.some(command => ambiguousCommand(command, parsers, workspaceRoot, depth + 1));
  }
  if (['eval', 'source', '.', 'xargs'].includes(name)) return true;
  if (name === 'trap') {
    const action = argv[1] === '--' ? argv[2] : argv[1];
    if (action === undefined || action.startsWith('-')) return true;
    const parsed = parsers.plain(action);
    return !parsed || parsed.some(command => ambiguousCommand(command, parsers, workspaceRoot, depth + 1));
  }
  const wrapped = unwrapPlainWrapper(argv);
  return (
    wrapped === null ||
    (wrapped !== undefined && wrapped.length > 0 && ambiguousCommand(wrapped, parsers, workspaceRoot, depth + 1))
  );
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
  workspaceRoot?: string,
): CommandClassification {
  if (!ready) return {commands: null, dangerous: null, parserUnavailable: true};
  let commands = parsers.plain(script);
  if (commands && commands.length === 1 && trustedShell(commands[0]![0] ?? '', workspaceRoot)) {
    const inner = extractShellScript(commands[0]!);
    // Codex parses `bash -lc <script>` only when the script is plain; otherwise it stays opaque.
    if (inner !== null) commands = parsers.plain(inner);
  }
  if (commands && (!commands.length || commands.some(command => ambiguousCommand(command, parsers, workspaceRoot))))
    commands = null;
  const judged = commands ?? [[shell, '-c', script]];
  let dangerous: DangerousCommandMatch | null = null;
  for (const command of judged) dangerous ??= dangerousCommandMatch(command, parsers);
  if (commands === null && !dangerous) dangerous = 'other';
  return {commands, dangerous};
}

/** A sub-command as text for project rules (`Bash(npm test:*)`); quoted when needed. */
export function commandText(argv: string[]): string {
  return argv.map(word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Permission kind for a policy reason, so every tool shares one mode table (ADR 0061). */
export const APPROVAL_KIND_FOR_REASON: Record<string, PermissionKind> = {
  'secret-file': 'secret',
  'workspace-patch': 'edit',
  'outside-writable-roots': 'edit',
  'sandboxed-command': 'sandboxed-command',
  'process-execute': 'command',
  'unsandboxed-session': 'command',
  'excluded-command': 'command',
  'unsandboxed-escalation': 'escalation',
  'stdin-sandboxed': 'sandboxed-command',
  'stdin-process': 'command',
  'stdin-unsandboxed': 'command',
};
