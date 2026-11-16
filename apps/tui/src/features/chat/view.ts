import type {ThemeManifest, ThemeTokens, AppearanceConfig} from '@futryn/contracts';
import type {FutrynClient, ReactiveAgentEvent} from '@futryn/sdk';
import type {Canvas} from '../../ui';
import type {TranscriptViewport} from '../../types';
import {renderContextIndicator} from '../context-meter';
import {renderTopHeaderBar} from '../header';
import {FYN_LABELS, type FynCompanion} from '../companion';
import {renderWeepinbell} from '../companion/weepinbell';
import {renderPromptComposerLines, type ComposerState} from '../composer';
import {
  explorationRows,
  formatElapsed,
  reasoningTitle,
  renderTranscriptViewport,
  type TranscriptItem,
} from '../transcript';
import {renderWelcomeScreen} from '../welcome';
import type {ScreenMetrics} from '../../render/metrics';

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
  /** Start of the running turn (ms since epoch), for the status timer. */
  turnStartedAt?: number | null;
  isPreviewing: boolean;
  /** The composer has focus (no overlay is open). */
  focused: boolean;
  workspaceAccess: boolean;
}

/** Welcome card or live conversation, with the composer docked at the bottom. */
export function drawChatScreen(canvas: Canvas, v: ChatScreenInput): TranscriptViewport | undefined {
  let viewport: TranscriptViewport | undefined;
  const {rows, tokens, manifest, appearance, status, reactiveEvent, companionView, wallpaperId} = v;
  const {mainWidth, colWidth} = v.metrics;

  const workspaceFiles =
    v.composer.fileMenuOpen && v.workspaceAccess ? v.client.listWorkspaceFiles(v.composer.fileQuery) : [];
  const chatting = v.transcript.length > 0;
  const framePad = chatting && mainWidth >= 32 ? 1 : 0;
  const contentWidth = chatting ? Math.max(18, mainWidth - framePad * 2) : Math.min(56, colWidth);
  const contentLeft = chatting ? framePad : Math.max(0, Math.floor((mainWidth - contentWidth) / 2));
  const composerLines = renderPromptComposerLines({
    width: contentWidth,
    state: v.composer,
    mode: status.mode,
    permissionMode: status.permissionMode,
    // The backend is named whenever Futryn does not own both the loop and the tools (ADR 0029).
    activeModelLabel: `${status.selection?.modelId ?? 'chưa chọn model'}${status.reasoningEffort ? ` · effort: ${status.reasoningEffort}` : ''}${status.executionBackend?.runtime ? ` · ${status.executionBackend.kind === 'delegated' ? 'DELEGATED' : status.executionBackend.kind === 'codex-bridge' ? 'Codex loop + Futryn tools' : 'chat only'}` : ''}`,
    activeAccountLabel: status.activeAccount?.alias ?? 'chưa kết nối',
    isStreaming: v.isStreaming,
    focused: v.focused,
    tokens,
    borderStyle: manifest.borderStyle,
    workspaceFiles,
    maxHeight: Math.max(4, rows - 2),
    placeholder: !status.activeAccount
      ? 'Use /login to connect…'
      : !status.selection
        ? 'Use /model to choose…'
        : undefined,
    contextLine:
      status.selection && rows >= 12
        ? renderContextIndicator(v.client.context(v.composer.value), contentWidth, tokens)
        : undefined,
  });

  if (!chatting) {
    // Weepinbell belongs only to welcome; compact motion fits shorter terminals.
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
    if (availableHeight >= 8) {
      const mascotLines = renderWeepinbell(tokens, {compact: availableHeight < 12, ...companionView});
      mascotLines.push({
        spans: [
          {text: `Weepinbell · ${FYN_LABELS[companionView.state]}`, fg: tokens.foregroundMuted, bg: tokens.background},
        ],
      });
      const welcomeWidth = welcomeLines[0]?.spans.reduce((sum, span) => sum + span.text.length, 0) ?? colWidth;
      const centered = mascotLines.map(line => {
        const width = line.spans.reduce((sum, span) => sum + span.text.length, 0);
        const left = Math.max(0, Math.floor((welcomeWidth - width) / 2));
        return {
          spans: [
            {text: ' '.repeat(left), fg: tokens.foreground, bg: tokens.background},
            ...line.spans,
            {text: ' '.repeat(Math.max(0, welcomeWidth - left - width)), fg: tokens.foreground, bg: tokens.background},
          ],
        };
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
    let transcriptStartRow = framePad;
    if (rows >= 12 && mainWidth >= 40) {
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
      transcriptStartRow = framePad + 1;
    }
    // Live model/tool status remains above the composer, without companion artwork.
    const statusRow = v.isStreaming ? composerStartRow - 1 : -1;
    const transcriptHeight = Math.max(0, (statusRow >= 0 ? statusRow : composerStartRow) - transcriptStartRow);
    const transcriptWidth = contentWidth;
    if (transcriptHeight > 0) {
      const vp = renderTranscriptViewport({
        items: v.transcript,
        compactActivities: true,
        width: transcriptWidth,
        height: transcriptHeight,
        scrollOffset: v.scrollOffset,
        tokens,
        borderStyle: manifest.borderStyle,
        syntaxHighlighting: appearance.syntaxHighlighting,
        awaitingApproval: call => {
          const cmd = (call.input as {cmd?: unknown} | null)?.cmd;
          const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
          return (
            typeof cmd === 'string' &&
            v.client
              .listPendingPermissions()
              .some(p => p.capability === 'process.execute' && plain(p.target) === plain(cmd))
          );
        },
      });
      canvas.block(transcriptStartRow, contentLeft, vp.lines, transcriptWidth);
      viewport = {
        top: transcriptStartRow,
        left: contentLeft,
        width: transcriptWidth,
        height: transcriptHeight,
        offset: vp.clampedOffset,
        lines: vp.allLines,
        disclosures: vp.allLines.flatMap((line, row) => (line.disclosure ? [{row, ...line.disclosure}] : [])),
      };
    }
    if (statusRow > transcriptStartRow)
      canvas.spans(statusRow, contentLeft, turnStatusSpans(v, companionView.time), contentWidth);
    canvas.block(composerStartRow, contentLeft, composerLines, contentWidth);
  }
  return viewport;
}

/**
 * Live status of the running turn, after Codex's status indicator:
 * `◦ Exploring (12s • Esc to interrupt)`. The label is the latest reasoning title when the
 * provider sends one, otherwise what the turn is doing now.
 */
export function turnStatusSpans(
  v: Pick<ChatScreenInput, 'client' | 'status' | 'tokens' | 'transcript' | 'turnStartedAt'>,
  time: number,
): {text: string; fg: string; bold?: boolean}[] {
  const {tokens} = v;
  const turn = v.transcript.at(-1);
  const waitingTool = turn?.toolCalls?.some(call => !turn.toolResults?.some(result => result.callId === call.id));
  const pendingApproval = v.client.listPendingPermissions().length > 0;
  const last = turn?.parts?.at(-1);
  const label = pendingApproval
    ? 'Waiting for your approval'
    : waitingTool
      ? (() => {
          const running = turn!.toolCalls!.filter(call => !turn!.toolResults?.some(r => r.callId === call.id));
          if (running.some(call => call.name === 'exec_command')) return 'Command pending';
          if (running.some(call => call.name === 'apply_patch')) return 'Patch pending';
          return explorationRows(running, []).at(0)?.verb === 'Read' ? 'Reading' : 'Exploring';
        })()
      : turn?.awaitingModel
        ? 'Waiting for model'
        : last?.kind === 'reasoning'
          ? (reasoningTitle(last.text) ?? 'Thinking')
          : last?.kind === 'text'
            ? 'Replying'
            : v.status.phase === 'waiting'
              ? 'Waiting for provider'
              : 'Working';
  const elapsed = v.turnStartedAt ? formatElapsed(Date.now() - v.turnStartedAt) : '0s';
  return [
    {text: Math.floor(time * 2) % 2 ? '◦ ' : '• ', fg: tokens.accent},
    {text: label, fg: tokens.foreground, bold: true},
    {text: ` (${elapsed} • `, fg: tokens.foregroundSubtle},
    {text: 'Esc', fg: tokens.foregroundMuted},
    {text: ' to interrupt)', fg: tokens.foregroundSubtle},
  ];
}
