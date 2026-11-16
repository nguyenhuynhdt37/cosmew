import type {BorderStyle, ModelInfo, ThemeTokens} from '@futryn/contracts';
import {Modal, clampIndex, windowCentered, type RenderedBoxLine} from '../../ui';
import {capabilityTag, filterModels} from './logic';
import type {ModelPickerState} from './types';

export function renderModelPickerOverlay(options: {
  width: number;
  height: number;
  models: ModelInfo[];
  activeModelId: string | null;
  activeReasoningEffort?: string | null;
  activeAccountAlias: string | null;
  state: ModelPickerState;
  tokens: ThemeTokens;
  borderStyle: BorderStyle;
}): RenderedBoxLine[] {
  const {width, height, models, activeModelId, activeAccountAlias, state, tokens, borderStyle} = options;
  const modal = new Modal({width, height, tokens, borderStyle, minInner: 30});
  const filtered = filterModels(models, state.query);
  modal.top(
    ` MODEL SELECTION (${filtered.length}/${models.length}) `,
    ` Account: ${activeAccountAlias ?? 'none'} · Esc Close `,
  );

  modal.text(
    state.addingManual
      ? ` Enter Manual Model ID: ${state.manualDraft}█  (Enter Add & Select · Esc Cancel)`
      : ` Search Models: ${state.query}█  (Ctrl+R Refresh Live Catalog · Ctrl+A Add Manual ID)`,
    {fg: state.addingManual ? tokens.warning : tokens.foreground, bg: tokens.backgroundElevated},
  );

  const maxRows = Math.max(4, height - 5);
  if (filtered.length === 0) {
    modal.text(
      !activeAccountAlias
        ? ' No active provider account connected. Run /login first to authenticate.'
        : ` No models matching "${state.query}". Press Ctrl+R to discover or Ctrl+A to enter a manual model ID.`,
      {fg: tokens.warning},
    );
  } else {
    const selectedIndex = clampIndex(state.selectedIndex, filtered.length);
    const start = windowCentered(filtered.length, selectedIndex, maxRows);
    filtered.slice(start, start + maxRows).forEach((m, i) => {
      const selected = start + i === selectedIndex;
      const isCurrent = m.id === activeModelId;
      const marker = isCurrent ? '●' : selected ? '▸' : ' ';
      const context = m.contextLimit ? `Max context ${m.contextLimit.toLocaleString('en-US')}` : 'Context not reported';
      const right = modal.innerWidth >= 72 ? `${capabilityTag(m)} ${context}` : context;
      const leftMax = Math.max(4, modal.innerWidth - right.length - 1);
      const left = ` ${marker} ${m.id}`.slice(0, leftMax).padEnd(leftMax, ' ');
      modal.text(`${left} ${right}`, {
        fg: isCurrent ? tokens.accent : selected ? tokens.selectionForeground : tokens.foreground,
        bg: selected ? tokens.selection : modal.bg,
        bold: selected || isCurrent,
      });
    });
  }

  modal.fillTo(height - 2);
  const focused = filtered[clampIndex(state.selectedIndex, filtered.length)];
  const effort =
    state.effortDraft?.modelId === focused?.id
      ? state.effortDraft?.value
      : focused?.id === activeModelId
        ? (options.activeReasoningEffort ?? focused?.defaultReasoningEffort ?? 'auto')
        : (focused?.defaultReasoningEffort ?? 'auto');
  modal.text(
    state.statusMessage ??
      (focused?.reasoningEfforts?.length
        ? ` Effort: ${effort === 'default' ? 'auto' : effort} · ←/→ Adjust · Enter Save model & effort`
        : ' Effort: provider default · no adjustable levels reported.'),
    {fg: tokens.info, bg: tokens.backgroundElevated},
  );
  return modal.bottom(
    modal.innerWidth >= 60
      ? ' ↑↓ Model · ←→ Effort · Tab Account · Enter Save · Esc Cancel '
      : ' ↑↓ Model · ←→ Effort · Enter Save · Esc Cancel ',
  ).lines;
}
