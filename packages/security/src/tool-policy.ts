import type {PermissionDecision} from '@futryn/contracts';

/**
 * Built-in read policy for TOOLS1 (ADR 0017). Evaluation order is deny → ask → allow: the first
 * category with a match decides, so no allow can override a deny. There are no user-editable
 * rules in this slice; outside-workspace paths never reach here (the workspace layer denies them).
 */

/**
 * File names whose contents are usually secrets. One table feeds both the read tool (ask) and the
 * command sandbox (always masked, ADR 0022), so the two cannot drift apart. Matching ignores case.
 */
export const SECRET_FILE_RULES: readonly {match: 'exact' | 'prefix' | 'suffix'; value: string}[] = [
  {match: 'exact', value: '.env'},
  {match: 'prefix', value: '.env.'},
  {match: 'suffix', value: '.pem'},
  {match: 'suffix', value: '.key'},
  {match: 'suffix', value: '.p12'},
  {match: 'suffix', value: '.pfx'},
  {match: 'prefix', value: 'id_rsa'},
  {match: 'prefix', value: 'id_ed25519'},
  {match: 'prefix', value: 'id_ecdsa'},
  {match: 'exact', value: '.npmrc'},
  {match: 'exact', value: '.netrc'},
  {match: 'exact', value: '.pgpass'},
];
/** Templates that are meant to be shared. */
export const SECRET_FILE_EXCEPTIONS: readonly string[] = ['.env.example', '.env.sample', '.env.template'];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_NAMES = SECRET_FILE_RULES.map(
  rule =>
    new RegExp(
      rule.match === 'exact'
        ? `^${escape(rule.value)}$`
        : rule.match === 'prefix'
          ? `^${escape(rule.value)}${rule.value.endsWith('.') ? '.+' : ''}`
          : `${escape(rule.value)}$`,
      'i',
    ),
);
const SECRET_EXCEPTIONS = SECRET_FILE_EXCEPTIONS.map(name => new RegExp(`^${escape(name)}$`, 'i'));

export interface ReadPolicyContext {
  /** Absolute path of Futryn's own state directory (credentials metadata, sessions). */
  stateDirectory?: string;
}

/** Decide one workspace-relative path (`/` separators) whose canonical absolute path is known. */
export function evaluateRead(
  relativePath: string,
  absolutePath: string,
  context: ReadPolicyContext = {},
): PermissionDecision {
  // Case-insensitive file systems (macOS/Windows default) open `.ENV` or `.Git/config` as the real
  // file, so every comparison ignores case; callers also pass on-disk casing via realpath.native.
  const segments = relativePath.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  const absolute = absolutePath.replace(/\\/g, '/').toLowerCase();
  const state = context.stateDirectory?.replace(/\\/g, '/').toLowerCase();
  // deny
  if (state && (absolute === state || absolute.startsWith(state + '/'))) {
    return {effect: 'deny', reason: 'hannes-state'};
  }
  if (segments.includes('.git')) return {effect: 'deny', reason: 'git-internals'};
  // ask
  if (SECRET_NAMES.some(pattern => pattern.test(name)) && !SECRET_EXCEPTIONS.some(pattern => pattern.test(name))) {
    return {effect: 'ask', reason: 'secret-file'};
  }
  // allow
  return {effect: 'allow', reason: 'default-allow'};
}

/**
 * Session-scoped grants a user gave with "Allow for session". Keys bind the capability and the
 * canonical target; nothing is persisted, and a revoke takes effect on the next check.
 */
export class SessionGrants {
  private readonly grants = new Set<string>();

  private key(capability: string, target: string): string {
    return `${capability}\0${target}`;
  }

  has(capability: string, target: string): boolean {
    return this.grants.has(this.key(capability, target));
  }

  grant(capability: string, target: string): void {
    this.grants.add(this.key(capability, target));
  }

  revoke(capability: string, target: string): void {
    this.grants.delete(this.key(capability, target));
  }

  list(): {capability: string; target: string}[] {
    return [...this.grants].map(entry => {
      const [capability, target] = entry.split('\0');
      return {capability: capability!, target: target!};
    });
  }

  clear(): void {
    this.grants.clear();
  }
}

/** Longest command string accepted by the execution policy (ADR 0022). */
export const MAX_COMMAND_CHARS = 1024;

/**
 * Policy for one sandboxed command (ADR 0022). There is no allow branch: a command either is
 * denied or needs an explicit user decision bound to the command, the canonical working directory
 * and the sandbox policy. File-read grants never authorize execution.
 */
export function evaluateExec(
  command: string,
  workdirRelative: string,
  workdirAbsolute: string,
  context: ExecPolicyContext = {},
): PermissionDecision {
  if (!command.trim() || command.length > MAX_COMMAND_CHARS || /[\u0000]/.test(command))
    return {effect: 'deny', reason: 'invalid-command'};
  const location = evaluateRead(workdirRelative === '.' ? '.' : workdirRelative + '/', workdirAbsolute, context);
  if (location.effect === 'deny') return location;
  const sandbox = context.sandbox;
  // Codex `SandboxPermissions::RequireEscalated` (ADR 0053): running without the sandbox is always
  // a decision for the user (`untrusted`/`on-request`) and refused under `never`. No allow rule,
  // session grant or granted network permission can stand in for it.
  if (sandbox?.unsandboxed) {
    if (context.escalation === 'never') return {effect: 'deny', reason: 'escalation-forbidden'};
    return {effect: 'ask', reason: 'unsandboxed-escalation'};
  }
  if (sandbox) {
    // A request may not loosen the configured mode (Codex: per-command overrides go through
    // additional permissions, and `never` forbids every escalation).
    if (context.configuredMode === 'read-only' && sandbox.mode === 'workspace-write')
      return {effect: 'deny', reason: 'sandbox-mode'};
    if (sandbox.network && context.escalation === 'never') return {effect: 'deny', reason: 'escalation-forbidden'};
    if (sandbox.network && !context.networkGranted) return {effect: 'ask', reason: 'network-escalation'};
  }
  // ADR 0053 (Codex exec_policy.rs `render_decision_for_unmatched_command`): the session's approval
  // policy answers these asks. Only commands on the dangerous list stay forbidden under `never`;
  // a command the parser cannot verify still runs inside the sandbox under `on-request`/`never`
  // and asks under `untrusted`, because the sandbox, not the parse, is the boundary.
  const classification = context.classification ?? {dangerous: null, parserUnavailable: true};
  if (classification.parserUnavailable) return {effect: 'ask', reason: 'shell-parser-unavailable'};
  if (classification.dangerous === 'other') return {effect: 'ask', reason: 'unverified-command'};
  if (classification.dangerous) return {effect: 'ask', reason: 'dangerous-command'};
  return {effect: 'ask', reason: 'process-execute'};
}

export type SandboxEscalation = 'on-request' | 'never';
export interface ExecSandbox {
  mode: 'read-only' | 'workspace-write';
  network: boolean;
  /** The one-off approved escalation to no sandbox (ADR 0053). */
  unsandboxed?: boolean;
}
export interface ExecPolicyContext extends ReadPolicyContext {
  /** Effective sandbox requested for this command. */
  sandbox?: ExecSandbox;
  /** Mode configured for the session; requests cannot exceed it. */
  configuredMode?: ExecSandbox['mode'];
  escalation?: SandboxEscalation;
  /** Codex-style classification (ADR 0040); an unparsed command is judged by the approval policy, not refused. */
  classification?: {dangerous: string | null; parserUnavailable?: boolean};
  /** The user granted network for this turn or session through `request_permissions`. */
  networkGranted?: boolean;
}

/**
 * Terminal input review, ported from Codex `unified_exec/stdin_approval.rs` (pinned 75fc67e8).
 * Input never widens a session's authority: the process keeps its launch sandbox. Polls and an
 * interrupt are transport, not new commands. Non-empty input is an `stdin` approval kind: it runs
 * under `on-request`/`never` (the session is sandboxed) and asks under `untrusted` (ADR 0053).
 * Drift is named in the reason; a session that can no longer satisfy a stricter current policy
 * is refused ("start a new terminal"), because approval cannot retrofit restrictions onto a
 * running process.
 */
export function evaluateStdin(input: {
  chars: string;
  interrupt: boolean;
  tty: boolean;
  launch: ExecSandbox;
  current: ExecSandbox;
  escalation?: SandboxEscalation;
}): PermissionDecision {
  if (input.chars.includes('\u0000')) return {effect: 'deny', reason: 'invalid-input'};
  if (!input.chars && !input.interrupt) return {effect: 'allow', reason: 'stdin-poll'};
  if (input.interrupt || (!input.tty && input.chars === '\u0003')) return {effect: 'allow', reason: 'stdin-interrupt'};
  // `current` is the configured session policy; network is never configured, only approved per command.
  if (input.launch.mode === 'workspace-write' && input.current.mode === 'read-only')
    return {effect: 'deny', reason: 'stdin-policy-tightened'};
  if (input.launch.network && input.escalation === 'never') return {effect: 'deny', reason: 'escalation-forbidden'};
  if (input.launch.network) return {effect: 'ask', reason: 'stdin-retained-escalation'};
  if (input.launch.mode !== input.current.mode) return {effect: 'ask', reason: 'stdin-policy-drift'};
  // The session keeps its launch sandbox, so what typed input does stays inside it. The approval
  // policy decides: `untrusted` asks, `on-request`/`never` let it through (decideApproval).
  return {effect: 'ask', reason: 'stdin-input-approval-required'};
}

export interface WritePolicyContext extends ReadPolicyContext {
  /**
   * The path lies in a writable root of the session sandbox (workspace-write, or a path granted by
   * `request_permissions`). Codex `assess_patch_safety`: writes there are approved by `on-request`;
   * elsewhere they are an escalation. Defaults to true (workspace-write).
   */
  writable?: boolean;
}

/** Patch writes cannot modify credentials, Git internals or Futryn durable state. */
export function evaluateWrite(
  relativePath: string,
  absolutePath: string,
  context: WritePolicyContext = {},
): PermissionDecision {
  const read = evaluateRead(relativePath, absolutePath, context);
  if (read.effect !== 'allow') return {effect: 'deny', reason: read.reason};
  if (
    relativePath
      .toLowerCase()
      .split('/')
      .some(p => p === '.hannes' || p === '.futryn' || p.startsWith('.hannes-patch-') || p.startsWith('.futryn-patch-'))
  )
    return {effect: 'deny', reason: 'protected-path'};
  if (context.writable === false) return {effect: 'ask', reason: 'outside-writable-roots'};
  return {effect: 'ask', reason: 'workspace-patch'};
}
