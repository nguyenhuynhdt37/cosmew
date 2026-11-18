import {
  PERMISSION_PRESETS,
  type PermissionMode,
  type PermissionPresetId,
  type PermissionResolutionScope,
  type PermissionRuleEffect,
} from '@futryn/contracts';

/**
 * Dialog answers (ADR 0055, Codex `ReviewDecision`): `once`, `session`, `always` (saves the
 * request's Allow rule for this project, ADR 0028) and `deny`.
 */
export type PermissionDialogAction = PermissionResolutionScope;

export interface PermissionDialogState {
  selectedIndex: number;
  scrollOffset?: number;
  selectedAction: PermissionDialogAction;
}

export function createInitialPermissionDialogState(): PermissionDialogState {
  return {selectedIndex: 0, selectedAction: 'deny'};
}

/** Order the decision buttons are cycled with ←/→. */
export const PERMISSION_ACTIONS: readonly PermissionDialogAction[] = ['once', 'session', 'deny', 'always'];

/** Tabs of the rule screen shown when nothing is waiting. */
export type PermissionRulesTab = PermissionRuleEffect | 'mode';
export const PERMISSION_RULE_TABS: readonly PermissionRulesTab[] = ['allow', 'ask', 'deny', 'mode'];

export interface PermissionRulesState {
  tab: PermissionRulesTab;
  /** 0 is "Add a new rule…" on rule tabs; a mode index on the Mode tab. */
  selectedIndex: number;
  /** Text being typed for a new rule, or null when not editing. */
  input: string | null;
  /** Full Access was chosen once: Enter again confirms it, anything else cancels (ADR 0055). */
  confirmFullAccess?: boolean;
  error?: string;
}

export function createInitialRulesState(): PermissionRulesState {
  return {tab: 'allow', selectedIndex: 0, input: null};
}

/** What the Mode tab lists: the Codex presets first, then approval-only modes that keep the sandbox. */
export type ModeEntry = {kind: 'preset'; id: PermissionPresetId} | {kind: 'mode'; mode: PermissionMode};
export const MODE_ENTRIES: readonly ModeEntry[] = [
  ...PERMISSION_PRESETS.map(preset => ({kind: 'preset' as const, id: preset.id})),
  ...(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const).map(mode => ({kind: 'mode' as const, mode})),
];
