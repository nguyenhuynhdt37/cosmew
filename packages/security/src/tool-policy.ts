import {SANDBOX_MODE_RANK, type PermissionDecision} from '@cosmew/contracts';

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

/**
 * Directories under the user's home that commands can never read or write (ADR 0061): credentials,
 * key material, keychains, browser profiles and the state of other agents. Reads everywhere else
 * are allowed; this is the default sensitive list, `Read(...)` deny rules add to it.
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.config/op',
  '.docker/config.json',
  '.git-credentials',
  '.codex',
  '.claude',
  '.cosmew',
  '.futryn',
  '.hannes',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Safari',
  'Library/Mail',
  'Library/Messages',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/Firefox',
  'Library/Application Support/com.apple.sharedfilelist',
  '.mozilla',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.local/share/keyrings',
];

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
  /** Absolute path of Cosmew's own state directory (credentials metadata, sessions). */
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
  /** Process-local authority identity; persisted handles cannot resurrect grants after restart. */
  readonly scopeId = crypto.randomUUID();
  private readonly grants = new Set<string>();
  private revocationGeneration = 0;
  get generation(): number {
    return this.revocationGeneration;
  }
  private readonly children = new Set<SessionGrants>();

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
    this.revocationGeneration++;
    this.grants.delete(this.key(capability, target));
    for (const child of this.children) child.revoke(capability, target);
  }

  list(): {capability: string; target: string}[] {
    return [...this.grants].map(entry => {
      const [capability, target] = entry.split('\0');
      return {capability: capability!, target: target!};
    });
  }

  clear(): void {
    this.revocationGeneration++;
    this.grants.clear();
    for (const child of this.children) child.clear();
  }

  /**
   * Create a child grant scope for a subagent (Wave 2 S5a): inherits ONLY `fs.read` grants from
   * this parent, never command, write, network or sandbox-escalation grants. Revoking or clearing
   * the parent also revokes/clears the child.
   */
  createChild(): SessionGrants {
    const child = new ChildSessionGrants(this);
    this.children.add(child);
    return child;
  }
}

export class ChildSessionGrants extends SessionGrants {
  constructor(private readonly parent: SessionGrants) {
    super();
  }

  override has(capability: string, target: string): boolean {
    if (super.has(capability, target)) return true;
    if (capability === 'fs.read') return this.parent.has('fs.read', target);
    return false;
  }
}

/** Longest command string accepted by the execution policy (ADR 0022). */
export const MAX_COMMAND_CHARS = 1024;

/**
 * Policy for one command (ADR 0022, 0061). A command is never allowed here: the decision names
 * what kind of command it is, and `FutrynClient.requestPermission` applies rules and the
 * permission mode to that kind (a sandboxed command with `autoAllowBashIfSandboxed` is allowed by
 * default/acceptEdits; anything else asks). The reason selects the kind through
 * `APPROVAL_KIND_FOR_REASON`.
 * - `sandboxed-command`: runs in the OS sandbox and auto-allow is on;
 * - `process-execute`: runs in the sandbox but auto-allow is off;
 * - `unsandboxed-session`: the sandbox is disabled in settings;
 * - `excluded-command`: matches `sandbox.excludedCommands`, runs outside the sandbox;
 * - `unsandboxed-escalation`: `dangerouslyDisableSandbox`, one command outside the sandbox;
 * - `unsandboxed-forbidden` (deny): the same request while `allowUnsandboxedCommands` is false.
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
  if (context.escalation) {
    if (context.unsandboxedAllowed === false) return {effect: 'deny', reason: 'unsandboxed-forbidden'};
    return {effect: 'ask', reason: 'unsandboxed-escalation'};
  }
  if (context.sandbox?.unsandboxed)
    return {effect: 'ask', reason: context.excluded ? 'excluded-command' : 'unsandboxed-session'};
  return {effect: 'ask', reason: context.autoAllow === false ? 'process-execute' : 'sandboxed-command'};
}

export interface ExecSandbox {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** The command runs outside the OS sandbox (sandbox disabled, excluded command or approved escape). */
  unsandboxed?: boolean;
}
export interface ExecPolicyContext extends ReadPolicyContext {
  /** Effective sandbox requested for this command. */
  sandbox?: ExecSandbox;
  /** The model asked for `dangerouslyDisableSandbox` while the sandbox is enabled. */
  escalation?: boolean;
  /** `sandbox.allowUnsandboxedCommands` is not false. */
  unsandboxedAllowed?: boolean;
  /** `sandbox.autoAllowBashIfSandboxed`; default true. */
  autoAllow?: boolean;
  /** The command matched `sandbox.excludedCommands` (it runs outside the sandbox). */
  excluded?: boolean;
  /** Codex-style classification (ADR 0040), used for display and rule segments. */
  classification?: {dangerous: string | null; parserUnavailable?: boolean};
}

/**
 * Terminal input review (ADR 0034, 0061). Input never widens a session's authority: the process
 * keeps its launch sandbox. Polls and an interrupt are transport, not new commands. Non-empty
 * input is a `stdin-sandboxed` request when the terminal runs in the OS sandbox (like a sandboxed
 * command) and `stdin-unsandboxed` otherwise. A session that can no longer satisfy a stricter
 * current policy is refused ("start a new terminal"), because approval cannot retrofit
 * restrictions onto a running process.
 */
export function evaluateStdin(input: {
  chars: string;
  interrupt: boolean;
  tty: boolean;
  launch: ExecSandbox;
  current: ExecSandbox;
  /** `sandbox.autoAllowBashIfSandboxed`; off makes input to a sandboxed terminal ask like any command. */
  autoAllow?: boolean;
}): PermissionDecision {
  if (input.chars.includes('\u0000')) return {effect: 'deny', reason: 'invalid-input'};
  if (!input.chars && !input.interrupt) return {effect: 'allow', reason: 'stdin-poll'};
  if (input.interrupt || (!input.tty && input.chars === '\u0003')) return {effect: 'allow', reason: 'stdin-interrupt'};
  if (SANDBOX_MODE_RANK[input.launch.mode] > SANDBOX_MODE_RANK[input.current.mode])
    return {effect: 'deny', reason: 'stdin-policy-tightened'};
  if (input.launch.unsandboxed) return {effect: 'ask', reason: 'stdin-unsandboxed'};
  return {effect: 'ask', reason: input.autoAllow === false ? 'stdin-process' : 'stdin-sandboxed'};
}

export interface WritePolicyContext extends ReadPolicyContext {
  /**
   * The path lies in a writable root (the working directory or `additionalDirectories`). Writes
   * there follow the permission mode; the read-only analysis profile of a subagent has none.
   * Defaults to true.
   */
  writable?: boolean;
}

/** Patch writes cannot modify credentials, Git internals or Cosmew durable state. */
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
      .some(
        p =>
          p === '.hannes' ||
          p === '.futryn' ||
          p === '.cosmew' ||
          p.startsWith('.hannes-patch-') ||
          p.startsWith('.futryn-patch-') ||
          p.startsWith('.cosmew-patch-'),
      )
  )
    return {effect: 'deny', reason: 'protected-path'};
  if (context.writable === false) return {effect: 'ask', reason: 'outside-writable-roots'};
  return {effect: 'ask', reason: 'workspace-patch'};
}
