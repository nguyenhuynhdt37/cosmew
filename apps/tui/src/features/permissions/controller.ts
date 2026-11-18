import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {stepIndex} from '../../ui';
import {FULL_ACCESS_WARNING} from '@futryn/contracts';
import {
  MODE_ENTRIES,
  PERMISSION_ACTIONS,
  PERMISSION_RULE_TABS,
  createInitialPermissionDialogState,
  createInitialRulesState,
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
    return {width: Math.min(cols - 2, 82), height: Math.min(rows - 2, 20), backdrop: true};
  }

  render(_overlay: 'permissions', size: {width: number; height: number}, theme: ThemeFrame) {
    if (!this.pending().length) {
      const client = this.host.client;
      return renderPermissionRulesOverlay({
        ...size,
        rules: client.permissionRules(),
        mode: client.permissionMode(),
        preset: client.permissionPreset(),
        grants: client.listToolGrants(),
        state: this.rules,
        tokens: theme.tokens,
        borderStyle: theme.borderStyle,
      });
    }
    return renderPermissionDialogOverlay({
      ...size,
      workspaceReading: this.host.client.status().workspaceReadStatus,
      terminalRuntime: this.host.client.status().terminalRuntime,
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
      // Only the answers this request offers (ADR 0055): `always` needs a rule that can stand for it.
      const actions = PERMISSION_ACTIONS.filter(action => action === 'deny' || current.decisions.includes(action));
      const next =
        actions[(Math.max(0, actions.indexOf(state.selectedAction)) + delta + actions.length) % actions.length]!;
      this.state = {...state, selectedAction: next};
      return;
    }
    const offered = (action: 'once' | 'session' | 'always') => current.decisions.includes(action);
    if (key === '1' && offered('once')) this.state = {...state, selectedAction: 'once'};
    else if (key === '2' && offered('session')) this.state = {...state, selectedAction: 'session'};
    else if (key === '3') this.state = {...state, selectedAction: 'deny'};
    else if (key === '4' && offered('always') && current.alwaysRule) this.state = {...state, selectedAction: 'always'};

    const chosen =
      key === '1'
        ? 'once'
        : key === '2'
          ? 'session'
          : key === '3'
            ? 'deny'
            : key === '4'
              ? 'always'
              : key === 'Enter'
                ? this.state.selectedAction
                : null;
    if (chosen && current.status === 'pending') {
      // A key for an answer the request does not offer is ignored; Enter on one denies.
      if (chosen !== 'deny' && !offered(chosen)) {
        if (key === 'Enter') this.state = {...this.state, selectedAction: 'deny'};
        return;
      }
      try {
        // `always` saves the request's Allow rule for this project first, then approves (Codex amendment).
        host.client.resolvePermission(current.approvalId, current.scopeHash, chosen);
      } catch {
        host.setBanner(
          chosen === 'always'
            ? `Could not save rule ${current.alwaysRule ?? ''}; the request is still waiting.`
            : 'Permission request expired or changed; review the current request.',
        );
        if (!this.pending().length) host.closeOverlay();
        return;
      }
      host.setBanner(
        chosen === 'always'
          ? `Allowed and saved rule ${current.alwaysRule} for this project (/permissions to edit).`
          : `Permission ${current.approvalId.slice(0, 8)}: ${chosen.toUpperCase()}.`,
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
        selectedIndex: tab === 'mode' ? this.currentModeIndex() : 0,
        input: null,
      };
      return;
    }
    const size = rules.tab === 'mode' ? MODE_ENTRIES.length : client.permissionRules()[rules.tab].length + 1;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.rules = {...rules, selectedIndex: stepIndex(rules.selectedIndex, key, size), confirmFullAccess: false};
      return;
    }
    if (rules.tab === 'mode') {
      if (key === 'Enter') this.chooseMode(MODE_ENTRIES[rules.selectedIndex]!);
      else if (rules.confirmFullAccess) this.rules = {...rules, confirmFullAccess: false};
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

  /** The Mode tab row of the session's current preset (or, for a custom pair, its approval mode). */
  private currentModeIndex(): number {
    const {client} = this.host;
    const preset = client.permissionPreset();
    const index = MODE_ENTRIES.findIndex(entry =>
      preset === 'custom'
        ? entry.kind === 'mode' && entry.mode === client.permissionMode()
        : entry.kind === 'preset' && entry.id === preset,
    );
    return Math.max(0, index);
  }

  /** Apply a Mode tab row. Full Access asks for a second Enter, with the warning (ADR 0055). */
  private chooseMode(entry: (typeof MODE_ENTRIES)[number]): void {
    const {host} = this;
    const client = host.client;
    if (entry.kind === 'mode') {
      client.setPermissionMode(entry.mode);
      host.setBanner(`Permission mode: ${entry.mode}.`);
      this.rules = {...this.rules, confirmFullAccess: false};
      return;
    }
    if (entry.id === 'full-access' && !this.rules.confirmFullAccess && client.permissionPreset() !== 'full-access') {
      this.rules = {...this.rules, confirmFullAccess: true};
      return;
    }
    const preset = client.setPermissionPreset(entry.id);
    host.setBanner(entry.id === 'full-access' ? FULL_ACCESS_WARNING : `Permissions: ${preset.label}.`);
    this.rules = {...this.rules, confirmFullAccess: false};
  }
}
