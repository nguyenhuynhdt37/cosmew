import type { ModelWorkflow, OverlayFeature, OverlayLayout, ThemeFrame, TuiHost } from '../../core/feature';
import { editField, stepIndex } from '../../ui';
import { filterModels } from './logic';
import { createInitialModelPickerState, type ModelPickerState } from './types';
import { renderModelPickerOverlay } from './view';

/** Model picker; can also choose a model on behalf of an account that is about to become active. */
export class ModelsFeature implements OverlayFeature, ModelWorkflow {
  readonly overlays = ['models'] as const;
  private state: ModelPickerState = createInitialModelPickerState();
  /** Account whose models are shown while a switch waits for a model choice. */
  private pendingAccountId: string | null = null;

  constructor(private readonly host: TuiHost) {}

  open(): void {
    this.state = createInitialModelPickerState();
    this.pendingAccountId = null;
  }

  close(): void { this.pendingAccountId = null; }

  awaitModelForAccount(accountId: string, message: string): void {
    this.pendingAccountId = accountId;
    this.state.statusMessage = message;
  }

  /** Show a hint in the picker's status line. */
  showMessage(message: string): void { this.state.statusMessage = message; }

  layout(_overlay: 'models', cols: number, rows: number): OverlayLayout {
    const count = this.host.client.cachedModels(this.pendingAccountId ?? undefined).length;
    return { width: Math.min(cols - 2, 76), height: Math.min(rows - 2, Math.max(9, Math.min(8, count) + 5)), backdrop: true };
  }

  render(_overlay: 'models', size: { width: number; height: number }, theme: ThemeFrame) {
    const { client } = this.host;
    const status = client.status();
    return renderModelPickerOverlay({
      ...size,
      models: client.cachedModels(this.pendingAccountId ?? undefined),
      activeModelId: status.selection?.modelId ?? null,
      activeReasoningEffort: status.reasoningEffort,
      activeAccountAlias: this.pendingAccountId ? client.listAccounts().find(a => a.id === this.pendingAccountId)?.alias ?? null : status.activeAccount?.alias ?? null,
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  async handleKey(_overlay: 'models', key: string): Promise<void> {
    const { host } = this;
    const { client } = host;
    if (host.isStreaming && ['Enter', 'Tab', 'Shift+Tab', 'Ctrl+A'].includes(key)) { host.setBanner('Cancel the active response with Esc first.'); return; }
    const st = this.state;
    const pending = this.pendingAccountId ?? undefined;
    const models = filterModels(client.cachedModels(pending), st.query);

    if (st.addingManual) { await this.handleManualEntry(st, key); return; }

    if (key === 'Escape') { this.pendingAccountId = null; host.closeOverlay(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (models.length) this.state = { ...st, selectedIndex: stepIndex(st.selectedIndex, key, models.length) };
      return;
    }
    if ((key === 'Tab' || key === 'Shift+Tab') && this.pendingAccountId) {
      this.state.statusMessage = 'Choose a model for this account or Esc to cancel the switch.'; return;
    }
    if (key === 'Tab' || key === 'Shift+Tab') {
      const accounts = client.listAccounts().filter(a => a.status !== 'logged-out');
      if (!accounts.length) { this.state.statusMessage = 'Use /login to connect a provider.'; return; }
      const current = accounts.findIndex(a => a.id === client.status().activeAccount?.id);
      const target = accounts[(current + (key === 'Tab' ? 1 : -1) + accounts.length) % accounts.length]!;
      client.useAccount(target.id);
      host.syncTranscript();
      this.state = { ...createInitialModelPickerState(), statusMessage: `${target.providerId} · ${target.alias}. Ctrl+R discovers models; Tab switches accounts.` };
      return;
    }
    if (key === 'Ctrl+E' || key === 'ArrowLeft' || key === 'ArrowRight') { this.adjustEffort(st, models, key); return; }
    if (key === 'Ctrl+R') {
      try {
        const res = await client.discoverModels({ accountId: pending });
        this.state = { ...st, selectedIndex: 0, statusMessage: `Discovered ${res.models.length} models from ${res.account.alias}.` };
      } catch {
        this.state = { ...st, statusMessage: 'Model discovery failed. Check active account credentials (/login).' };
      }
      return;
    }
    if (key === 'Ctrl+A') { this.state = { ...st, addingManual: true, manualDraft: '' }; return; }
    if (key === 'Enter') { await this.choose(st, models[st.selectedIndex]); return; }
    const query = editField(st.query, key, { max: Number.MAX_SAFE_INTEGER });
    if (query !== null) this.state = { ...st, query, selectedIndex: 0 };
  }

  private adjustEffort(st: ModelPickerState, models: ReturnType<typeof filterModels>, key: string): void {
    const { host } = this;
    if (host.isStreaming) { this.state.statusMessage = 'Cancel the response before changing effort.'; return; }
    const chosen = models[st.selectedIndex];
    const levels = chosen?.reasoningEfforts ?? [];
    if (!levels.length) { this.state.statusMessage = 'Reasoning effort is not advertised by this model/transport.'; return; }
    const status = host.client.status();
    const values = ['default', ...levels];
    const current = st.effortDraft?.modelId === chosen!.id ? st.effortDraft.value : chosen!.id === status.selection?.modelId ? status.reasoningEffort ?? 'default' : chosen!.defaultReasoningEffort ?? 'default';
    const index = Math.max(0, values.indexOf(current));
    const next = values[Math.max(0, Math.min(values.length - 1, index + (key === 'ArrowLeft' ? -1 : 1)))]!;
    this.state = { ...st, effortDraft: { modelId: chosen!.id, value: next }, statusMessage: undefined };
  }

  /** Enter on a model: select it, or hand it to the pending account switch. */
  private async choose(st: ModelPickerState, chosen: ReturnType<typeof filterModels>[number] | undefined): Promise<void> {
    if (!chosen) return;
    const { host } = this;
    const { client } = host;
    try {
      if (this.pendingAccountId) {
        const targetAccountId = this.pendingAccountId;
        await host.features.accounts.continueWithAccount(targetAccountId, chosen.id);
        const after = client.status().selection;
        if (after?.accountId === targetAccountId && after?.modelId === chosen.id && host.overlay === 'none' && st.effortDraft?.modelId === chosen.id) client.setReasoningEffort(st.effortDraft.value);
        return;
      }
      client.selectModel(chosen.id);
      if (st.effortDraft?.modelId === chosen.id) client.setReasoningEffort(st.effortDraft.value);
      this.pendingAccountId = null;
      host.syncTranscript();
      host.closeOverlay();
      host.setBanner(`Selected model "${chosen.id}".`);
    } catch {
      this.state = { ...st, statusMessage: 'Could not select model.' };
    }
  }

  private async handleManualEntry(st: ModelPickerState, key: string): Promise<void> {
    const { host } = this;
    const { client } = host;
    if (key === 'Escape') { this.state = { ...st, addingManual: false, manualDraft: '' }; return; }
    if (key === 'Enter') {
      try {
        const added = client.addManualModel(st.manualDraft.trim(), this.pendingAccountId ?? undefined);
        if (this.pendingAccountId) { await host.features.accounts.continueWithAccount(this.pendingAccountId, added.id); return; }
        client.selectModel(added.id);
        this.pendingAccountId = null;
        host.syncTranscript();
        this.state = { ...st, addingManual: false, manualDraft: '' };
        host.closeOverlay();
        host.setBanner(`Added and selected manual model "${added.id}".`);
      } catch {
        this.state = { ...st, addingManual: false, statusMessage: 'Failed to add manual model. Ensure an account is active (/login).' };
      }
      return;
    }
    const manualDraft = editField(st.manualDraft, key, { max: 80 });
    if (manualDraft !== null) this.state = { ...st, manualDraft };
  }
}
