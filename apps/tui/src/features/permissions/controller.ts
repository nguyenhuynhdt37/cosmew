import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {stepIndex} from '../../ui';
import {PERMISSION_MODES} from '@futryn/contracts';
import {
  PERMISSION_ACTIONS,
  PERMISSION_RULE_TABS,
  createInitialPermissionDialogState,
  createInitialRulesState,
  suggestedRule,
  type PermissionDialogState,
  type PermissionRulesState,
} from './types';
import {renderPermissionDialogOverlay, renderPermissionRulesOverlay} from './view';

export class PermissionsFeature implements OverlayFeature {
  readonly overlays = ['permissions'] as const;
  private selectedApprovalId: string | null = null;
  private state: PermissionDialogState = createInitialPermissionDialogState();
  private rules: PermissionRulesState = createInitialRulesState();

  constructor(private readonly host: TuiHost) {}

  open(): void {
    this.state = createInitialPermissionDialogState();
    this.rules = createInitialRulesState();
    this.selectedApprovalId = null;
    this.pending();
  }

  close(): void {
    if (
      this.selectedApprovalId &&
      this.host.client.listPendingPermissions().some(r => r.approvalId === this.selectedApprovalId)
    ) {
      try {
        this.host.client.dismissPermissionDialog(this.selectedApprovalId);
      } catch {
        this.host.setBanner('Permission request expired or changed.');
      }
    }
    this.selectedApprovalId = null;
  }

  private pending() {
    const requests = this.host.client.listPendingPermissions();
    const previous = requests.findIndex(r => r.approvalId === this.selectedApprovalId);
    const index = previous >= 0 ? previous : 0;
    const id = requests[index]?.approvalId ?? null;
    if (id !== this.selectedApprovalId) this.state = {...this.state, selectedAction: 'deny', scrollOffset: 0};
    this.selectedApprovalId = id;
    this.state.selectedIndex = index;
    return requests;
  }

  layout(_overlay: 'permissions', cols: number, rows: number) {
    const pending = this.pending().length;
    if (!pending) return {width: Math.min(cols - 2, 82), height: Math.min(rows - 2, 20), backdrop: true};
    return {width: Math.min(cols - 2, 82), height: Math.min(rows - 2, 18), backdrop: true};
  }

  render(_overlay: 'permissions', size: {width: number; height: number}, theme: ThemeFrame) {
    if (!this.pending().length) {
      const client = this.host.client;
      return renderPermissionRulesOverlay({
        ...size,
        rules: client.permissionRules(),
        mode: client.permissionMode(),
        grants: client.listToolGrants(),
        state: this.rules,
        tokens: theme.tokens,
        borderStyle: theme.borderStyle,
      });
    }
    return renderPermissionDialogOverlay({
      ...size,
      workspaceReading: this.host.client.status().workspaceReadStatus,
      requests: this.host.client.listPermissions(),
      grants: this.host.client.listToolGrants(),
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  handleKey(_overlay: 'permissions', key: string): void {
    const {host} = this;
    const requests = this.pending();
    const state = this.state;
    const current = requests[Math.max(0, Math.min(Math.max(0, requests.length - 1), state.selectedIndex))];
    if (!requests.length && key !== 'Ctrl+X') {
      this.rulesKey(key);
      return;
    }

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
      host.setBanner(
        count ? `Revoked ${count} session grant(s); tools will ask again.` : 'No session grants to revoke.',
      );
      return;
    }
    if (key === 'PageDown' || key === 'PageUp') {
      this.state = {...state, scrollOffset: Math.max(0, (state.scrollOffset ?? 0) + (key === 'PageDown' ? 3 : -3))};
      return;
    }
    if (!current) return;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (requests.length) {
        const selectedIndex = stepIndex(state.selectedIndex, key, requests.length);
        this.selectedApprovalId = requests[selectedIndex]!.approvalId;
        this.state = {...state, selectedIndex, selectedAction: 'deny', scrollOffset: 0};
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const delta = key === 'ArrowRight' ? 1 : -1;
      // "Don't ask again" exists only when a rule can be suggested for this request.
      const actions = PERMISSION_ACTIONS.filter(action => action !== 'rule' || suggestedRule(current));
      const next =
        actions[(Math.max(0, actions.indexOf(state.selectedAction)) + delta + actions.length) % actions.length]!;
      this.state = {...state, selectedAction: next};
      return;
    }
    const rule = current ? suggestedRule(current) : null;
    if (key === '1') this.state = {...state, selectedAction: 'once'};
    else if (key === '2') this.state = {...state, selectedAction: 'session'};
    else if (key === '3') this.state = {...state, selectedAction: 'deny'};
    else if (key === '4' && rule) this.state = {...state, selectedAction: 'rule'};
    if (state.selectedAction === 'rule' && !rule) this.state = {...this.state, selectedAction: 'deny'};

    if (
      (key === 'Enter' || key === '1' || key === '2' || key === '3' || (key === '4' && rule)) &&
      current &&
      current.status === 'pending'
    ) {
      const choice =
        key === '1'
          ? 'once'
          : key === '2'
            ? 'session'
            : key === '3'
              ? 'deny'
              : key === '4'
                ? 'rule'
                : this.state.selectedAction;
      // "Don't ask again" saves an Allow rule for this project, then approves this request once.
      if (choice === 'rule' && rule) {
        try {
          host.client.addPermissionRule('allow', rule);
        } catch {
          host.setBanner(`Could not save rule ${rule}.`);
          return;
        }
      }
      if (choice === 'rule' && !rule) return;
      const decision = choice === 'rule' ? 'once' : choice;
      try {
        host.client.resolvePermission(current.approvalId, current.scopeHash, decision);
      } catch {
        host.setBanner('Permission request expired or changed; review the current request.');
        if (!this.pending().length) host.closeOverlay();
        return;
      }
      host.setBanner(
        choice === 'rule'
          ? `Allowed and saved rule ${rule} for this project (/permissions to edit).`
          : `Permission ${current.approvalId.slice(0, 8)}: ${decision.toUpperCase()}.`,
      );
      // The dialog was opened for this request; return to the chat once nothing else waits.
      if (!host.client.listPendingPermissions().length) host.closeOverlay();
    }
  }

  /** Rule screen keys: ←/→ tabs, ↑/↓ select, Enter add/use, Delete remove, typing edits a new rule. */
  private rulesKey(key: string): void {
    const {host} = this;
    const client = host.client;
    const rules = this.rules;
    if (rules.input !== null) {
      if (key === 'Escape') {
        this.rules = {...rules, input: null, error: undefined};
        return;
      }
      if (key === 'Backspace') {
        this.rules = {...rules, input: rules.input.slice(0, -1), error: undefined};
        return;
      }
      if (key === 'Enter') {
        if (rules.tab === 'mode') return;
        try {
          client.addPermissionRule(rules.tab, rules.input);
        } catch {
          this.rules = {
            ...rules,
            error: 'Not a rule. Use Bash(cmd:*), Read(glob), Edit(glob), WebFetch(domain:x) or Tool(name).',
          };
          return;
        }
        host.setBanner(`Saved ${rules.tab} rule ${rules.input.trim()}.`);
        this.rules = {
          ...rules,
          input: null,
          error: undefined,
          selectedIndex: client.permissionRules()[rules.tab].indexOf(rules.input.trim()) + 1,
        };
        return;
      }
      if (key === 'Space') {
        this.rules = {...rules, input: rules.input + ' ', error: undefined};
        return;
      }
      if ([...key].length === 1 && rules.input.length < 500)
        this.rules = {...rules, input: rules.input + key, error: undefined};
      return;
    }
    if (key === 'Escape') {
      this.close();
      host.closeOverlay();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab' || key === 'Shift+Tab') {
      const step = key === 'ArrowLeft' || key === 'Shift+Tab' ? -1 : 1;
      const tab =
        PERMISSION_RULE_TABS[
          (PERMISSION_RULE_TABS.indexOf(rules.tab) + step + PERMISSION_RULE_TABS.length) % PERMISSION_RULE_TABS.length
        ]!;
      this.rules = {
        tab,
        selectedIndex: tab === 'mode' ? Math.max(0, PERMISSION_MODES.indexOf(client.permissionMode())) : 0,
        input: null,
      };
      return;
    }
    const size = rules.tab === 'mode' ? PERMISSION_MODES.length : client.permissionRules()[rules.tab].length + 1;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.rules = {...rules, selectedIndex: stepIndex(rules.selectedIndex, key, size)};
      return;
    }
    if (rules.tab === 'mode') {
      if (key === 'Enter') {
        const mode = PERMISSION_MODES[rules.selectedIndex]!;
        client.setPermissionMode(mode);
        host.setBanner(`Permission mode: ${mode}.`);
      }
      return;
    }
    if (key === 'Enter' && rules.selectedIndex === 0) {
      this.rules = {...rules, input: ''};
      return;
    }
    if ((key === 'Delete' || key === 'Backspace' || key === 'd') && rules.selectedIndex > 0) {
      const rule = client.permissionRules()[rules.tab][rules.selectedIndex - 1];
      if (!rule) return;
      client.removePermissionRule(rules.tab, rule);
      host.setBanner(`Removed ${rules.tab} rule ${rule}.`);
      this.rules = {...rules, selectedIndex: Math.min(rules.selectedIndex, client.permissionRules()[rules.tab].length)};
    }
  }
}
