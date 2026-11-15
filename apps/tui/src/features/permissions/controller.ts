import { wideLayout } from '../../core/layout';
import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { stepIndex } from '../../ui';
import { PERMISSION_ACTIONS, createInitialPermissionDialogState, type PermissionDialogState } from './types';
import { renderPermissionDialogOverlay } from './view';

export class PermissionsFeature implements OverlayFeature {
  readonly overlays = ['permissions'] as const;
  private state: PermissionDialogState = createInitialPermissionDialogState();

  constructor(private readonly host: TuiHost) {}

  open(): void { this.state = createInitialPermissionDialogState(); }

  layout(_overlay: 'permissions', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'permissions', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderPermissionDialogOverlay({ ...size, requests: this.host.client.listPermissions(), state: this.state, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  handleKey(_overlay: 'permissions', key: string): void {
    const { host, state } = this;
    const requests = host.client.listPermissions();
    const current = requests[Math.max(0, Math.min(Math.max(0, requests.length - 1), state.selectedIndex))];

    // Closing or pressing Esc NEVER grants permission.
    if (key === 'Escape') {
      if (current && current.status === 'pending') {
        host.client.dismissPermissionDialog(current.approvalId);
        host.setBanner(`Permission request ${current.approvalId.slice(0, 8)} denied on dialog dismiss.`);
      }
      host.closeOverlay();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (requests.length) this.state = { ...state, selectedIndex: stepIndex(state.selectedIndex, key, requests.length) };
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const delta = key === 'ArrowRight' ? 1 : -1;
      const next = PERMISSION_ACTIONS[(PERMISSION_ACTIONS.indexOf(state.selectedAction) + delta + PERMISSION_ACTIONS.length) % PERMISSION_ACTIONS.length]!;
      this.state = { ...state, selectedAction: next };
      return;
    }
    if (key === '1') this.state = { ...state, selectedAction: 'once' };
    else if (key === '2') this.state = { ...state, selectedAction: 'session' };
    else if (key === '3') this.state = { ...state, selectedAction: 'deny' };

    if ((key === 'Enter' || key === '1' || key === '2' || key === '3') && current && current.status === 'pending') {
      const decision = key === '1' ? 'once' : key === '2' ? 'session' : key === '3' ? 'deny' : state.selectedAction;
      host.client.resolvePermission(current.approvalId, current.scopeHash, decision);
      host.setBanner(`Permission ${current.approvalId.slice(0, 8)}: ${decision.toUpperCase()}.`);
    }
  }
}
