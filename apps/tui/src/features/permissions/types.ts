import type { PermissionResolutionScope } from '@hannes/contracts';

export interface PermissionDialogState {
  selectedIndex: number;
  selectedAction: PermissionResolutionScope;
}

export function createInitialPermissionDialogState(): PermissionDialogState {
  return { selectedIndex: 0, selectedAction: 'once' };
}

/** Order the decision buttons are cycled with ←/→. */
export const PERMISSION_ACTIONS: readonly PermissionResolutionScope[] = ['once', 'session', 'deny'];
