import type { ThemeManifest, ThemeTokens, AppearanceConfig } from '@hannes/contracts';
import type { FutrynClient, ReactiveAgentEvent } from '@hannes/sdk';
import type { Canvas } from '../../ui';
import { renderContextIndicator } from '../context-meter';
import { renderTopHeaderBar } from '../header';
import { renderFyn, type FynCompanion } from '../companion';
import { renderPromptComposerLines, type ComposerState } from '../composer';
import { renderTranscriptViewport, type TranscriptItem } from '../transcript';
import { renderWelcomeScreen } from '../welcome';
import type { ScreenMetrics } from '../../render/metrics';

/** Everything the chat screen needs to paint one frame; no hidden state. */
export interface ChatScreenInput {
  client: FutrynClient;
  rows: number;
  metrics: ScreenMetrics;
  tokens: ThemeTokens;
  manifest: ThemeManifest;
  appearance: AppearanceConfig;
  status: ReturnType<FutrynClient['status']>;
  reactiveEvent: ReactiveAgentEvent;
  companionView: ReturnType<FynCompanion['view']>;
  wallpaperId: string | null;
  composer: ComposerState;
  transcript: TranscriptItem[];
  scrollOffset: number;
  isStreaming: boolean;
  isPreviewing: boolean;
  /** The composer has focus (no overlay is open). */
  focused: boolean;
  workspaceAccess: boolean;
}

/** Welcome card or live conversation, with the composer docked at the bottom. */
export function drawChatScreen(canvas: Canvas, v: ChatScreenInput): void {
  const { rows, tokens, manifest, appearance, status, reactiveEvent, companionView, wallpaperId } = v;
  const { mainWidth, colWidth } = v.metrics;

  const workspaceFiles = v.composer.fileMenuOpen && v.workspaceAccess
    ? v.client.listWorkspaceFiles(v.composer.fileQuery)
    : [];
  const chatting = v.transcript.length > 0;
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
    state: v.composer,
    mode: status.mode,
    activeModelLabel: `${status.selection?.modelId ?? 'chưa chọn model'}${status.reasoningEffort ? ` · effort: ${status.reasoningEffort}` : ''}`,
    activeAccountLabel: status.activeAccount?.alias ?? 'chưa kết nối',
    isStreaming: v.isStreaming,
    focused: v.focused,
    tokens,
    borderStyle: manifest.borderStyle,
    workspaceFiles,
    maxHeight: Math.max(4, rows - 2),
    placeholder: !status.activeAccount ? 'Use /login to connect…' : !status.selection ? 'Use /model to choose…' : undefined,
    contextLine: status.selection && rows >= 12 ? renderContextIndicator(v.client.context(v.composer.value), contentWidth, tokens) : undefined,
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
    if (blockHeight <= rows - 1) {
      canvas.block(startRow, Math.max(0, Math.floor((mainWidth - welcomeWidth) / 2)), welcomeLines, welcomeWidth);
      canvas.block(startRow + welcomeLines.length + 1, contentLeft, composerLines, contentWidth);
    } else {
      // Prioritize the focused editor and autocomplete on short terminals.
      canvas.block(Math.max(0, rows - 1 - composerLines.length), contentLeft, composerLines, contentWidth);
    }
  } else {
    const composerStartRow = Math.max(framePad + 1, rows - 1 - framePad - composerLines.length);
    const mascotLines = rows >= 34 && contentWidth >= 28 && composerStartRow >= framePad + 10
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
        isPreviewing: v.isPreviewing,
        tokens,
        companionState: companionView.state,
      });
      canvas.spans(framePad, contentLeft, headerSpans, contentWidth);
      transcriptStartRow = framePad + 2;
    }
    const transcriptHeight = Math.max(0, (showMascot ? mascotRow : composerStartRow) - transcriptStartRow);
    if (transcriptHeight > 0) {
      const vp = renderTranscriptViewport({
        items: v.transcript,
        width: contentWidth,
        height: transcriptHeight,
        scrollOffset: v.scrollOffset,
        tokens,
        borderStyle: manifest.borderStyle,
        syntaxHighlighting: appearance.syntaxHighlighting,
      });
      canvas.block(transcriptStartRow, contentLeft, vp.lines, contentWidth);
    }
    if (showMascot) {
      canvas.block(mascotRow, contentLeft, mascotLines, 28);
      if (v.isStreaming && contentWidth >= 44) {
        const phases = ['·    ', '··   ', '···  ', ' ··· ', '  ···', '   ··'];
        const pulse = phases[Math.floor(companionView.time * 5) % phases.length]!;
        canvas.spans(mascotRow + 2, contentLeft + 28, [
          { text: pulse, fg: tokens.accent },
          { text: status.phase === 'reasoning' ? ' Thinking from provider' : status.phase === 'waiting' ? ' Waiting for provider' : companionView.state === 'streaming' ? ' Replying' : ' Preparing request', fg: tokens.foregroundMuted },
        ], contentWidth - 28);
        canvas.spans(mascotRow + 3, contentLeft + 28, [
          { text: 'Esc to interrupt', fg: tokens.foregroundSubtle },
        ], contentWidth - 28);
      }
    }
    canvas.block(composerStartRow, contentLeft, composerLines, contentWidth);
  }
}
