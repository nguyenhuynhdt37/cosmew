import {
  HannesError,
  modelIdSchema,
  providerSchema,
  type Provider,
  THEME_TOKEN_KEYS,
  type ToolCall,
} from '@hannes/contracts';
import { acceptSlashSelection, parseSlashCommand, type FutrynClient } from '@hannes/sdk';
import { renderContextIndicator, reportRows, renderReportOverlay } from './screens/telemetry';
import { TextSelection } from './components/text-selection';
import { connectionChoices } from './screens/connect';
import {
  createInitialDiffViewState,
  renderDiffViewerOverlay,
  type DiffViewState,
} from './components/diff-view';
import {
  applyFileReferenceSelection,
  createInitialComposerState,
  getMatchingSlashCommands,
  navigateComposerHistory,
  recordComposerHistory,
  renderPromptComposerLines,
  updateComposerValue,
  type ComposerState,
  type RenderedBoxLine,
} from './components/editor';
import type { TranscriptItem } from './components/messages';
import { FynCompanion, renderFyn } from './components/mascot';
import {
  createInitialPermissionDialogState,
  renderPermissionDialogOverlay,
  type PermissionDialogState,
} from './components/permission-dialog';
import {
  renderSidebarPanel,
  renderTopHeaderBar,
  renderTranscriptViewport,
  renderWelcomeScreen,
} from './screens/chat';
import {
  createInitialSessionPickerState,
  filterSessions,
  renderSessionPickerOverlay,
  type SessionPickerState,
} from './screens/sessions';
import {
  createInitialCommandPaletteState,
  createInitialConnectProviderState,
  createInitialModelPickerState,
  createInitialThemeEditorState,
  createInitialThemePickerState,
  filterModels,
  filterPaletteCommands,
  renderCommandPaletteOverlay,
  renderConnectProviderOverlay,
  renderHelpOverlay,
  renderModelPickerOverlay,
  renderSettingsOverlay,
  renderThemeEditorOverlay,
  renderThemePickerOverlay,
  type CommandPaletteState,
  type ConnectProviderState,
  type ModelPickerState,
  type ThemeEditorState,
  type ThemePickerState,
} from './screens/settings';
import {
  ThemeEngine,
  bgHex,
  fgHex,
  type TerminalColorCapability,
} from './theme/theme';

export type ActiveOverlay =
  | 'none'
  | 'themes'
  | 'theme-editor'
  | 'models'
  | 'connect'
  | 'sessions'
  | 'permissions'
  | 'diff'
  | 'palette'
  | 'settings'
  | 'effort'
  | 'usage'
  | 'context'
  | 'status'
  | 'help';

export interface FrameCell {
  ch: string;
  fg: string;
  bg: string;
  bold: boolean;
  selected?: boolean;
}

export interface FrameSnapshot {
  cols: number;
  rows: number;
  cells: FrameCell[][];
  plainLines: string[];
  plainText: string;
  activeOverlay: ActiveOverlay;
  activeThemeId: string;
  effectiveMode: 'dark' | 'light';
  activeWallpaperId: string | null;
  isPreviewing: boolean;
  isStreaming: boolean;
}

export interface FutrynTuiOptions {
  client: FutrynClient;
  themeEngine?: ThemeEngine;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}

export function parseRawTerminalKey(chunk: Uint8Array | string): string[] {
  const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const keys: string[] = [];
  let i = 0;

  while (i < str.length) {
    if (str.startsWith('\x1b[200~', i) || str.startsWith('\x1b[201~', i)) { i += 6; continue; }
    if (str.startsWith('\x1b\r', i)) { keys.push('Alt+Enter'); i += 2; continue; }
    if (str.startsWith('\x1b[<', i)) {
      const endM = str.indexOf('M', i + 3);
      const endLowerM = str.indexOf('m', i + 3);
      let termIdx = -1;
      if (endM !== -1 && endLowerM !== -1) {
        termIdx = Math.min(endM, endLowerM);
      } else if (endM !== -1) {
        termIdx = endM;
      } else {
        termIdx = endLowerM;
      }

      if (termIdx !== -1) {
        const match = /^(\d{1,5});(\d{1,5});(\d{1,5})$/.exec(str.slice(i + 3, termIdx));
        if (match) {
          const button = Number(match[1]); const col = Number(match[2]) - 1; const row = Number(match[3]) - 1;
          const released = str[termIdx] === 'm';
          if (col >= 0 && row >= 0) {
            if (button === 64 && !released) keys.push('PageUp');
            else if (button === 65 && !released) keys.push('PageDown');
            else if (released && (button === 0 || button === 3 || button === 35)) keys.push(`MouseUp:${row}:${col}`);
            else if (button === 0) keys.push(`MouseDown:${row}:${col}`);
            else if (button === 32) keys.push(`MouseDrag:${row}:${col}`);
          }
        }
        i = termIdx + 1;
        continue;
      }
      break; // Incomplete mouse input must never become a composer draft.
    }
    if (str.startsWith('\x1b[I', i)) {
      keys.push('FocusIn');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[O', i)) {
      keys.push('FocusOut');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[A', i)) {
      keys.push('ArrowUp');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[B', i)) {
      keys.push('ArrowDown');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[C', i)) {
      keys.push('ArrowRight');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[D', i)) {
      keys.push('ArrowLeft');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[Z', i)) {
      keys.push('Shift+Tab');
      i += 3;
      continue;
    }
    if (str.startsWith('\x1b[3~', i)) {
      keys.push('Delete');
      i += 4;
      continue;
    }
    if (str.startsWith('\x1b[5~', i)) {
      keys.push('PageUp');
      i += 4;
      continue;
    }
    if (str.startsWith('\x1b[6~', i)) {
      keys.push('PageDown');
      i += 4;
      continue;
    }
    const ch = str[i]!;
    const code = ch.charCodeAt(0);
    if (ch === '\x1b') {
      keys.push('Escape');
      i++;
    } else if (ch === '\r') {
      keys.push('Enter');
      i++;
    } else if (ch === '\n') {
      keys.push('Ctrl+J');
      i++;
    } else if (ch === '\t') {
      keys.push('Tab');
      i++;
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push('Backspace');
      i++;
    } else if (code === 3) {
      keys.push('Ctrl+C');
      i++;
    } else if (code === 2) {
      keys.push('Ctrl+B');
      i++;
    } else if (code === 4) {
      keys.push('Ctrl+D');
      i++;
    } else if (code === 5) {
      keys.push('Ctrl+E');
      i++;
    } else if (code === 7) {
      keys.push('Ctrl+G');
      i++;
    } else if (code === 13) {
      keys.push('Enter');
      i++;
    } else if (code === 12) {
      keys.push('Ctrl+L');
      i++;
    } else if (code === 14) {
      keys.push('Ctrl+N');
      i++;
    } else if (code === 16) {
      keys.push('Ctrl+P');
      i++;
    } else if (code === 18) {
      keys.push('Ctrl+R');
      i++;
    } else if (code === 19) {
      keys.push('Ctrl+S');
      i++;
    } else if (code === 20) {
      keys.push('Ctrl+T');
      i++;
    } else if (code === 21) {
      keys.push('Ctrl+U');
      i++;
    } else if (code === 23) {
      keys.push('Ctrl+W');
      i++;
    } else if (code === 24) {
      keys.push('Ctrl+X');
      i++;
    } else if (code === 25) {
      keys.push('Ctrl+Y');
      i++;
    } else if (code === 26) {
      keys.push('Ctrl+Z');
      i++;
    } else if (code === 1) {
      keys.push('Ctrl+A');
      i++;
    } else if (code >= 32) {
      keys.push(ch);
      i++;
    } else {
      i++;
    }
  }
  return keys;
}

/** Preserve split CSI/mouse sequences and UTF-8 characters across PTY chunks. */
export class TerminalInputDecoder {
  private pending = '';
  private readonly decoder = new TextDecoder();
  private discardCSI = false;
  get waiting(): boolean { return !!this.pending; }
  feed(chunk: Uint8Array | string): string[] {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, {stream:true});
    if (this.discardCSI) {
      const final = text.search(/[@-~]/); if (final < 0) return [];
      text = text.slice(final + 1); this.discardCSI = false;
    }
    this.pending += text;
    const at = this.pending.lastIndexOf('\x1b');
    const tail = at >= 0 ? this.pending.slice(at) : '';
    if (tail === '\x1b' || /^\x1b\[[0-?]*$/.test(tail)) {
      const ready = this.pending.slice(0, at); this.pending = tail.length <= 128 ? tail : ''; if (tail.length > 128) this.discardCSI = true;
      return parseRawTerminalKey(ready);
    }
    const ready = this.pending; this.pending = ''; return parseRawTerminalKey(ready);
  }
  flush(): string[] { const escape = this.pending === '\x1b'; if (this.pending.startsWith('\x1b[')) this.discardCSI = true; this.pending = ''; return escape ? ['Escape'] : []; }
}

export class FutrynTuiApp {
  public readonly client: FutrynClient;
  public readonly themeEngine: ThemeEngine;
  private cols: number;
  private rows: number;
  private overlay: ActiveOverlay = 'none';
  private effortIndex = 0;
  private composer: ComposerState = createInitialComposerState();
  private transcript: TranscriptItem[] = [];
  private transcriptScrollOffset = -1; // -1 means auto-follow bottom
  private themePickerState: ThemePickerState = createInitialThemePickerState();
  private themeEditorState: ThemeEditorState = createInitialThemeEditorState();
  private modelPickerState: ModelPickerState = createInitialModelPickerState();
  private connectState: ConnectProviderState = createInitialConnectProviderState();
  private sessionPickerState: SessionPickerState = createInitialSessionPickerState();
  private permissionState: PermissionDialogState = createInitialPermissionDialogState();
  private diffState: DiffViewState = createInitialDiffViewState();
  private paletteState: CommandPaletteState = createInitialCommandPaletteState();
  private settingsSelectedIndex = 0;
  private helpOffset = 0;
  private reportOffset = 0;
  private reportDetails = false;
  private showReasoning = true;
  private pendingSwitchAccountId: string | null = null;
  private switchAbort: AbortController | null = null;
  private switchTask: Promise<boolean> | null = null;
  private statusBanner: string | null = null;
  private isStreaming = false;
  private activeAbortController: AbortController | null = null;
  private readonly textSelection = new TextSelection();
  private clipboardSequence = '';
  public selectedText(): string { return this.textSelection.text(); }
  public takeClipboardSequence(): string { const value = this.clipboardSequence; this.clipboardSequence = ''; return value; }
  private previousCells: FrameCell[][] | null = null;
  private animationTimeSeconds = 0;
  private readonly companion = new FynCompanion();
  private exitRequested = false;
  private authAbort: AbortController | null = null;
  private authTask: Promise<void> | null = null;
  private turnTask: Promise<void> | null = null;

  public constructor(options: FutrynTuiOptions) {
    this.client = options.client;
    this.themeEngine =
      options.themeEngine ??
      new ThemeEngine({
        client: options.client,
        env: options.env,
      });
    this.cols = Math.max(40, options.cols ?? (process.stdout.columns || 110));
    this.rows = Math.max(14, options.rows ?? (process.stdout.rows || 32));
  }

  public async initialize(): Promise<void> {
    await this.themeEngine.initialize();
    this.syncTranscriptFromActiveSession();
    const warnings = this.themeEngine.getWarnings();
    if (warnings.length > 0) {
      this.statusBanner = warnings[0]!;
    }
  }

  public isExitRequested(): boolean {
    return this.exitRequested;
  }

  public getActiveOverlay(): ActiveOverlay {
    return this.overlay;
  }

  public getComposerState(): ComposerState {
    return this.composer;
  }

  public getTranscript(): readonly TranscriptItem[] {
    return this.transcript;
  }

  public getStatusBanner(): string | null {
    return this.statusBanner;
  }

  public resize(cols: number, rows: number): void {
    this.textSelection.clear();
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.previousCells = null;
  }

  public stepAnimation(deltaSeconds = 0.08): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const config = this.themeEngine.getActiveAppearance().animations;
    const animate = !config.reducedMotion && !this.themeEngine.wallpaperEngine.isPaused(config);
    this.companion.tick(deltaSeconds, animate, config.speed);
    if (animate) this.animationTimeSeconds += deltaSeconds;
  }

  private syncTranscriptFromActiveSession(): void {
    const active = this.client.activeSession();
    if (!active) {
      this.transcript = [];
      return;
    }
    const status = this.client.status();
    this.transcript = active.messages.map((m, idx) => ({
      id: `${active.id}-${idx}`,
      role: m.role,
      content: m.content,
      modelId: active.selection.modelId,
      accountAlias: status.activeAccount?.alias,
    }));
  }

  public openOverlay(target: ActiveOverlay): void {
    this.textSelection.clear();
    if (this.overlay === 'connect' && target !== 'connect') {
      this.authAbort?.abort();
      if (this.connectState.authChallenge) void this.client.cancelProviderAuth(this.connectState.authChallenge.id);
      this.connectState.secretDraft = '';
    }
    if (this.overlay === 'themes' && target !== 'themes' && this.themeEngine.isPreviewing()) {
      this.themeEngine.cancelPreview();
    }
    this.overlay = target;
    this.pendingSwitchAccountId = null;
    if (['status', 'usage', 'context'].includes(target)) { this.reportOffset = 0; this.reportDetails = false; }
    if (target === 'themes') {
      const currentTheme = this.themeEngine.getCommittedAppearance().theme;
      const list = this.themeEngine.listThemes('all');
      const idx = list.findIndex(theme => theme.id === currentTheme);
      this.themePickerState = { ...createInitialThemePickerState(), selectedIndex: Math.max(0, idx) };
    } else if (target === 'theme-editor') {
      const currentTheme = this.themeEngine.getActiveAppearance().theme;
      this.themeEditorState = createInitialThemeEditorState(
        currentTheme,
        this.themeEngine.getEffectiveMode(),
      );
    } else if (target === 'help') {
      this.helpOffset = 0;
    } else if (target === 'models') {
      this.modelPickerState = createInitialModelPickerState();
    } else if (target === 'connect') {
      this.connectState = createInitialConnectProviderState();
    } else if (target === 'sessions') {
      this.sessionPickerState = createInitialSessionPickerState();
    } else if (target === 'permissions') {
      this.permissionState = createInitialPermissionDialogState();
    } else if (target === 'diff') {
      this.diffState = createInitialDiffViewState();
    } else if (target === 'palette') {
      this.paletteState = createInitialCommandPaletteState();
    }
  }

  public async executeSlashCommand(rawInput: string): Promise<void> {
    this.textSelection.clear();
    const parsed = parseSlashCommand(rawInput);
    if (parsed.error) { this.statusBanner = parsed.error; return; }
    const trimmed = parsed.input;
    const lower = trimmed.toLowerCase();
    if (this.isStreaming && !parsed.definition?.duringRequest) {
      this.statusBanner = 'Cancel the active response with Esc before changing accounts, model or session.';
      return;
    }
    if (parsed.definition?.unavailable) { this.statusBanner = parsed.definition.unavailable; return; }
    if (parsed.definition?.command === '/usage' || parsed.definition?.command === '/context') {
      this.openOverlay(parsed.definition.command.slice(1) as 'usage' | 'context'); return;
    }
    if (parsed.definition?.command === '/effort') {
      try {
        const available = this.client.status().activeModel?.reasoningEfforts ?? [];
        if (!available.length) { this.statusBanner = 'Reasoning effort is not advertised by this model/transport. Provider default is used.'; return; }
        const value = parsed.args === 'auto' ? 'default' : parsed.args;
        if (!value) {
          this.openOverlay('effort');
          this.effortIndex = Math.max(0, ['default', ...available].indexOf(this.client.status().reasoningEffort ?? 'default'));
          return;
        }
        if (value !== 'status' && value !== 'default' && !available.includes(value)) { this.statusBanner = `Available efforts: ${available.join(', ')}. Use /effort <level> or /effort auto. Advanced Claude-only modes are not supported by this transport.`; return; }
        if (value !== 'status') this.client.setReasoningEffort(value);
        this.statusBanner = `Effort: ${this.client.status().reasoningEffort ?? 'provider default'}. Available: ${available.join(', ')}.`;
      } catch (error) { this.statusBanner = this.connectionError(error); }
      return;
    }
    if (parsed.definition?.command === '/switch') {
      const accounts = this.client.listAccounts().filter(a => a.status !== 'logged-out');
      if (!accounts.length) { this.statusBanner = 'No connected accounts. Use /login.'; return; }
      const target = parsed.args ? (/^\d+$/.test(parsed.args) ? accounts[Number(parsed.args) - 1] : accounts.find(a => a.id === parsed.args || a.alias === parsed.args)) : null;
      if (parsed.args && !target) { this.statusBanner = 'Account not found. Use /switch to choose.'; return; }
      const activeId = this.client.status().activeAccount?.id;
      if (target?.id === activeId) { this.statusBanner = `Already using ${target!.alias}.`; return; }
      if (!target && accounts.every(account => account.id === activeId)) { this.statusBanner = 'Only the current account is connected. Use /login to add another.'; return; }
      this.openOverlay('connect');
      this.connectState = { ...createInitialConnectProviderState(), step: target ? 'confirm' : 'accounts', switchOnly: true,
        accountId: target?.id, providerLabel: target?.alias, pendingAction: 'switch',
        selectedIndex: target ? 0 : Math.max(0, accounts.findIndex(a => a.id !== activeId)) };
      return;
    }
    if (lower.startsWith('/model ')) {
      try { this.client.selectModel(trimmed.slice(7).trim()); this.syncTranscriptFromActiveSession(); this.statusBanner = 'Model selected; started a fresh conversation.'; }
      catch (e) { this.statusBanner = this.connectionError(e); }
      return;
    }
    if (lower.startsWith('/resume ')) {
      try { this.client.resumeSession(trimmed.slice(8).trim()); this.syncTranscriptFromActiveSession(); this.overlay = 'none'; }
      catch (e) { this.statusBanner = this.connectionError(e); }
      return;
    }
    if (['/mcp', '/plugin', '/plugins', '/compact'].some(c => lower === c || lower.startsWith(c + ' '))) {
      this.statusBanner = `${trimmed.split(' ')[0]}: Not implemented in PA1/TUI1. ${lower.startsWith('/mcp') ? 'MCP authentication remains separate from provider authentication.' : lower.startsWith('/compact') ? 'Context summarization backend is unavailable; use /clear or /resume.' : 'No plugin host or plugin authentication drivers are enabled.'}`;
      return;
    }
    if (lower === '/doctor') {
      this.statusBanner = 'Diagnosing provider connectivity…';
      try { this.statusBanner = await this.client.diagnose(); }
      catch (e) { this.statusBanner = this.connectionError(e); }
      return;
    }

    if (parsed.definition?.command === '/theme') {
      if (parsed.args) {
        try { await this.themeEngine.setTheme(parsed.args); this.statusBanner = `Applied theme ${parsed.args}.`; }
        catch { this.statusBanner = 'Theme not found. Use /theme to choose.'; }
        return;
      }
      this.openOverlay('themes');
      return;
    }
    if (parsed.definition?.command === '/theme edit' || lower === '/editor' || lower === '/customize') {
      this.statusBanner = 'Custom themes are unavailable. Use /theme for the three monochrome appearances.';
      return;
    }
    if (lower.startsWith('/theme set ')) {
      const id = trimmed.slice('/theme set '.length).trim();
      try {
        await this.themeEngine.setTheme(id);
        this.statusBanner = `Applied theme "${id}".`;
      } catch {
        this.statusBanner = `Theme "${id}" not found.`;
      }
      return;
    }
    if (lower === '/models' || lower === '/model') {
      this.openOverlay('models');
      return;
    }
    if (parsed.definition?.command === '/login') {
      if (parsed.args) {
        try { this.client.useAccount(parsed.args); this.syncTranscriptFromActiveSession(); this.openOverlay('models'); }
        catch (error) { this.statusBanner = this.connectionError(error); }
        return;
      }
      this.openOverlay('connect');
      return;
    }
    if (parsed.definition?.command === '/logout') {
      const accounts = this.client.listAccounts().filter(a => !parsed.args || a.id === parsed.args || a.alias === parsed.args);
      if (!accounts.length) { this.statusBanner = 'No accounts to sign out.'; return; }
      this.openOverlay('connect');
      this.connectState = { ...createInitialConnectProviderState(), step: 'accounts', logoutOnly: true,
        selectedIndex: Math.max(0, accounts.findIndex(a => a.id === this.client.status().activeAccount?.id)) };
      if (accounts.length === 1) {
        this.connectState = { ...this.connectState, step: 'confirm', accountId: accounts[0]!.id,
          providerLabel: accounts[0]!.alias, pendingAction: 'logout', selectedIndex: 0 };
      }
      return;
    }
    if (parsed.definition?.command === '/accounts') {
      this.openOverlay('connect');
      this.connectState.step = 'accounts';
      this.connectState.query = parsed.args;
      return;
    }
    if (lower === '/sessions' || lower === '/resume' || lower === '/continue') {
      this.openOverlay('sessions');
      return;
    }
    if (lower === '/new') {
      try {
        const created = this.client.createSession();
        this.syncTranscriptFromActiveSession();
        this.overlay = 'none';
        this.statusBanner = `Started new session ${created.id.slice(0, 8)} (${created.selection.modelId}).`;
      } catch {
        this.statusBanner = 'Connect a provider account and select a model before starting a session (/login).';
      }
      return;
    }
    if (lower === '/permissions' || lower === '/perm') {
      this.openOverlay('permissions');
      return;
    }
    if (lower === '/diff') {
      this.openOverlay('diff');
      return;
    }
    if (lower === '/settings' || lower === '/config') {
      this.openOverlay('settings');
      return;
    }
    if (lower === '/status') {
      this.openOverlay('status');
      return;
    }
    if (lower === '/help' || lower === '/?') {
      this.openOverlay('help');
      return;
    }
    if (lower === '/clear') {
      this.client.clearSessionView();
      this.transcript = [];
      this.overlay = 'none';
      this.statusBanner = 'Started a fresh conversation. Previous sessions remain in /resume.';
      return;
    }
    if (lower === '/exit' || lower === '/quit') {
      if (this.themeEngine.isPreviewing()) {
        this.themeEngine.cancelPreview();
      }
      this.exitRequested = true;
      return;
    }

    this.statusBanner = `Unknown slash command "${trimmed}". Type /help or press Ctrl+P for commands.`;
  }

  private async continueWithAccount(id: string, modelId?: string): Promise<boolean> {
    if (this.client.status().activeAccount?.id === id) { this.openOverlay('none'); this.statusBanner = 'This account is already active.'; return false; }
    const task = this.runAccountSwitch(id, modelId); this.switchTask = task;
    try { return await task; } finally { if (this.switchTask === task) this.switchTask = null; }
  }
  private async runAccountSwitch(id: string, modelId?: string): Promise<boolean> {
    const abort = new AbortController(); this.switchAbort = abort;
    const alias = this.client.listAccounts().find(a => a.id === id)?.alias ?? 'account';
    const alreadyUsing = this.client.activeSession()?.selection.accountId === id;
    this.openOverlay('connect');
    this.connectState = { ...createInitialConnectProviderState(), step: 'busy', switchOnly: true, pendingAction: 'switch', accountId: id, providerLabel: alias, statusMessage: 'Loading models for the selected account…' };
    try {
      const account = await this.client.switchAccount(id, true, modelId, abort.signal); this.syncTranscriptFromActiveSession(); this.openOverlay('none');
      this.statusBanner = alreadyUsing ? `Already using ${account.alias}.` : this.client.activeSession()?.messages.length
        ? `Using ${account.alias}. Continued in a new account-bound session; original history retained.` : `Using ${account.alias}. Ready to chat.`;
      return true;
    } catch (error) {
      if (abort.signal.aborted) { this.openOverlay('none'); this.statusBanner = 'Account switch cancelled; current account and history preserved.'; }
      else if (error instanceof HannesError && error.code === 'NOT_FOUND' && this.client.cachedModels(id).length) {
        this.openOverlay('models'); this.pendingSwitchAccountId = id;
        this.modelPickerState.statusMessage = 'Choose a model for the new account. Current account stays active until you confirm.';
      } else {
        this.connectState = { ...createInitialConnectProviderState(), step: 'confirm', switchOnly: true, pendingAction: 'switch', accountId: id, providerLabel: alias, statusMessage: this.connectionError(error) };
      }
      return false;
    } finally { if (this.switchAbort === abort) this.switchAbort = null; }
  }

  private async signOutAccount(id: string): Promise<void> {
    const alias = this.client.listAccounts().find(account => account.id === id)?.alias ?? 'account';
    await this.client.logoutAccount(id);
    this.syncTranscriptFromActiveSession();
    this.openOverlay('none');
    this.statusBanner = `Signed out of ${alias}.`;
  }

  public async shutdown(): Promise<void> {
    this.textSelection.clear(); this.clipboardSequence = '';
    this.authAbort?.abort();
    this.switchAbort?.abort();
    this.activeAbortController?.abort();
    if (this.connectState.authChallenge) await this.client.cancelProviderAuth(this.connectState.authChallenge.id);
    this.connectState.secretDraft = '';
    await Promise.allSettled([this.authTask, this.turnTask, this.switchTask]);
  }

  public async submitPrompt(content: string): Promise<void> {
    if (content.trim().startsWith('/')) { await this.submitPromptInternal(content); return; }
    const task = this.submitPromptInternal(content);
    this.turnTask = task;
    try { await task; } finally { if (this.turnTask === task) this.turnTask = null; }
  }

  private async submitPromptInternal(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || (this.isStreaming && !trimmed.startsWith('/'))) return;

    if (trimmed.startsWith('!')) {
      this.statusBanner = 'Shell mode: Not implemented in PA1/TUI1. No command was executed or sent to the provider.';
      return;
    }
    this.composer = recordComposerHistory(this.composer, trimmed);
    if (trimmed.startsWith('/')) {
      await this.executeSlashCommand(trimmed);
      return;
    }

    const status = this.client.status();
    const userItem: TranscriptItem = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      modelId: status.selection?.modelId,
      accountAlias: status.activeAccount?.alias,
    };
    const assistantItem: TranscriptItem = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      modelId: status.selection?.modelId,
      accountAlias: status.activeAccount?.alias,
      streaming: true,
      toolCalls: [],
    };
    this.transcript = [...this.transcript, userItem, assistantItem];
    this.transcriptScrollOffset = -1;
    this.isStreaming = true;
    this.statusBanner = '';
    this.companion.transition('thinking');
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let completed = false;
    const startTime = Date.now();

    try {
      for await (const event of this.client.sendMessage(trimmed, {
        signal: abortController.signal,
      })) {
        if (event.type === 'textDelta') {
          this.companion.transition('streaming');
          assistantItem.content += event.text;
        } else if (event.type === 'reasoningDelta') {
          assistantItem.reasoning = (assistantItem.reasoning ?? '') + event.text;
          assistantItem.reasoningExpanded = this.showReasoning;
          this.companion.transition('thinking');
        } else if (event.type === 'usage') {
          assistantItem.usage = event.usage;
        } else if (event.type === 'toolCallComplete') {
          const calls: ToolCall[] = assistantItem.toolCalls ?? [];
          calls.push(event.call);
          assistantItem.toolCalls = calls;
        } else if (event.type === 'completed') {
          completed = true;
          assistantItem.usage = event.usage;
          assistantItem.streaming = false;
          assistantItem.durationMs = Date.now() - startTime;
        }
      }
      if (abortController.signal.aborted) throw new HannesError('CANCELLED');
      if (!completed) throw new HannesError('PROTOCOL');
      assistantItem.streaming = false;
      assistantItem.reasoningExpanded = this.showReasoning;
      const totalTok =
        (assistantItem.usage?.inputTokens ?? 0) + (assistantItem.usage?.outputTokens ?? 0);
      this.statusBanner = assistantItem.usage?.inputTokens == null || assistantItem.usage?.outputTokens == null
        ? 'Completed turn · token usage not reported.' : `Completed turn (${totalTok} tokens).`;
      this.companion.transition('done');
    } catch (err) {
      this.companion.transition(abortController.signal.aborted || (err instanceof HannesError && err.code === 'CANCELLED') ? 'cancelled' : 'error');
      assistantItem.streaming = false;
      if (err instanceof HannesError) {
        assistantItem.errorText = `Error [${err.code}]: ${
          err.code === 'AUTH'
            ? 'No active provider account or model selected. Run /login or /model.'
            : err.code === 'CANCELLED'
              ? 'Generation cancelled by user.'
              : err.code
        }`;
        this.statusBanner = assistantItem.errorText;
      } else {
        assistantItem.errorText = 'Request failed. Run /doctor for safe connection diagnostics.';
        this.statusBanner = assistantItem.errorText;
      }
    } finally {
      this.isStreaming = false;
      this.activeAbortController = null;
    }
  }

  public async handleKey(key: string): Promise<void> {
    const mouse = /^(MouseDown|MouseDrag|MouseUp):(\d+):(\d+)$/.exec(key);
    if (mouse) {
      const point = {row:Number(mouse[2]), col:Number(mouse[3])};
      if (mouse[1] === 'MouseDown') { this.textSelection.clear(); this.textSelection.begin(this.computeFrameSnapshot(), point); }
      else if (mouse[1] === 'MouseDrag') this.textSelection.move(point);
      else this.textSelection.release(point);
      return;
    }
    if (this.textSelection.active() && (key === 'Ctrl+C' || key === 'Ctrl+Y')) {
      const sequence = this.textSelection.copySequence();
      if (sequence) this.clipboardSequence = sequence;
      return;
    }
    if (key !== 'FocusIn' && key !== 'FocusOut' && this.textSelection.frame) {
      this.textSelection.clear(); if (key === 'Escape') return;
    }

    if (key !== 'FocusIn' && key !== 'FocusOut') this.companion.activity();
    if (key !== 'FocusIn' && key !== 'FocusOut') this.statusBanner = null;
    if (key === 'FocusIn') {
      this.themeEngine.wallpaperEngine.setFocused(true);
      return;
    }
    if (key === 'FocusOut') {
      this.themeEngine.wallpaperEngine.setFocused(false);
      return;
    }

    if (this.isStreaming && ['Ctrl+L', 'Ctrl+S', 'Ctrl+N'].includes(key)) {
      this.statusBanner = 'Cancel the active response with Esc before changing model or session.';
      return;
    }

    if (this.switchAbort && key !== 'Escape' && key !== 'Ctrl+C') return;

    // Global shortcuts
    if (key === 'Ctrl+C') {
      if (this.overlay === 'connect') {
        if (this.switchAbort) { this.switchAbort.abort(); this.connectState.statusMessage = 'Cancelling account switch…'; return; }
        this.authAbort?.abort();
        this.connectState.secretDraft = '';
        this.openOverlay('none');
        this.statusBanner = 'Authentication cancelled.';
        return;
      }
      if (!this.isStreaming && this.composer.value) {
        this.composer = updateComposerValue(this.composer, '', 0);
        this.statusBanner = 'Input cleared. Press Ctrl+C again to exit.';
        return;
      }
      if (this.isStreaming && this.activeAbortController) {
        this.activeAbortController.abort();
        this.statusBanner = 'Cancelled streaming response.';
        return;
      }
      if (this.themeEngine.isPreviewing()) {
        this.themeEngine.cancelPreview();
      }
      this.exitRequested = true;
      return;
    }
    if (key === 'Ctrl+P') {
      this.openOverlay(this.overlay === 'palette' ? 'none' : 'palette');
      return;
    }
    if (key === 'Ctrl+T') {
      this.openOverlay(this.overlay === 'themes' ? 'none' : 'themes');
      return;
    }
    if (key === 'Ctrl+L') {
      this.openOverlay(this.overlay === 'models' ? 'none' : 'models');
      return;
    }
    if (key === 'Ctrl+S' && this.overlay !== 'theme-editor') {
      this.openOverlay(this.overlay === 'sessions' ? 'none' : 'sessions');
      return;
    }
    if (key === 'Ctrl+D' && this.overlay === 'none') {
      this.openOverlay('diff');
      return;
    }
    if (key === 'Ctrl+B' && this.overlay === 'none') {
      const current = this.themeEngine.getActiveAppearance().sidebar;
      await this.themeEngine.updateAppearance({ sidebar: !current });
      this.statusBanner = `Sidebar ${!current ? 'shown' : 'collapsed'}.`;
      return;
    }

    // Route to active overlay if open
    if (this.overlay !== 'none') {
      await this.handleOverlayKey(key);
      return;
    }

    // Main screen key handling
    if (key === 'Ctrl+R') {
      this.showReasoning = !this.showReasoning;
      for (const item of this.transcript) item.reasoningExpanded = this.showReasoning;
      return;
    }
    if (key === 'Alt+Enter' || key === 'Ctrl+J') {
      const next = this.composer.value.slice(0, this.composer.cursor) + '\n' + this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, next, this.composer.cursor + 1);
      return;
    }
    if (key === 'Shift+Tab') {
      const nextMode = this.client.cycleMode();
      this.statusBanner = `View mode: ${nextMode.toUpperCase()}. Tool permission modes: Not implemented; no permissions changed.`;
      return;
    }

    if (key === 'Escape') {
      if (this.composer.slashMenuOpen || this.composer.fileMenuOpen) {
        this.composer = {
          ...this.composer,
          slashMenuOpen: false,
          fileMenuOpen: false,
        };
        return;
      }
      if (this.isStreaming && this.activeAbortController) {
        this.activeAbortController.abort();
        this.statusBanner = 'Cancelled streaming response.';
        return;
      }
      if (this.composer.value.length > 0) {
        this.composer = updateComposerValue(this.composer, '', 0);
      }
      return;
    }

    if (key === 'PageUp') {
      this.transcriptScrollOffset = Math.max(0, (this.transcriptScrollOffset < 0 ? 10 : this.transcriptScrollOffset) - 5);
      return;
    }
    if (key === 'PageDown') {
      this.transcriptScrollOffset = -1;
      return;
    }

    // Autocomplete navigation in composer
    if (this.composer.slashMenuOpen) {
      const matches = getMatchingSlashCommands(this.composer.value);
      if (key === 'ArrowDown') {
        this.composer = {
          ...this.composer,
          slashSelectedIndex: (this.composer.slashSelectedIndex + 1) % Math.max(1, matches.length),
        };
        return;
      }
      if (key === 'ArrowUp') {
        this.composer = {
          ...this.composer,
          slashSelectedIndex:
            (this.composer.slashSelectedIndex - 1 + Math.max(1, matches.length)) %
            Math.max(1, matches.length),
        };
        return;
      }
      if (key === 'Tab') {
        const chosen = matches[this.composer.slashSelectedIndex % Math.max(1, matches.length)];
        if (chosen) {
          this.composer = {
            ...updateComposerValue(this.composer, chosen.command, chosen.command.length),
            slashMenuOpen: false,
          };
        }
        return;
      }
      if (key === 'Enter') {
        const chosen = matches[this.composer.slashSelectedIndex % Math.max(1, matches.length)];
        const toRun =
          acceptSlashSelection(this.composer.value, chosen);
        this.composer = recordComposerHistory(this.composer, toRun);
        await this.executeSlashCommand(toRun);
        return;
      }
    }

    if (this.composer.fileMenuOpen) {
      const files = this.client.listWorkspaceFiles(this.composer.fileQuery).slice(0, 5);
      if (key === 'ArrowDown' && files.length > 0) {
        this.composer = {
          ...this.composer,
          fileSelectedIndex: (this.composer.fileSelectedIndex + 1) % files.length,
        };
        return;
      }
      if (key === 'ArrowUp' && files.length > 0) {
        this.composer = {
          ...this.composer,
          fileSelectedIndex: (this.composer.fileSelectedIndex - 1 + files.length) % files.length,
        };
        return;
      }
      if ((key === 'Tab' || key === 'Enter') && files.length > 0) {
        const chosen = files[this.composer.fileSelectedIndex % files.length];
        if (chosen) {
          this.composer = applyFileReferenceSelection(this.composer, chosen);
          return;
        }
      }
    }

    if (key === 'ArrowUp') {
      this.composer = navigateComposerHistory(this.composer, 'up');
      return;
    }
    if (key === 'ArrowDown') {
      this.composer = navigateComposerHistory(this.composer, 'down');
      return;
    }
    if (key === 'ArrowLeft') {
      this.composer = {
        ...this.composer,
        cursor: Math.max(0, this.composer.cursor - 1),
      };
      return;
    }
    if (key === 'ArrowRight') {
      this.composer = {
        ...this.composer,
        cursor: Math.min(this.composer.value.length, this.composer.cursor + 1),
      };
      return;
    }
    if (key === 'Backspace') {
      if (this.composer.cursor > 0) {
        const nextVal =
          this.composer.value.slice(0, this.composer.cursor - 1) +
          this.composer.value.slice(this.composer.cursor);
        this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor - 1);
      }
      return;
    }
    if (key === 'Delete') {
      if (this.composer.cursor < this.composer.value.length) {
        const nextVal =
          this.composer.value.slice(0, this.composer.cursor) +
          this.composer.value.slice(this.composer.cursor + 1);
        this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor);
      }
      return;
    }
    if (key === 'Enter') {
      await this.submitPrompt(this.composer.value);
      return;
    }

    if (key.length === 1) {
      const nextVal =
        this.composer.value.slice(0, this.composer.cursor) +
        key +
        this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor + 1);
    }
  }

  private async handleOverlayKey(key: string): Promise<void> {
    switch (this.overlay) {
      case 'effort': {
        const values = ['default', ...(this.client.status().activeModel?.reasoningEfforts ?? [])];
        if (key === 'Escape') { this.overlay = 'none'; return; }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
          this.effortIndex = Math.max(0, Math.min(values.length - 1, this.effortIndex + (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1)));
        } else if (key === 'Enter') {
          try { this.client.setReasoningEffort(values[this.effortIndex] ?? 'default'); this.statusBanner = `Effort: ${values[this.effortIndex] === 'default' ? 'auto (provider default)' : values[this.effortIndex]}.`; this.overlay = 'none'; }
          catch (error) { this.statusBanner = this.connectionError(error); }
        }
        return;
      }
      case 'themes':
        await this.handleThemesOverlayKey(key);
        return;
      case 'theme-editor':
        await this.handleThemeEditorKey(key);
        return;
      case 'models':
        await this.handleModelsOverlayKey(key);
        return;
      case 'connect':
        await this.handleConnectOverlayKey(key);
        return;
      case 'sessions':
        await this.handleSessionsOverlayKey(key);
        return;
      case 'permissions':
        this.handlePermissionsOverlayKey(key);
        return;
      case 'diff':
        this.handleDiffOverlayKey(key);
        return;
      case 'palette':
        await this.handlePaletteOverlayKey(key);
        return;
      case 'settings':
        await this.handleSettingsOverlayKey(key);
        return;
      case 'help':
        if (['ArrowDown', 'PageDown'].includes(key)) this.helpOffset = Math.min(40, this.helpOffset + (key === 'PageDown' ? 8 : 1));
        else if (['ArrowUp', 'PageUp'].includes(key)) this.helpOffset = Math.max(0, this.helpOffset - (key === 'PageUp' ? 8 : 1));
        else if (key === 'Escape' || key === 'Enter') this.overlay = 'none';
        return;
      case 'usage':
      case 'context':
      case 'status':
        if (key.toLowerCase() === 'd') { this.reportDetails = !this.reportDetails; this.reportOffset = 0; return; }
        if (['ArrowDown', 'PageDown'].includes(key)) this.reportOffset = Math.min(Number.MAX_SAFE_INTEGER, this.reportOffset + (key === 'PageDown' ? Math.max(1, Math.floor(this.rows * 0.6)) : 1));
        else if (['ArrowUp', 'PageUp'].includes(key)) this.reportOffset = Math.max(0, this.reportOffset - (key === 'PageUp' ? Math.max(1, Math.floor(this.rows * 0.6)) : 1));
        if (key === 'Escape' || key === 'Enter') {
          this.overlay = 'none';
        }
        return;
    }
  }

  private async handleThemesOverlayKey(key: string): Promise<void> {
    const list = this.themeEngine.listThemes('all');
    if (key === 'Escape') {
      this.themeEngine.cancelPreview(); this.overlay = 'none'; return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!list.length) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      const selectedIndex = (this.themePickerState.selectedIndex + delta + list.length) % list.length;
      this.themePickerState = { ...this.themePickerState, selectedIndex };
      this.themeEngine.previewTheme(list[selectedIndex]!.id);
      return;
    }
    if (key === 'Enter') {
      const selected = list[this.themePickerState.selectedIndex];
      if (selected) { await this.themeEngine.setTheme(selected.id); this.statusBanner = `Appearance: ${selected.name}.`; }
      this.overlay = 'none';
    }
  }

  private async handleThemeEditorKey(key: string): Promise<void> {
    const st = this.themeEditorState;
    const manifest = this.themeEngine.getTheme(st.targetThemeId) ?? this.themeEngine.getActiveThemeManifest();

    if (st.renaming) {
      if (key === 'Escape') {
        this.themeEditorState = { ...st, renaming: false };
        return;
      }
      if (key === 'Backspace') {
        this.themeEditorState = { ...st, nameDraft: st.nameDraft.slice(0, -1) };
        return;
      }
      if (key === 'Enter') {
        try {
          let targetId = manifest.id;
          if (manifest.builtIn) {
            const dup = await this.themeEngine.duplicateTheme(manifest.id, `${manifest.id}-custom`, st.nameDraft);
            targetId = dup.id;
          } else {
            await this.themeEngine.renameCustomTheme(manifest.id, st.nameDraft);
          }
          this.themeEditorState = {
            ...st,
            targetThemeId: targetId,
            renaming: false,
            statusMessage: `Saved custom theme name "${st.nameDraft}".`,
          };
        } catch {
          this.themeEditorState = { ...st, renaming: false, statusMessage: 'Invalid theme name.' };
        }
        return;
      }
      if (key.length === 1) {
        this.themeEditorState = { ...st, nameDraft: (st.nameDraft + key).slice(0, 60) };
      }
      return;
    }

    if (st.editingHex) {
      if (key === 'Escape') {
        this.themeEditorState = { ...st, editingHex: false };
        return;
      }
      if (key === 'Backspace') {
        this.themeEditorState = { ...st, hexDraft: st.hexDraft.slice(0, -1) };
        return;
      }
      if (key === 'Enter') {
        const tokenKey = THEME_TOKEN_KEYS[st.selectedTokenIndex]!;
        const candidateHex = st.hexDraft.startsWith('#') ? st.hexDraft : `#${st.hexDraft}`;
        try {
          let targetId = manifest.id;
          if (manifest.builtIn) {
            const customId = `${manifest.id}-custom`;
            if (!this.themeEngine.hasTheme(customId)) {
              await this.themeEngine.duplicateTheme(manifest.id, customId, `${manifest.name} Custom`);
            }
            targetId = customId;
          }
          await this.themeEngine.updateCustomThemeToken(targetId, st.editMode, tokenKey, candidateHex);
          await this.themeEngine.setTheme(targetId);
          this.themeEditorState = {
            ...st,
            targetThemeId: targetId,
            editingHex: false,
            statusMessage: `Updated ${tokenKey} to ${candidateHex.toLowerCase()} on "${targetId}".`,
          };
        } catch {
          this.themeEditorState = {
            ...st,
            editingHex: false,
            statusMessage: `Invalid hex color "${candidateHex}". Expected #rrggbb.`,
          };
        }
        return;
      }
      if (key.length === 1 && /^[#0-9a-fA-F]$/.test(key)) {
        this.themeEditorState = { ...st, hexDraft: (st.hexDraft + key).slice(0, 7) };
      }
      return;
    }

    if (key === 'Escape') {
      this.overlay = 'none';
      return;
    }
    if (key === 'Tab') {
      this.themeEditorState = {
        ...st,
        editMode: st.editMode === 'dark' ? 'light' : 'dark',
      };
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.themeEditorState = {
        ...st,
        selectedTokenIndex: (st.selectedTokenIndex + delta + THEME_TOKEN_KEYS.length) % THEME_TOKEN_KEYS.length,
      };
      return;
    }
    if (key === 'Enter') {
      const tokenKey = THEME_TOKEN_KEYS[st.selectedTokenIndex]!;
      const curHex = (st.editMode === 'light' ? manifest.light : manifest.dark)[tokenKey];
      this.themeEditorState = {
        ...st,
        editingHex: true,
        hexDraft: curHex,
      };
      return;
    }
    if (key === 'Ctrl+D') {
      const newId = `${manifest.id.slice(0, 28)}-copy`;
      const dup = await this.themeEngine.duplicateTheme(manifest.id, newId, `${manifest.name} Copy`);
      await this.themeEngine.setTheme(dup.id);
      this.themeEditorState = {
        ...st,
        targetThemeId: dup.id,
        statusMessage: `Duplicated to custom theme "${dup.id}".`,
      };
      return;
    }
    if (key === 'Ctrl+R') {
      this.themeEditorState = {
        ...st,
        renaming: true,
        nameDraft: manifest.name,
      };
      return;
    }
    if (key === 'Ctrl+Z') {
      if (manifest.builtIn) {
        this.themeEditorState = { ...st, statusMessage: 'Built-in themes are already at default values.' };
        return;
      }
      const tokenKey = THEME_TOKEN_KEYS[st.selectedTokenIndex]!;
      await this.themeEngine.resetCustomThemeToken(manifest.id, st.editMode, tokenKey);
      this.themeEditorState = { ...st, statusMessage: `Reset token "${tokenKey}" to default.` };
      return;
    }
    if (key === 'Ctrl+U') {
      if (manifest.builtIn) {
        this.themeEditorState = { ...st, statusMessage: 'Built-in themes cannot be reset.' };
        return;
      }
      await this.themeEngine.resetCustomTheme(manifest.id);
      this.themeEditorState = { ...st, statusMessage: `Reset all tokens of "${manifest.id}" to default.` };
      return;
    }
    if (key === 'Ctrl+X') {
      if (manifest.builtIn) {
        this.themeEditorState = { ...st, statusMessage: 'Built-in themes are immutable and cannot be deleted.' };
        return;
      }
      await this.themeEngine.removeCustomTheme(manifest.id);
      this.themeEditorState = {
        ...createInitialThemeEditorState('futryn-default', this.themeEngine.getEffectiveMode()),
        statusMessage: `Deleted custom theme "${manifest.id}".`,
      };
    }
  }

  private async handleModelsOverlayKey(key: string): Promise<void> {
    if (this.isStreaming && ['Enter', 'Tab', 'Shift+Tab', 'Ctrl+A'].includes(key)) { this.statusBanner = 'Cancel the active response with Esc first.'; return; }
    const st = this.modelPickerState;
    const models = filterModels(this.client.cachedModels(this.pendingSwitchAccountId ?? undefined), st.query);

    if (st.addingManual) {
      if (key === 'Escape') {
        this.modelPickerState = { ...st, addingManual: false, manualDraft: '' };
        return;
      }
      if (key === 'Backspace') {
        this.modelPickerState = { ...st, manualDraft: st.manualDraft.slice(0, -1) };
        return;
      }
      if (key === 'Enter') {
        try {
          const added = this.client.addManualModel(st.manualDraft.trim(), this.pendingSwitchAccountId ?? undefined);
          if (this.pendingSwitchAccountId) { await this.continueWithAccount(this.pendingSwitchAccountId, added.id); return; }
          this.client.selectModel(added.id);
          this.pendingSwitchAccountId = null;
          this.syncTranscriptFromActiveSession();
          this.modelPickerState = { ...st, addingManual: false, manualDraft: '' };
          this.overlay = 'none';
          this.statusBanner = `Added and selected manual model "${added.id}".`;
        } catch {
          this.modelPickerState = {
            ...st,
            addingManual: false,
            statusMessage: 'Failed to add manual model. Ensure an account is active (/login).',
          };
        }
        return;
      }
      if (key.length === 1) {
        this.modelPickerState = { ...st, manualDraft: (st.manualDraft + key).slice(0, 80) };
      }
      return;
    }

    if (key === 'Escape') {
      this.pendingSwitchAccountId = null;
      this.overlay = 'none';
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (models.length === 0) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.modelPickerState = {
        ...st,
        selectedIndex: (st.selectedIndex + delta + models.length) % models.length,
      };
      return;
    }
    if ((key === 'Tab' || key === 'Shift+Tab') && this.pendingSwitchAccountId) {
      this.modelPickerState.statusMessage = 'Choose a model for this account or Esc to cancel the switch.'; return;
    }
    if (key === 'Tab' || key === 'Shift+Tab') {
      const accounts = this.client.listAccounts().filter(a => a.status !== 'logged-out');
      if (!accounts.length) { this.modelPickerState.statusMessage = 'Use /login to connect a provider.'; return; }
      const current = accounts.findIndex(a => a.id === this.client.status().activeAccount?.id);
      const target = accounts[(current + (key === 'Tab' ? 1 : -1) + accounts.length) % accounts.length]!;
      this.client.useAccount(target.id); this.syncTranscriptFromActiveSession();
      this.modelPickerState = { ...createInitialModelPickerState(), statusMessage: `${target.providerId} · ${target.alias}. Ctrl+R discovers models; Tab switches accounts.` };
      return;
    }
    if (key === 'Ctrl+E' || key === 'ArrowLeft' || key === 'ArrowRight') {
      if (this.isStreaming) { this.modelPickerState.statusMessage = 'Cancel the response before changing effort.'; return; }
      const chosen = models[st.selectedIndex];
      const levels = chosen?.reasoningEfforts ?? [];
      if (!levels.length) { this.modelPickerState.statusMessage = 'Reasoning effort is not advertised by this model/transport.'; return; }
      const values = ['default', ...levels];
      const current = st.effortDraft?.modelId === chosen!.id ? st.effortDraft.value : chosen!.id === this.client.status().selection?.modelId ? this.client.status().reasoningEffort ?? 'default' : chosen!.defaultReasoningEffort ?? 'default';
      const index = Math.max(0, values.indexOf(current));
      const next = values[Math.max(0, Math.min(values.length - 1, index + (key === 'ArrowLeft' ? -1 : 1)))]!;
      this.modelPickerState = { ...st, effortDraft: { modelId: chosen!.id, value: next }, statusMessage: undefined }; return;
    }
    if (key === 'Ctrl+R') {
      try {
        const res = await this.client.discoverModels({ accountId: this.pendingSwitchAccountId ?? undefined });
        this.modelPickerState = {
          ...st,
          selectedIndex: 0,
          statusMessage: `Discovered ${res.models.length} models from ${res.account.alias}.`,
        };
      } catch {
        this.modelPickerState = {
          ...st,
          statusMessage: 'Model discovery failed. Check active account credentials (/login).',
        };
      }
      return;
    }
    if (key === 'Ctrl+A') {
      this.modelPickerState = { ...st, addingManual: true, manualDraft: '' };
      return;
    }
    if (key === 'Enter') {
      const chosen = models[st.selectedIndex];
      if (chosen) {
        try {
          if (this.pendingSwitchAccountId) {
            const targetAccountId = this.pendingSwitchAccountId;
            await this.continueWithAccount(targetAccountId, chosen.id);
            if (this.client.status().selection?.accountId === targetAccountId && this.client.status().selection?.modelId === chosen.id && this.overlay === 'none' && st.effortDraft?.modelId === chosen.id) this.client.setReasoningEffort(st.effortDraft.value);
            return;
          }
          this.client.selectModel(chosen.id);
          if (st.effortDraft?.modelId === chosen.id) this.client.setReasoningEffort(st.effortDraft.value);
          this.pendingSwitchAccountId = null;
          this.syncTranscriptFromActiveSession();
          this.overlay = 'none';
          this.statusBanner = `Selected model "${chosen.id}".`;
        } catch {
          this.modelPickerState = { ...st, statusMessage: 'Could not select model.' };
        }
      }
      return;
    }
    if (key === 'Backspace') {
      this.modelPickerState = { ...st, query: st.query.slice(0, -1), selectedIndex: 0 };
      return;
    }
    if (key.length === 1) {
      this.modelPickerState = { ...st, query: st.query + key, selectedIndex: 0 };
    }
  }

  private async handleConnectOverlayKey(key: string): Promise<void> {
    const st = this.connectState;
    if (st.authChallenge && (key === 'PageDown' || key === 'PageUp')) { st.scrollOffset = Math.max(0, Math.min(40, (st.scrollOffset ?? 0) + (key === 'PageDown' ? 1 : -1))); return; }
    if (st.step === 'busy' && st.pendingAction === 'switch') {
      if (key === 'Escape' || key === 'Ctrl+C') { this.switchAbort?.abort(); st.statusMessage = 'Cancelling account switch…'; }
      return;
    }
    if (st.step === 'busy') {
      if (key === 'Escape' || key === 'Ctrl+C') {
        this.authAbort?.abort();
        this.connectState = { ...st, secretDraft: '', step: 'method', selectedIndex: 0, statusMessage: 'Authentication cancelled; cleaning up credentials. Wait before reconnecting.' };
      }
      return;
    }
    if (key === 'Escape') {
      this.connectState.secretDraft = '';
      if (st.authChallenge) await this.client.cancelProviderAuth(st.authChallenge.id);
      if (st.step === 'provider' || st.step === 'accounts' || ((st.logoutOnly || st.switchOnly) && st.step === 'confirm')) this.openOverlay('none');
      else if (st.step === 'actions' || st.step === 'confirm' || st.step === 'rename') this.connectState = { ...st, step: 'accounts', query: '', selectedIndex: 0, secretDraft: '' };
      else this.connectState = createInitialConnectProviderState();
      return;
    }
    if (key === 'Ctrl+A' && !st.logoutOnly && !st.switchOnly && (st.step === 'provider' || st.step === 'accounts')) {
      this.connectState = { ...createInitialConnectProviderState(), step: st.step === 'provider' ? 'accounts' : 'provider' };
      return;
    }
    const choices = connectionChoices(st, this.client.listIntegrations(), this.client.listAccounts(), this.client.status().activeAccount?.id);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (choices.length) {
        for (let count = 0; count < choices.length; count++) {
          st.selectedIndex = (st.selectedIndex + (key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
          if (!choices[st.selectedIndex]?.disabled) break;
        }
      }
      return;
    }
    if (key === 'Enter') {
      const chosen = choices[st.selectedIndex];
      if (chosen?.disabled) { st.statusMessage = 'This account is already active.'; return; }
      const next = (step: ConnectProviderState['step'], draft = '') => { this.connectState = { ...st, step, draft, selectedIndex: 0, statusMessage: undefined }; };
      try {
        if (st.step === 'provider' && chosen) {
          if (chosen.id === '__custom') { next('custom-id'); this.connectState.custom = {}; }
          else { st.providerId = chosen.id; st.providerLabel = this.client.listIntegrations().find(i => i.provider.id === chosen.id)?.provider.name; st.accountId = undefined; next('method'); }
        } else if (st.step === 'method' && chosen) {
          if (chosen.id === '__advanced') { st.showAdvanced = !st.showAdvanced; st.selectedIndex = 0; return; }
          const method = this.client.listIntegrations().find(i => (i.providerIds ?? [i.provider.id]).includes(st.providerId!))?.methods.find(m => m.id === chosen.id);
          if (method?.available === false) { st.statusMessage = method.diagnostic ?? 'Install the official runtime and retry.'; return; }
          st.method = chosen.id as ConnectProviderState['method'];
          st.providerId = method?.providerId ?? st.providerId;
          st.authChallenge = undefined;
          const baseAlias = st.providerId!.slice(0, 90);
          const accounts = this.client.listAccounts();
          let alias = baseAlias; let suffix = 2;
          while (accounts.some(account => account.alias === alias)) alias = `${baseAlias}-${suffix++}`;
          st.aliasDraft = st.accountId ? accounts.find(account => account.id === st.accountId)!.alias : alias;
          if (st.method === 'subscription-browser' || st.method === 'subscription-device') {
            this.startProviderSignIn(st);
          } else if (st.method === 'openrouter-oauth') {
            const challenge = await this.client.beginProviderAuth(st.providerId!, st.method);
            next('oauth'); this.connectState.authChallenge = challenge;
            if (challenge.autoComplete) this.startConnectionAuthentication(this.connectState);
          } else if (st.method === 'none') this.startConnectionAuthentication(st);
          else next(st.method === 'env' ? 'env' : 'secret');
        } else if (st.step === 'secret' || st.step === 'env' || st.step === 'oauth') {
          if (!(st.step === 'secret' || st.step === 'oauth' ? st.secretDraft : st.draft).trim()) { st.statusMessage = 'A credential or variable name is required.'; return; }
          if (st.step === 'env' && !/^[A-Z_][A-Z0-9_]{0,99}$/.test(st.draft)) { st.statusMessage = 'Enter the environment variable NAME, not its value.'; return; }
          this.startConnectionAuthentication(st);
        } else if (st.step === 'custom-id') {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(st.draft)) { st.statusMessage = 'Use a provider ID with letters, numbers, dots or dashes.'; return; }
          st.custom = { id: st.draft, name: st.draft }; next('url');
        } else if (st.step === 'url') {
          // The backend validates scheme, host, URL credentials, query and hash before saving.
          const u = new URL(st.draft);
          if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) { st.statusMessage = 'Use a base URL without credentials, query or fragment.'; return; }
          st.custom = { ...st.custom, baseURL: st.draft }; next('protocol');
        } else if (st.step === 'protocol' && chosen) {
          st.custom = { ...st.custom, protocol: chosen.id as Provider['protocol'] }; next('auth');
        } else if (st.step === 'auth' && chosen) {
          st.custom = { ...st.custom, auth: chosen.id as Provider['auth'] }; next('catalog');
        } else if (st.step === 'catalog' && chosen) {
          st.custom = { ...st.custom, catalog: chosen.id as Provider['catalog'] };
          if (chosen.id === 'manual') next('manual');
          else this.saveCustomProvider(st);
        } else if (st.step === 'manual') {
          modelIdSchema.parse(st.draft); st.customModelId = st.draft; this.saveCustomProvider(st);
        } else if (st.step === 'accounts' && chosen) {
          if (st.logoutOnly || st.switchOnly) {
            st.accountId = chosen.id; st.providerLabel = this.client.listAccounts().find(a => a.id === chosen.id)?.alias;
            st.pendingAction = st.switchOnly ? 'switch' : 'logout'; next('confirm'); return;
          }
          st.accountId = chosen.id;
          st.providerId = this.client.listAccounts().find(a => a.id === chosen.id)!.providerId;
          next('actions');
        } else if (st.step === 'actions' && chosen) {
          if (chosen.id === 'switch') {
            this.client.useAccount(st.accountId!); this.syncTranscriptFromActiveSession(); this.openOverlay('models');
          } else if (chosen.id === 'add') { st.accountId = undefined; next('method'); }
          else if (chosen.id === 'rename') next('rename');
          else if (chosen.id === 'reconnect') next('method');
          else { st.pendingAction = chosen.id as 'logout' | 'remove'; next('confirm'); }
        } else if (st.step === 'rename') {
          this.client.renameAccount(st.accountId!, st.draft.trim()); next('accounts'); this.connectState.query = ''; this.connectState.statusMessage = 'Account renamed.';
        } else if (st.step === 'confirm' && chosen) {
          if (chosen.id === 'confirm' && st.switchOnly) {
            await this.continueWithAccount(st.accountId!); return;
          }
          if (chosen.id === 'confirm' && st.logoutOnly) { await this.signOutAccount(st.accountId!); return; }
          if (chosen.id === 'cancel' && (st.logoutOnly || st.switchOnly)) { this.openOverlay('none'); return; }
          if (chosen.id === 'confirm') {
            await this.client.logoutAccount(st.accountId!, true);
            this.syncTranscriptFromActiveSession();
          }
          this.connectState = { ...createInitialConnectProviderState(), step: 'accounts', statusMessage: chosen.id === 'confirm' ? 'Local credential removed. Revoke remote API keys in the provider console; shell environment values remain in your shell.' : 'Cancelled.' };
        }
      } catch (error) {
        st.secretDraft = '';
        st.statusMessage = this.connectionError(error);
      }
      return;
    }
    const field = st.step === 'provider' || st.step === 'accounts' ? 'query' : st.step === 'secret' || st.step === 'oauth' ? 'secretDraft' : 'draft';
    if (choices.length && st.step !== 'provider' && st.step !== 'accounts') return;
    if (key === 'Backspace') st[field] = st[field].slice(0, -1);
    else if (key.length === 1 && !/[\x00-\x1f\x7f-\x9f]/.test(key)) st[field] = (st[field] + key).slice(0, field === 'secretDraft' ? 8192 : 2048);
    if (field === 'query') st.selectedIndex = 0;
  }

  private saveCustomProvider(st: ConnectProviderState): void {
    const provider = providerSchema.parse({ ...st.custom, metadataVersion: 1, timeoutMs: 60000 });
    this.client.addProvider(provider);
    this.connectState = { ...st, providerId: provider.id, providerLabel: provider.name, step: 'method', selectedIndex: 0, draft: '', statusMessage: 'Endpoint saved. Choose authentication.' };
  }

  private connectionError(error: unknown, providerId?: string): string {
    const code = error instanceof HannesError ? error.code : 'INVALID_INPUT';
    const target = providerId ?? (this.overlay === 'connect' ? this.connectState.providerId : this.client.status().activeProvider?.id);
    const provider = this.client.listProviders().find(p => p.id === target) ?? this.client.listIntegrations().find(i => i.provider.id === target)?.provider;
    if (provider?.runtime) {
      const name = provider.runtime === 'copilot' ? 'GitHub' : provider.name;
      const subscriptionHints: Record<string, string> = {
        AUTH: `${name} sign-in could not be verified. Try signing in again.`,
        FORBIDDEN: `${name} signed in, but subscription access was denied. Check your plan or organization policy.`,
        STORAGE: 'Secure sign-in storage is unavailable. Unlock the OS keyring and retry.',
        POLICY: 'This account is busy or changed. Cancel the active request and retry.',
        TRANSPORT: `${name} runtime connection failed. Restart FUTRYN and retry.`,
      };
      if (subscriptionHints[code]) return `${code}: ${subscriptionHints[code]}`;
    }
    const hints: Record<string, string> = {
      RUNTIME_UNAVAILABLE: 'Install the official Codex, Copilot CLI, Gemini CLI or Qwen Code runtime on PATH for this subscription.',
      AUTH: 'Credential rejected or missing. Reconnect with a valid API key or environment variable.',
      FORBIDDEN: 'Access denied. Check API entitlement, billing and endpoint permissions.',
      STORAGE: 'OS keyring unavailable or storage failed. Unlock the keyring or choose an environment reference. Retry /logout if cleanup failed.',
      TRANSPORT: 'Endpoint unreachable. Check base URL, network and server availability.',
      TIMEOUT: 'Endpoint timed out. Check the server and retry.',
      CANCELLED: 'Authentication cancelled; new credentials removed.',
      POLICY: 'Policy denied the endpoint or account. Use HTTPS or explicit loopback HTTP.',
      NOT_FOUND: 'Provider/model not found. Check the URL, discovery protocol or manual model ID.',
      RATE_LIMIT: 'Provider rate limited this request. Wait and retry.',
      INVALID_INPUT: 'Check the fields and use a unique provider/account name.',
    };
    return `${code}: ${hints[code] ?? 'Provider response was invalid. Check API protocol and model discovery settings.'}`;
  }

  private startProviderSignIn(st: ConnectProviderState): void {
    if (this.authAbort) return;
    const controller = new AbortController();
    this.authAbort = controller;
    const starting = this.connectState = { ...st, step: 'busy', statusMessage: 'Opening sign-in…' };
    this.authTask = (async () => {
      try {
        const challenge = await this.client.beginProviderAuth(st.providerId!, st.method, controller.signal);
        if (controller.signal.aborted || this.overlay !== 'connect' || this.connectState !== starting) {
          await this.client.cancelProviderAuth(challenge.id); return;
        }
        this.authAbort = null;
        this.connectState = { ...st, step: 'oauth', authChallenge: challenge };
        await this.authenticateConnection(this.connectState);
      } catch (error) {
        if (this.overlay === 'connect' && this.connectState === starting) this.connectState = { ...st, step: 'method', statusMessage: this.connectionError(error, st.providerId) };
      } finally { if (this.authAbort === controller) this.authAbort = null; }
    })();
  }

  private startConnectionAuthentication(st: ConnectProviderState): void {
    if (this.authAbort) { st.statusMessage = 'Previous authentication is still cancelling. Please wait.'; return; }
    this.authTask = this.authenticateConnection(st);
  }

  private async authenticateConnection(st: ConnectProviderState): Promise<void> {
    if (this.authAbort) { st.statusMessage = 'Previous authentication is still cancelling. Please wait.'; return; }
    const controller = new AbortController();
    this.authAbort = controller;
    const secret = st.secretDraft;
    st.secretDraft = '';
    this.connectState = { ...st, step: 'busy', secretDraft: '', statusMessage: 'Validating connectivity. Esc cancels.' };
    const busyState = this.connectState;
    const progressTimer = st.authChallenge?.autoComplete ? setInterval(() => {
      try {
        const progress = this.client.providerAuthProgress(st.authChallenge!.id);
        if (this.connectState === busyState && busyState.authChallenge) {
          if (progress.authorizationURL) busyState.authChallenge.authorizationURL = progress.authorizationURL;
          busyState.authChallenge.userCode = progress.userCode;
          busyState.statusMessage = progress.message ?? 'Waiting for provider sign-in. Esc cancels.';
        }
      } catch { /* Completion may consume the challenge before the final UI update. */ }
    }, 150) : null;
    try {
      const account = await this.client.connectAccount({
        providerId: st.providerId!, alias: st.aliasDraft.trim(),
        credential: st.method === 'none' ? { kind: 'none' } : st.method === 'env' ? { kind: 'env', name: st.draft } : { kind: 'keyring', key: crypto.randomUUID() },
        secret: st.method === 'api-key' ? secret : undefined,
        reauthenticateAccountId: st.accountId,
        manualModelId: st.customModelId,
        authChallengeId: st.authChallenge?.id,
        authorizationCode: st.method === 'openrouter-oauth' ? secret : undefined,
      }, controller.signal);
      if (controller.signal.aborted) return;
      this.syncTranscriptFromActiveSession();
      this.openOverlay('models');
      this.statusBanner = `Connected ${account.alias}. Choose a model to chat.`;
    } catch (error) {
      if (this.overlay === 'connect' && this.connectState === busyState) this.connectState = { ...st, authChallenge: undefined, step: st.method === 'api-key' ? 'secret' : st.method === 'env' ? 'env' : 'method', secretDraft: '', selectedIndex: 0, statusMessage: this.connectionError(error, st.providerId) };
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      this.authAbort = null;
    }
  }

  private async handleSessionsOverlayKey(key: string): Promise<void> {
    const st = this.sessionPickerState;
    const filtered = filterSessions(this.client.listSessions(), st.query);

    if (key === 'Escape') {
      this.overlay = 'none';
      return;
    }
    if (key === 'Ctrl+N') {
      await this.executeSlashCommand('/new');
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (filtered.length === 0) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.sessionPickerState = {
        ...st,
        selectedIndex: (st.selectedIndex + delta + filtered.length) % filtered.length,
      };
      return;
    }
    if (key === 'Ctrl+X' || key === 'Delete') {
      const target = filtered[st.selectedIndex];
      if (target) {
        this.client.deleteSession(target.id);
        this.syncTranscriptFromActiveSession();
        this.statusBanner = `Deleted session ${target.id.slice(0, 8)}.`;
      }
      return;
    }
    if (key === 'Enter') {
      const target = filtered[st.selectedIndex];
      if (target) {
        try {
          this.client.resumeSession(target.id);
          this.syncTranscriptFromActiveSession();
          this.overlay = 'none';
          this.statusBanner = `Resumed session "${target.title || target.id.slice(0, 8)}".`;
        } catch {
          this.statusBanner = 'Could not resume session.';
        }
      }
      return;
    }
    if (key === 'Backspace') {
      this.sessionPickerState = { ...st, query: st.query.slice(0, -1), selectedIndex: 0 };
      return;
    }
    if (key.length === 1) {
      this.sessionPickerState = { ...st, query: st.query + key, selectedIndex: 0 };
    }
  }

  private handlePermissionsOverlayKey(key: string): void {
    const requests = this.client.listPermissions();
    const st = this.permissionState;
    const currentReq = requests[Math.max(0, Math.min(Math.max(0, requests.length - 1), st.selectedIndex))];

    // Closing or pressing Esc NEVER grants permission
    if (key === 'Escape') {
      if (currentReq && currentReq.status === 'pending') {
        this.client.dismissPermissionDialog(currentReq.approvalId);
        this.statusBanner = `Permission request ${currentReq.approvalId.slice(0, 8)} denied on dialog dismiss.`;
      }
      this.overlay = 'none';
      return;
    }

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (requests.length === 0) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.permissionState = {
        ...st,
        selectedIndex: (st.selectedIndex + delta + requests.length) % requests.length,
      };
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const order: ('once' | 'session' | 'deny')[] = ['once', 'session', 'deny'];
      const idx = order.indexOf(st.selectedAction);
      const delta = key === 'ArrowRight' ? 1 : -1;
      this.permissionState = {
        ...st,
        selectedAction: order[(idx + delta + order.length) % order.length]!,
      };
      return;
    }
    if (key === '1') {
      this.permissionState = { ...st, selectedAction: 'once' };
    } else if (key === '2') {
      this.permissionState = { ...st, selectedAction: 'session' };
    } else if (key === '3') {
      this.permissionState = { ...st, selectedAction: 'deny' };
    }

    if ((key === 'Enter' || key === '1' || key === '2' || key === '3') && currentReq && currentReq.status === 'pending') {
      const decision =
        key === '1' ? 'once' : key === '2' ? 'session' : key === '3' ? 'deny' : st.selectedAction;
      this.client.resolvePermission(currentReq.approvalId, currentReq.scopeHash, decision);
      this.statusBanner = `Permission ${currentReq.approvalId.slice(0, 8)}: ${decision.toUpperCase()}.`;
    }
  }

  private handleDiffOverlayKey(key: string): void {
    const report = this.client.getWorkspaceDiff();
    if (key === 'Escape') {
      this.overlay = 'none';
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab') {
      if (report.files.length === 0) return;
      const delta = key === 'ArrowLeft' ? -1 : 1;
      this.diffState = {
        selectedFileIndex: (this.diffState.selectedFileIndex + delta + report.files.length) % report.files.length,
        scrollOffset: 0,
      };
      return;
    }
    if (key === 'ArrowDown') {
      this.diffState = { ...this.diffState, scrollOffset: this.diffState.scrollOffset + 1 };
    } else if (key === 'ArrowUp') {
      this.diffState = { ...this.diffState, scrollOffset: Math.max(0, this.diffState.scrollOffset - 1) };
    }
  }

  private async handlePaletteOverlayKey(key: string): Promise<void> {
    const st = this.paletteState;
    const matches = filterPaletteCommands(st.query);
    if (key === 'Escape') {
      this.overlay = 'none';
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (matches.length === 0) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.paletteState = {
        ...st,
        selectedIndex: (st.selectedIndex + delta + matches.length) % matches.length,
      };
      return;
    }
    if (key === 'Enter') {
      const chosen = matches[st.selectedIndex];
      this.overlay = 'none';
      if (chosen) {
        await this.executeSlashCommand(chosen.command);
      }
      return;
    }
    if (key === 'Backspace') {
      this.paletteState = { ...st, query: st.query.slice(0, -1), selectedIndex: 0 };
      return;
    }
    if (key.length === 1) {
      this.paletteState = { ...st, query: st.query + key, selectedIndex: 0 };
    }
  }

  private async handleSettingsOverlayKey(key: string): Promise<void> {
    if (key === 'Escape') {
      this.overlay = 'none';
      return;
    }
    const rowCount = 13;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.settingsSelectedIndex = (this.settingsSelectedIndex + delta + rowCount) % rowCount;
      return;
    }

    const app = this.themeEngine.getActiveAppearance();
    const idx = this.settingsSelectedIndex;
    const isAdjust = key === 'Enter' || key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight';
    if (!isAdjust) return;

    const dir = key === 'ArrowLeft' ? -1 : 1;
    switch (idx) {
      case 0: // Active Theme -> open /themes
        this.openOverlay('themes');
        break;
      case 1: { // Color Mode
        const modes: ('dark' | 'light' | 'system')[] = ['dark', 'light', 'system'];
        const next = modes[(modes.indexOf(app.mode) + dir + modes.length) % modes.length]!;
        await this.themeEngine.setMode(next);
        break;
      }
      case 2: // Monochrome appearance has no wallpaper.
        this.statusBanner = 'Wallpaper is unavailable in monochrome appearance.';
        break;
      case 3: // Animations enabled
        await this.themeEngine.updateAnimation({ enabled: !app.animations.enabled });
        break;
      case 4: // Motion mode
        await this.themeEngine.updateAnimation({
          motion: app.animations.motion === 'smooth' ? 'grid' : 'smooth',
        });
        break;
      case 5: { // Speed
        const nextSpeed = Math.max(0.1, Math.min(16, Number((app.animations.speed + dir * 0.25).toFixed(2))));
        await this.themeEngine.updateAnimation({ speed: nextSpeed });
        break;
      }
      case 6: { // Cell size
        const nextCell = Math.max(1, Math.min(4, app.animations.cellSize + dir));
        await this.themeEngine.updateAnimation({ cellSize: nextCell });
        break;
      }
      case 7: { // Veil
        const nextVeil = Math.max(0, Math.min(0.95, Number((app.animations.veil + dir * 0.05).toFixed(2))));
        await this.themeEngine.updateAnimation({ veil: nextVeil });
        break;
      }
      case 8: // Reduced motion
        await this.themeEngine.updateAnimation({ reducedMotion: !app.animations.reducedMotion });
        break;
      case 9: // Pause unfocused
        await this.themeEngine.updateAnimation({ pauseUnfocused: !app.animations.pauseUnfocused });
        break;
      case 10: // Reactive effects
        await this.themeEngine.updateAnimation({ reactiveEffects: !app.animations.reactiveEffects });
        break;
      case 11: // Syntax highlighting
        await this.themeEngine.updateAppearance({ syntaxHighlighting: !app.syntaxHighlighting });
        break;
      case 12: // Sidebar
        await this.themeEngine.updateAppearance({ sidebar: !app.sidebar });
        break;
    }
  }

  // ============================================================================
  // FRAME COMPOSITOR & SNAPSHOT ENGINE
  // ============================================================================

  public computeFrameSnapshot(): FrameSnapshot {
    if (this.textSelection.frame) return this.textSelection.view(this.themeEngine.getActiveTokens());
    const cols = this.cols;
    const rows = this.rows;
    const tokens = this.themeEngine.getActiveTokens();
    const manifest = this.themeEngine.getActiveThemeManifest();
    const appearance = this.themeEngine.getActiveAppearance();
    const effectiveMode = this.themeEngine.getEffectiveMode();
    const wallpaperId = this.themeEngine.getActiveWallpaperPresetId();
    const status = this.client.status();
    const reactiveEvent = this.client.currentReactiveEvent();
    const companionView = this.companion.view(
      this.client.listPermissions().some(request => request.status === 'pending'),
      appearance.animations.reactiveEffects,
      appearance.animations.reducedMotion || !appearance.animations.enabled,
    );

    // 1. Initialize base canvas with tokens.background
    const cells: FrameCell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({
        ch: ' ',
        fg: tokens.foreground,
        bg: tokens.background,
        bold: false,
      })),
    );

    const showSidebar = cols >= 100 && appearance.sidebar;
    const sidebarWidth = showSidebar ? 30 : 0;
    const mainWidth = Math.max(20, cols - sidebarWidth);

    // Full-screen tràn màn: tận dụng tối đa mainWidth, padding 1 ký tự mỗi bên nếu đủ rộng để viền không dính sát mép terminal
    const colWidth = mainWidth >= 40 ? mainWidth - 2 : mainWidth;
    const colLeft = mainWidth >= 40 ? 1 : 0;

    // 2. Render Live ASCII Wallpaper into side gutters only (Clear Reserved Content Area)
    if (wallpaperId && appearance.animations.enabled) {
      const wallGrid = this.themeEngine.wallpaperEngine.renderFrame(wallpaperId, {
        cols,
        rows,
        timeSeconds: this.animationTimeSeconds,
        config: appearance.animations,
        backgroundHex: tokens.background,
        centerColumnRange: [colLeft, colLeft + colWidth],
        eventKind: appearance.animations.reactiveEffects ? reactiveEvent.kind : undefined,
      });

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // BẢO VỆ CONTENT AREA:
          // Wallpaper chỉ xuất hiện ở 2 bên lề ngoài cột nội dung (Side Gutters)
          // Tuyệt đối không để bất kỳ ký tự ASCII nào chèn vào Composer hoặc Transcript
          const inContentColumn = x >= colLeft && x < colLeft + colWidth;
          if (inContentColumn) {
            continue;
          }

          const wCell = wallGrid[y]?.[x];
          if (wCell) {
            cells[y]![x] = {
              ch: wCell.ch[0] ?? ' ',
              fg: wCell.fg,
              bg: wCell.bg ?? tokens.background,
              bold: false,
            };
          }
        }
      }
    }

    const drawSpansAt = (row: number, startCol: number, spans: { text: string; fg: string; bg?: string; bold?: boolean }[], maxWidth?: number) => {
      if (row < 0 || row >= rows) return;
      let col = startCol;
      const limit = maxWidth !== undefined ? Math.min(cols, startCol + maxWidth) : cols;
      for (const span of spans) {
        for (let i = 0; i < span.text.length; i++) {
          if (col >= limit) return;
          if (col >= 0) {
            cells[row]![col] = {
              ch: span.text[i]!,
              fg: span.fg,
              bg: span.bg ?? cells[row]![col]!.bg,
              bold: Boolean(span.bold),
            };
          }
          col++;
        }
      }
    };

    const drawBoxBlock = (startRow: number, startCol: number, boxLines: RenderedBoxLine[], maxWidth?: number) => {
      boxLines.forEach((line, idx) => {
        if (line.spans.length > 0) {
          drawSpansAt(startRow + idx, startCol, line.spans, maxWidth);
        }
      });
    };

    // Empty desk uses a narrow centered card. A live thread fills the screen
    // with the same inset on every side, larger when the terminal is large.
    const workspaceFiles = this.composer.fileMenuOpen
      ? this.client.listWorkspaceFiles(this.composer.fileQuery)
      : [];
    const chatting = this.transcript.length > 0;
    const wantPad = mainWidth >= 150 ? 6 : mainWidth >= 110 ? 4 : 2;
    const framePad = !chatting || mainWidth < 32 ? 0 : Math.min(wantPad, Math.max(1, Math.floor((rows - 12) / 2)));
    const contentWidth = chatting
      ? Math.max(18, mainWidth - framePad * 2)
      : Math.min(56, colWidth);
    const contentLeft = chatting
      ? framePad
      : Math.max(0, Math.floor((mainWidth - contentWidth) / 2));
    const composerLines = renderPromptComposerLines({
      width: contentWidth,
      state: this.composer,
      mode: status.mode,
      activeModelLabel: `${status.selection?.modelId ?? 'chưa chọn model'}${status.reasoningEffort ? ` · effort: ${status.reasoningEffort}` : ''}`,
      activeAccountLabel: status.activeAccount?.alias ?? 'chưa kết nối',
      isStreaming: this.isStreaming,
      focused: this.overlay === 'none',
      tokens,
      borderStyle: manifest.borderStyle,
      workspaceFiles,
      maxHeight: Math.max(4, rows - 6),
      telemetryLabel: chatting && contentWidth >= 90 && status.usage.costUSD != null ? `~$${status.usage.costUSD.toFixed(status.usage.costUSD > 0 && status.usage.costUSD < 0.0001 ? 6 : 4)}` : undefined,
      contextLine: status.selection && rows >= 12 ? renderContextIndicator(this.client.context(this.composer.value), contentWidth, tokens) : undefined,
    });

    if (!chatting) {
      // Chưa có câu nào: linh vật gốc thu nhỏ, căn giữa cùng lời chào.
      const welcomeLines = renderWelcomeScreen({
        width: mainWidth,
        height: rows,
        manifest,
        status,
        wallpaperPresetId: wallpaperId,
        tokens,
        borderStyle: manifest.borderStyle,
      });
      const availableHeight = rows - 2 - welcomeLines.length - composerLines.length;
      if (availableHeight >= 6) {
        const mascotLines = renderFyn({
          ...companionView,
          tokens,
          width: 28,
          scale: 5,
        });
        const welcomeWidth = welcomeLines[0]?.spans.reduce((sum, span) => sum + span.text.length, 0) ?? colWidth;
        const centered = mascotLines.map(line => {
          const width = line.spans.reduce((sum, span) => sum + span.text.length, 0);
          const left = Math.max(0, Math.floor((welcomeWidth - width) / 2));
          return { spans: [
            { text: ' '.repeat(left), fg: tokens.foreground, bg: tokens.background },
            ...line.spans,
            { text: ' '.repeat(Math.max(0, welcomeWidth - left - width)), fg: tokens.foreground, bg: tokens.background },
          ] };
        });
        welcomeLines.unshift(...centered);
      }
      const blockHeight = welcomeLines.length + 1 + composerLines.length;
      const startRow = Math.max(0, Math.floor((rows - 1 - blockHeight) / 2));
      const welcomeWidth = welcomeLines[0]?.spans.reduce((acc, sp) => acc + sp.text.length, 0) ?? colWidth;
      drawBoxBlock(
        startRow,
        Math.max(0, Math.floor((mainWidth - welcomeWidth) / 2)),
        welcomeLines,
        welcomeWidth,
      );
      drawBoxBlock(startRow + welcomeLines.length + 1, contentLeft, composerLines, contentWidth);
    } else {
      const composerStartRow = Math.max(framePad + 1, rows - 1 - framePad - composerLines.length);
      const mascotLines = contentWidth >= 28 && composerStartRow >= framePad + 10
        ? renderFyn({ ...companionView, tokens, width: 28, scale: 5 })
        : [];
      const mascotRow = composerStartRow - mascotLines.length;
      const showMascot = mascotLines.length > 0 && mascotRow >= framePad;
      let transcriptStartRow = framePad;
      if (!showMascot && rows >= 12 && mainWidth >= 40) {
        const headerSpans = renderTopHeaderBar({
          width: contentWidth,
          status,
          manifest,
          reactiveEvent,
          reactiveEffectsEnabled: appearance.animations.reactiveEffects,
          isPreviewing: this.themeEngine.isPreviewing(),
          tokens,
          companionState: companionView.state,
        });
        drawSpansAt(framePad, contentLeft, headerSpans, contentWidth);
        transcriptStartRow = framePad + 2;
      }
      const transcriptHeight = Math.max(0, (showMascot ? mascotRow : composerStartRow) - transcriptStartRow);
      if (transcriptHeight > 0) {
        const vp = renderTranscriptViewport({
          items: this.transcript,
          width: contentWidth,
          height: transcriptHeight,
          scrollOffset: this.transcriptScrollOffset,
          tokens,
          borderStyle: manifest.borderStyle,
          syntaxHighlighting: appearance.syntaxHighlighting,
        });
        drawBoxBlock(transcriptStartRow, contentLeft, vp.lines, contentWidth);
      }
      if (showMascot) {
        drawBoxBlock(mascotRow, contentLeft, mascotLines, 28);
        if (this.isStreaming && contentWidth >= 44) {
          const phases = ['·    ', '··   ', '···  ', ' ··· ', '  ···', '   ··'];
          const pulse = phases[Math.floor(companionView.time * 5) % phases.length]!;
          drawSpansAt(mascotRow + 2, contentLeft + 28, [
            { text: pulse, fg: tokens.accent },
            { text: status.phase === 'reasoning' ? ' Thinking from provider' : status.phase === 'waiting' ? ' Waiting for provider' : companionView.state === 'streaming' ? ' Replying' : ' Preparing request', fg: tokens.foregroundMuted },
          ], contentWidth - 28);
          drawSpansAt(mascotRow + 3, contentLeft + 28, [
            { text: 'Esc to interrupt', fg: tokens.foregroundSubtle },
          ], contentWidth - 28);
        }
      }
      drawBoxBlock(composerStartRow, contentLeft, composerLines, contentWidth);
    }
    void reactiveEvent;

    // 6. Draw Collapsible Sidebar if enabled & terminal is wide enough
    if (showSidebar) {
      const sidebarLines = renderSidebarPanel({
        width: sidebarWidth,
        height: rows - 1,
        status,
        sessions: this.client.listSessions(),
        manifest,
        wallpaperPresetId: wallpaperId,
        tokens,
        borderStyle: manifest.borderStyle,
      });
      drawBoxBlock(0, mainWidth, sidebarLines, sidebarWidth);
    }

    // 7. Draw Active Overlay on top of center viewport if open
    if (this.overlay !== 'none') {
      if (['connect', 'themes', 'models', 'effort', 'status', 'usage', 'context'].includes(this.overlay)) {
        // A modal backdrop must cover the wider composer and sidebar too.
        for (const row of cells) for (const cell of row) { cell.ch = ' '; cell.fg = tokens.foreground; cell.bg = tokens.background; cell.bold = false; }
      }
      const reportSummary = (this.overlay === 'effort' || ['status', 'usage', 'context'].includes(this.overlay) && !this.reportDetails);
      const overlayWidth = this.overlay === 'themes' ? Math.min(cols - 2, 52) : this.overlay === 'models' ? Math.min(cols - 2, 76) : this.overlay === 'connect' ? Math.min(cols - 2, 68) : reportSummary ? Math.min(cols - 2, 58) : Math.min(cols - 2, Math.max(44, Math.floor(cols * 0.86)));
      const overlayHeight = Math.min(rows - 2, this.overlay === 'themes' ? 9 : this.overlay === 'models' ? Math.max(9, Math.min(8, this.client.cachedModels(this.pendingSwitchAccountId ?? undefined).length) + 5) : Math.max(12, Math.floor(rows * 0.82)));
      let overlayLines: RenderedBoxLine[] = [];

      switch (this.overlay) {
        case 'themes':
          overlayLines = renderThemePickerOverlay({
            width: overlayWidth,
            height: overlayHeight,
            engine: this.themeEngine,
            state: this.themePickerState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'theme-editor':
          overlayLines = renderThemeEditorOverlay({
            width: overlayWidth,
            height: overlayHeight,
            engine: this.themeEngine,
            state: this.themeEditorState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'models':
          overlayLines = renderModelPickerOverlay({
            width: overlayWidth,
            height: overlayHeight,
            models: this.client.cachedModels(this.pendingSwitchAccountId ?? undefined),
            activeModelId: status.selection?.modelId ?? null,
            activeReasoningEffort: status.reasoningEffort,
            activeAccountAlias: this.pendingSwitchAccountId ? this.client.listAccounts().find(a => a.id === this.pendingSwitchAccountId)?.alias ?? null : status.activeAccount?.alias ?? null,
            state: this.modelPickerState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'connect':
          overlayLines = renderConnectProviderOverlay({
            width: overlayWidth,
            height: overlayHeight,
            integrations: this.client.listIntegrations(),
            accounts: this.client.listAccounts(),
            activeAccountId: status.activeAccount?.id ?? null,
            state: this.connectState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'sessions':
          overlayLines = renderSessionPickerOverlay({
            width: overlayWidth,
            height: overlayHeight,
            sessions: this.client.listSessions(),
            activeSessionId: status.activeSessionId,
            state: this.sessionPickerState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'permissions':
          overlayLines = renderPermissionDialogOverlay({
            width: overlayWidth,
            height: overlayHeight,
            requests: this.client.listPermissions(),
            state: this.permissionState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'diff':
          overlayLines = renderDiffViewerOverlay({
            width: overlayWidth,
            height: overlayHeight,
            report: this.client.getWorkspaceDiff(),
            state: this.diffState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'palette':
          overlayLines = renderCommandPaletteOverlay({
            width: overlayWidth,
            height: overlayHeight,
            state: this.paletteState,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'settings':
          overlayLines = renderSettingsOverlay({
            width: overlayWidth,
            height: overlayHeight,
            appearance,
            effectiveMode,
            selectedIndex: this.settingsSelectedIndex,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
        case 'effort': {
          const values = ['auto', ...(status.activeModel?.reasoningEfforts ?? [])];
          overlayLines = renderReportOverlay({ title: 'Reasoning effort', rows: [
            `Effort: [ ${values[this.effortIndex]} ]`,
            values.map((value, index) => index === this.effortIndex ? `[ ${value} ]` : value).join(' ─ '), '',
            this.effortIndex === 0 ? 'Auto uses the provider default.' : 'Higher effort can increase latency and usage.', '',
          ], width: overlayWidth, height: overlayHeight, offset: 0, footer: '←/→ Adjust · Enter Save · Esc Cancel', tokens }).lines;
          break;
        }
        case 'usage':
        case 'context':
        case 'status':
          { const report = renderReportOverlay({ title: ({ usage: 'Session usage', context: 'Context window', status: 'Session status' })[this.overlay], rows: reportRows(this.client, this.overlay, this.composer.value, this.reportDetails), width: overlayWidth,
            height: overlayHeight, offset: this.reportOffset, details: this.reportDetails, tokens });
            overlayLines = report.lines; this.reportOffset = report.offset; }
          break;
        case 'help':
          overlayLines = renderHelpOverlay({
            scrollOffset: this.helpOffset,
            width: overlayWidth,
            height: overlayHeight,
            tokens,
            borderStyle: manifest.borderStyle,
          });
          break;
      }

      const startCol = Math.max(0, Math.floor((cols - overlayWidth) / 2));
      const startRow = Math.max(1, Math.floor((rows - overlayLines.length) / 2));
      drawBoxBlock(Math.max(0, Math.min(startRow, rows - 1 - overlayLines.length)), startCol, overlayLines.slice(0, rows - 1), overlayWidth);
    }

    // 8. Dòng trạng thái mờ, không nền (thông báo tạm thời hoặc đường dẫn + model).
    const shortWs = status.workspace.split('/').slice(-2).join('/');
    const thinking = this.isStreaming ? '● ' : '';
    const focusedDialog = ['connect', 'status', 'usage', 'context'].includes(this.overlay);
    const leftText = focusedDialog ? '' : this.statusBanner
      ? ` ${this.statusBanner}`
      : this.overlay === 'connect' ? '' : ` ${thinking}${shortWs}${this.themeEngine.isPreviewing() ? '  · xem thử theme' : ''}`;
    const rightText = this.statusBanner || focusedDialog ? '' : 'Ctrl+P';
    const pad = Math.max(0, cols - leftText.length - rightText.length);
    drawSpansAt(
      rows - 1,
      0,
      [
        { text: leftText.slice(0, cols), fg: this.statusBanner ? tokens.info : tokens.foregroundSubtle },
        { text: ' '.repeat(pad), fg: tokens.foregroundSubtle },
        { text: rightText, fg: tokens.foregroundSubtle },
      ],
      cols,
    );
    void effectiveMode;

    const plainLines = cells.map(row => row.map(c => c.ch).join(''));
    return {
      cols,
      rows,
      cells,
      plainLines,
      plainText: plainLines.join('\n'),
      activeOverlay: this.overlay,
      activeThemeId: appearance.theme,
      effectiveMode,
      activeWallpaperId: wallpaperId,
      isPreviewing: this.themeEngine.isPreviewing(),
      isStreaming: this.isStreaming,
    };
  }

  public renderAnsiFrame(forceFull = false): string {
    const snap = this.computeFrameSnapshot();
    const cap: TerminalColorCapability = this.themeEngine.colorCapability;
    const prev = forceFull ? null : this.previousCells;
    let out = '';

    for (let y = 0; y < snap.rows; y++) {
      const row = snap.cells[y]!;
      const prevRow = prev?.[y];
      let rowChanged = !prevRow || prevRow.length !== row.length;
      if (!rowChanged && prevRow) {
        for (let x = 0; x < row.length; x++) {
          const a = row[x]!;
          const b = prevRow[x]!;
          if (a.ch !== b.ch || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.selected !== b.selected) {
            rowChanged = true;
            break;
          }
        }
      }
      if (!rowChanged) continue;

      out += `\x1b[${y + 1};1H`;
      let curFg = '';
      let curBg = '';
      let curBold = false;
      let curSelected = false;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x]!;
        if (cap === 'none' && Boolean(cell.selected) !== curSelected) {
          out += cell.selected ? '\x1b[7m' : '\x1b[27m'; curSelected = Boolean(cell.selected);
        }
        if (cell.bold !== curBold) {
          out += cell.bold ? '\x1b[1m' : '\x1b[22m';
          curBold = cell.bold;
        }
        if (cell.fg !== curFg) {
          out += fgHex(cell.fg, cap);
          curFg = cell.fg;
        }
        if (cell.bg !== curBg) {
          out += bgHex(cell.bg, cap);
          curBg = cell.bg;
        }
        out += cell.ch;
      }
      out += '\x1b[0m';
    }

    this.previousCells = snap.cells;
    return out;
  }
}

export async function runInteractiveTui(options: FutrynTuiOptions & { initialCommand?: string }): Promise<void> {
  const app = new FutrynTuiApp(options);
  await app.initialize();
  if (options.initialCommand) {
    await app.executeSlashCommand(options.initialCommand);
  }

  const stdout = process.stdout;
  const stdin = process.stdin;
  const isTty = Boolean(stdout.isTTY && stdin.isTTY);

  if (!isTty) {
    // Non-TTY deterministic single-frame output and clean exit
    const snap = app.computeFrameSnapshot();
    stdout.write(snap.plainText + '\n');
    return;
  }

  let cleanedUp = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSystemCheck = Date.now();
  let stopUpdates: (() => void) | null = null;
  const inputDecoder = new TerminalInputDecoder();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopUpdates?.(); stopUpdates = null;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
    } catch {
      // Ignore cleanup error
    }
    stdout.write('\x1b[0m\x1b[?7h\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?1004l\x1b[?25h\x1b[?1049l');
  };

  stdout.write('\x1b[?1049h\x1b[?7l\x1b[?25l\x1b[?1004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h\x1b[2J\x1b[3J\x1b[H');
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  stdin.resume();

  app.resize(stdout.columns || 110, stdout.rows || 32);

  const renderNow = (force = false) => {
    if (cleanedUp) return;
    const clipboard = app.takeClipboardSequence(); if (clipboard) stdout.write(clipboard);
    const ansi = app.renderAnsiFrame(force);
    if (ansi) stdout.write(ansi);
  };

  renderNow(true);

  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        stdout.off('resize', onResize);
        stdin.off('data', onData);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        cleanup();
        if (error) reject(error); else resolve();
      };
      stopUpdates = options.client.onReactiveEvent(() => {
        if (cleanedUp || refreshTimer) return;
        // Render after the TUI consumes the deltas, coalescing provider bursts.
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          try { renderNow(false); }
          catch { finish(new HannesError('INVALID_INPUT')); }
        }, 16);
      });
      const onSignal = () => finish(new HannesError('CANCELLED'));
      const onResize = () => {
        app.resize(stdout.columns || 110, stdout.rows || 32);
        renderNow(true);
      };
      const onData = async (chunk: Buffer) => {
        try {
          if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
          const keys = inputDecoder.feed(chunk);
          if (inputDecoder.waiting) inputTimer = setTimeout(() => {
            inputTimer = null;
            void (async () => {
              for (const key of inputDecoder.flush()) await app.handleKey(key);
              if (app.isExitRequested()) finish(); else renderNow(false);
            })().catch(error => finish(error instanceof HannesError ? error : new HannesError('INVALID_INPUT')));
          }, 30);
          for (const key of keys) {
            await app.handleKey(key);
            if (app.isExitRequested()) { finish(); return; }
          }
          renderNow(false);
        } catch (error) { finish(error instanceof HannesError ? error : new HannesError('INVALID_INPUT')); }
      };
      stdout.on('resize', onResize);
      stdin.on('data', onData);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      timer = setInterval(() => {
        try {
          if (app.themeEngine.getCommittedAppearance().mode === 'system' && Date.now() - lastSystemCheck >= 5000) {
            lastSystemCheck = Date.now(); app.themeEngine.refreshSystemPreference();
          }
          app.stepAnimation(0.08); renderNow(false);
        }
        catch { finish(new HannesError('INVALID_INPUT')); }
      }, 80);
    });
  } finally {
    cleanup();
    // Drain cancellation/credential rollback before composition closes the database.
    await app.shutdown();
  }
}

export * from './theme/theme';
export * from './theme/presets';
export * from './theme/compat';
export * from './theme/wallpaper';
export * from './components/editor';
export * from './components/messages';
export * from './components/tool-output';
export * from './components/diff-view';
export * from './components/permission-dialog';
export * from './screens/chat';
export * from './screens/sessions';
export * from './screens/settings';

export { reportRows } from './screens/telemetry';
