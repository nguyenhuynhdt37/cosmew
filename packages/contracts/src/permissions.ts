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
    'agent.state.write',
    'process.execute',
    'network.connect',
    'network.search',
    'mcp.call',
    'extension.service',
    'settings.trust',
  ]),
  action: z.string().min(1).max(200),
  target: z.string().min(1).max(1024),
  riskLevel: z.enum(['low', 'medium', 'high']),
  reason: z.string().max(400),
  scopeHash: z.string().min(8).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  diffPreview: z.string().optional(),
  /** Subagent that triggered this permission prompt, when requested by a child conversation (Wave 2 S5). */
  subagent: z
    .strictObject({
      agentId: z.string().min(1).max(100),
      agentType: z.string().min(1).max(64),
      description: z.string().min(1).max(200),
    })
    .optional(),
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
 * Session permission mode (ADR 0061, supersedes the Codex model of ADR 0040/0053/0055). The four
 * modes are Claude Code's: Shift+Tab cycles them, `/permissions` shows them, `--permission-mode`
 * and `permissions.defaultMode` select the starting one.
 * - default: file edits ask; commands ask unless a rule allows them or they run inside the OS
 *   sandbox with `sandbox.autoAllowBashIfSandboxed`; reads of ordinary files are free.
 * - acceptEdits: edits inside the working directory (and `additionalDirectories`) are approved;
 *   commands follow `default`.
 * - plan: read-only research; edits, commands and network are refused.
 * - bypassPermissions: nothing prompts (`--dangerously-skip-permissions`). The OS sandbox still
 *   applies when it is enabled. Deny rules and the hard path denials never change.
 * The mode answers only what policy and rules left as `ask`; deny rules (and protected paths) win.
 */
export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const PERMISSION_MODES: readonly PermissionMode[] = permissionModeSchema.options;
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';
/** Shift+Tab order, as Claude Code: default -> acceptEdits -> plan -> default (bypass only when the session started in it). */
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  bypassPermissions: 'bypass permissions',
};
/** Shown whenever bypassPermissions is entered (`--dangerously-skip-permissions`, `/permissions`). */
export const BYPASS_PERMISSIONS_WARNING =
  'WARNING: bypassPermissions skips every permission prompt: file edits, commands and sandbox network requests are approved without asking. The OS sandbox (when enabled), deny rules and the audit trail still apply. Use it only in a disposable environment.';

/**
 * Internal enforcement mode of one command (not user configuration): `read-only` and
 * `workspace-write` are OS sandboxes, `danger-full-access` marks a command that runs without one
 * (sandbox disabled, an excluded command, or an approved `dangerouslyDisableSandbox`).
 * Subagent profiles use it as a ceiling (a read-only explorer never gets `workspace-write`).
 */
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
 * What a permission request is about, as far as the permission mode is concerned:
 * - `read` / `secret`: a file read; a secret-looking file asks;
 * - `edit`: a file write inside the allowed directories;
 * - `sandboxed-command`: a command that runs inside the OS sandbox with `autoAllowBashIfSandboxed` on;
 * - `command`: any other command (sandbox off or auto-allow off, an excluded command, terminal input to one);
 * - `escalation`: `dangerouslyDisableSandbox` - one command outside the sandbox;
 * - `network`: a sandboxed command's connection to a domain that is not allowed yet;
 * - `other`: web, MCP and the rest.
 */
export type PermissionKind =
  'read' | 'secret' | 'edit' | 'sandboxed-command' | 'command' | 'escalation' | 'network' | 'other';

/**
 * The mode table (ADR 0061). Rules are applied before it (deny > ask > allow), except that `plan`
 * refuses writes and execution first. `bypassPermissions` answers every remaining ask with allow.
 */
export function permissionModeDecision(mode: PermissionMode, kind: PermissionKind): 'allow' | 'ask' | 'deny' {
  if (kind === 'read') return 'allow';
  if (mode === 'bypassPermissions') return 'allow';
  if (mode === 'plan') return kind === 'secret' || kind === 'other' ? 'ask' : 'deny';
  switch (kind) {
    case 'edit':
      return mode === 'acceptEdits' ? 'allow' : 'ask';
    case 'sandboxed-command':
      return 'allow';
    default:
      return 'ask';
  }
}

/** One-line explanation shown when Shift+Tab or /permissions changes the mode. */
export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  default: 'Asks before file edits and before commands that no rule or the sandbox auto-allow covers.',
  acceptEdits: 'File edits in the working directory are approved; commands follow default.',
  plan: 'Read-only: edits, commands and network are refused.',
  bypassPermissions: 'No prompts. The OS sandbox (when enabled) and deny rules still apply.',
};

/**
 * Permission rules (ADR 0028, 0061), written like Claude Code's: `Bash`, `Bash(npm run test:*)`,
 * `Read(./src/**)`, `Edit(**\/*.ts)` (`Write(...)` is an alias), `WebFetch(domain:example.com)`,
 * `WebSearch`, `mcp__server__tool` and Cosmew's own `Tool(name)`. Paths are relative to the working
 * directory (`/x` is relative to the project root, `//x` is absolute). They answer only requests
 * that would otherwise ask; hard denies (outside workspace, `.git`, Cosmew state) stay.
 */
export const PERMISSION_RULE_TOOLS = ['Bash', 'Read', 'Edit', 'WebFetch', 'WebSearch', 'Tool', 'Mcp'] as const;
export type PermissionRuleTool = (typeof PERMISSION_RULE_TOOLS)[number];
/** Rule tools whose target is a shell command. */
export const COMMAND_RULE_TOOLS: readonly PermissionRuleTool[] = ['Bash'];
const RULE_PATTERN =
  /^(?:(?:Bash|Read|Edit|Write|WebFetch|WebSearch|Tool)(?:\([^()\n\u0000-\u001f]{1,500}\))?|mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?)$/;
/** A rule as written in settings; `Write(...)` is normalized to `Edit(...)`. */
export const permissionRuleSchema = z
  .string()
  .max(520)
  .regex(RULE_PATTERN)
  .transform(rule => (rule.startsWith('Write') ? 'Edit' + rule.slice(5) : rule));
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
  if (rule.startsWith('mcp__')) {
    if (request.tool !== 'Mcp') return false;
    const name = request.target.trim();
    if (rule.endsWith('__*')) return name.startsWith(rule.slice(0, -1));
    return name === rule || name.startsWith(rule + '__');
  }
  const parsed = /^(\w+)(?:\((.*)\))?$/.exec(rule);
  if (!parsed || parsed[1] !== request.tool) return false;
  const pattern = parsed[2];
  if (pattern === undefined) return true;
  if (request.tool === 'WebSearch') return false;
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
  // `//abs` patterns compare against an absolute target; every other pattern against a project-relative one.
  if (pattern.startsWith('//')) return new RegExp('^' + globSource(pattern.slice(1)) + '$').test(target);
  return new RegExp('^' + globSource(pattern.replace(/^\/(?!\/)/, '')) + '$').test(target.replace(/^\.\//, ''));
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

/**
 * Command prefixes that must never be offered or saved as prefix wildcard rules (Codex
 * `BANNED_PREFIX_SUGGESTIONS`, `codex-rs/core/src/exec_policy.rs:64-153`, pinned 090be4df).
 */
export const BANNED_PREFIX_SUGGESTIONS: readonly (readonly string[])[] = [
  ['/bin/bash'],
  ['/bin/bash', '-c'],
  ['/bin/bash', '-lc'],
  ['/bin/sh'],
  ['/bin/sh', '-c'],
  ['/bin/sh', '-lc'],
  ['/bin/zsh'],
  ['/bin/zsh', '-c'],
  ['/bin/zsh', '-lc'],
  ['Rscript'],
  ['bash'],
  ['bash', '-c'],
  ['bash', '-lc'],
  ['bun'],
  ['bun', '-e'],
  ['bun', 'run'],
  ['cmd'],
  ['cmd', '/c'],
  ['cmd', '/k'],
  ['cmd.exe'],
  ['cmd.exe', '/c'],
  ['cmd.exe', '/k'],
  ['dash'],
  ['dash', '-c'],
  ['deno'],
  ['deno', 'eval'],
  ['env'],
  ['fish'],
  ['fish', '-c'],
  ['git'],
  ['julia'],
  ['julia', '-e'],
  ['ksh'],
  ['ksh', '-c'],
  ['lua'],
  ['lua', '-e'],
  ['node'],
  ['node', '-e'],
  ['nodejs'],
  ['nodejs', '-e'],
  ['npm', 'run'],
  ['osascript'],
  ['perl'],
  ['perl', '-e'],
  ['php'],
  ['php', '-r'],
  ['pnpm', 'run'],
  ['powershell'],
  ['powershell', '-Command'],
  ['powershell', '-EncodedCommand'],
  ['powershell', '-File'],
  ['powershell', '-c'],
  ['powershell.exe'],
  ['powershell.exe', '-Command'],
  ['powershell.exe', '-EncodedCommand'],
  ['powershell.exe', '-File'],
  ['powershell.exe', '-c'],
  ['pwsh'],
  ['pwsh', '-Command'],
  ['pwsh', '-EncodedCommand'],
  ['pwsh', '-File'],
  ['pwsh', '-c'],
  ['pwsh', '-e'],
  ['pwsh', '-ec'],
  ['pwsh', '-f'],
  ['py'],
  ['py', '-3'],
  ['pypy'],
  ['pypy3'],
  ['python'],
  ['python', '-'],
  ['python', '-c'],
  ['python3'],
  ['python3', '-'],
  ['python3', '-c'],
  ['pythonw'],
  ['pyw'],
  ['rm'],
  ['ruby'],
  ['ruby', '-e'],
  ['sh'],
  ['sh', '-c'],
  ['sh', '-lc'],
  ['sudo'],
  ['yarn', 'run'],
  ['zsh'],
  ['zsh', '-c'],
  ['zsh', '-lc'],
];

const RULE_INTERPRETERS = new Set(['doas', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'npx', 'bunx', 'ssh']);

function commandVariants(words: readonly string[]): string[][] {
  if (!words.length) return [];
  const lower = words.map(w => w.toLowerCase());
  const base = lower[0]!.replace(/^.*[\\/]/, '');
  return base && base !== lower[0] ? [lower, [base, ...lower.slice(1)]] : [lower];
}

/**
 * True when `words` is a banned prefix suggestion or a broader prefix of one (e.g. `npm` for
 * `npm run`, or `git push` under `git`): never generalize to `Tool(<prefix>:*)`.
 */
export function isBannedPrefixSuggestion(words: readonly string[]): boolean {
  if (!words.length || words.some(w => !w || w.includes('*'))) return true;
  for (const variant of commandVariants(words)) {
    if (RULE_INTERPRETERS.has(variant[0]!)) return true;
    for (const banned of BANNED_PREFIX_SUGGESTIONS) {
      const len = Math.min(variant.length, banned.length);
      if (len > 0 && Array.from({length: len}, (_, i) => variant[i] === banned[i]!.toLowerCase()).every(Boolean))
        return true;
    }
  }
  return false;
}

/** True when an exact command has no concrete operand beyond a banned prefix or interpreter name. */
function isMeaninglessExactCommand(words: readonly string[]): boolean {
  if (!words.length || words.some(w => !w || w.includes('*'))) return true;
  for (const variant of commandVariants(words)) {
    if (variant.length === 1 && RULE_INTERPRETERS.has(variant[0]!)) return true;
    for (const banned of BANNED_PREFIX_SUGGESTIONS) {
      if (variant.length <= banned.length && variant.every((word, index) => word === banned[index]!.toLowerCase()))
        return true;
    }
  }
  return false;
}

/**
 * Codex `BANNED_PREFIX_SUGGESTIONS` + `prefix_rule_would_approve_all_commands` guard: an `always`
 * amendment must be a valid scoped rule, never a catch-all (`Bash`, `Bash(*)`), never a banned
 * prefix wildcard. When `request` is supplied, the
 * rule must also approve every segment of that request.
 */
export function isSafeAlwaysRule(
  rule: string,
  request?: {tool: PermissionRuleTool; target: string; segments?: string[] | null},
): boolean {
  if (!permissionRuleSchema.safeParse(rule).success) return false;
  if (rule.startsWith('mcp__')) {
    const parts = rule.split('__');
    // An exact tool (`mcp__server__tool`) can be saved. A whole server or a wildcard cannot.
    if (parts.length !== 3 || parts.some(part => !part || part.includes('*'))) return false;
    if (
      request &&
      permissionRuleDecision({allow: [rule], ask: [], deny: []}, {tool: 'Mcp', target: request.target}) !== 'allow'
    )
      return false;
    return true;
  }
  const parsed = /^(\w+)(?:\((.*)\))?$/.exec(rule);
  if (!parsed || !parsed[2]) return false;
  const tool = parsed[1] as PermissionRuleTool;
  const pattern = parsed[2].trim();
  if (!pattern || /^\*+$|^:\*$/.test(pattern)) return false;
  if (COMMAND_RULE_TOOLS.includes(tool)) {
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2).trim();
      if (!prefix || prefix.includes('*')) return false;
      if (isBannedPrefixSuggestion(prefix.split(/\s+/).filter(Boolean))) return false;
    } else {
      if (pattern.includes('*')) return false;
      if (isMeaninglessExactCommand(pattern.split(/\s+/).filter(Boolean))) return false;
    }
    if (permissionRuleMatches(rule, {tool, target: '__futryn_unrelated_command__'})) return false;
    if (request && permissionRuleDecision({allow: [rule], ask: [], deny: []}, request) !== 'allow') return false;
  }
  return true;
}

/**
 * The project Allow rule an `always` answer saves (ADR 0028/0055), Claude style: a command prefix
 * (`Bash(npm test:*)`) - or the exact command for a banned prefix, an interpreter/wrapper
 * or an `exact` request such as a dangerous command - the exact file for edits and secret reads, the
 * domain for web access. Null when no meaningful rule can safely stand for the request.
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
    if (!command || /[;&|<>`\n*]|\$\(/.test(command)) return null;
    const words = command.split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const prefixWords =
      words.length > 1 && !words[1]!.startsWith('-') && /^[\w.:@/-]+$/.test(words[1]!)
        ? [words[0]!, words[1]!]
        : [words[0]!];
    const exact = request.exact || isBannedPrefixSuggestion(prefixWords);
    const rule = exact ? `${request.tool}(${command})` : `${request.tool}(${prefixWords.join(' ')}:*)`;
    return isSafeAlwaysRule(rule, {
      tool: request.tool,
      target: request.target.trim(),
      segments: [request.target.trim()],
    })
      ? rule
      : null;
  }
  if (request.tool === 'Edit' || request.tool === 'Read') {
    const path = clean(request.target);
    const rule = path && !path.includes(', ') ? `${request.tool}(${path})` : null;
    return rule && isSafeAlwaysRule(rule) ? rule : null;
  }
  if (request.tool === 'WebFetch') {
    let host = clean(request.target);
    try {
      host = new URL(request.target).hostname;
    } catch {
      /* plain host */
    }
    const rule = host ? `WebFetch(domain:${host})` : null;
    return rule && isSafeAlwaysRule(rule) ? rule : null;
  }
  return null;
}

/** Where a settings file lives (ADR 0061). `cli` is the launch overlay (`--allowedTools`, `--disallowedTools`) and is not stored. */
export type PermissionSettingsScope = 'user' | 'project' | 'local';
export const PERMISSION_SETTINGS_SCOPES: readonly PermissionSettingsScope[] = ['user', 'project', 'local'];

/** One settings file as `/permissions` shows it. */
export interface PermissionSettingsFileInfo {
  scope: PermissionSettingsScope;
  path: string;
  exists: boolean;
  /** Repository files count only after the user approved their exact content; user settings always do. */
  trusted: boolean;
  rules: PermissionRuleSet;
  defaultMode?: PermissionMode;
  allowedDomains: string[];
  diagnostics: string[];
}

/** A repository settings file whose content would loosen something, waiting for the user's decision. */
export interface PendingSettingsTrust {
  scope: Exclude<PermissionSettingsScope, 'user'>;
  path: string;
  hash: string;
  /** What approving would grant, one line each. */
  grants: string[];
}

/** Everything the permission engine reads from settings, already merged and trust-filtered. */
export interface PermissionSettingsSnapshot {
  rules: PermissionRuleSet;
  defaultMode?: PermissionMode;
  /** Absolute directories commands and edits may write besides the working directory. */
  additionalDirectories: string[];
  sandbox: {
    enabled: boolean;
    autoAllowBashIfSandboxed: boolean;
    excludedCommands: string[];
    allowUnsandboxedCommands: boolean;
    allowedDomains: string[];
  };
  files: PermissionSettingsFileInfo[];
  pendingTrust: PendingSettingsTrust[];
  diagnostics: string[];
}

/**
 * The settings port the SDK reads (implemented by the composition root, which owns the files).
 * Writes are user actions (`/permissions`, an `always` answer) and are trusted immediately.
 */
export type SandboxSettingsPatch = Partial<
  Pick<PermissionSettingsSnapshot['sandbox'], 'enabled' | 'autoAllowBashIfSandboxed' | 'allowUnsandboxedCommands'>
> & {excludeCommand?: string};

export interface PermissionSettingsPort {
  /** Explicit user action; writes user settings only. */
  updateSandbox?(patch: SandboxSettingsPatch): void;
  snapshot(): PermissionSettingsSnapshot;
  addRule(scope: PermissionSettingsScope, effect: PermissionRuleEffect, rule: string): void;
  removeRule(scope: PermissionSettingsScope, effect: PermissionRuleEffect, rule: string): void;
  addAllowedDomain(scope: PermissionSettingsScope, domain: string): void;
  /** Approve one exact file content: persisted (`always`) or for this session only. */
  trust(path: string, hash: string, persist: boolean): void;
}

/** Domains as `sandbox.network.allowedDomains` entries: `example.com` or `*.example.com`. */
export const DOMAIN_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function hostMatchesDomainPattern(host: string, pattern: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  const wanted = pattern.toLowerCase();
  return wanted.startsWith('*.') ? name.endsWith(wanted.slice(1)) : name === wanted;
}

export function domainAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => hostMatchesDomainPattern(host, pattern));
}
