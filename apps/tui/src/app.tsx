import {commandForShortcut, type FutrynClient} from '@futryn/sdk';
import type {FeatureRegistry, OverlayFeature, ThemeFrame, TuiHost} from './core/feature';
import {ChatController, drawChatScreen} from './features/chat';
import {CommandRouter} from './features/commands';
import type {ComposerState} from './features/composer';
import {ConnectFeature, describeProviderError} from './features/connect';
import {DiffFeature} from './features/diff';
import {EffortFeature} from './features/effort';
import {HelpFeature} from './features/help';
import {ModelsFeature} from './features/models';
import {PaletteFeature} from './features/palette';
import {PermissionsFeature} from './features/permissions';
import {QuestionFeature} from './features/question';
import {ReportsFeature} from './features/reports';
import {renderSidebarPanel} from './features/sidebar';
import {TextSelection} from './features/selection';
import {SessionsFeature} from './features/sessions';
import {SettingsFeature} from './features/settings';
import {StartupGate} from './features/startup-gate';
import {ThemeEditorFeature} from './features/theme-editor';
import {ThemesFeature} from './features/themes';
import type {TranscriptItem} from './features/transcript';
import {renderAnsiDiff} from './render/ansi-diff';
import {screenMetrics} from './render/metrics';
import {paintWallpaper} from './render/wallpaper';
import {ThemeEngine} from './theme/theme';
import {Canvas, type RenderedBoxLine} from './ui';
import type {ActiveOverlay, FrameCell, FrameSnapshot, FutrynTuiOptions} from './types';

export class FutrynTuiApp {
  public readonly client: FutrynClient;
  public readonly themeEngine: ThemeEngine;
  private cols: number;
  private rows: number;
  private overlay: ActiveOverlay = 'none';
  private readonly features = new Map<ActiveOverlay, OverlayFeature>();
  private readonly featureList: OverlayFeature[] = [];
  private connect!: ConnectFeature;
  private gate!: StartupGate;
  private commands!: CommandRouter;
  private chat!: ChatController;

  private statusBanner: string | null = null;
  private readonly textSelection = new TextSelection();
  private clipboardSequence = '';
  public selectedText(): string {
    return this.textSelection.text();
  }
  public takeClipboardSequence(): string {
    const value = this.clipboardSequence;
    this.clipboardSequence = '';
    return value;
  }
  private previousCells: FrameCell[][] | null = null;
  private animationTimeSeconds = 0;
  private exitRequested = false;
  private updateListener: (() => void) | null = null;
  private focused = true;
  private contextReadout: ReturnType<FutrynClient['context']> | null = null;
  private contextDirty = true;
  private contextUpdatedAt = 0;
  private subscriptions: (() => void)[] = [];
  public onUpdate(listener: () => void): () => void {
    this.updateListener = listener;
    return () => {
      this.updateListener = null;
    };
  }
  public invalidateContext(): void {
    this.contextDirty = true;
  }
  public animationDelay(): number | null {
    if (!this.focused) return null;
    if (this.textSelection.frame) return this.textSelection.needsAnimation ? 80 : null;
    if (this.gate.phase === 'checking' || this.chat.isStreaming) return 1000;
    const config = this.themeEngine.getActiveAppearance().animations;
    if (
      this.overlay === 'none' &&
      !this.chat.transcript.length &&
      config.enabled &&
      !config.reducedMotion &&
      !this.themeEngine.wallpaperEngine.isPaused(config)
    )
      return 80;
    return null;
  }
  /** Reading the workspace is allowed by default for embedders; interactive and non-TTY runs withhold it until approved. */
  private workspaceAccess = true;

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
    this.registerFeatures();
  }

  /** What feature modules may ask of the app; they never see the class itself. */
  private createHost(): TuiHost {
    const app = this;
    return {
      client: this.client,
      requestRender: () => this.updateListener?.(),
      themeEngine: this.themeEngine,
      get cols() {
        return app.cols;
      },
      get rows() {
        return app.rows;
      },
      get isStreaming() {
        return app.chat.isStreaming;
      },
      get overlay() {
        return app.overlay;
      },
      get composerDraft() {
        return app.chat.composer.value;
      },
      get workspaceAccess() {
        return app.workspaceAccess;
      },
      grantWorkspaceAccess: () => {
        this.workspaceAccess = true;
        this.client.setToolsEnabled(true);
      },
      openOverlay: target => this.openOverlay(target),
      closeOverlay: () => {
        this.overlay = 'none';
        this.updateListener?.();
      },
      setBanner: message => {
        this.statusBanner = message;
        this.updateListener?.();
      },
      requestExit: () => {
        this.exitRequested = true;
      },
      syncTranscript: () => {
        this.chat.syncFromSession();
        this.invalidateContext();
      },
      addTranscriptNotice: text => {
        this.chat.addNotice(text);
        this.updateListener?.();
      },
      clearTranscript: () => this.chat.clear(),
      clearSelection: () => this.textSelection.clear(),
      copyText: text => {
        const bytes = Buffer.from(text).subarray(0, 65536);
        this.clipboardSequence = `\x1b]52;c;${bytes.toString('base64')}\x07`;
        this.statusBanner = 'Copied displayed diff; clipboard support depends on the terminal host.';
      },
      runSlashCommand: raw => this.executeSlashCommand(raw),
      submitPrompt: content => this.chat.submit(content),
      describeError: (error, providerId) => this.connectionError(error, providerId),
      features: {} as FeatureRegistry,
    };
  }

  private registerFeatures(): void {
    const host = this.createHost();
    this.connect = new ConnectFeature(host);
    const models = new ModelsFeature(host);
    this.gate = new StartupGate(host);
    this.commands = new CommandRouter(host);
    this.chat = new ChatController(host);
    host.features.accounts = this.connect;
    host.features.models = models;
    const all: OverlayFeature[] = [
      this.connect,
      models,
      new PaletteFeature(host),
      new SessionsFeature(host),
      new PermissionsFeature(host),
      new QuestionFeature(host),
      new DiffFeature(host),
      new HelpFeature(host),
      new ReportsFeature(host),
      new EffortFeature(host),
      new SettingsFeature(host),
      new ThemesFeature(host),
      new ThemeEditorFeature(host),
    ];
    for (const feature of all) {
      this.featureList.push(feature);
      for (const overlay of feature.overlays) this.features.set(overlay, feature);
    }
  }

  public async initialize(): Promise<void> {
    await this.themeEngine.initialize();
    // An interactive UI can answer request_user_input (ADR 0042).
    this.client.setUserInputAvailable(true);
    this.chat.syncFromSession();
    this.invalidateContext();
    this.subscriptions.push(
      this.client.onReactiveEvent(event => {
        this.invalidateContext();
        if (event.kind === 'permission' || event.detail?.startsWith('Permission ')) {
          const item = this.chat.transcript.at(-1);
          if (item) this.chat.layout.invalidate(item.id);
        }
        this.updateListener?.();
      }),
      this.themeEngine.subscribe(() => this.updateListener?.()),
    );
    const warnings = this.themeEngine.getWarnings();
    if (warnings.length > 0) {
      this.statusBanner = warnings[0]!;
    }
  }

  /** Startup consent is scoped to this interactive session and never grants tool permissions. */
  public startStartupGate(initialCommand?: string): void {
    this.workspaceAccess = false;
    this.client.setToolsEnabled(false);
    this.gate.start(initialCommand);
  }

  /** Non-interactive runs have no way to ask, so they must not read the workspace. */
  public denyWorkspaceAccess(): void {
    this.workspaceAccess = false;
    this.client.setToolsEnabled(false);
  }

  public advanceStartupGate(): void {
    this.gate.advance();
    // A tool of the running turn waiting for approval brings up the permission dialog once nothing else is open.
    if (
      !this.gate.active &&
      this.chat.isStreaming &&
      this.overlay === 'none' &&
      this.client.listPendingPermissions().length
    )
      this.openOverlay('permissions');
    // A question of the running turn (ADR 0042) opens its dialog the same way.
    if (!this.gate.active && this.overlay === 'none' && this.client.listPendingQuestions().length)
      this.openOverlay('question');
  }

  public isExitRequested(): boolean {
    return this.exitRequested;
  }

  public getActiveOverlay(): ActiveOverlay {
    return this.overlay;
  }

  public getComposerState(): ComposerState {
    return this.chat.composer;
  }

  public getTranscript(): readonly TranscriptItem[] {
    return this.chat.transcript;
  }

  public getStatusBanner(): string | null {
    return this.statusBanner;
  }

  public resize(cols: number, rows: number): void {
    this.invalidateContext();
    this.textSelection.clear();
    this.cols = Math.max(20, cols);
    this.rows = Math.max(8, rows);
    this.previousCells = null;
  }

  public stepAnimation(deltaSeconds = 0.08): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const config = this.themeEngine.getActiveAppearance().animations;
    const animate = !config.reducedMotion && !this.themeEngine.wallpaperEngine.isPaused(config);
    this.chat.companion.tick(deltaSeconds, animate, config.speed);
    if (animate) this.animationTimeSeconds += deltaSeconds;
    this.textSelection.step(deltaSeconds);
    this.advanceStartupGate();
  }

  public openOverlay(target: ActiveOverlay): void {
    this.textSelection.clear();
    if (!this.workspaceAccess && this.features.get(target)?.needsWorkspace) {
      this.statusBanner = 'Workspace access has not been approved for this session.';
      return;
    }
    const leaving = this.features.get(this.overlay);
    if (leaving && !leaving.overlays.includes(target)) leaving.close?.(target);
    this.overlay = target;
    this.features.get(target)?.open(target);
    this.updateListener?.();
  }

  private connectionError(error: unknown, providerId?: string): string {
    return describeProviderError(this.client, error, providerId ?? this.client.status().activeProvider?.id);
  }

  public executeSlashCommand(rawInput: string): Promise<void> {
    return this.commands.execute(rawInput);
  }

  public async shutdown(): Promise<void> {
    this.client.setUserInputAvailable(false);
    this.textSelection.clear();
    this.clipboardSequence = '';
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    await Promise.allSettled([
      this.gate.shutdown(),
      this.chat.shutdown(),
      ...this.featureList.map(feature => feature.shutdown?.()),
    ]);
  }

  public async submitPrompt(content: string): Promise<void> {
    if (this.gate.active) return; // nothing is sent before consent and verification
    this.invalidateContext();
    await this.chat.submit(content);
    this.invalidateContext();
  }

  public async handleKey(key: string, waitForTurn = true): Promise<void> {
    if (this.gate.active && (await this.gate.handleKey(key))) return;
    if (['WheelUp', 'WheelDown', 'PageUp', 'PageDown'].includes(key) && this.textSelection.frame) {
      const amount = key.startsWith('Wheel') ? 2 : Math.max(1, this.rows - 8);
      if (this.textSelection.scroll(key === 'WheelUp' || key === 'PageUp' ? -amount : amount)) return;
    }
    const mouse = /^(MouseDown|MouseDrag|MouseUp):(\d+):(\d+)$/.exec(key);
    if (mouse) {
      const point = {row: Number(mouse[2]), col: Number(mouse[3])};
      if (mouse[1] === 'MouseDown') {
        this.textSelection.clear();
        this.textSelection.begin(this.computeFrameSnapshot(), point);
      } else if (mouse[1] === 'MouseDrag') this.textSelection.move(point);
      else {
        const clickFrame = this.textSelection.frame;
        const wasSelection = this.textSelection.active();
        this.textSelection.release(point);
        if (!wasSelection && !this.textSelection.frame && this.overlay === 'none' && !this.gate.active) {
          const viewport = clickFrame?.transcriptViewport;
          const hit =
            viewport &&
            point.row >= viewport.top &&
            point.row < viewport.top + viewport.height &&
            point.col >= viewport.left &&
            point.col < viewport.left + viewport.width
              ? viewport.disclosures.find(hit => hit.row === viewport.offset + point.row - viewport.top)
              : undefined;
          const item = hit && this.chat.transcript.find(item => item.id === hit.itemId);
          if (item && hit && viewport) {
            this.chat.scrollOffset = viewport.offset;
            const expanded = new Set(item.expandedActivities);
            const collapsed = new Set(item.collapsedActivities);
            const wasExpanded =
              !collapsed.has(hit.key) &&
              (expanded.has(hit.key) || (hit.key.startsWith('reasoning:') && item.reasoningExpanded === true));
            if (wasExpanded) {
              expanded.delete(hit.key);
              collapsed.add(hit.key);
            } else {
              expanded.add(hit.key);
              collapsed.delete(hit.key);
            }
            this.chat.layout.invalidate(item.id, false);
            item.expandedActivities = [...expanded];
            item.collapsedActivities = [...collapsed];
          }
        }
        const sequence = this.textSelection.copySequence();
        if (sequence) this.clipboardSequence = sequence;
      }
      return;
    }
    if (this.textSelection.active() && (key === 'Ctrl+C' || key === 'Ctrl+Y')) {
      const sequence = this.textSelection.copySequence();
      if (sequence) this.clipboardSequence = sequence;
      return;
    }
    if (key !== 'FocusIn' && key !== 'FocusOut' && this.textSelection.frame) {
      this.textSelection.clear();
      if (key === 'Escape') return;
    }

    if (key !== 'FocusIn' && key !== 'FocusOut') this.chat.companion.activity();
    if (key !== 'FocusIn' && key !== 'FocusOut') this.statusBanner = null;
    if (key === 'FocusIn') {
      this.focused = true;
      this.themeEngine.wallpaperEngine.setFocused(true);
      return;
    }
    if (key === 'FocusOut') {
      this.focused = false;
      this.themeEngine.wallpaperEngine.setFocused(false);
      return;
    }

    if (this.connect.switching && key !== 'Escape' && key !== 'Ctrl+C') return;

    // Global shortcuts
    if (key === 'Ctrl+C') {
      if (this.features.get(this.overlay)?.interrupt?.()) return;
      if (this.chat.interrupt()) return;
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
    const shortcut = commandForShortcut(key);
    if (
      shortcut &&
      key !== 'Ctrl+C' &&
      !(key === 'Ctrl+S' && this.overlay === 'theme-editor') &&
      (!(key === 'Ctrl+N' || key === 'Ctrl+D') || this.overlay === 'none')
    ) {
      if (shortcut.overlay && this.overlay === shortcut.overlay) this.openOverlay('none');
      else await this.executeSlashCommand(shortcut.command);
      return;
    }
    if (key === 'Ctrl+B' && this.overlay === 'none') {
      const current = this.themeEngine.getActiveAppearance().sidebar;
      await this.themeEngine.updateAppearance({sidebar: !current});
      this.statusBanner = `Sidebar ${!current ? 'shown' : 'collapsed'}.`;
      return;
    }

    // Route to active overlay if open
    if (this.overlay !== 'none') {
      await this.features
        .get(this.overlay)
        ?.handleKey(this.overlay, key === 'WheelUp' ? 'PageUp' : key === 'WheelDown' ? 'PageDown' : key);
      return;
    }

    await this.chat.handleKey(key, waitForTurn);
  }

  // ============================================================================
  // FRAME COMPOSITOR & SNAPSHOT ENGINE
  // ============================================================================

  private composerContext(): ReturnType<FutrynClient['context']> {
    if (
      !this.contextReadout ||
      (this.contextDirty && (!this.chat.isStreaming || Date.now() - this.contextUpdatedAt >= 1000))
    ) {
      this.contextReadout = this.client.context();
      this.contextDirty = false;
      this.contextUpdatedAt = Date.now();
    }
    const base = this.contextReadout;
    const draft = this.chat.composer.value.trim();
    const extra = draft && !/^[\/!]/.test(draft) ? Math.ceil(Buffer.byteLength(draft) / 4) + 16 : 0;
    const estimateTokens = base.estimateTokens + extra;
    return {
      ...base,
      estimateTokens,
      measuredCurrentHistory: !this.contextDirty && !extra && base.measuredCurrentHistory,
      estimatedPercent: base.limitTokens ? Math.round((estimateTokens / base.limitTokens) * 1000) / 10 : null,
    };
  }

  public computeFrameSnapshot(): FrameSnapshot {
    if (this.textSelection.frame) return this.textSelection.view(this.themeEngine.getActiveTokens());
    const {cols, rows} = this;
    const tokens = this.themeEngine.getActiveTokens();
    const manifest = this.themeEngine.getActiveThemeManifest();
    const appearance = this.themeEngine.getActiveAppearance();
    const effectiveMode = this.themeEngine.getEffectiveMode();
    const wallpaperId = this.themeEngine.getActiveWallpaperPresetId();
    const status = this.client.status();
    const reactiveEvent = this.client.currentReactiveEvent();
    const companionView = this.chat.companion.view(
      this.client.listPermissions().some(request => request.status === 'pending'),
      appearance.animations.reactiveEffects,
      appearance.animations.reducedMotion || !appearance.animations.enabled,
    );

    const canvas = new Canvas(cols, rows, tokens.foreground, tokens.background);
    const diffPanelWidth =
      this.overlay === 'diff' && cols >= 140 ? this.features.get('diff')!.layout('diff', cols, rows).width : 0;
    const metrics = screenMetrics(cols - diffPanelWidth, rows, diffPanelWidth ? false : appearance.sidebar);
    if (wallpaperId && appearance.animations.enabled && !this.chat.transcript.length) {
      paintWallpaper(canvas, {
        engine: this.themeEngine,
        wallpaperId,
        appearance,
        tokens,
        metrics,
        timeSeconds: this.animationTimeSeconds,
        eventKind: appearance.animations.reactiveEffects ? reactiveEvent.kind : undefined,
      });
    }

    const transcriptViewport = drawChatScreen(canvas, {
      client: this.client,
      rows,
      metrics,
      tokens,
      manifest,
      appearance,
      status,
      reactiveEvent,
      companionView,
      wallpaperId,
      composer: this.chat.composer,
      transcript: this.chat.transcript,
      transcriptLayout: this.chat.layout,
      contextReadout: this.composerContext(),
      scrollOffset: this.chat.scrollOffset,
      isStreaming: this.chat.isStreaming,
      turnStartedAt: this.chat.turnStartedAt,
      isPreviewing: this.themeEngine.isPreviewing(),
      focused: this.overlay === 'none',
      workspaceAccess: this.workspaceAccess,
    });

    if (transcriptViewport) {
      this.chat.viewportOffset = transcriptViewport.offset;
      this.chat.viewportHeight = transcriptViewport.height;
      this.chat.viewportMaxOffset = Math.max(
        0,
        (transcriptViewport.totalLines ?? transcriptViewport.lines.length) - transcriptViewport.height,
      );
      if (this.chat.scrollOffset >= 0) this.chat.scrollOffset = transcriptViewport.offset;
    }

    // 6. Draw Collapsible Sidebar if enabled & terminal is wide enough
    if (metrics.showSidebar) {
      const sidebarLines = renderSidebarPanel({
        width: metrics.sidebarWidth,
        height: rows - 1,
        status,
        sessions: this.client.listSessions(),
        manifest,
        wallpaperPresetId: wallpaperId,
        tokens,
        borderStyle: manifest.borderStyle,
      });
      canvas.block(0, metrics.mainWidth, sidebarLines, metrics.sidebarWidth);
    }

    // 7. Draw Active Overlay on top of center viewport if open
    if (this.overlay !== 'none') {
      const feature = this.features.get(this.overlay);
      const layout = feature?.layout(this.overlay, cols, rows);
      if (layout?.backdrop) {
        // A modal backdrop must cover the wider composer and sidebar too.
        canvas.clear(tokens.foreground, tokens.background);
      }
      const overlayWidth = layout?.width ?? 0;
      const overlayHeight = layout?.height ?? 0;
      const theme: ThemeFrame = {tokens, borderStyle: manifest.borderStyle, effectiveMode};
      const overlayLines: RenderedBoxLine[] = feature
        ? feature.render(this.overlay, {width: overlayWidth, height: overlayHeight}, theme)
        : [];

      const startCol = diffPanelWidth ? cols - overlayWidth : Math.max(0, Math.floor((cols - overlayWidth) / 2));
      const startRow = diffPanelWidth ? 0 : Math.max(1, Math.floor((rows - overlayLines.length) / 2));
      canvas.block(
        Math.max(0, Math.min(startRow, rows - 1 - overlayLines.length)),
        startCol,
        overlayLines.slice(0, rows - 1),
        overlayWidth,
      );
    }

    const gateLayout = this.gate.render(cols, rows, {tokens, borderStyle: manifest.borderStyle, effectiveMode});
    if (gateLayout) {
      canvas.clear(tokens.foreground, tokens.background);
      canvas.block(gateLayout.y, gateLayout.x, gateLayout.lines, gateLayout.width);
    }

    // 8. Dòng trạng thái mờ, không nền (thông báo tạm thời hoặc đường dẫn + model).
    const shortWs = status.workspace.split('/').slice(-2).join('/');
    const thinking = this.chat.isStreaming ? '● ' : '';
    const focusedDialog =
      this.gate.active || (this.features.get(this.overlay)?.layout(this.overlay, cols, rows).backdrop ?? false);
    const leftText = focusedDialog
      ? ''
      : this.statusBanner
        ? ` ${this.statusBanner}`
        : this.overlay === 'connect'
          ? ''
          : ` ${thinking}${shortWs}${this.themeEngine.isPreviewing() ? '  · xem thử theme' : ''}`;
    const rightText =
      this.statusBanner || focusedDialog
        ? ''
        : transcriptViewport?.hasNewOutput
          ? '↓ New output · End'
          : cols >= 55
            ? 'Ctrl+P commands'
            : 'Ctrl+P';
    const pad = Math.max(0, cols - leftText.length - rightText.length);
    canvas.spans(
      rows - 1,
      0,
      [
        {text: leftText.slice(0, cols), fg: this.statusBanner ? tokens.info : tokens.foregroundSubtle},
        {text: ' '.repeat(pad), fg: tokens.foregroundSubtle},
        {text: rightText, fg: tokens.foregroundSubtle},
      ],
      cols,
    );
    void effectiveMode;

    const plainLines = canvas.cells.map(row => row.map(c => c.ch).join(''));
    return {
      ...(transcriptViewport && this.overlay === 'none' && !this.gate.active ? {transcriptViewport} : {}),
      cols,
      rows,
      cells: canvas.cells,
      plainLines,
      plainText: plainLines.join('\n'),
      activeOverlay: this.overlay,
      activeThemeId: appearance.theme,
      effectiveMode,
      activeWallpaperId: wallpaperId,
      isPreviewing: this.themeEngine.isPreviewing(),
      isStreaming: this.chat.isStreaming,
    };
  }

  public renderAnsiFrame(forceFull = false): string {
    const snap = this.computeFrameSnapshot();
    const out = renderAnsiDiff(
      snap.cells,
      snap.rows,
      this.themeEngine.colorCapability,
      forceFull ? null : this.previousCells,
    );
    this.previousCells = snap.cells;
    return out;
  }
}
