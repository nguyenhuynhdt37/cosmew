import type { FutrynClient } from '@hannes/sdk';
import type { BorderStyle, PermissionPromptRequest, ThemeTokens } from '@hannes/contracts';
import { Modal, clampIndex, type RenderedBoxLine } from '../../ui';
import type { PermissionDialogState } from './types';
import { parseUnifiedDiff, renderDiffCodeLine } from '../diff/code-lines';

export function renderPermissionDialogOverlay(options: {
  workspaceReading?: ReturnType<FutrynClient['status']>['workspaceReadStatus'];
  width: number; height: number; requests: PermissionPromptRequest[]; grants?: string[];
  state: PermissionDialogState; tokens: ThemeTokens; borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, requests, state, tokens, borderStyle} = options;
  const pending = requests.filter(r => r.status === 'pending');
  const request = pending[clampIndex(state.selectedIndex, pending.length)];
  const grants = options.grants ?? [];
  const modal = new Modal({width, height, minInner: 1, tokens, borderStyle, borderColor: request ? tokens.warning : tokens.borderFocused});
  const title = request ? ' Permission request ' : ' Permissions ';
  modal.top(title.slice(0, modal.innerWidth));
  const body: (string | RenderedBoxLine)[] = [];
  const wrap = (text: string) => {
    const size = Math.max(1, modal.innerWidth - 2);
    for (const line of text.split('\n')) {
      if (!line) body.push('');
      else for (let i = 0; i < line.length; i += size) body.push(' ' + line.slice(i, i + size));
    }
  };
  if (request) {
    wrap(`${state.selectedIndex + 1}/${pending.length} waiting · ${request.capability}`);
    const command = request.capability === 'process.execute';
    wrap(command ? `Command: ${request.target}` : `Target: ${JSON.stringify(request.target)}`);
    wrap(`${command ? 'Where' : 'Action'}: ${request.action}`);
    wrap(`Why: ${request.reason}`);
    wrap(request.capability==='fs.write' ? 'Once applies this exact diff. Session remembers only this patch and original file versions.' : command ? 'Once runs it now. Session allows this exact command in this directory until revoked.' : 'Once applies to this request. Session allows this target until revoked.');
    if (request.diffPreview) {
      wrap('Preview · proposed changes (not applied):');
      const diff = parseUnifiedDiff(request.diffPreview);
      if (diff.length) body.push(...diff.flatMap(line => renderDiffCodeLine(line,modal.innerWidth,tokens)));
      else wrap(request.diffPreview);
    }
  } else {
    wrap('No requests waiting.');
    wrap(options.workspaceReading === 'read-only' ? 'Workspace reading is enabled for this model.' : options.workspaceReading === 'disabled' ? 'Workspace reads are disabled for this session.' : 'Workspace reads are unavailable for this model.');
    wrap('Project files: allowed after folder consent.');
    wrap('Secret files: ask. Outside workspace: denied.');
    wrap('Tools: read, glob, grep; apply_patch asks before writes.');
    wrap('Commands unavailable: process cleanup safety check failed.');
    if (grants.length) {
      wrap(`Allowed this session (${grants.length}, Ctrl+X revokes):`);
      for (const grant of grants) wrap('  ' + JSON.stringify(grant));
    } else wrap('No file or command access remembered for this session.');
    const resolved = requests.filter(r => r.status !== 'pending');
    if (resolved.length) wrap(`Recent decisions: ${resolved.slice(0, 3).map(r => r.status).join(', ')}`);
  }
  const actionRows = request ? 3 : 0;
  const capacity = Math.max(0, height - 2 - actionRows);
  const offset = Math.max(0, Math.min(state.scrollOffset ?? 0, Math.max(0, body.length - capacity)));
  // Remember the visible origin, so PageUp responds immediately after reaching the end.
  state.scrollOffset = offset;
  for (const line of body.slice(offset, offset + capacity)) {
    if (typeof line === 'string') modal.text(line, {fg: tokens.foregroundMuted});
    else modal.spans(line.spans);
  }
  modal.fillTo(height - 1 - actionRows);
  if (request) {
    for (const [action, label] of [['once', '[1] Allow once'], ['session', '[2] Allow this session'], ['deny', '[3] Deny']] as const) {
      modal.text(`${state.selectedAction === action ? ' ›' : '  '} ${label}`, {fg: state.selectedAction === action ? tokens.foreground : tokens.foregroundMuted, bg: state.selectedAction === action ? tokens.selection : modal.bg, bold: state.selectedAction === action});
    }
  }
  const scrolling = body.length > capacity;
  const footer = request
    ? width < 55 ? ' Esc Deny · Enter Apply ' : ' ←/→ Choose · Enter Apply · Esc Deny '
    : grants.length ? ' Ctrl+X Revoke · Esc Close ' : ' Esc Close ';
  return modal.bottom(scrolling ? (width < 55 ? ' PgUp/PgDn · Esc ' : ' PgUp/PgDn Scroll · ' + footer.trim()) : footer).lines;
}
