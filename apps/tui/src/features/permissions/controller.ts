import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { stepIndex } from '../../ui';
import { PERMISSION_ACTIONS, createInitialPermissionDialogState, type PermissionDialogState } from './types';
import { renderPermissionDialogOverlay } from './view';

export class PermissionsFeature implements OverlayFeature {
  readonly overlays = ['permissions'] as const;
  private selectedApprovalId: string | null = null;
  private state: PermissionDialogState = createInitialPermissionDialogState();

  constructor(private readonly host: TuiHost) {}

  open(): void { this.state = createInitialPermissionDialogState(); this.selectedApprovalId = null; this.pending(); }

  close(): void {
    if (this.selectedApprovalId && this.host.client.listPendingPermissions().some(r => r.approvalId === this.selectedApprovalId)) {
      try { this.host.client.dismissPermissionDialog(this.selectedApprovalId); }
      catch { this.host.setBanner('Permission request expired or changed.'); }
    }
    this.selectedApprovalId = null;
  }

  private pending() {
    const requests = this.host.client.listPendingPermissions();
    const previous = requests.findIndex(r => r.approvalId === this.selectedApprovalId);
    const index = previous >= 0 ? previous : 0;
    const id = requests[index]?.approvalId ?? null;
    if (id !== this.selectedApprovalId) this.state = {...this.state, selectedAction: 'deny', scrollOffset: 0};
    this.selectedApprovalId = id; this.state.selectedIndex = index;
    return requests;
  }

  layout(_overlay: 'permissions', cols: number, rows: number) {
    const pending = this.pending().length;
    const grants = this.host.client.listToolGrants().length;
    return {width: Math.min(cols - 2, 82), height: Math.min(rows - 2, pending ? 17 : 9 + Math.min(grants, 5)), backdrop: true};
  }

  render(_overlay: 'permissions', size: { width: number; height: number }, theme: ThemeFrame) {
    this.pending();
    return renderPermissionDialogOverlay({ ...size, workspaceReading: this.host.client.status().workspaceReadStatus, requests: this.host.client.listPermissions(), grants: this.host.client.listToolGrants(), state: this.state, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  handleKey(_overlay: 'permissions', key: string): void {
    const { host } = this;
    const requests = this.pending();
    const state = this.state;
    const current = requests[Math.max(0, Math.min(Math.max(0, requests.length - 1), state.selectedIndex))];

    // Closing or pressing Esc NEVER grants permission.
    if (key === 'Escape') {
      if (current && current.status === 'pending') {
        host.setBanner('Permission request dismissed.');
      }
      this.close();
      host.closeOverlay();
      return;
    }
    if (key === 'Ctrl+X') {
      const count = host.client.listToolGrants().length;
      host.client.revokeToolGrants();
      host.setBanner(count ? `Revoked ${count} session grant(s); tools will ask again.` : 'No session grants to revoke.');
      return;
    }
    if (key === 'PageDown' || key === 'PageUp') {
      this.state = {...state, scrollOffset: Math.max(0, (state.scrollOffset ?? 0) + (key === 'PageDown' ? 3 : -3))}; return;
    }
    if (!current) return;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (requests.length) {
        const selectedIndex = stepIndex(state.selectedIndex, key, requests.length);
        this.selectedApprovalId = requests[selectedIndex]!.approvalId;
        this.state = { ...state, selectedIndex, selectedAction: 'deny', scrollOffset: 0 };
      }
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
      try { host.client.resolvePermission(current.approvalId, current.scopeHash, decision); }
      catch {
        host.setBanner('Permission request expired or changed; review the current request.');
        if (!this.pending().length) host.closeOverlay();
        return;
      }
      host.setBanner(`Permission ${current.approvalId.slice(0, 8)}: ${decision.toUpperCase()}.`);
      // The dialog was opened for this request; return to the chat once nothing else waits.
      if (!host.client.listPendingPermissions().length) host.closeOverlay();
    }
  }
}
