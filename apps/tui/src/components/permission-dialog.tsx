import type {
  BorderStyle,
  PermissionPromptRequest,
  PermissionResolutionScope,
  ThemeTokens,
} from '@hannes/contracts';
import { getBorderGlyphs } from '../theme/theme';
import type { RenderedBoxLine } from './editor';

export interface PermissionDialogState {
  selectedIndex: number;
  selectedAction: PermissionResolutionScope;
}

export function createInitialPermissionDialogState(): PermissionDialogState {
  return {
    selectedIndex: 0,
    selectedAction: 'once',
  };
}

export function renderPermissionDialogOverlay(options: {
  width: number;
  height: number;
  requests: PermissionPromptRequest[];
  state: PermissionDialogState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const { width, height, requests, state, tokens, borderStyle } = options;
  const innerWidth = Math.max(24, width - 2);
  const glyphs = getBorderGlyphs(borderStyle);
  const bg = tokens.overlayBackground;
  const lines: RenderedBoxLine[] = [];

  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const title = ` SECURITY PERMISSION GATE (${pendingCount} Pending) `;
  const rightMeta = ' Esc Dismiss (Never Grants) ';
  const topFill = Math.max(0, innerWidth - title.length - rightMeta.length);

  lines.push({
    spans: [
      { text: glyphs.topLeft, fg: tokens.warning, bg },
      { text: title, fg: tokens.accentForeground, bg: tokens.warning, bold: true },
      { text: glyphs.horizontal.repeat(topFill), fg: tokens.warning, bg },
      { text: rightMeta.slice(0, Math.max(0, innerWidth - title.length)), fg: tokens.foregroundMuted, bg },
      { text: glyphs.topRight, fg: tokens.warning, bg },
    ],
  });

  const pushPaddedRow = (text: string, fg = tokens.foreground, rowBg = bg, bold = false) => {
    lines.push({
      spans: [
        { text: glyphs.vertical, fg: tokens.warning, bg },
        { text: text.slice(0, innerWidth).padEnd(innerWidth, ' '), fg, bg: rowBg, bold },
        { text: glyphs.vertical, fg: tokens.warning, bg },
      ],
    });
  };

  if (requests.length === 0) {
    pushPaddedRow(' Tool policy configuration: Not implemented in PA1/TUI1.', tokens.warning);
    pushPaddedRow(' No permission requests in the current session.', tokens.foregroundMuted);
    pushPaddedRow(' Note: Closing or cancelling a permission prompt never grants permission.', tokens.info);
  } else {
    const idx = Math.max(0, Math.min(requests.length - 1, state.selectedIndex));
    const req = requests[idx]!;
    const riskColor =
      req.riskLevel === 'high'
        ? tokens.error
        : req.riskLevel === 'medium'
          ? tokens.warning
          : tokens.info;

    pushPaddedRow(
      ` Request ${idx + 1}/${requests.length} · ID: ${req.approvalId.slice(0, 12)} · Status: ${req.status.toUpperCase()}`,
      tokens.foregroundMuted,
      tokens.backgroundElevated,
      true,
    );
    pushPaddedRow(` Capability : ${req.capability}   │   Risk Level: ${req.riskLevel.toUpperCase()}`, riskColor, bg, true);
    pushPaddedRow(` Action     : ${req.action}`, tokens.foreground, bg, true);
    pushPaddedRow(` Target     : ${req.target}`, tokens.info, bg);
    pushPaddedRow(` Reason     : ${req.reason}`, tokens.foregroundMuted, bg);
    pushPaddedRow(` Scope Hash : ${req.scopeHash}`, tokens.foregroundSubtle, bg);

    if (req.diffPreview) {
      pushPaddedRow(' Diff Preview:', tokens.foregroundMuted, bg, true);
      for (const dLine of req.diffPreview.split('\n').slice(0, 4)) {
        const dFg = dLine.startsWith('+')
          ? tokens.diffAdded
          : dLine.startsWith('-')
            ? tokens.diffRemoved
            : tokens.diffContext;
        pushPaddedRow(`   ${dLine}`, dFg, tokens.backgroundElevated);
      }
    }

    pushPaddedRow('');
    if (req.status === 'pending') {
      const choices: { key: PermissionResolutionScope; label: string }[] = [
        { key: 'once', label: '[1] Allow Once' },
        { key: 'session', label: '[2] Allow for Session' },
        { key: 'deny', label: '[3] Deny' },
      ];
      const buttonLine = choices
        .map(c => (c.key === state.selectedAction ? ` ▸ ${c.label} ◂ ` : `   ${c.label}   `))
        .join('  ');
      pushPaddedRow(
        ` Decision: ${buttonLine}`,
        state.selectedAction === 'deny' ? tokens.error : tokens.success,
        tokens.selection,
        true,
      );
    } else {
      pushPaddedRow(` Decision Finalized: ${req.status.toUpperCase()}`, tokens.foregroundMuted);
    }
  }

  const targetBodyRows = Math.max(6, height - 2);
  while (lines.length < targetBodyRows) {
    pushPaddedRow('');
  }

  const footer =
    ' ←/→ Select Action · Enter Confirm · 1 Allow Once · 2 Session · 3/Esc Deny ';
  const footerFill = Math.max(0, innerWidth - footer.length);
  lines.push({
    spans: [
      { text: glyphs.bottomLeft, fg: tokens.warning, bg },
      { text: footer.slice(0, innerWidth), fg: tokens.foregroundSubtle, bg },
      { text: glyphs.horizontal.repeat(footerFill), fg: tokens.warning, bg },
      { text: glyphs.bottomRight, fg: tokens.warning, bg },
    ],
  });

  return lines;
}
