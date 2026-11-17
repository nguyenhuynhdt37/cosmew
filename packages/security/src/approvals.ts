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
 * Futryn is stricter than Codex (plan W1 and two security reviews, 2026-11-17): a script that cannot
 * be parsed, a word whose runtime value is not its spelling, a shell fed from a pipe, file or
 * non-literal heredoc, an unknown shell or wrapper option, or a program name that cannot be known
 * statically (`$cmd`, `eval`) is `uncertain` and prompts under `untrusted`/`on-request`.
 */

export {decideApproval, type ApprovalPolicy};

/** Codex `MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`. */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

/** Where a command's standard input comes from, when the script says so. */
export interface ShellInput {
  kind: 'pipe' | 'file' | 'heredoc' | 'herestring';
  /** The literal text fed to the command (quoted or expansion-free heredoc, literal herestring). */
  body?: string;
}

/** Literal view of a shell script, produced by the tree-sitter parser in `@futryn/tools`. */
export interface ShellAnalysis {
  /** Statically known words of every command node, in source order. */
  commands: string[][];
  /** Standard-input sources of each command (same order as `commands`); absent means none. */
  inputs?: (ShellInput[] | undefined)[];
  /** Parse error, substitution, non-literal word, dynamic command name or `eval`. */
  uncertain: boolean;
}

/** Parses a nested script (`bash -c '…'`, a heredoc body, a trap action); null when it cannot be parsed. */
export type ShellParser = (script: string) => ShellAnalysis | null;

export type DangerousCommandMatch = 'forced-rm' | 'other';

export interface CommandClassification {
  dangerous: DangerousCommandMatch | null;
  uncertain: boolean;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const basename = (word: string) => word.split('/').filter(Boolean).at(-1) ?? '';
const programOf = (argv: string[]) => (argv[0] === undefined ? '' : basename(argv[0]));

function rmForces(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--force') return true;
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('f')) return true;
  }
  return false;
}

/** Long shell options that take no argument; any other long option is unverifiable. */
const SHELL_LONG_FLAGS = new Set([
  '--norc',
  '--noprofile',
  '--login',
  '--posix',
  '--restricted',
  '--verbose',
  '--noediting',
]);
const SHELL_LONG_WITH_VALUE = new Set(['--rcfile', '--init-file']);

export interface ShellInvocation {
  /** `-c` in any short-option cluster: the first operand is the script. */
  commandString: boolean;
  script: string | undefined;
  /** Operands after the script (`$0`, `$1`, …) or after a script file. */
  positional: string[];
  /** An unknown long option: what the shell does is not known. */
  unknownOption: boolean;
}

/** Parse `sh/bash/zsh/dash/ksh [options] [operands]`; null when `argv` is not a shell. */
export function parseShellInvocation(argv: string[]): ShellInvocation | null {
  if (!SHELLS.has(programOf(argv))) return null;
  let commandString = false;
  let unknownOption = false;
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--' || arg === '-') {
      index++;
      break;
    }
    if (!/^[-+]/.test(arg)) break;
    if (arg.startsWith('--')) {
      if (SHELL_LONG_WITH_VALUE.has(arg)) index++;
      else if (!SHELL_LONG_FLAGS.has(arg)) unknownOption = true;
    } else {
      if (arg.slice(1).includes('c')) commandString = true;
      // `-o option`, `+o option`, `-O shopt`, `+O shopt` consume the next word.
      if (/[oO]$/.test(arg)) index++;
    }
    index++;
  }
  return {commandString, script: argv[index], positional: argv.slice(index + 1), unknownOption};
}

/**
 * Transparent wrappers (`sudo`, `env`, `exec`, `command`, `nohup`, `timeout`, `nice`) → the command
 * they run. `uncertain` when an option is unknown or turns the wrapper into a shell (`sudo -s`,
 * `env -S`); `argv` empty when the wrapper runs nothing (`command -v x`).
 */
function unwrap(argv: string[]): {argv: string[]; uncertain: boolean} | null {
  const name = programOf(argv);
  const skip = (valueOptions: Set<string>, onFlag?: (flag: string) => boolean | void) => {
    let index = 1;
    let uncertain = false;
    while (index < argv.length) {
      const arg = argv[index]!;
      if (arg === '--') return {argv: argv.slice(index + 1), uncertain};
      if (!arg.startsWith('-') || arg === '-') break;
      if (onFlag?.(arg)) uncertain = true;
      if (valueOptions.has(arg)) index++;
      index++;
    }
    return {argv: argv.slice(index), uncertain};
  };
  switch (name) {
    case 'sudo':
      // `-s`/`-i` run a shell reading stdin; `-e` is sudoedit.
      return skip(new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R']), flag =>
        flag.startsWith('--') ? !flag.includes('=') : /[sie]/.test(flag.slice(1)),
      );
    case 'env': {
      let index = 1;
      let uncertain = false;
      while (index < argv.length) {
        const arg = argv[index]!;
        if (arg === '--') {
          index++;
          break;
        }
        const eq = arg.indexOf('=');
        if (eq > 0 && !arg.startsWith('-')) {
          index++;
          continue;
        }
        if (!arg.startsWith('-')) break;
        if (arg === '-S' || arg.startsWith('--split-string') || arg.startsWith('-S')) uncertain = true;
        if (arg === '-u' || arg === '-C' || arg === '--unset' || arg === '--chdir') index++;
        index++;
      }
      return {argv: argv.slice(index), uncertain};
    }
    case 'exec':
      return skip(new Set(['-a']));
    case 'command': {
      const result = skip(new Set());
      // `command -v/-V x` only describes x.
      if (argv.slice(1, argv.length - result.argv.length).some(a => /^-[a-zA-Z]*[vV]/.test(a)))
        return {argv: [], uncertain: false};
      return result;
    }
    case 'nohup':
      return skip(new Set());
    case 'nice':
      return skip(new Set(['-n']));
    case 'timeout': {
      const result = skip(new Set(['-s', '-k']));
      // The first operand is the duration.
      return {argv: result.argv.slice(1), uncertain: result.uncertain};
    }
    default:
      return null;
  }
}

function merge(a: CommandClassification, b: CommandClassification): CommandClassification {
  return {dangerous: a.dangerous ?? b.dangerous, uncertain: a.uncertain || b.uncertain};
}

/** Classify one command (its literal argv and stdin sources). */
function inspect(
  argv: string[],
  inputs: ShellInput[] | undefined,
  parse: ShellParser,
  depth: number,
): CommandClassification {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return {dangerous: 'other', uncertain: true};
  const name = programOf(argv);
  if (name === 'rm' && rmForces(argv.slice(1))) return {dangerous: 'forced-rm', uncertain: false};
  if (name === 'trap') {
    const action = argv[1] === '--' ? argv[2] : argv[1];
    if (action === undefined || action.startsWith('-')) return {dangerous: null, uncertain: false};
    return script(action, parse, depth + 1);
  }
  const wrapped = unwrap(argv);
  if (wrapped) {
    const inner = wrapped.argv.length
      ? inspect(wrapped.argv, inputs, parse, depth + 1)
      : {dangerous: null, uncertain: false};
    return merge(inner, {dangerous: null, uncertain: wrapped.uncertain});
  }
  const shell = parseShellInvocation(argv);
  if (!shell) return {dangerous: null, uncertain: false};
  let result: CommandClassification = {dangerous: null, uncertain: shell.unknownOption};
  if (shell.commandString) {
    result = merge(
      result,
      shell.script === undefined ? {dangerous: null, uncertain: true} : script(shell.script, parse, depth + 1),
    );
    // `bash -c '"$@"' _ rm -rf /` runs its positional arguments.
    if (shell.positional.length > 1)
      result = merge(inspect(shell.positional.slice(1), undefined, parse, depth + 1), {
        dangerous: null,
        uncertain: true,
      });
    return result;
  }
  // A shell reading its script from stdin: only a literal heredoc/herestring body can be checked.
  for (const input of inputs ?? [])
    result = merge(
      result,
      input.body === undefined ? {dangerous: null, uncertain: true} : script(input.body, parse, depth + 1),
    );
  return result;
}

function script(text: string, parse: ShellParser, depth: number): CommandClassification {
  if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) return {dangerous: 'other', uncertain: true};
  const analysis = parse(text);
  if (!analysis) return {dangerous: null, uncertain: true};
  let result: CommandClassification = {dangerous: null, uncertain: analysis.uncertain};
  analysis.commands.forEach((command, i) => {
    result = merge(result, inspect(command, analysis.inputs?.[i], parse, depth));
  });
  return result;
}

/** Codex `dangerous_command_match` for one argv. */
export function dangerousCommandMatch(argv: string[], parse: ShellParser, depth = 0): DangerousCommandMatch | null {
  return inspect(argv, undefined, parse, depth).dangerous;
}

/**
 * Classify a top-level command line. A null analysis (parser unavailable or failed) is uncertain:
 * fail closed, never silently treat an unverified command as ordinary.
 */
export function classifyCommand(analysis: ShellAnalysis | null, parse: ShellParser): CommandClassification {
  if (!analysis) return {dangerous: null, uncertain: true};
  let result: CommandClassification = {dangerous: null, uncertain: analysis.uncertain};
  analysis.commands.forEach((command, i) => {
    result = merge(result, inspect(command, analysis.inputs?.[i], parse, 0));
  });
  return result;
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
  'stdin-input-approval-required': 'stdin',
  'stdin-policy-drift': 'escalation',
  'stdin-retained-escalation': 'network',
  'request-permissions': 'escalation',
};
