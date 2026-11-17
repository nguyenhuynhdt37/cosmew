import {z} from 'zod';

export const permissionScopeSchema = z.enum(['once', 'session', 'deny']);
export type PermissionResolutionScope = z.infer<typeof permissionScopeSchema>;

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
  status: z.enum(['pending', 'approved_once', 'approved_session', 'denied', 'expired']).default('pending'),
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
 *   is safe (ordinary and unparsed commands) or is refused (dangerous commands, escalations, secrets).
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
/**
 * What a permission request is about, as far as the approval policy is concerned:
 * - `execute`: an ordinary command inside the configured sandbox;
 * - `dangerous`: a command on Codex's dangerous list (`rm` with force, also through sudo/env/trap/`sh -c`);
 * - `stdin`: non-empty input to a running command. It always asks (`never` refuses): what a running
 *   program does with typed input cannot be verified (ADR 0040, stricter than Codex);
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
  options: {autoApproveEdits?: boolean} = {},
): 'allow' | 'ask' | 'deny' {
  switch (kind) {
    case 'read':
      return 'allow';
    case 'edit':
      return policy === 'untrusted' && !options.autoApproveEdits ? 'ask' : 'allow';
    case 'execute':
      return policy === 'untrusted' ? 'ask' : 'allow';
    default:
      return policy === 'never' ? 'deny' : 'ask';
  }
}

export function permissionModeDecision(mode: PermissionMode, kind: PermissionKind): 'allow' | 'ask' | 'deny' {
  if (mode === 'plan') {
    if (kind === 'read') return 'allow';
    return ['edit', 'execute', 'dangerous', 'stdin'].includes(kind) ? 'deny' : 'ask';
  }
  return decideApproval(APPROVAL_POLICY_FOR_MODE[mode], kind, {autoApproveEdits: mode === 'acceptEdits'});
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
export const PERMISSION_RULE_TOOLS = ['Bash', 'Read', 'Edit', 'WebFetch', 'Tool'] as const;
export type PermissionRuleTool = (typeof PERMISSION_RULE_TOOLS)[number];
export const permissionRuleSchema = z
  .string()
  .max(520)
  .regex(/^(Bash|Read|Edit|WebFetch|Tool)(\([^()\n\u0000-\u001f]{1,500}\))?$/);
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
  if (request.tool === 'Bash') {
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
  const bash = request.tool === 'Bash';
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
