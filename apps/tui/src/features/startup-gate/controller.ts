import { FutrynError } from '@futryn/contracts';
import type { ThemeFrame, TuiHost } from '../../core/feature';
import {
  CHECK_TIMEOUT_SECONDS, GATE_BLOCKED_KEYS, GATE_OVERLAYS, TIMEOUT_MESSAGE, clampOption, failureMessage, optionCount, selectableAccounts, suggestedAlternative,
} from './logic';
import type { StartupGateState } from './types';
import { renderStartupGate, type GateLayout } from './view';

/**
 * Gate in front of the chat: consent for the folder, then a verification request for
 * the selected account and model. Not an overlay: it owns the whole screen until done.
 */
export class StartupGate {
  private state: StartupGateState = { phase: 'off', index: 0, message: '' };
  private abort: AbortController | null = null;
  private task: Promise<void> | null = null;
  private initialCommand?: string;
  private timedOut = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: TuiHost) {}

  get phase() { return this.state.phase; }
  get active(): boolean { return this.state.phase !== 'off'; }
  /** True when the gate covers the whole screen (sign-in overlays are drawn above it). */
  get coversScreen(): boolean { return this.state.phase !== 'off' && this.state.phase !== 'login'; }

  /** Consent is scoped to this interactive session and never grants tool permissions. */
  start(initialCommand?: string): void {
    this.initialCommand = initialCommand;
    this.state = { phase: 'trust', index: 1, message: '' }; // deny by default
  }

  async shutdown(): Promise<void> {
    this.timedOut = false;
    this.abort?.abort();
    await Promise.allSettled([this.task]);
  }

  render(cols: number, rows: number, theme: ThemeFrame): GateLayout | null {
    if (!this.coversScreen) return null;
    const { client } = this.host;
    return renderStartupGate({
      phase: this.state.phase as 'trust' | 'checking' | 'choose',
      index: this.state.index,
      message: this.state.message,
      workspace: client.status().workspace,
      activeAlias: client.status().activeAccount?.alias ?? '',
      model: client.status().selection?.modelId,
      elapsedSeconds: this.state.startedAt ? Math.floor((Date.now() - this.state.startedAt) / 1000) : 0,
      accounts: selectableAccounts(client.listAccounts()),
      cols, rows,
      tokens: theme.tokens,
    });
  }

  /** Called every frame: leave 'login' once the sign-in overlays are closed. */
  advance(): void {
    if (this.state.phase !== 'login' || this.host.overlay !== 'none') return;
    const status = this.host.client.status();
    if (!status.activeAccount) { this.toChooser(0, ''); return; }
    if (!status.selection) { this.toChooser(0, 'No model selected. Choose a model or another account.'); return; }
    this.beginValidation();
  }

  /** @returns true when the gate consumed the key. */
  async handleKey(key: string): Promise<boolean> {
    const { host } = this;
    if (this.state.phase === 'off') return false;
    if (this.state.phase === 'login') {
      if (host.overlay !== 'none') return !GATE_OVERLAYS.includes(host.overlay) || GATE_BLOCKED_KEYS.includes(key);
      this.advance();
    }
    if (key === 'Ctrl+C' || key === 'Escape') { this.abort?.abort(); host.requestExit(); return true; }
    if (this.state.phase === 'checking') return true;

    const accounts = selectableAccounts(host.client.listAccounts());
    const count = optionCount(this.state.phase, accounts);
    this.state.index = clampOption(this.state.index, count);
    if (key === 'ArrowDown' || key === 'ArrowUp') this.state.index = (this.state.index + (key === 'ArrowDown' ? 1 : -1) + count) % count;
    if (key !== 'Enter') return true;

    if (this.state.phase === 'trust') {
      if (this.state.index !== 0) { host.requestExit(); return true; }
      host.grantWorkspaceAccess();
      this.beginValidation();
      return true;
    }
    const selected = accounts[this.state.index];
    if (selected) {
      try { host.client.useAccount(selected.id); host.syncTranscript(); this.beginValidation(); }
      catch { this.state.message = 'Account is unavailable. Choose another or sign in again.'; }
    } else {
      this.state.phase = 'login';
      host.openOverlay('connect');
    }
    return true;
  }

  /** Enter the 'checking' phase with a deadline so a hung provider cannot stall startup. */
  private beginRequest(): AbortController {
    const abort = new AbortController();
    this.abort = abort;
    this.timedOut = false;
    this.state = { ...this.state, phase: 'checking', message: '', startedAt: Date.now() };
    this.deadline = setTimeout(() => { this.timedOut = true; abort.abort(); }, CHECK_TIMEOUT_SECONDS * 1000);
    return abort;
  }

  private endRequest(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null; this.abort = null; this.task = null;
  }

  /** True (and moves to the chooser) when the request was cut off by the deadline. */
  private reportTimeout(abort: AbortController, failedAccountId: string): boolean {
    if (!abort.signal.aborted || !this.timedOut) return false;
    this.toChooser(suggestedAlternative(selectableAccounts(this.host.client.listAccounts()), failedAccountId), TIMEOUT_MESSAGE);
    return true;
  }

  private toChooser(index: number, message: string): void {
    this.state = { phase: 'choose', index, message };
  }

  private beginValidation(): void {
    if (this.task) return;
    const { host } = this;
    const { client } = host;
    const account = client.status().activeAccount;
    if (!account || account.status === 'logged-out') { this.toChooser(0, ''); return; }

    const original = client.status().selection;
    if (!original) { this.pickModelFirst(account.id); return; }

    const abort = this.beginRequest();
    this.task = (async () => {
      try {
        // Generation proves access for providers whose model-list endpoint is public.
        await client.diagnose(abort.signal, true);
        if (abort.signal.aborted) return;
        const current = client.status();
        const changed = current.activeAccount?.id !== account.id || current.activeAccount.authGeneration !== account.authGeneration
          || current.selection?.accountId !== original.accountId || current.selection?.modelId !== original.modelId;
        if (changed) { this.toChooser(0, 'Account or model changed during verification. Choose an account to check again.'); return; }
        await this.finish();
      } catch (error) {
        if (this.reportTimeout(abort, account.id)) return;
        if (abort.signal.aborted) return;
        const alternatives = selectableAccounts(client.listAccounts());
        this.toChooser(suggestedAlternative(alternatives, account.id), failureMessage(error instanceof FutrynError ? error.code : 'PROTOCOL'));
      } finally { this.endRequest(); }
    })();
  }

  /**
   * No model chosen yet: load the model list (no generation, so nothing is billed) and let
   * the user pick one. Verification runs once a model is selected.
   */
  private pickModelFirst(accountId: string): void {
    const { host } = this;
    const abort = this.beginRequest();
    this.task = (async () => {
      try {
        await host.client.discoverModels({ accountId, signal: abort.signal });
        if (abort.signal.aborted) return;
        this.state = { phase: 'login', index: 0, message: '' };
        host.openOverlay('models');
        host.features.models.showMessage('Choose a model to continue.');
      } catch (error) {
        if (this.reportTimeout(abort, accountId)) return;
        if (abort.signal.aborted) return;
        this.toChooser(suggestedAlternative(selectableAccounts(host.client.listAccounts()), accountId), failureMessage(error instanceof FutrynError ? error.code : 'PROTOCOL'));
      } finally { this.endRequest(); }
    })();
  }

  /** Verification passed: open the chat and run any command the CLI asked for. */
  private async finish(): Promise<void> {
    this.state = { phase: 'off', index: 0, message: '' };
    const command = this.initialCommand;
    this.initialCommand = undefined;
    if (!command) return;
    // A failing command is a command problem, not an account problem.
    try { await this.host.runSlashCommand(command); }
    catch (error) { this.host.setBanner(this.host.describeError(error)); }
  }
}
