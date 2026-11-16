import {PERMISSION_MODE_HINTS} from '@futryn/contracts';
import {FutrynError, type ToolCall} from '@futryn/contracts';
import {acceptSlashSelection, parseSlashCommand} from '@futryn/sdk';
import {nextGrapheme, previousGrapheme, verticalCursor} from '../../input/text';
import type {TuiHost} from '../../core/feature';
import {FynCompanion} from '../companion';
import {
  applyFileReferenceSelection,
  createInitialComposerState,
  getMatchingSlashCommands,
  navigateComposerHistory,
  recordComposerHistory,
  updateComposerValue,
  type ComposerState,
} from '../composer';
import {
  appendStreamPart,
  appendToolPart,
  applyActivity,
  discardResponse,
  markResponse,
  messagesToTranscript,
  type ResponseMark,
  type TranscriptItem,
} from '../transcript';

/**
 * The main screen: prompt composer, transcript and the streaming turn. Owns their state so
 * the rest of the app only asks it to submit, scroll, cancel or draw.
 */
export class ChatController {
  composer: ComposerState = createInitialComposerState();
  transcript: TranscriptItem[] = [];
  /** -1 follows the newest message. */
  scrollOffset = -1;
  viewportOffset = 0;
  viewportHeight = 1;
  viewportMaxOffset = 0;
  showReasoning = false;
  isStreaming = false;
  /** Start of the running turn, for the status line timer; null when idle. */
  turnStartedAt: number | null = null;
  readonly companion = new FynCompanion();
  private activeAbortController: AbortController | null = null;
  private turnTask: Promise<void> | null = null;
  private sessionGeneration = 0;

  constructor(private readonly host: TuiHost) {}

  private set banner(message: string | null) {
    this.host.setBanner(message);
  }

  syncFromSession(): void {
    this.invalidateTurn();
    const active = this.host.client.activeSession();
    if (!active) {
      this.transcript = [];
      return;
    }
    const status = this.host.client.status();
    this.transcript = messagesToTranscript(active.messages, {
      idPrefix: active.id,
      modelId: active.selection.modelId,
      accountAlias: status.activeAccount?.alias,
    });
  }

  private invalidateTurn(): void {
    this.sessionGeneration++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.isStreaming = false;
    this.turnStartedAt = null;
  }

  clear(): void {
    this.invalidateTurn();
    this.transcript = [];
  }

  async submit(content: string): Promise<void> {
    if (content.trim().startsWith('/')) {
      await this.runTurn(content);
      return;
    }
    if (this.isStreaming) {
      this.steer(content);
      return;
    }
    const generation = this.sessionGeneration;
    const task = this.runTurn(content);
    this.turnTask = task;
    try {
      await task;
    } finally {
      if (this.turnTask === task) this.turnTask = null;
    }
    // Input that missed the finishing turn is queued by the SDK (Codex start_or_steer) and becomes
    // the next turn, in submission order, exactly once.
    if (generation !== this.sessionGeneration) return;
    const next = this.host.client.takeQueuedMessage();
    if (next !== undefined && !this.isStreaming) await this.submit(next);
  }

  /** Enter while a turn runs: steer it or queue it for the next turn (ADR 0033). Shell input is never steering. */
  private steer(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('!')) {
      this.banner = 'Shell input cannot steer a running turn; your draft was kept. Wait or press Esc to cancel.';
      return;
    }
    let outcome: ReturnType<typeof this.host.client.submitWhileBusy>;
    // Acceptance requires a durable journal write; if that fails nothing was accepted and the draft stays.
    try {
      outcome = this.host.client.submitWhileBusy(trimmed);
    } catch (error) {
      this.banner = `Steering not accepted [${error instanceof FutrynError ? error.code : 'ERROR'}]; your draft was kept.`;
      return;
    }
    if (outcome.disposition === 'steered') {
      this.composer = recordComposerHistory(this.composer, trimmed);
      this.banner = 'Steering queued: it reaches the model before its next request.';
    } else if (outcome.disposition === 'queued') {
      this.composer = recordComposerHistory(this.composer, trimmed);
      this.banner = `The turn is finishing; queued as the next turn (${outcome.position} waiting).`;
    } else if (outcome.reason === 'queue_unavailable') {
      this.banner = 'The turn is finishing, but this backend cannot durably queue input; your draft was kept.';
    } else if (outcome.reason === 'not_steerable') {
      this.banner = 'This turn cannot be steered (review mode or a runtime-owned loop). Wait for it or press Ctrl+C.';
    }
  }

  /**
   * `!command` (ADR 0034, Codex user shell command): runs through the same exec_command dispatcher,
   * approval and sandbox as model calls and is shown as a Bash card. It is not sent to the model.
   */
  private async runShell(input: string): Promise<void> {
    const command = input.slice(1).trim();
    if (!command) {
      this.banner = 'Shell mode: type a command after !, for example !git status.';
      return;
    }
    if (!this.host.client.toolsEnabled()) {
      this.banner = 'Shell mode needs workspace tools: approve this folder first. Nothing was run.';
      return;
    }
    const generation = this.sessionGeneration;
    this.composer = recordComposerHistory(this.composer, input);
    const call: ToolCall = {id: `shell-${crypto.randomUUID()}`, name: 'exec_command', input: {cmd: command}};
    const item: TranscriptItem = {
      id: `assistant-${call.id}`,
      role: 'assistant',
      content: '',
      streaming: true,
      toolCalls: [call],
    };
    appendToolPart(item, call.id);
    this.transcript = [...this.transcript, {id: `user-${call.id}`, role: 'user', content: input}, item];
    this.scrollOffset = -1;
    this.isStreaming = true;
    this.banner = '';
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    try {
      const result = await this.host.client.runShellCommand(command, {
        signal: abortController.signal,
        callId: call.id,
        onOutput: chunk => {
          if (generation !== this.sessionGeneration) return;
          item.toolOutput ??= {};
          item.toolOutput[call.id] = (
            (item.toolOutput[call.id] ?? '') +
            (chunk.stream === 'stderr' ? '[stderr] ' : '') +
            chunk.text
          ).slice(-16000);
        },
      });
      if (generation !== this.sessionGeneration) return;
      item.toolResults = [{...result, callId: call.id}];
      this.banner = result.sessionId
        ? `Shell command still running (session ${result.sessionId}); collect its final result with write_stdin.`
        : result.status === 'ok'
          ? `Shell command finished${result.exitCode === undefined || result.exitCode === null ? '' : ` (exit ${result.exitCode})`}.`
          : `Shell command ${result.status}${result.code ? ` [${result.code}]` : ''}.`;
    } catch (error) {
      if (generation !== this.sessionGeneration) return;
      if (!this.composer.value && !abortController.signal.aborted)
        this.composer = updateComposerValue(this.composer, input);
      item.errorText = `Error [${error instanceof FutrynError ? error.code : 'ERROR'}]: the shell command did not complete.`;
    } finally {
      item.streaming = false;
      if (generation === this.sessionGeneration) {
        this.isStreaming = false;
        if (this.activeAbortController === abortController) this.activeAbortController = null;
      }
    }
  }

  private async runTurn(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || (this.isStreaming && !trimmed.startsWith('/'))) return;

    if (trimmed.startsWith('!')) {
      await this.runShell(trimmed);
      return;
    }
    if (trimmed.startsWith('/')) {
      const parsed = parseSlashCommand(trimmed);
      if (!parsed.error && !parsed.definition?.unavailable && (!this.isStreaming || parsed.definition?.duringRequest))
        this.composer = recordComposerHistory(this.composer, trimmed);
      await this.host.runSlashCommand(trimmed);
      return;
    }
    this.composer = recordComposerHistory(this.composer, trimmed);

    const generation = this.sessionGeneration;
    const status = this.host.client.status();
    const userItem: TranscriptItem = {
      id: `user-${crypto.randomUUID()}`,
      role: 'user',
      content: trimmed,
      modelId: status.selection?.modelId,
      accountAlias: status.activeAccount?.alias,
    };
    let assistantItem: TranscriptItem = {
      id: `assistant-${crypto.randomUUID()}`,
      role: 'assistant',
      content: '',
      modelId: status.selection?.modelId,
      accountAlias: status.activeAccount?.alias,
      streaming: true,
      awaitingModel: true,
      toolCalls: [],
    };
    this.transcript = [...this.transcript, userItem, assistantItem];
    this.scrollOffset = -1;
    this.isStreaming = true;
    this.banner = '';
    this.companion.transition('thinking');
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let completed = false;
    let responseMark: ResponseMark = markResponse(assistantItem);
    const startTime = Date.now();
    this.turnStartedAt = startTime;

    try {
      for await (const event of this.host.client.sendMessage(trimmed, {
        signal: abortController.signal,
      })) {
        if (generation !== this.sessionGeneration) return;
        if (event.type === 'started') {
          responseMark = markResponse(assistantItem);
          assistantItem.awaitingModel = true;
          this.companion.transition('thinking');
        } else if (event.type === 'textDelta') {
          assistantItem.awaitingModel = false;
          this.companion.transition('streaming');
          assistantItem.content += event.text;
          appendStreamPart(assistantItem, 'text', event.text);
        } else if (event.type === 'reasoningDelta') {
          assistantItem.awaitingModel = false;
          assistantItem.reasoning = (assistantItem.reasoning ?? '') + event.text;
          appendStreamPart(assistantItem, 'reasoning', event.text);
          assistantItem.reasoningExpanded = this.showReasoning;
          this.companion.transition('thinking');
        } else if (event.type === 'usage') {
          assistantItem.usage = event.usage;
        } else if (event.type === 'toolCallComplete') {
          assistantItem.awaitingModel = false;
          const calls: ToolCall[] = assistantItem.toolCalls ?? [];
          calls.push(event.call);
          assistantItem.toolCalls = calls;
          appendToolPart(assistantItem, event.call.id);
        } else if (event.type === 'activity') {
          assistantItem.awaitingModel = false;
          applyActivity(assistantItem, event.activity);
        } else if (event.type === 'toolOutputDelta') {
          assistantItem.toolOutput ??= {};
          assistantItem.toolOutput[event.callId] = (
            (assistantItem.toolOutput[event.callId] ?? '') +
            (event.stream === 'stderr' ? '[stderr] ' : '') +
            event.text
          ).slice(-16000);
        } else if (event.type === 'toolResult') {
          assistantItem.toolResults = [...(assistantItem.toolResults ?? []), event.result];
          assistantItem.awaitingModel =
            Boolean(assistantItem.toolCalls?.length) &&
            assistantItem.toolCalls!.every(call =>
              assistantItem.toolResults!.some(result => result.callId === call.id),
            );
          if (assistantItem.awaitingModel) this.companion.transition('thinking');
        } else if (event.type === 'responseDiscarded') {
          discardResponse(assistantItem, responseMark);
          assistantItem.notices = [...(assistantItem.notices ?? []), `Response discarded (${event.reason}).`].slice(
            -16,
          );
          this.banner =
            event.reason === 'retry'
              ? `Reconnecting... ${event.attempt ?? 1}/${event.maxRetries ?? '?'}` // Codex notify_stream_error
              : 'Response preempted by your new instruction.';
        } else if (event.type === 'inputDeferred') {
          assistantItem.notices = [
            ...(assistantItem.notices ?? []),
            `${event.steerIds.length} accepted instruction(s) deferred (${event.reason.replaceAll('_', ' ')}).`,
          ].slice(-16);
          this.banner = `${event.steerIds.length} accepted instruction(s) were not processed (${event.reason.replace('_', ' ')}); they open your next turn.`;
        } else if (event.type === 'steered') {
          // The steering message became model-visible here; later output answers it.
          assistantItem.streaming = false;
          assistantItem.awaitingModel = false;
          const steeredItem: TranscriptItem = {
            id: `user-steer-${event.steerId}`,
            role: 'user',
            content: event.content,
            modelId: status.selection?.modelId,
            accountAlias: status.activeAccount?.alias,
          };
          assistantItem = {
            id: `assistant-${event.steerId}`,
            role: 'assistant',
            content: '',
            modelId: status.selection?.modelId,
            accountAlias: status.activeAccount?.alias,
            streaming: true,
            awaitingModel: true,
            toolCalls: [],
          };
          this.transcript = [...this.transcript, steeredItem, assistantItem];
          this.scrollOffset = -1;
          responseMark = markResponse(assistantItem);
        } else if (event.type === 'completed') {
          completed = true;
          assistantItem.usage = event.usage;
          assistantItem.streaming = false;
          assistantItem.durationMs = Date.now() - startTime;
        }
      }
      if (abortController.signal.aborted) throw new FutrynError('CANCELLED');
      if (!completed) throw new FutrynError('PROTOCOL');
      assistantItem.streaming = false;
      assistantItem.reasoningExpanded = this.showReasoning;
      const totalTok = (assistantItem.usage?.inputTokens ?? 0) + (assistantItem.usage?.outputTokens ?? 0);
      this.banner =
        assistantItem.usage?.inputTokens == null || assistantItem.usage?.outputTokens == null
          ? 'Completed turn · token usage not reported.'
          : `Completed turn (${totalTok} tokens).`;
      const notes = this.host.client.projectContext()?.diagnostics.length ?? 0;
      if (notes) this.banner += ` Project context: ${notes} note(s); /context.`;
      const pending = this.host.client.queuedInput().length;
      if (pending) this.banner += ` ${pending} accepted instruction(s) not processed yet; they open your next turn.`;
      this.companion.transition('done');
    } catch (err) {
      if (generation !== this.sessionGeneration) return;
      // A failed send is retryable from the composer; preserve any newer draft typed while waiting.
      if (!this.composer.value && !abortController.signal.aborted)
        this.composer = updateComposerValue(this.composer, content);
      this.companion.transition(
        abortController.signal.aborted || (err instanceof FutrynError && err.code === 'CANCELLED')
          ? 'cancelled'
          : 'error',
      );
      assistantItem.streaming = false;
      if (err instanceof FutrynError) {
        assistantItem.errorText = `Error [${err.code}]: ${
          err.code === 'AUTH'
            ? 'No active provider account or model selected. Run /login or /model.'
            : err.code === 'CANCELLED'
              ? 'Generation cancelled by user.'
              : err.code === 'UNSUPPORTED'
                ? 'This model does not accept workspace tools. Tools are now off for it; send your message again.'
                : err.code
        }`;
        this.banner = assistantItem.errorText;
      } else {
        assistantItem.errorText = 'Request failed. Run /doctor for safe connection diagnostics.';
        this.banner = assistantItem.errorText;
      }
    } finally {
      assistantItem.awaitingModel = false;
      if (generation === this.sessionGeneration) {
        this.isStreaming = false;
        this.turnStartedAt = null;
        this.activeAbortController = null;
      }
    }
  }

  /** Ctrl+C: clear a draft or cancel the response. Returns false when the app should exit. */
  interrupt(): boolean {
    if (!this.isStreaming && this.composer.value) {
      this.composer = updateComposerValue(this.composer, '', 0);
      this.banner = 'Input cleared. Press Ctrl+C again to exit.';
      return true;
    }
    if (this.isStreaming && this.activeAbortController) {
      this.activeAbortController.abort();
      this.banner = 'Cancelled streaming response.';
      return true;
    }
    return false;
  }

  /** Esc on the main screen. */
  async handleKey(key: string): Promise<void> {
    // Main screen key handling
    if (key === 'Ctrl+R') {
      this.showReasoning = !this.showReasoning;
      for (const item of this.transcript) {
        item.reasoningExpanded = this.showReasoning;
        item.expandedActivities = item.expandedActivities?.filter(key => !key.startsWith('reasoning:'));
        item.collapsedActivities = item.collapsedActivities?.filter(key => !key.startsWith('reasoning:'));
      }
      return;
    }
    if (key.startsWith('Paste:')) {
      const pasted = key.slice(6);
      const next =
        this.composer.value.slice(0, this.composer.cursor) + pasted + this.composer.value.slice(this.composer.cursor);
      this.composer = {
        ...updateComposerValue(this.composer, next, this.composer.cursor + pasted.length),
        slashMenuOpen: false,
        fileMenuOpen: false,
      };
      if (pasted.length >= 1_048_576) this.banner = 'Paste limited to 1 MiB of text.';
      return;
    }
    if (key === 'Home' || key === 'Ctrl+A' || key === 'End' || key === 'Ctrl+E') {
      const start =
        this.composer.cursor === 0 ? 0 : this.composer.value.lastIndexOf('\n', this.composer.cursor - 1) + 1;
      const at = this.composer.value.indexOf('\n', this.composer.cursor);
      this.composer = {
        ...this.composer,
        cursor: key === 'Home' || key === 'Ctrl+A' ? start : at < 0 ? this.composer.value.length : at,
      };
      return;
    }
    if (key === 'Alt+Enter' || key === 'Ctrl+J' || key === 'Shift+Enter') {
      const next =
        this.composer.value.slice(0, this.composer.cursor) + '\n' + this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, next, this.composer.cursor + 1);
      return;
    }
    if (key === 'Shift+Tab') {
      const next = this.host.client.cyclePermissionMode();
      this.banner = `Permission mode: ${next}. ${PERMISSION_MODE_HINTS[next]}`;
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
        this.banner = 'Cancelled streaming response.';
        return;
      }
      if (this.composer.value.length > 0) {
        this.composer = updateComposerValue(this.composer, '', 0);
      }
      return;
    }

    if (['PageUp', 'PageDown', 'WheelUp', 'WheelDown'].includes(key)) {
      const amount = key.startsWith('Wheel') ? 2 : Math.max(1, this.viewportHeight - 2);
      const next = this.viewportOffset + (key === 'PageUp' || key === 'WheelUp' ? -amount : amount);
      this.scrollOffset = next >= this.viewportMaxOffset ? -1 : Math.max(0, next);
      this.viewportOffset = this.scrollOffset < 0 ? this.viewportMaxOffset : this.scrollOffset;
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
            (this.composer.slashSelectedIndex - 1 + Math.max(1, matches.length)) % Math.max(1, matches.length),
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
        const toRun = acceptSlashSelection(this.composer.value, chosen);
        await this.submit(toRun);
        return;
      }
    }

    if (this.composer.fileMenuOpen) {
      const files = this.host.workspaceAccess
        ? this.host.client.listWorkspaceFiles(this.composer.fileQuery).slice(0, 5)
        : [];
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
      const cursor = verticalCursor(this.composer.value, this.composer.cursor, -1);
      this.composer = cursor === null ? navigateComposerHistory(this.composer, 'up') : {...this.composer, cursor};
      return;
    }
    if (key === 'ArrowDown') {
      const cursor = verticalCursor(this.composer.value, this.composer.cursor, 1);
      this.composer = cursor === null ? navigateComposerHistory(this.composer, 'down') : {...this.composer, cursor};
      return;
    }
    if (key === 'ArrowLeft') {
      this.composer = {
        ...this.composer,
        cursor: previousGrapheme(this.composer.value, this.composer.cursor),
      };
      return;
    }
    if (key === 'ArrowRight') {
      this.composer = {
        ...this.composer,
        cursor: nextGrapheme(this.composer.value, this.composer.cursor),
      };
      return;
    }
    if (key === 'Backspace') {
      if (this.composer.cursor > 0) {
        const nextVal =
          this.composer.value.slice(0, previousGrapheme(this.composer.value, this.composer.cursor)) +
          this.composer.value.slice(this.composer.cursor);
        this.composer = updateComposerValue(
          this.composer,
          nextVal,
          previousGrapheme(this.composer.value, this.composer.cursor),
        );
      }
      return;
    }
    if (key === 'Delete') {
      if (this.composer.cursor < this.composer.value.length) {
        const nextVal =
          this.composer.value.slice(0, this.composer.cursor) +
          this.composer.value.slice(nextGrapheme(this.composer.value, this.composer.cursor));
        this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor);
      }
      return;
    }
    if (key === 'Enter') {
      await this.submit(this.composer.value);
      return;
    }

    if ([...key].length === 1 && !/[\x00-\x1f\x7f-\x9f]/.test(key)) {
      const nextVal =
        this.composer.value.slice(0, this.composer.cursor) + key + this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor + key.length);
    }
  }

  async shutdown(): Promise<void> {
    this.activeAbortController?.abort();
    await Promise.allSettled([this.turnTask]);
  }
}
