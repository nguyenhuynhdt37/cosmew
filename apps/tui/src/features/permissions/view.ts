import type {FutrynClient} from '@futryn/sdk';
import {
  FULL_ACCESS_WARNING,
  PERMISSION_MODE_HINTS,
  PERMISSION_PRESETS,
  type BorderStyle,
  type PermissionMode,
  type PermissionPresetId,
  type PermissionPromptRequest,
  type PermissionRuleSet,
  type ThemeTokens,
} from '@futryn/contracts';
import {Modal, clampIndex, type RenderedBoxLine} from '../../ui';
import {MODE_ENTRIES, PERMISSION_RULE_TABS, type PermissionDialogState, type PermissionRulesState} from './types';
import {parseUnifiedDiff, renderDiffCodeLine} from '../diff/code-lines';

export function renderPermissionDialogOverlay(options: {
  workspaceReading?: ReturnType<FutrynClient['status']>['workspaceReadStatus'];
  terminalRuntime?: ReturnType<FutrynClient['status']>['terminalRuntime'];
  width: number;
  height: number;
  requests: PermissionPromptRequest[];
  grants?: string[];
  state: PermissionDialogState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, requests, state, tokens, borderStyle} = options;
  const pending = requests.filter(r => r.status === 'pending');
  const request = pending[clampIndex(state.selectedIndex, pending.length)];
  const grants = options.grants ?? [];
  const modal = new Modal({
    width,
    height,
    minInner: 1,
    tokens,
    borderStyle,
    borderColor: request ? tokens.warning : tokens.borderFocused,
  });
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
    if (request.subagent) {
      wrap(`Subagent: ${request.subagent.agentType} (${request.subagent.description})`);
    }
    const command = request.capability === 'process.execute';
    wrap(command ? `Command: ${request.target}` : `Target: ${JSON.stringify(request.target)}`);
    wrap(`${command ? 'Where' : 'Action'}: ${request.action}`);
    wrap(`Why: ${request.reason}`);
    if (options.terminalRuntime && ['process.execute', 'network.connect'].includes(request.capability)) {
      const runtime = options.terminalRuntime;
      wrap(`Runtime: ${runtime.label} · ${runtime.sandbox}`);
      for (const limitation of runtime.limitations) wrap(limitation);
    }
    wrap(
      request.capability === 'fs.write'
        ? 'Once applies this exact diff. Session remembers only this patch and original file versions.'
        : command || request.action.startsWith('Run ')
          ? 'Once runs it now. Session allows this exact command in this directory until revoked.'
          : request.action === 'Grant additional permissions'
            ? 'Once grants it for the rest of this turn. Session grants it until the session ends.'
            : 'Once applies to this request. Session allows this target until revoked.',
    );
    if (request.alwaysRule)
      wrap(`Always saves the Allow rule ${request.alwaysRule} for this project (edit it in /permissions).`);
    if (request.diffPreview) {
      wrap('Preview · proposed changes (not applied):');
      const diff = parseUnifiedDiff(request.diffPreview);
      if (diff.length) body.push(...diff.flatMap(line => renderDiffCodeLine(line, modal.innerWidth, tokens)));
      else wrap(request.diffPreview);
    }
  } else {
    wrap('No requests waiting.');
    wrap(
      options.workspaceReading === 'read-only'
        ? 'Workspace reading is enabled for this model.'
        : options.workspaceReading === 'disabled'
          ? 'Workspace reads are disabled for this session.'
          : 'Workspace reads are unavailable for this model.',
    );
    wrap('Project files: allowed after folder consent.');
    wrap('Secret files: ask. Outside workspace: denied.');
    wrap('Tools: read, glob, grep; edit, write and apply_patch ask before writes.');
    wrap(
      options.terminalRuntime
        ? `Commands: ${options.terminalRuntime.label}${options.terminalRuntime.reason ? ` · ${options.terminalRuntime.reason}` : ''}`
        : 'Command runtime details unavailable.',
    );
    if (grants.length) {
      wrap(`Allowed this session (${grants.length}, Ctrl+X revokes):`);
      for (const grant of grants) wrap('  ' + JSON.stringify(grant));
    } else wrap('No file or command access remembered for this session.');
    const resolved = requests.filter(r => r.status !== 'pending');
    if (resolved.length)
      wrap(
        `Recent decisions: ${resolved
          .slice(0, 3)
          .map(r => r.status)
          .join(', ')}`,
      );
  }
  // Exactly the answers the request offers (ADR 0055, Codex `available_decisions`).
  const actions = request
    ? ([
        ['once', '[1] Yes'],
        ...(request.decisions.includes('session') ? [['session', '[2] Yes, for this session']] : []),
        ['deny', '[3] No'],
        ...(request.decisions.includes('always') && request.alwaysRule
          ? [['always', `[4] Yes, and always allow ${request.alwaysRule} in this project`]]
          : []),
      ] as const)
    : [];
  // Tiny terminals keep at least two body rows: show only the selected choice (←/→ changes it).
  const compact = actions.length > 0 && height - 2 - actions.length < 2;
  const shownActions = compact ? actions.filter(([action]) => action === state.selectedAction).slice(0, 1) : actions;
  const actionRows = shownActions.length;
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
    for (const [action, label] of shownActions) {
      modal.text(`${state.selectedAction === action ? ' ›' : '  '} ${label}`, {
        fg: state.selectedAction === action ? tokens.foreground : tokens.foregroundMuted,
        bg: state.selectedAction === action ? tokens.selection : modal.bg,
        bold: state.selectedAction === action,
      });
    }
  }
  const scrolling = body.length > capacity;
  const footer = request
    ? width < 55
      ? ' Esc Deny · Enter Apply '
      : ' ←/→ Choose · Enter Apply · Esc Deny '
    : grants.length
      ? ' Ctrl+X Revoke · Esc Close '
      : ' Esc Close ';
  return modal.bottom(scrolling ? (width < 55 ? ' PgUp/PgDn · Esc ' : ' PgUp/PgDn Scroll · ' + footer.trim()) : footer)
    .lines;
}

const TAB_LABELS = {allow: 'Allow', ask: 'Ask', deny: 'Deny', mode: 'Mode'} as const;
const TAB_HELP = {
  allow: 'Futryn will not ask before using these.',
  ask: 'Futryn asks first, even in auto mode; bypass (never) refuses instead.',
  deny: 'Futryn refuses these without asking.',
  mode: 'Read Only, Auto and Full Access are Codex presets (sandbox + approval). Shift+Tab cycles them.',
} as const;

/**
 * `/permissions` with nothing waiting, Claude Code style: Allow / Ask / Deny rule lists for this
 * project and the session mode. Rules: Bash(npm test:*), Read(src/**), Edit(**\/*.ts), WebFetch(domain:x).
 */
export function renderPermissionRulesOverlay(options: {
  width: number;
  height: number;
  rules: PermissionRuleSet;
  mode: PermissionMode;
  preset?: PermissionPresetId | 'custom';
  grants: string[];
  state: PermissionRulesState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, rules, mode, state, tokens, borderStyle} = options;
  const preset = options.preset ?? 'custom';
  const modal = new Modal({width, height, minInner: 1, tokens, borderStyle, borderColor: tokens.borderFocused});
  modal.top(' Permissions ');
  // Tab strip: the active tab is bold accent and underlined by a rule on the next row.
  const tabs: RenderedBoxLine['spans'] = [{text: ' ', fg: tokens.foreground, bg: modal.bg}];
  let underline = ' ';
  for (const tab of PERMISSION_RULE_TABS) {
    const label = ` ${TAB_LABELS[tab]}${tab === 'mode' ? '' : ` ${rules[tab].length}`} `;
    const active = tab === state.tab;
    tabs.push(
      {
        text: label,
        fg: active ? tokens.accentForeground : tokens.foregroundMuted,
        bg: active ? tokens.accent : modal.bg,
        bold: active,
      },
      {text: ' ', fg: tokens.foreground, bg: modal.bg},
    );
    underline += (active ? '─'.repeat(label.length) : ' '.repeat(label.length)) + ' ';
  }
  const used = tabs.reduce((sum, span) => sum + span.text.length, 0);
  modal.spans([...tabs, {text: ' '.repeat(Math.max(0, modal.innerWidth - used)), fg: tokens.foreground, bg: modal.bg}]);
  modal.text(underline, {fg: tokens.accent});
  modal.text(' ' + TAB_HELP[state.tab], {fg: tokens.foregroundMuted});
  modal.text('');
  const row = (selected: boolean, text: string, fg = tokens.foreground) =>
    modal.text(`${selected ? ' › ' : '   '}${text}`.slice(0, modal.innerWidth), {
      fg: selected ? tokens.foreground : fg,
      bg: selected ? tokens.selection : modal.bg,
      bold: selected,
    });
  if (state.tab === 'mode') {
    MODE_ENTRIES.forEach((entry, index) => {
      const selected = index === state.selectedIndex;
      const current = entry.kind === 'preset' ? entry.id === preset : preset === 'custom' && entry.mode === mode;
      const info = entry.kind === 'preset' ? PERMISSION_PRESETS.find(item => item.id === entry.id)! : undefined;
      const label = info ? info.label : entry.kind === 'mode' ? entry.mode : '';
      row(
        selected,
        `${current ? '●' : '○'} ${label}${info ? ` (${info.sandbox} + ${info.mode === 'bypassPermissions' ? 'never' : 'on-request'})` : ' (approval only)'}`,
        info?.id === 'full-access' ? tokens.error : current ? tokens.accent : tokens.foregroundMuted,
      );
      if (selected) {
        const text = info ? info.description : entry.kind === 'mode' ? PERMISSION_MODE_HINTS[entry.mode] : '';
        for (let i = 0; i < text.length && i < 3 * (modal.innerWidth - 5); i += modal.innerWidth - 5)
          modal.text(`     ${text.slice(i, i + modal.innerWidth - 5)}`, {fg: tokens.foregroundSubtle});
      }
    });
    if (state.confirmFullAccess) {
      for (let i = 0; i < FULL_ACCESS_WARNING.length; i += modal.innerWidth - 2)
        modal.text(` ${FULL_ACCESS_WARNING.slice(i, i + modal.innerWidth - 2)}`, {fg: tokens.error, bold: true});
      modal.text(' Press Enter again to enable Full Access, any other key cancels.', {fg: tokens.warning});
    }
  } else {
    const list = rules[state.tab];
    if (state.input !== null) {
      modal.text(' New rule:', {fg: tokens.foregroundMuted});
      const shown = state.input.slice(-Math.max(1, modal.innerWidth - 5));
      modal.spans([
        {text: ' > ', fg: tokens.accent, bg: modal.bg, bold: true},
        {text: shown, fg: tokens.foreground, bg: modal.bg},
        {text: '▌', fg: tokens.accent, bg: modal.bg},
        {text: ' '.repeat(Math.max(0, modal.innerWidth - 4 - shown.length)), fg: tokens.foreground, bg: modal.bg},
      ]);
      modal.text(
        ' e.g. Bash(npm test:*)  Read(src/**)  Edit(**/*.ts)  WebFetch(domain:docs.x.ai)'.slice(0, modal.innerWidth),
        {fg: tokens.foregroundSubtle},
      );
      if (state.error) modal.text(' ' + state.error, {fg: tokens.error});
    } else {
      row(state.selectedIndex === 0, '+ Add a new rule…', tokens.accent);
      const capacity = Math.max(1, height - 10);
      const start = Math.max(0, Math.min(state.selectedIndex - 1 - capacity + 1, list.length - capacity));
      list
        .slice(start, start + capacity)
        .forEach((rule, offset) => row(state.selectedIndex === start + offset + 1, rule));
      if (!list.length) modal.text('   No rules yet.', {fg: tokens.foregroundSubtle});
      if (state.tab === 'allow') {
        // Session grants ("Yes, for this session") live only in memory; Ctrl+X revokes them all.
        modal.text('');
        if (options.grants.length) {
          modal.text(` Allowed this session (${options.grants.length}, Ctrl+X revokes):`, {fg: tokens.foregroundMuted});
          for (const grant of options.grants.slice(0, 4))
            modal.text(`   ${JSON.stringify(grant)}`, {fg: tokens.foregroundSubtle});
        } else modal.text(' No file or command access remembered for this session.', {fg: tokens.foregroundSubtle});
      }
    }
  }
  modal.fillTo(height - 2);
  modal.text(' Rules are saved for this project.', {fg: tokens.foregroundSubtle});
  const footer =
    state.input !== null
      ? ' Enter Save · Esc Cancel '
      : state.tab === 'mode'
        ? ' ←/→ Tab · ↑/↓ Select · Enter Use · Esc Close '
        : ' ←/→ Tab · ↑/↓ Select · Enter Add · Del Remove · Esc Close ';
  return modal.bottom(width < 60 ? ' ←/→ · ↑/↓ · Enter · Esc ' : footer).lines;
}
