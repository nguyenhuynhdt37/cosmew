import type { PermissionResolutionScope } from '@hannes/contracts';

export interface PermissionDialogState {
  selectedIndex: number;
  scrollOffset?: number;
  selectedAction: PermissionResolutionScope;
}

export function createInitialPermissionDialogState(): PermissionDialogState {
  return { selectedIndex: 0, selectedAction: 'deny' };
}

/** Order the decision buttons are cycled with ←/→. */
export const PERMISSION_ACTIONS: readonly PermissionResolutionScope[] = ['once', 'session', 'deny'];
