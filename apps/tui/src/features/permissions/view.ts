import type { BorderStyle, PermissionPromptRequest, PermissionResolutionScope, ThemeTokens } from '@hannes/contracts';
import { Modal, clampIndex, type RenderedBoxLine } from '../../ui';
import type { PermissionDialogState } from './types';

export function renderPermissionDialogOverlay(options: {
  width: number;
  height: number;
  requests: PermissionPromptRequest[];
  state: PermissionDialogState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, requests, state, tokens, borderStyle } = options;
  const modal = new Modal({
    width, height, tokens, borderStyle,
    borderColor: tokens.warning,
    titleStyle: { fg: tokens.accentForeground, bg: tokens.warning },
  });
  const row = (text: string, fg = tokens.foreground, bg = modal.bg, bold = false) => modal.text(text, { fg, bg, bold });

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  modal.top(` SECURITY PERMISSION GATE (${pendingCount} Pending) `, ' Esc Dismiss (Never Grants) ');

  if (requests.length === 0) {
    row(' Tool policy configuration: Not implemented in PA1/TUI1.', tokens.warning);
    row(' No permission requests in the current session.', tokens.foregroundMuted);
    row(' Note: Closing or cancelling a permission prompt never grants permission.', tokens.info);
  } else {
    const idx = clampIndex(state.selectedIndex, requests.length);
    const req = requests[idx]!;
    const riskColor = req.riskLevel === 'high' ? tokens.error : req.riskLevel === 'medium' ? tokens.warning : tokens.info;

    row(` Request ${idx + 1}/${requests.length} · ID: ${req.approvalId.slice(0, 12)} · Status: ${req.status.toUpperCase()}`, tokens.foregroundMuted, tokens.backgroundElevated, true);
    row(` Capability : ${req.capability}   │   Risk Level: ${req.riskLevel.toUpperCase()}`, riskColor, modal.bg, true);
    row(` Action     : ${req.action}`, tokens.foreground, modal.bg, true);
    row(` Target     : ${req.target}`, tokens.info);
    row(` Reason     : ${req.reason}`, tokens.foregroundMuted);
    row(` Scope Hash : ${req.scopeHash}`, tokens.foregroundSubtle);

    if (req.diffPreview) {
      row(' Diff Preview:', tokens.foregroundMuted, modal.bg, true);
      for (const line of req.diffPreview.split('\n').slice(0, 4)) {
        const fg = line.startsWith('+') ? tokens.diffAdded : line.startsWith('-') ? tokens.diffRemoved : tokens.diffContext;
        row(`   ${line}`, fg, tokens.backgroundElevated);
      }
    }

    modal.blank();
    if (req.status === 'pending') {
      const choices: { key: PermissionResolutionScope; label: string }[] = [
        { key: 'once', label: '[1] Allow Once' },
        { key: 'session', label: '[2] Allow for Session' },
        { key: 'deny', label: '[3] Deny' },
      ];
      const buttons = choices.map(c => (c.key === state.selectedAction ? ` ▸ ${c.label} ◂ ` : `   ${c.label}   `)).join('  ');
      row(` Decision: ${buttons}`, state.selectedAction === 'deny' ? tokens.error : tokens.success, tokens.selection, true);
    } else {
      row(` Decision Finalized: ${req.status.toUpperCase()}`, tokens.foregroundMuted);
    }
  }

  return modal.fillTo(Math.max(6, height - 2)).bottom(' ←/→ Select Action · Enter Confirm · 1 Allow Once · 2 Session · 3/Esc Deny ').lines;
}
