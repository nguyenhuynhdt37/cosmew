import {z} from 'zod';

export const permissionScopeSchema = z.enum(['once', 'session', 'deny']);
export type PermissionResolutionScope = z.infer<typeof permissionScopeSchema>;

export const permissionPromptRequestSchema = z.strictObject({
  approvalId: z.string().uuid(),
  capability: z.enum(['fs.read', 'fs.write', 'process.execute', 'network.connect', 'mcp.call', 'extension.service']),
  action: z.string().min(1).max(200),
  target: z.string().min(1).max(1024),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reason: z.string().max(400),
  scopeHash: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  diffPreview: z.string().max(65536).optional(),
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
 * Session permission mode (ADR 0027), modelled on Claude Code's modes. It only changes how an
 * `ask` decision is answered; deny rules (outside workspace, `.git`, Futryn state) never change.
 * - default: prompt for edits, commands, secret reads and anything else sensitive.
 * - acceptEdits: file edits are approved; commands and secrets still prompt.
 * - auto: edits and commands are approved; secret reads, network and other tools still prompt.
 * - bypassPermissions: every ask is approved without a prompt.
 * - plan: read-only; edits and commands are refused, secret reads still prompt.
 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModeSchema.options;
/** What a permission request is about, as far as the mode is concerned. */
export type PermissionKind = 'read' | 'secret' | 'edit' | 'execute' | 'network' | 'other';
export function permissionModeDecision(mode: PermissionMode, kind: PermissionKind): 'allow' | 'ask' | 'deny' {
  if (mode === 'bypassPermissions') return 'allow';
  if (kind === 'read') return 'allow';
  if (kind === 'secret') return 'ask';
  if (mode === 'plan') return kind === 'edit' || kind === 'execute' ? 'deny' : 'ask';
  if (kind === 'edit') return mode === 'default' ? 'ask' : 'allow';
  if (kind === 'execute') return mode === 'auto' ? 'allow' : 'ask';
  return 'ask';
}

/** One-line explanation shown when Shift+Tab or /permissions changes the mode (ADR 0027). */
export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  default: 'Edits, commands and secret files ask first.',
  acceptEdits: 'File edits are approved; commands and secret files ask.',
  auto: 'Edits and commands are approved; secret files, network and other tools ask.',
  plan: 'Read-only: edits and commands are refused.',
  bypassPermissions:
    'Every request is approved without asking. Hard blocks (outside workspace, .git, Futryn state) still apply.',
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
      ? [request.target, ...shellSegments(request.target)]
      : [request.target];
  const any = (list: string[]) =>
    targets.some(target => list.some(rule => permissionRuleMatches(rule, {tool: request.tool, target})));
  if (any(rules.deny)) return 'deny';
  if (any(rules.ask)) return 'ask';
  // Substitutions, redirects and control characters cannot be checked by prefix; they never auto-allow.
  if (bash && /\$\(|`|[<>]|[\u0000-\u0008\u000b-\u001f\u007f]/.test(request.target)) return undefined;
  // A path that escapes the workspace (or is absolute outside it) is never allowed by a rule.
  if (paths && normalPaths.some(path => path === null)) return undefined;
  const allowTargets = bash ? shellSegments(request.target) : paths ? (normalPaths as string[]) : targets;
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
