import type { PermissionPromptRequest, PermissionResolutionScope, PermissionRuleEffect } from '@futryn/contracts';

/** `rule` approves once and saves the suggested Allow rule for this project (ADR 0028). */
export type PermissionDialogAction = PermissionResolutionScope | 'rule';

export interface PermissionDialogState {
  selectedIndex: number;
  scrollOffset?: number;
  selectedAction: PermissionDialogAction;
}

export function createInitialPermissionDialogState(): PermissionDialogState {
  return { selectedIndex: 0, selectedAction: 'deny' };
}

/** Order the decision buttons are cycled with ←/→. */
export const PERMISSION_ACTIONS: readonly PermissionDialogAction[] = ['once', 'session', 'deny', 'rule'];

/** Tabs of the rule screen shown when nothing is waiting. */
export type PermissionRulesTab = PermissionRuleEffect | 'mode';
export const PERMISSION_RULE_TABS: readonly PermissionRulesTab[] = ['allow', 'ask', 'deny', 'mode'];

export interface PermissionRulesState {
  tab: PermissionRulesTab;
  /** 0 is "Add a new rule…" on rule tabs; a mode index on the Mode tab. */
  selectedIndex: number;
  /** Text being typed for a new rule, or null when not editing. */
  input: string | null;
  error?: string;
}

export function createInitialRulesState(): PermissionRulesState {
  return { tab: 'allow', selectedIndex: 0, input: null };
}

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'python', 'python3', 'node', 'bun', 'deno', 'perl', 'ruby', 'php', 'env', 'sudo', 'doas', 'xargs', 'eval', 'exec', 'nohup', 'timeout', 'npx', 'bunx', 'osascript', 'ssh']);

/**
 * The rule "don't ask again" would save, Claude style: a command prefix (`Bash(npm test:*)`),
 * the exact file for edits and secret reads, the domain for network.
 */
export function suggestedRule(request: Pick<PermissionPromptRequest, 'capability' | 'target' | 'action'>): string | null {
  const clean = (value: string) => value.replace(/[()\n\u0000-\u001f]/g, '').trim().slice(0, 200);
  if (request.capability === 'process.execute') {
    const command = clean(request.target);
    // Chained, substituted or redirected commands never auto-allow (ADR 0028), so no rule is offered.
    if (!command || /[;&|<>`\n]|\$\(/.test(command)) return null;
    const words = command.split(/\s+/).filter(Boolean);
    // Interpreters and wrappers run arbitrary code; a prefix rule for them would allow anything.
    if (INTERPRETERS.has(words[0]!.replace(/^.*\//, ''))) return `Bash(${command})`;
    const prefix = words.length > 1 && !words[1]!.startsWith('-') && /^[\w.:@/-]+$/.test(words[1]!) ? `${words[0]} ${words[1]}` : words[0]!;
    return `Bash(${prefix}:*)`;
  }
  if (request.capability === 'fs.write') { const path = clean(request.target); return path && !path.includes(', ') ? `Edit(${path})` : null; }
  if (request.capability === 'fs.read') { const path = clean(request.target); return path ? `Read(${path})` : null; }
  if (request.capability === 'network.connect') {
    let host = clean(request.target); try { host = new URL(request.target).hostname; } catch { /* plain host */ }
    return host ? `WebFetch(domain:${host})` : null;
  }
  return null;
}
