import {
  FutrynError,
  messageSchema,
  type CompactionOutcome,
  type ConversationStore,
  type Message,
  type ModelEvent,
  type ModelPort,
  type ProjectContextPort,
  type Selection,
  type SteerOutcome,
  type ToolPort,
  type Usage,
} from '@futryn/contracts';
import {normalizeHistory} from '../context/builder';
import {compactConversation} from './compact';
import {TurnRun} from './turn';
import type {ActiveTurn, ConversationOptions, ConversationState, TurnHost} from './turn-types';

export {SAFETY_LIMITS, estimateTokens, type ConversationOptions} from './turn-types';

/**
 * Conversation runtime (Codex `Session`). Tools run only through the injected ToolPort; no provider
 * SDK enters core. `send` runs one turn at a time (see `TurnRun`); while it runs, `steer` queues user
 * input into it. History, pending input, the task checkpoint and the context snapshot are durable in
 * the store and re-read after every turn.
 */
export class Conversation {
  readonly id: string;
  private readonly state: ConversationState = {messages: [], pendingInput: []};
  private running = false;
  private active?: ActiveTurn;

  constructor(
    private readonly selection: Selection,
    private readonly model: ModelPort,
    private readonly store: ConversationStore,
    existing?: {id: string; messages: Message[]},
    private readonly tools?: ToolPort,
    /** Called when the provider rejects the tool definitions themselves (ADR 0017). */
    private readonly onToolsRejected?: () => void,
    private readonly projectContext?: ProjectContextPort,
    private readonly options: ConversationOptions = {},
  ) {
    if (!existing) {
      this.id = store.create(selection);
      return;
    }
    this.id = existing.id;
    const recovery = store.recover?.(existing.id);
    const messages = recovery?.messages.length ? recovery.messages : existing.messages;
    this.state.messages = normalizeHistory(messages.map(m => messageSchema.parse(m)));
    this.state.task = recovery?.task;
    this.state.snapshot = recovery?.compaction;
    this.state.pendingInput = recovery?.pendingInput ?? [];
  }

  history(): readonly Message[] {
    return this.state.messages.map(m => ({...m}));
  }

  /** Accepted instructions that no turn processed yet; the next `send` delivers them first. */
  queuedInput(): readonly {steerId: string; content: string}[] {
    return this.state.pendingInput.map(p => ({steerId: p.steerId, content: p.message.content}));
  }

  /** Identity of the turn that currently accepts steering, if any. */
  activeTurnId(): string | undefined {
    return this.active?.accepting ? this.active.id : undefined;
  }

  /**
   * Snapshot of conversation history including completed rounds of the active turn, used when a
   * subagent is spawned with `fork_context: true` (Codex FullHistory, Wave 2 S5).
   */
  forkableHistory(): Message[] {
    return (this.active?.inTurnMessages?.() ?? this.state.messages).map(m => ({...m}));
  }

  /** Fold a subagent's usage into the active turn's receipt (or the latest stored turn when idle). */
  addSubagentUsage(usage: Usage): void {
    if (this.active?.addUsage) {
      this.active.addUsage(usage);
      return;
    }
    this.store.addUsage?.(this.id, usage);
  }

  /**
   * Codex `Session::steer_input`: queue user input against the active regular turn. The input is
   * journaled before acceptance is reported, and becomes model-visible before the next model request.
   * Steering never changes policy.
   */
  steer(content: string, expectedTurnId?: string): SteerOutcome {
    const turn = this.active;
    if (!turn?.accepting) return {accepted: false, reason: 'no_active_turn'};
    if (expectedTurnId !== undefined && expectedTurnId !== turn.id) return {accepted: false, reason: 'turn_mismatch'};
    if (!this.store.recordExecution) return {accepted: false, reason: 'not_steerable'};
    let message: Message;
    try {
      message = messageSchema.parse({role: 'user', content: content.trim()});
    } catch {
      return {accepted: false, reason: 'empty_input'};
    }
    const steerId = crypto.randomUUID();
    this.store.recordExecution(this.id, turn.id, {type: 'user.steered', steerId, message});
    turn.pending.push({steerId, message});
    turn.wake?.(); // Codex watch_user_input: arriving input preempts the response being sampled.
    return {accepted: true, turnId: turn.id, steerId};
  }

  /** Run one turn for `content`. Only one turn runs at a time. */
  async *send(
    content: string,
    signal?: AbortSignal,
    maxOutputTokens?: number,
    maxEstimatedCostUSD?: number,
    reasoningEffort?: string,
    queuedInputId?: string,
  ): AsyncIterable<ModelEvent> {
    if (this.running) throw new FutrynError('POLICY');
    let user: Message;
    try {
      user = messageSchema.parse({role: 'user', content});
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }

    const turn = new TurnRun(this.host(), user, {
      signal,
      maxOutputTokens,
      maxEstimatedCostUSD,
      reasoningEffort,
      queuedInputId,
    });
    this.running = true;
    try {
      yield* turn.run();
    } finally {
      this.running = false;
    }
  }

  /**
   * Manual `/compact` (ADR 0054). Only an idle conversation can be compacted: during a turn the
   * running loop owns the context (`POLICY`). Durable history is untouched; the checkpoint is durable.
   */
  async compact(instructions?: string, signal?: AbortSignal): Promise<CompactionOutcome> {
    if (this.running) throw new FutrynError('POLICY');
    this.running = true;
    try {
      return await compactConversation(this.host(), instructions, signal);
    } finally {
      this.running = false;
    }
  }

  private host(): TurnHost {
    return {
      id: this.id,
      selection: this.selection,
      model: this.model,
      store: this.store,
      tools: this.tools,
      projectContext: this.projectContext,
      options: this.options,
      onToolsRejected: this.onToolsRejected,
      state: this.state,
      activate: turn => {
        this.active = turn;
      },
      release: turn => {
        if (this.active === turn) this.active = undefined;
      },
    };
  }
}
