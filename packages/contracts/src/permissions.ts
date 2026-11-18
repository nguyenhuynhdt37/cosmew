import {z} from 'zod';

/**
 * How a prompt is answered (ADR 0055, Codex `ReviewDecision`): `once` = Approved, `session` =
 * ApprovedForSession, `always` = a persistent project allow rule (Codex's execpolicy amendment).
 * `always` is only valid when the request offered it (`decisions`).
 */
export const permissionScopeSchema = z.enum(['once', 'session', 'always', 'deny']);
export type PermissionResolutionScope = z.infer<typeof permissionScopeSchema>;
export const permissionDecisionKindSchema = z.enum(['once', 'session', 'always']);
export type PermissionDecisionKind = z.infer<typeof permissionDecisionKindSchema>;

export const permissionPromptRequestSchema = z.strictObject({
  approvalId: z.string().uuid(),
  capability: z.enum([
    'fs.read',
    'fs.write',
    'process.execute',
    'network.connect',
    'network.search',
    'mcp.call',
    'extension.service',
  ]),
  action: z.string().min(1).max(200),
  target: z.string().min(1).max(1024),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reason: z.string().max(400),
  scopeHash: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  diffPreview: z.string().optional(),
  /** The approvals this prompt may be answered with, in display order (Codex `available_decisions`). */
  decisions: z.array(permissionDecisionKindSchema).min(1).max(3).default(['once', 'session']),
  /** The project Allow rule `always` saves; present exactly when `decisions` includes `always`. */
  alwaysRule: z.string().max(520).optional(),
  status: z
    .enum(['pending', 'approved_once', 'approved_session', 'approved_always', 'denied', 'expired'])
    .default('pending'),
});
export type PermissionPromptRequest = z.infer<typeof permissionPromptRequestSchema>;

export const permissionPromptResolutionSchema = z.strictObject({
  approvalId: z.string().uuid(),
  scopeHash: z.string().min(8).max(128),
  decision: permissionScopeSchema,
  resolvedAt: z.string().datetime(),
});
export type PermissionPromptResolution = z.infer<typeof permissionPromptResolutionSchema>;

/**
 * Session permission mode (ADR 0027), shown with Claude Code's names. Since ADR 0040 every mode is
 * a Codex approval policy (`AskForApproval`, pinned 090be4df `core/src/exec_policy.rs`):
 * - default → `untrusted`: edits, commands and secret reads prompt (unless a project rule allows).
 * - acceptEdits → `untrusted` with workspace edits approved.
 * - auto → `on-request` (Futryn's default, as Codex): commands run in the sandbox and workspace
 *   edits apply without a prompt; dangerous commands, network and other sandbox
 *   escalations, and secret reads prompt.
 * - bypassPermissions → `never`: nothing prompts; what would prompt runs in the sandbox when that
 *   is safe (ordinary, unparsed commands and terminal input) or is refused (dangerous commands, escalations, secrets).
 * - plan: read-only; edits and commands are refused, secret reads still prompt.
 * The mode answers only what policy left as `ask`; deny rules (outside workspace, `.git`, Futryn
 * state) never change.
 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModeSchema.options;
/** Codex approval policies (ADR 0040). `FUTRYN_APPROVAL_POLICY` selects the session's starting mode. */
export const approvalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export const APPROVAL_POLICY_FOR_MODE: Record<PermissionMode, ApprovalPolicy> = {
  default: 'untrusted',
  acceptEdits: 'untrusted',
  auto: 'on-request',
  plan: 'untrusted',
  bypassPermissions: 'never',
};
/** The mode a configured approval policy starts a session in. */
export const MODE_FOR_APPROVAL_POLICY: Record<ApprovalPolicy, PermissionMode> = {
  untrusted: 'default',
  'on-request': 'auto',
  never: 'bypassPermissions',
};
/** Futryn's default, as Codex: workspace-write sandbox, `on-request` approvals (plan D3). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/** Codex `SandboxMode` (`protocol/src/config_types.rs`, pinned 090be4df); `FUTRYN_SANDBOX_MODE`, config `sandbox_mode`. */
export const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type SandboxModeSetting = z.infer<typeof sandboxModeSchema>;
export const SANDBOX_MODES: readonly SandboxModeSetting[] = sandboxModeSchema.options;
/** Strictness order: a running terminal cannot be tightened, only refused (`stdin-policy-tightened`). */
export const SANDBOX_MODE_RANK: Record<SandboxModeSetting, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

/**
 * Codex approval presets (`utils/approval-presets/src/lib.rs`, pinned 090be4df): the named pairs of
 * sandbox and approval policy that `/approvals` offers. Codex labels the middle one "Default"
 * (id `auto`); Futryn calls it Auto. A session whose sandbox or mode matches none of them is `custom`.
 */
export const permissionPresetIdSchema = z.enum(['read-only', 'auto', 'full-access']);
export type PermissionPresetId = z.infer<typeof permissionPresetIdSchema>;
export interface PermissionPreset {
  id: PermissionPresetId;
  label: string;
  description: string;
  sandbox: SandboxModeSetting;
  /** The session mode that carries the preset's approval policy. */
  mode: PermissionMode;
}
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'read-only',
    label: 'Read Only',
    description:
      'Futryn can read files in the workspace. Approval is required to edit files, run commands that write, or use the network.',
    sandbox: 'read-only',
    mode: 'auto',
  },
  {
    id: 'auto',
    label: 'Auto',
    description:
      'Futryn can read and edit files in the workspace and run commands in the sandbox. Approval is required for the network, for files outside the workspace and for commands outside the sandbox.',
    sandbox: 'workspace-write',
    mode: 'auto',
  },
  {
    id: 'full-access',
    label: 'Full Access',
    description:
      'No sandbox and no approval prompts: commands can change any file your user can and use the network. Project deny rules and the audit trail still apply. Exercise caution.',
    sandbox: 'danger-full-access',
    mode: 'bypassPermissions',
  },
];
export const DEFAULT_PERMISSION_PRESET: PermissionPresetId = 'auto';
/** Shown whenever Full Access is entered (Shift+Tab, `/permissions`, `fyn exec`): it removes the sandbox and the prompts. */
export const FULL_ACCESS_WARNING =
  'WARNING: Full Access runs commands WITHOUT the sandbox and WITHOUT approval prompts. They can change or delete any file your user can reach and use the network. Project deny rules and the audit trail still apply.';
/** The preset a (sandbox, mode) pair equals, or `custom`. */
export function permissionPresetFor(sandbox: SandboxModeSetting, mode: PermissionMode): PermissionPresetId | 'custom' {
  return PERMISSION_PRESETS.find(preset => preset.sandbox === sandbox && preset.mode === mode)?.id ?? 'custom';
}
/** Resolve a preset id or its label (`full access`, case-insensitive). */
export function findPermissionPreset(name: string): PermissionPreset | undefined {
  const wanted = name.trim().toLowerCase().replace(/\s+/g, '-');
  return PERMISSION_PRESETS.find(
    preset => preset.id === wanted || preset.label.toLowerCase().replace(/\s+/g, '-') === wanted,
  );
}
/**
 * What a permission request is about, as far as the approval policy is concerned:
 * - `execute`: an ordinary command inside the configured sandbox;
 * - `dangerous`: a command on Codex's dangerous list (`rm` with force, also through sudo/env/trap/`sh -c`);
 * - `stdin`: non-empty input to a running command. It follows `execute` (ADR 0053): the session
 *   runs inside its launch sandbox, so `untrusted` asks and `on-request`/`never` allow;
 * - `network` / `escalation`: anything beyond the sandbox (network, writes outside writable roots,
 *   `request_permissions`).
 */
export type PermissionKind =
  'read' | 'secret' | 'edit' | 'execute' | 'dangerous' | 'stdin' | 'network' | 'escalation' | 'other';

/**
 * The approval table (ADR 0040), after Codex `render_decision_for_unmatched_command` and
 * `assess_patch_safety`: dangerous commands prompt (`never` → forbidden); `on-request`/`never` run
 * sandboxed commands and approve writes inside writable roots; `untrusted` prompts for every
 * command and write; escalations prompt (`never` → refused). Secret reads prompt (OpenCode's `.env`
 * ask) and are refused under `never`. Project rules are applied before this table.
 */
export function decideApproval(
  policy: ApprovalPolicy,
  kind: PermissionKind,
  options: {autoApproveEdits?: boolean; fullAccess?: boolean} = {},
): 'allow' | 'ask' | 'deny' {
  switch (kind) {
    case 'read':
      return 'allow';
    case 'edit':
      return policy === 'untrusted' && !options.autoApproveEdits ? 'ask' : 'allow';
    case 'execute':
    case 'stdin':
      return policy === 'untrusted' ? 'ask' : 'allow';
    case 'network':
    case 'escalation':
      // ADR 0055: with no sandbox there is nothing to escalate out of (Codex `danger-full-access`
      // is `Unrestricted`: network and file access need no approval) - unless the policy is `untrusted`.
      if (options.fullAccess && policy !== 'untrusted') return 'allow';
      return policy === 'never' ? 'deny' : 'ask';
    default:
      return policy === 'never' ? 'deny' : 'ask';
  }
}

export function permissionModeDecision(
  mode: PermissionMode,
  kind: PermissionKind,
  sandbox: SandboxModeSetting = 'workspace-write',
): 'allow' | 'ask' | 'deny' {
  if (mode === 'plan') {
    if (kind === 'read') return 'allow';
    return ['edit', 'execute', 'dangerous', 'stdin'].includes(kind) ? 'deny' : 'ask';
  }
  return decideApproval(APPROVAL_POLICY_FOR_MODE[mode], kind, {
    autoApproveEdits: mode === 'acceptEdits',
    fullAccess: sandbox === 'danger-full-access',
  });
}

/** One-line explanation shown when Shift+Tab or /permissions changes the mode (ADR 0027/0040). */
export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  default: 'untrusted: edits, commands and secret files ask first.',
  acceptEdits: 'untrusted + edits: file edits are approved; commands and secret files ask.',
  auto: 'on-request: sandboxed commands and workspace edits run; dangerous commands, network and secrets ask.',
  plan: 'Read-only: edits and commands are refused.',
  bypassPermissions:
    'never: nothing asks. Sandboxed work runs; dangerous commands, escalations and secret files are refused.',
};

/**
 * Project permission rules (ADR 0028), written like Claude Code's: `Bash`, `Bash(npm test:*)`,
 * `Read(src/**)`, `Edit(**\/*.ts)`, `WebFetch(domain:example.com)`, `Tool(name)`. They answer only
 * requests that would otherwise ask; hard denies (outside workspace, `.git`, Futryn state) stay.
 */
export const PERMISSION_RULE_TOOLS = ['Bash', 'Read', 'Edit', 'WebFetch', 'Tool', 'Network', 'Unsandboxed'] as const;
export type PermissionRuleTool = (typeof PERMISSION_RULE_TOOLS)[number];
/**
 * `Network(curl:*)` lets a matching command use the network without asking, `Unsandboxed(npm i:*)`
 * lets it run once outside the sandbox when the model requests `require_escalated` (ADR 0055, the
 * project form of Codex's execpolicy amendment for those prompts). They match like `Bash` rules.
 * A plain `Bash` allow rule never grants either: it covers sandboxed commands only.
 */
export const COMMAND_RULE_TOOLS: readonly PermissionRuleTool[] = ['Bash', 'Network', 'Unsandboxed'];
export const permissionRuleSchema = z
  .string()
  .max(520)
  .regex(/^(Bash|Read|Edit|WebFetch|Tool|Network|Unsandboxed)(\([^()\n\u0000-\u001f]{1,500}\))?$/);
export const permissionRuleSetSchema = z.strictObject({
  allow: z.array(permissionRuleSchema).max(200),
  ask: z.array(permissionRuleSchema).max(200),
  deny: z.array(permissionRuleSchema).max(200),
});
export type PermissionRuleSet = z.infer<typeof permissionRuleSetSchema>;
export type PermissionRuleEffect = keyof PermissionRuleSet;
export interface PermissionRuleRequest {
  tool: PermissionRuleTool;
  target: string;
  /**
   * Bash only (ADR 0040, Codex `commands_for_exec_policy`): the parsed sub-commands, or null for an
   * unparsed script, which is one opaque command no allow rule can match. Absent: legacy text split.
   */
  segments?: string[] | null;
}

const globSource = (pattern: string) =>
  pattern
    .replace(/^\.\//, '')
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map(part =>
      part === '**/'
        ? '(?:.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part === '?'
              ? '[^/]'
              : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');

/** Does one rule cover one target? Paths compare workspace-relative with `/` separators. */
export function permissionRuleMatches(rule: string, request: PermissionRuleRequest): boolean {
  const parsed = /^(\w+)(?:\((.*)\))?$/.exec(rule);
  if (!parsed || parsed[1] !== request.tool) return false;
  const pattern = parsed[2];
  if (pattern === undefined) return true;
  const target = request.target.trim();
  if (COMMAND_RULE_TOOLS.includes(request.tool)) {
    if (pattern.endsWith(':*')) return target === pattern.slice(0, -2) || target.startsWith(pattern.slice(0, -2) + ' ');
    if (pattern.includes('*'))
      return new RegExp(
        '^' +
          pattern
            .split('*')
            .map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*') +
          '$',
      ).test(target);
    return target === pattern;
  }
  if (request.tool === 'WebFetch') {
    const domain = (pattern.startsWith('domain:') ? pattern.slice(7) : pattern).toLowerCase();
    let host: string;
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      if (!/^[a-z0-9.-]+$/i.test(target)) return false;
      host = target.toLowerCase();
    } // only a bare host is a host
    return host === domain || host.endsWith('.' + domain);
  }
  if (request.tool === 'Tool')
    return target === pattern || target.startsWith(pattern + ' ') || target.startsWith(pattern + ':');
  return new RegExp('^' + globSource(pattern) + '$').test(target.replace(/^\.\//, ''));
}

/**
 * Rule decision for one request, Claude order: deny beats ask beats allow. A request naming several
 * paths (a patch) is denied or asked if any path matches, and allowed only if every path is allowed.
 */
export function permissionRuleDecision(
  rules: PermissionRuleSet | undefined,
  request: PermissionRuleRequest,
): PermissionRuleEffect | undefined {
  if (!rules) return undefined;
  const bash = COMMAND_RULE_TOOLS.includes(request.tool);
  const paths = request.tool === 'Read' || request.tool === 'Edit';
  // Paths are judged normalised: `src/../../.ssh/key` is not under `src/**`.
  const rawPaths = paths ? request.target.split(', ').filter(Boolean) : [];
  const normalPaths = rawPaths.map(normalizeRulePath);
  // Chained commands are judged per sub-command: `npm test && rm -rf ~` must not ride on `Bash(npm test:*)`.
  const targets = paths
    ? [...rawPaths, ...normalPaths.filter((p): p is string => p !== null)]
    : bash
      ? [request.target, ...(request.segments ?? shellSegments(request.target))]
      : [request.target];
  const any = (list: string[]) =>
    targets.some(target => list.some(rule => permissionRuleMatches(rule, {tool: request.tool, target})));
  if (any(rules.deny)) return 'deny';
  if (any(rules.ask)) return 'ask';
  // An unparsed script never matches an allow rule (Codex: allow needs every parsed sub-command).
  if (bash && request.segments === null) return undefined;
  // Substitutions, redirects and control characters cannot be checked by prefix; they never auto-allow.
  if (bash && /\$\(|`|[<>]|[\u0000-\u0008\u000b-\u001f\u007f]/.test(request.target)) return undefined;
  // A path that escapes the workspace (or is absolute outside it) is never allowed by a rule.
  if (paths && normalPaths.some(path => path === null)) return undefined;
  const allowTargets = bash
    ? (request.segments ?? shellSegments(request.target))
    : paths
      ? (normalPaths as string[])
      : targets;
  if (
    allowTargets.length &&
    allowTargets.every(target => rules.allow.some(rule => permissionRuleMatches(rule, {tool: request.tool, target})))
  )
    return 'allow';
  return undefined;
}

/** Sub-commands of a shell line split on `;`, `&&`, `||`, `|`, `&` and line breaks. */
export function shellSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[;|&\n\r]/)
    .map(part => part.trim())
    .filter(Boolean);
}

/** Workspace-relative POSIX path with `.`/`..` resolved; null when absolute or escaping the root. */
export function normalizeRulePath(path: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || path.startsWith('~') || /^[a-z]:[\\/]/i.test(path))
    return null;
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/') || null;
}

const RULE_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'perl',
  'ruby',
  'php',
  'env',
  'sudo',
  'doas',
  'xargs',
  'eval',
  'exec',
  'nohup',
  'timeout',
  'npx',
  'bunx',
  'osascript',
  'ssh',
]);

/**
 * The project Allow rule an `always` answer saves (ADR 0028/0055), Claude style: a command prefix
 * (`Bash(npm test:*)`) - or the exact command for an interpreter, wrapper or `exact` request such as
 * a dangerous command - the exact file for edits and secret reads, the domain for web access.
 * Null when no rule can safely stand for the request (chained, substituted or redirected commands
 * never auto-allow, so none is offered).
 */
export function suggestPermissionRule(request: {
  tool: PermissionRuleTool;
  target: string;
  /** Command tools: a rule for exactly this command, never a prefix. */
  exact?: boolean;
}): string | null {
  const clean = (value: string) =>
    value
      .replace(/[()\n\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 200);
  if (COMMAND_RULE_TOOLS.includes(request.tool)) {
    const command = clean(request.target);
    if (!command || /[;&|<>`\n]|\$\(/.test(command)) return null;
    const words = command.split(/\s+/).filter(Boolean);
    if (request.exact || RULE_INTERPRETERS.has(words[0]!.replace(/^.*\//, ''))) return `${request.tool}(${command})`;
    const prefix =
      words.length > 1 && !words[1]!.startsWith('-') && /^[\w.:@/-]+$/.test(words[1]!)
        ? `${words[0]} ${words[1]}`
        : words[0]!;
    return `${request.tool}(${prefix}:*)`;
  }
  if (request.tool === 'Edit' || request.tool === 'Read') {
    const path = clean(request.target);
    return path && !path.includes(', ') ? `${request.tool}(${path})` : null;
  }
  if (request.tool === 'WebFetch') {
    let host = clean(request.target);
    try {
      host = new URL(request.target).hostname;
    } catch {
      /* plain host */
    }
    return host ? `WebFetch(domain:${host})` : null;
  }
  return null;
}
