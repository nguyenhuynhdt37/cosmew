import { HannesError, type ToolCall } from '@hannes/contracts';
import { acceptSlashSelection } from '@hannes/sdk';
import type { TuiHost } from '../../core/feature';
import { FynCompanion } from '../companion';
import {
  applyFileReferenceSelection, createInitialComposerState, getMatchingSlashCommands, navigateComposerHistory,
  recordComposerHistory, updateComposerValue, type ComposerState,
} from '../composer';
import { messagesToTranscript, type TranscriptItem } from '../transcript';

/**
 * The main screen: prompt composer, transcript and the streaming turn. Owns their state so
 * the rest of the app only asks it to submit, scroll, cancel or draw.
 */
export class ChatController {
  composer: ComposerState = createInitialComposerState();
  transcript: TranscriptItem[] = [];
  /** -1 follows the newest message. */
  scrollOffset = -1;
  showReasoning = true;
  isStreaming = false;
  readonly companion = new FynCompanion();
  private activeAbortController: AbortController | null = null;
  private turnTask: Promise<void> | null = null;

  constructor(private readonly host: TuiHost) {}

  private set banner(message: string | null) { this.host.setBanner(message); }

  syncFromSession(): void {
    const active = this.host.client.activeSession();
    if (!active) {
      this.transcript = [];
      return;
    }
    const status = this.host.client.status();
    this.transcript = messagesToTranscript(active.messages, { idPrefix: active.id, modelId: active.selection.modelId, accountAlias: status.activeAccount?.alias });
  }

  clear(): void { this.transcript = []; }

  async submit(content: string): Promise<void> {
    if (content.trim().startsWith('/')) { await this.runTurn(content); return; }
    const task = this.runTurn(content);
    this.turnTask = task;
    try { await task; } finally { if (this.turnTask === task) this.turnTask = null; }
  }

  private async runTurn(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || (this.isStreaming && !trimmed.startsWith('/'))) return;

    if (trimmed.startsWith('!')) {
      this.banner = 'Shell mode: Not implemented in PA1/TUI1. No command was executed or sent to the provider.';
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
    this.scrollOffset = -1;
    this.isStreaming = true;
    this.banner = '';
    this.companion.transition('thinking');
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let completed = false;
    const startTime = Date.now();

    try {
      for await (const event of this.host.client.sendMessage(trimmed, {
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
        } else if (event.type === 'toolResult') {
          assistantItem.toolResults = [...(assistantItem.toolResults ?? []), event.result];
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
      this.banner = assistantItem.usage?.inputTokens == null || assistantItem.usage?.outputTokens == null
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
      this.isStreaming = false;
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
      for (const item of this.transcript) item.reasoningExpanded = this.showReasoning;
      return;
    }
    if (key === 'Alt+Enter' || key === 'Ctrl+J') {
      const next = this.composer.value.slice(0, this.composer.cursor) + '\n' + this.composer.value.slice(this.composer.cursor);
      this.composer = updateComposerValue(this.composer, next, this.composer.cursor + 1);
      return;
    }
    if (key === 'Shift+Tab') {
      const nextMode = this.host.client.cycleMode();
      this.banner = `View mode: ${nextMode.toUpperCase()}. Tool permission modes: Not implemented; no permissions changed.`;
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

    if (key === 'PageUp') {
      this.scrollOffset = Math.max(0, (this.scrollOffset < 0 ? 10 : this.scrollOffset) - 5);
      return;
    }
    if (key === 'PageDown') {
      this.scrollOffset = -1;
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
        await this.host.runSlashCommand(toRun);
        return;
      }
    }

    if (this.composer.fileMenuOpen) {
      const files = this.host.workspaceAccess ? this.host.client.listWorkspaceFiles(this.composer.fileQuery).slice(0, 5) : [];
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
      await this.submit(this.composer.value);
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

  async shutdown(): Promise<void> {
    this.activeAbortController?.abort();
    await Promise.allSettled([this.turnTask]);
  }
}
