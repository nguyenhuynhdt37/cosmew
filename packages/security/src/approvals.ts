import {decideApproval, type ApprovalPolicy, type PermissionKind} from '@futryn/contracts';

/**
 * Command classification for the approval policy (ADR 0040).
 *
 * Ported (behavior, not code) from Codex `shell-command/src/command_safety/is_dangerous_command.rs`
 * at openai/codex 090be4df0724cdef5758e6a0934ba557af8b6bbe (read 2026-11-17): an `rm` whose
 * arguments before `--` contain `--force` or a short-flag group with `f` is dangerous, also behind
 * `sudo`, `env [-i] [NAME=value…] [--]`, a `trap` action and a nested `sh/bash/zsh -c|-lc` script.
 * More than 8 nested wrappers fail closed (`MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`).
 *
 * Futryn is stricter than Codex in one place (plan W1): a script that cannot be parsed, or whose
 * command names cannot be known statically (substitution, `eval`, `$cmd`), is `uncertain` and
 * prompts under `untrusted`/`on-request` instead of running silently.
 */

export {decideApproval, type ApprovalPolicy};

/** Codex `MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`. */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

/** Literal view of a shell script, produced by the tree-sitter parser in `@futryn/tools`. */
export interface ShellAnalysis {
  /** Statically known words of every command node, in source order (dynamic words omitted). */
  commands: string[][];
  /** Parse error, substitution, dynamic command name or `eval`: the commands cannot be verified. */
  uncertain: boolean;
}

/** Parses a nested script (`bash -c '…'`, a trap action); null when it cannot be parsed. */
export type ShellParser = (script: string) => ShellAnalysis | null;

export type DangerousCommandMatch = 'forced-rm' | 'other';

const SHELLS = new Set(['bash', 'sh', 'zsh']);
const basename = (word: string) => word.split('/').filter(Boolean).at(-1) ?? '';

function rmForces(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--force') return true;
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('f')) return true;
  }
  return false;
}

/** Codex `dangerous_command_match` for one argv. */
export function dangerousCommandMatch(argv: string[], parse: ShellParser, depth = 0): DangerousCommandMatch | null {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return 'other';
  const name = argv[0] === undefined ? '' : basename(argv[0]);
  if (name === 'rm' && rmForces(argv.slice(1))) return 'forced-rm';
  if (name === 'sudo') return dangerousCommandMatch(argv.slice(1), parse, depth + 1);
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
    return dangerousCommandMatch(argv.slice(index), parse, depth + 1);
  }
  if (name === 'trap') {
    const action = argv[1] === '--' ? argv[2] : argv[1];
    if (action === undefined || action.startsWith('-')) return null;
    return dangerousScript(action, parse, depth + 1);
  }
  // `bash -lc "script"`: every literal command inside the script is checked.
  if (SHELLS.has(name) && argv.length === 3 && (argv[1] === '-c' || argv[1] === '-lc'))
    return dangerousScript(argv[2]!, parse, depth + 1);
  return null;
}

function dangerousScript(script: string, parse: ShellParser, depth: number): DangerousCommandMatch | null {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return 'other';
  const nested = parse(script);
  if (!nested) return null;
  for (const command of nested.commands) {
    const match = dangerousCommandMatch(command, parse, depth);
    if (match) return match;
  }
  return null;
}

export interface CommandClassification {
  dangerous: DangerousCommandMatch | null;
  uncertain: boolean;
}

/**
 * Classify a top-level command line. A null analysis (parser unavailable or failed) is uncertain:
 * fail closed, never silently treat an unverified command as ordinary.
 */
export function classifyCommand(analysis: ShellAnalysis | null, parse: ShellParser): CommandClassification {
  if (!analysis) return {dangerous: null, uncertain: true};
  for (const command of analysis.commands) {
    const dangerous = dangerousCommandMatch(command, parse);
    if (dangerous) return {dangerous, uncertain: analysis.uncertain};
  }
  // A nested `bash -c` script that is itself unverifiable makes the whole line uncertain.
  const nestedUncertain = analysis.commands.some(command => {
    const name = command[0] === undefined ? '' : basename(command[0]);
    if (!SHELLS.has(name) || !(command[1] === '-c' || command[1] === '-lc')) return false;
    const nested = command[2] === undefined ? null : parse(command[2]);
    return !nested || nested.uncertain;
  });
  return {dangerous: null, uncertain: analysis.uncertain || nestedUncertain};
}

/** Permission kind for a policy reason, so every tool shares one approval table. */
export const APPROVAL_KIND_FOR_REASON: Record<string, PermissionKind> = {
  'secret-file': 'secret',
  'workspace-patch': 'edit',
  'outside-writable-roots': 'escalation',
  'process-execute': 'execute',
  'unverified-command': 'uncertain',
  'dangerous-command': 'dangerous',
  'network-escalation': 'network',
  'stdin-input': 'stdin',
  'stdin-policy-drift': 'escalation',
  'stdin-retained-escalation': 'network',
  'request-permissions': 'escalation',
};
