import {PERMISSION_MODE_HINTS} from '@futryn/contracts';
import {FutrynError, type ToolCall} from '@futryn/contracts';
import {acceptSlashSelection} from '@futryn/sdk';
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

  constructor(private readonly host: TuiHost) {}

  private set banner(message: string | null) {
    this.host.setBanner(message);
  }

  syncFromSession(): void {
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

  clear(): void {
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
    const task = this.runTurn(content);
    this.turnTask = task;
    try {
      await task;
    } finally {
      if (this.turnTask === task) this.turnTask = null;
    }
    // Input that missed the finishing turn is queued by the SDK (Codex start_or_steer) and becomes
    // the next turn, in submission order, exactly once.
    const next = this.host.client.takeQueuedMessage();
    if (next !== undefined && !this.isStreaming) await this.submit(next);
  }

  /** Enter while a turn runs: steer it or queue it for the next turn (ADR 0033). Shell input is never steering. */
  private steer(content: string): void {
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith('!')) return;
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
    this.composer = recordComposerHistory(this.composer, input);
    const call: ToolCall = {id: `shell-${Date.now()}`, name: 'exec_command', input: {cmd: command}};
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
        onOutput: chunk => {
          item.toolOutput ??= {};
          item.toolOutput[call.id] = (
            (item.toolOutput[call.id] ?? '') +
            (chunk.stream === 'stderr' ? '[stderr] ' : '') +
            chunk.text
          ).slice(-16000);
        },
      });
      item.toolResults = [{...result, callId: call.id}];
      this.banner =
        result.status === 'ok'
          ? `Shell command finished${result.exitCode === undefined || result.exitCode === null ? '' : ` (exit ${result.exitCode})`}.`
          : `Shell command ${result.status}${result.code ? ` [${result.code}]` : ''}.`;
    } catch (error) {
      item.errorText = `Error [${error instanceof FutrynError ? error.code : 'ERROR'}]: the shell command did not complete.`;
    } finally {
      item.streaming = false;
      this.isStreaming = false;
      if (this.activeAbortController === abortController) this.activeAbortController = null;
    }
  }

  private async runTurn(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || (this.isStreaming && !trimmed.startsWith('/'))) return;

    if (trimmed.startsWith('!')) {
      await this.runShell(trimmed);
      return;
    }
    this.composer = recordComposerHistory(this.composer, trimmed);
    if (trimmed.startsWith('/')) {
      await this.host.runSlashCommand(trimmed);
      return;
    }

    const status = this.host.client.status();
    const userItem: TranscriptItem = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      modelId: status.selection?.modelId,
      accountAlias: status.activeAccount?.alias,
    };
    let assistantItem: TranscriptItem = {
      id: `assistant-${Date.now()}`,
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
          this.banner =
            event.reason === 'retry'
              ? `Reconnecting... ${event.attempt ?? 1}/${event.maxRetries ?? '?'}` // Codex notify_stream_error
              : 'Response preempted by your new instruction.';
        } else if (event.type === 'inputDeferred') {
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
      this.isStreaming = false;
      this.turnStartedAt = null;
      this.activeAbortController = null;
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
    if (key === 'Alt+Enter' || key === 'Ctrl+J') {
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
        this.composer = recordComposerHistory(this.composer, toRun);
        await this.host.runSlashCommand(toRun);
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
          this.composer.value.slice(0, this.composer.cursor - 1) + this.composer.value.slice(this.composer.cursor);
        this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor - 1);
      }
      return;
    }
    if (key === 'Delete') {
      if (this.composer.cursor < this.composer.value.length) {
        const nextVal =
          this.composer.value.slice(0, this.composer.cursor) + this.composer.value.slice(this.composer.cursor + 1);
        this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor);
      }
      return;
    }
    if (key === 'Enter') {
      await this.submit(this.composer.value);
      return;
    }

    if (key.length === 1) {
      const nextVal =
        this.composer.value.slice(0, this.composer.cursor) + key + this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, nextVal, this.composer.cursor + 1);
    }
  }

  async shutdown(): Promise<void> {
    this.activeAbortController?.abort();
    await Promise.allSettled([this.turnTask]);
  }
}
