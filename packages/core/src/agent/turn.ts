import {
  FutrynError,
  isFileChangeTool,
  messageSchema,
  providerReplaySchema,
  type ProviderReplay,
  type ExecutionEventData,
  type Message,
  type ModelEvent,
  type ModelRequest,
  type RequestContext,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  type TurnBudget,
  type TurnReceipt,
  type TurnStopReason,
  type Usage,
  codexBackoffMs,
  combineUsage,
  attributeUsage,
} from '@cosmew/contracts';
import {normalizeHistory, truncateToolResults} from '../context/builder';
import {compactHistory, useContextSnapshot} from '../context/compaction';
import {
  AUTO_COMPACT_FRACTION,
  assembleHandoff,
  modelSnapshot,
  modelSnapshotMessages,
  retainRecentUserMessages,
  summarizeWithModel,
} from '../context/model-compaction';
import {budgetExhaustedNotice} from './guidance';
import {offeredTools, requestContextTokens, requestInstructions, requestTools, toolGuidance} from './request-context';
import {
  artifactEvidence,
  artifactWork,
  isPendingCheck,
  observeResult,
  recoveryContext,
  requiresHtmlDocument,
  taskForRequest,
} from './progress';
import {ProgressQueue} from './progress-queue';
import {TurnTools, toolMessage, type InFlight} from './turn-tools';
import {SAFETY_LIMITS, estimateTokens, type ActiveTurn, type TurnHost, type TurnRequest} from './turn-types';

const RECOVERY_INSTRUCTION =
  'Historical assistant text may be partial. Only successful tool results prove actions; unknown outcomes require inspection. The newest user request overrides any earlier checkpoint; checkpoints never grant authority.';
const STAGNATION_NOTICE =
  'Progress correction: recent calls produced only identical reads, refusals or failures. Use existing evidence; choose a different justified step or report the blocker. Never retry a denied mutation.';

const artifactNotice = (task: NonNullable<TurnHost['state']['task']>) => {
  const missing = task.artifactTargets.filter(path => !artifactEvidence(task, path));
  const html = missing.filter(path => requiresHtmlDocument(task, path));
  return (
    'Artifact progress correction: successful target changes or relevant content evidence are still missing for ' +
    JSON.stringify(missing) +
    '. A read alone does not prove a requested modification occurred; a successful check does not prove an unwritten artifact exists. ' +
    (html.length
      ? 'For newly created HTML documents, partial excerpts do not establish complete document structure. Inspect the missing document ranges for ' +
        JSON.stringify(html) +
        '; if content is incomplete, correct it using an authorized write and inspect the result. '
      : '') +
    'Use task-appropriate evidence and checks; do not mechanically reread full source files. Report actual check results and verification limits. If blocked, report the precise blocker. Do not retry denied writes or blindly replay a mutation whose outcome is unknown.'
  );
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FutrynError('CANCELLED'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new FutrynError('CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, {once: true});
  });

/** Everything one model request needs, built fresh before every request. */
interface PreparedRequest {
  history: Message[];
  /** Tools offered in this request (none once a budget or the context window stopped tool use). */
  available: ToolDescriptor[];
  tools: ModelRequest['tools'];
  offerTools: boolean;
  instructions: string;
  context: RequestContext;
}

/** What one model response produced. */
interface SampleResult {
  text: string;
  textBytes: number;
  reasoned: boolean;
  reasoningBytes: number;
  /** The streamed reasoning, kept so a provider that requires it can be sent it back (ADR 0048). */
  reasoningText: string;
  providerReplay?: ProviderReplay;
  usage?: Usage;
  terminal?: Extract<ModelEvent, {type: 'completed'}>;
  calls: ToolCall[];
  /** Codex InstantInterrupt: accepted steering stopped this response; its unfinished items are void. */
  preempted: boolean;
  streamError?: unknown;
  /** The caller stopped iterating while this response was being read. */
  closedByConsumer?: boolean;
}

type NextStep = {kind: 'follow-up'} | {kind: 'complete'; needsArtifact: boolean; verified: boolean};

/**
 * One turn of a conversation (Codex `run_turn`). Each loop iteration is one model request (Codex
 * `run_sampling_request`); complete tool calls are dispatched while the response still streams
 * (Codex `try_run_sampling_request` + `ToolCallRuntime`) and their results are recorded in
 * model-output order. The turn ends when no follow-up remains, or fails with a named reason.
 */
export class TurnRun {
  readonly receipt: TurnReceipt;
  private readonly turn: ActiveTurn;
  private readonly turnAbort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly budget: TurnBudget;
  private readonly startedAt = Date.now();
  private readonly progress = new ProgressQueue();
  private readonly tools: TurnTools;
  /** Absent: no cap is sent (Codex). */
  private maxOutputTokens: number | undefined;

  /** Accepted-but-undelivered input of earlier turns that opens this one. */
  private carried: Message[] = [];
  /** Tool rounds of this turn: assistant tool-call messages, their tool results and delivered steering. */
  private readonly steps: Message[] = [];
  private projectMessages: Message[] = [];
  /** Usable context window in tokens (model window minus the output reservation). */
  private window = 1;
  private revision?: number;
  private completed = false;
  /** The journal already records this turn as interrupted. */
  private settled = false;
  private recoveryNeeded = false;
  /** True while round 0 offered tools and nothing has come back yet. */
  private rejectionCandidate = false;
  /** Consecutive tool rounds without new evidence. */
  private stagnant = 0;
  /** Artifact-verification continuations used (at most one). */
  private corrections = 0;
  private progressNotice = '';
  /** Why tools were withdrawn for a final answer (a budget, the context window or a safety limit). */
  private stop?: TurnStopReason;
  /** Provider-measured tokens of the previous round: its input plus its output form the next prefix. */
  private lastInput: number | null | undefined;
  private lastOutput: number | null | undefined;
  /** Usage of the parent model's own requests (sampling + compaction), kept distinct from subagent usage. */
  private modelUsage: Usage | null = null;
  /** Cumulative usage reported by subagents spawned during this turn (Wave 2 S5). */
  private childUsage: Usage | null = null;
  /** Compaction events produced while preparing a request, delivered before it is sent (ADR 0054). */
  private notices: ModelEvent[] = [];
  /** A model summary failed this turn: do not spend another request on it (the excerpt fallback applies). */
  private modelCompactionOff = false;
  /** When tool schemas consume most of a small context window, keep host guidance concise. */
  private compactGuidance = false;
  /**
   * In-turn compaction (Codex mid-turn auto compaction): the model-visible start of this turn is a
   * handoff, with `consumed` tool-round messages already folded into it. Memory only; the journal is
   * intact, and the next turn compacts durably if the context is still large.
   */
  private base?: {messages: Message[]; consumed: number};

  constructor(
    private readonly host: TurnHost,
    private readonly user: Message,
    private readonly request: TurnRequest,
  ) {
    this.signal = request.signal ? AbortSignal.any([request.signal, this.turnAbort.signal]) : this.turnAbort.signal;
    this.budget = host.options.budget?.() ?? {};
    this.maxOutputTokens = request.maxOutputTokens;
    this.receipt = {
      requestId: crypto.randomUUID(),
      accountId: host.selection.accountId,
      modelId: host.selection.modelId,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: null,
      outcome: 'pending',
      usage: null,
      context: null,
    };
    this.turn = {
      id: this.receipt.requestId,
      accepting: false,
      pending: [],
      addUsage: usage => this.addChildUsage(usage),
      limits: () => ({
        ...(this.request.maxOutputTokens !== undefined ? {maxOutputTokens: this.request.maxOutputTokens} : {}),
        ...(this.request.maxEstimatedCostUSD !== undefined
          ? {maxEstimatedCostUSD: this.request.maxEstimatedCostUSD}
          : {}),
        budget: {...this.budget},
        usage: this.receipt.usage ? {...this.receipt.usage} : null,
        elapsedMs: Date.now() - this.startedAt,
      }),
      inTurnMessages: () => [...this.host.state.messages, ...this.carried, this.user, ...this.steps],
    };
    this.tools = new TurnTools({
      port: host.tools,
      budget: this.budget,
      signal: this.signal,
      progress: this.progress,
      parallelSlots: (() => {
        const configured = host.options.parallelSlots?.();
        return configured === undefined || !Number.isFinite(configured)
          ? SAFETY_LIMITS.parallelTools
          : Math.max(1, Math.floor(configured));
      })(),
      record: event => this.record(event),
      workExhausted: () => this.workExhausted(),
      onSettled: (call, result, sequence) => this.observeTaskResult(call, result, sequence),
      saveAttachments: (callId, attachments) => host.store.saveAttachments?.(host.id, callId, attachments),
    });
  }

  async *run(): AsyncGenerator<ModelEvent> {
    try {
      yield* this.loop();
    } catch (error) {
      throw this.failure(error);
    } finally {
      this.cleanup();
    }
  }

  // -------------------------------------------------------------------------------------------
  // The loop

  private async *loop(): AsyncGenerator<ModelEvent> {
    await this.begin();
    // One iteration = one model request. `round` counts completed responses (user step budget);
    // `attempt` counts stream retries of the current one.
    for (let round = 0, attempt = 0, requests = 0; ; requests++) {
      this.stop ??= this.budgetStop(round);
      // Codex run_turn: pending input is drained into history before every request except the
      // turn's first (whose fresh input is sampled first). Steering is information, not authority.
      if (requests > 0) yield* this.deliverSteering();

      const prepared = await this.prepareRequest(round);
      yield* this.flushNotices();
      // Input accepted while this request was being prepared is delivered with it, keeping the
      // journal (steering before a non-first request) and the model-visible order identical.
      if (requests > 0 && this.turn.pending.length) {
        requests--;
        continue;
      }

      const sample = yield* this.sample(prepared, requests);

      if (sample.streamError !== undefined) {
        yield* this.prepareRetry(sample, attempt);
        attempt++;
        continue;
      }
      if (sample.preempted) {
        // Codex try_run_sampling_request on preempt: needs_follow_up, pending input drained next.
        if (sample.text || sample.reasoned) yield {type: 'responseDiscarded', reason: 'preempted'};
        attempt = 0;
        round++;
        continue;
      }
      if (!sample.terminal) throw new FutrynError('PROTOCOL');
      attempt = 0;
      round++;

      const next = this.nextStep(sample);
      if (next.kind === 'follow-up') continue;
      yield* this.complete(sample, next);
      return;
    }
  }

  /** Recover durable state, journal the user message, become the active turn, load project context. */
  private async begin(): Promise<void> {
    const {host} = this;
    const {state, store} = host;

    const recovered = store.recover?.(host.id);
    if (recovered?.messages.length) state.messages = normalizeHistory(recovered.messages);
    this.recoveryNeeded =
      (recovered?.task ?? state.task)?.state === 'unfinished' ||
      !!recovered?.turns.some(t => ['interrupted', 'failed', 'cancelled'].includes(t.state));
    state.task = taskForRequest(this.user.content, recovered?.task ?? state.task);
    state.snapshot = recovered?.compaction ?? state.snapshot;
    if (recovered) state.pendingInput = recovered.pendingInput ?? [];

    // Accepted-but-undelivered instructions open this turn, before the new message (Codex records
    // leftover input into history before the next turn). Only a journal can prove they were pending.
    const carry = store.beginExecution ? state.pendingInput.slice() : [];
    // Explicit user image bytes are request-local: journal only the visible text chips.
    const {attachments: _userImages, ...durableUser} = this.user;
    this.revision = store.beginExecution
      ? store.beginExecution(
          host.id,
          durableUser,
          this.receipt,
          carry.map(c => c.steerId),
          this.request.queuedInputId,
        )
      : store.append(host.id, durableUser, 'pending', this.receipt);
    this.carried = carry.map(c => c.message);
    state.pendingInput = state.pendingInput.filter(p => !carry.includes(p));
    store.saveTask?.(host.id, state.task);

    // The turn is durable: from here it is the one active owner and may receive steering.
    host.activate(this.turn);
    this.turn.accepting = true;

    this.signal.throwIfAborted();
    const context = await host.projectContext?.load(this.signal);
    this.signal.throwIfAborted();
    const invalidBudget =
      context &&
      (!Number.isSafeInteger(context.budgetBytes) ||
        context.budgetBytes < 0 ||
        context.budgetBytes > 65536 ||
        Buffer.byteLength(context.content) > context.budgetBytes);
    if (invalidBudget) throw new FutrynError('BUDGET');
    this.projectMessages = context?.content ? [messageSchema.parse({role: 'user', content: context.content})] : [];
    // Catalog metadata shares the repository-context trust boundary, never host instructions.
    const catalog = host.options.skills?.instructions();
    if (catalog) this.projectMessages.push(messageSchema.parse({role: 'user', content: catalog}));
    for (const note of host.options.contextNotes?.() ?? [])
      if (note.trim()) this.projectMessages.push(messageSchema.parse({role: 'user', content: note}));
    const memories = host.options.memories?.context();
    if (memories) this.projectMessages.push(messageSchema.parse({role: 'user', content: memories}));
    const skillBodies: string[] = [];
    for (const message of [...this.carried, this.user])
      skillBodies.push(...((await host.options.skills?.loadPrompt(message.content, this.signal)) ?? []));
    this.signal.throwIfAborted();
    this.projectMessages.push(...skillBodies.map(content => messageSchema.parse({role: 'user', content})));

    // Codex sends no output cap and reserves nothing from the window. Only a cap the caller asked
    // for (`--max-output-tokens`) is sent, clamped to the model's limit, and reserved.
    const outputLimit = host.options.outputLimit?.() ?? undefined;
    const contextLimit = host.options.contextLimit?.() ?? SAFETY_LIMITS.unknownContextTokens;
    if (this.maxOutputTokens !== undefined && outputLimit)
      this.maxOutputTokens = Math.min(this.maxOutputTokens, outputLimit);
    this.window = Math.max(1, contextLimit - (this.maxOutputTokens ?? 0));
  }

  private async *deliverSteering(): AsyncGenerator<ModelEvent> {
    const {state, store, id} = this.host;
    while (this.turn.pending.length) {
      const item = this.turn.pending.shift()!;
      const skillBodies = (await this.host.options.skills?.loadPrompt(item.message.content, this.signal)) ?? [];
      this.projectMessages.push(...skillBodies.map(content => messageSchema.parse({role: 'user', content})));
      this.steps.push(item.message);
      if (state.task) {
        state.task.latestRequest = item.message.content;
        store.saveTask?.(id, state.task);
      }
      yield {type: 'steered', steerId: item.steerId, content: item.message.content};
    }
  }

  // -------------------------------------------------------------------------------------------
  // Building a request

  /**
   * Context window (ADR 0030): the measured input of the last round or a conservative estimate,
   * whichever is larger. Near the limit the model answers without tools; past it the turn fails
   * honestly. Durable history stays intact; model-visible checkpoints are explicit.
   */
  private async prepareRequest(round: number): Promise<PreparedRequest> {
    const {host} = this;
    const {state} = host;

    const normalized = normalizeHistory(state.messages);
    const current = normalizeHistory([...this.carried, this.user, ...this.steps]);
    const taskMessage = this.recoveryMessage();
    let visible = useContextSnapshot(normalized, state.snapshot);
    const compose = () =>
      this.base
        ? [
            ...this.projectMessages,
            ...this.base.messages,
            ...taskMessage,
            ...normalizeHistory(this.steps.slice(this.base.consumed)),
          ]
        : [...this.projectMessages, ...visible, ...taskMessage, ...current];
    let history = compose();

    const offered = this.stop ? [] : offeredTools(host.tools, host.options.analysisOnly?.());
    const guidanceNames =
      offered.length > 0
        ? offered.map(d => d.name)
        : this.steps.length || this.stop
          ? (host.tools?.descriptors().map(d => d.name) ?? [])
          : [];
    const offeredSchemas = requestTools(offered);
    const additionalInstructions = host.options.additionalInstructions?.();
    const guidance = () =>
      requestInstructions(
        this.instructions(guidanceNames, offered.length > 0, taskMessage.length > 0),
        additionalInstructions,
      );
    // Tool schemas are part of the request and can legitimately occupy most of a small model
    // window. Keep the first request viable by replacing the long procedural host guidance with a
    // short safety summary in that case. Subsequent rounds use measured provider usage.
    let messageTokens = estimateTokens(history);
    const requiredTokens = requestContextTokens(messageTokens, offeredSchemas, '');
    if (
      round === 0 &&
      requiredTokens < this.window &&
      requestContextTokens(messageTokens, offeredSchemas, guidance()) >= this.window
    ) {
      this.compactGuidance = true;
    }
    const measuredInstructions = guidance();
    const measure = () => {
      const estimate = requestContextTokens(messageTokens, offeredSchemas, measuredInstructions);
      return Math.max(estimate, round > 0 ? (this.lastInput ?? 0) + (this.lastOutput ?? 0) : 0);
    };

    // Compact before considering tool withdrawal, using the same pressure threshold.
    if (measure() >= this.window * AUTO_COMPACT_FRACTION && host.options.autoCompact?.() !== false) {
      const tokensBefore = measure();
      let failed = false;
      let strategy: 'model' | 'excerpt' | undefined;
      if (!this.modelCompactionOff && this.host.options.modelCompaction !== false) {
        try {
          const folded = await this.compactWithModel(normalized, visible, current);
          if (folded) {
            visible = folded.visible;
            strategy = 'model';
          }
        } catch (error) {
          if (this.signal.aborted) throw error; // cancelled: nothing was changed
          this.modelCompactionOff = true;
          failed = true;
        }
      }
      // The excerpt checkpoint covers earlier turns only; it is also the fallback when the model fails.
      if (!strategy && !this.base && normalized.filter(m => m.role === 'user').length >= 3) {
        const allowance =
          this.window -
          requestContextTokens(
            estimateTokens([...this.projectMessages, ...taskMessage, ...current]),
            offeredSchemas,
            measuredInstructions,
          );
        const compacted = await compactHistory(
          normalized,
          state.task,
          Math.max(0, allowance),
          host.options.compactor,
          this.signal,
        );
        if (compacted && compacted.throughRevision > (state.snapshot?.throughRevision ?? 0)) {
          state.snapshot = compacted;
          host.store.saveContextSnapshot?.(host.id, compacted);
          visible = useContextSnapshot(normalized, compacted);
          strategy = 'excerpt';
        }
      }
      if (strategy) {
        history = compose();
        messageTokens = estimateTokens(history);
        this.lastInput = this.lastOutput = undefined;
        this.notices.push({
          type: 'context.compacted',
          trigger: 'auto',
          strategy,
          tokensBefore,
          tokensAfter: measure(),
          ...(failed && strategy === 'excerpt' ? {fallback: true} : {}),
        });
      }
    }

    // Preserve producer pages when the complete request fits. Only recut evidence under pressure,
    // after giving compaction the original pages and their retrieval references.
    if (measure() >= this.window * AUTO_COMPACT_FRACTION) {
      history = truncateToolResults(history, Math.max(1024, Math.min(24000, Math.floor(this.window * 0.06) * 3)));
      messageTokens = estimateTokens(history);
    }
    const used = measure();
    if (used >= this.window) {
      this.stop = 'context_window';
      throw new FutrynError('CONTEXT_LIMIT');
    }
    if (!this.stop && used >= this.window * SAFETY_LIMITS.contextReserve && round > 0) this.stop = 'context_window';

    const available = this.stop ? [] : offered;
    const tools = this.stop ? [] : offeredSchemas;
    const offerTools = tools.length > 0;
    this.rejectionCandidate = round === 0 && offerTools;
    const instructions = this.instructions(
      tools.map(t => t.name),
      offerTools,
      taskMessage.length > 0,
    );
    this.tools.retainVisibleEvidence(history);
    const context = {
      estimateTokens: requestContextTokens(
        messageTokens,
        tools,
        requestInstructions(instructions, additionalInstructions),
      ),
      limitTokens: this.window,
      outputReserve: this.maxOutputTokens ?? 0,
      messages: history.length,
    };
    if (context.estimateTokens >= this.window) {
      this.stop = 'context_window';
      throw new FutrynError('CONTEXT_LIMIT');
    }
    return {history, available, tools, offerTools, instructions, context};
  }

  /**
   * Model-written compaction (ADR 0054). Before the turn's first tool round it checkpoints earlier
   * turns durably (recovery reloads it); mid-turn it folds this turn's rounds into an in-memory
   * handoff. Returns the new model-visible prior history, or undefined when it would not shrink.
   */
  private async compactWithModel(
    normalized: Message[],
    visible: Message[],
    current: Message[],
  ): Promise<{visible: Message[]} | undefined> {
    const {host} = this;
    const {state, store} = host;
    const inTurn = this.steps.length > 0 || this.base !== undefined;
    if (!inTurn && !normalized.some(m => m.role === 'user')) return undefined;

    const input = this.base
      ? [...this.base.messages, ...normalizeHistory(this.steps.slice(this.base.consumed))]
      : inTurn
        ? [...visible, ...current]
        : visible;
    const summary = await summarizeWithModel({
      model: host.model,
      selection: host.selection,
      visible: input,
      window: this.window,
      maxOutputTokens: this.maxOutputTokens,
      maxEstimatedCostUSD: this.request.maxEstimatedCostUSD,
      signal: this.signal,
    });
    // Billed whether or not it helps: count it in this turn's (and so the session's) usage.
    if (summary.usage) {
      this.modelUsage = combineUsage(this.modelUsage, attributeUsage(summary.usage, {sessionId: this.host.id}));
      this.receipt.usage = this.childUsage ? combineUsage(this.modelUsage, this.childUsage) : this.modelUsage;
      store.observeTurn?.(host.id, this.revision!, this.receipt);
    }
    const handoff = assembleHandoff(summary.text, input, store.loadPlan?.(host.id));
    const before = estimateTokens(input);

    if (inTurn) {
      const retained = retainRecentUserMessages(input);
      let messages = modelSnapshotMessages({summary: handoff, retainedUserRequests: retained});
      // Keep the newest completed evidence round verbatim when it leaves ample headroom. Retain
      // the whole assistant/result group or nothing; never create orphaned tool messages.
      const recentStart = input.findLastIndex(message => message.role === 'assistant' && !!message.toolCalls?.length);
      if (recentStart >= 0) {
        const recent = input.slice(recentStart);
        const candidate = [...messages, ...recent];
        if (
          recent.slice(1).every(message => message.role === 'tool') &&
          estimateTokens(recent) <= this.window * 0.15 &&
          estimateTokens(candidate) <= this.window * 0.65 &&
          estimateTokens(candidate) < before
        )
          messages = candidate;
      }
      if (estimateTokens(messages) >= before) throw new FutrynError('CONTEXT_LIMIT');
      this.base = {messages, consumed: this.steps.length};
      return {visible};
    }
    const snapshot = modelSnapshot(normalized, handoff, retainRecentUserMessages(normalized));
    if (estimateTokens(modelSnapshotMessages(snapshot)) >= before) throw new FutrynError('CONTEXT_LIMIT');
    state.snapshot = snapshot;
    store.saveContextSnapshot?.(host.id, snapshot);
    return {visible: useContextSnapshot(normalized, snapshot)};
  }

  private *flushNotices(): Generator<ModelEvent> {
    while (this.notices.length) yield this.notices.shift()!;
  }

  /** After an interrupted or unfinished turn, the model gets an explicit checkpoint of the task. */
  private recoveryMessage(): Message[] {
    const {task, messages} = this.host.state;
    const hasWork =
      task && (task.artifactTargets.length > 0 || messages.some(m => m.role === 'assistant' || m.role === 'tool'));
    return task && this.recoveryNeeded && hasWork ? [recoveryContext(task, messages)] : [];
  }

  /** Host guidance travels with the tools; once tools are withdrawn mid-turn the model is told why. */
  private instructions(offeredNames: string[], offerTools: boolean, recovering: boolean): string {
    const {host, budget, stop} = this;
    const toolsUsed = this.steps.length > 0;
    let names: string[] = [];
    if (offerTools) names = offeredNames;
    else if (toolsUsed || stop) names = host.tools?.descriptors().map(d => d.name) ?? [];
    const guidance = toolGuidance(names, budget, this.compactGuidance);

    let base: string | undefined;
    if (offerTools) base = guidance;
    else if (stop || toolsUsed) base = [guidance, budgetExhaustedNotice(stop)].filter(Boolean).join('\n');

    return [base, this.progressNotice, ...(recovering ? [RECOVERY_INSTRUCTION] : [])].filter(Boolean).join('\n');
  }

  // -------------------------------------------------------------------------------------------
  // Sampling one response

  /**
   * Stream one model response. Complete tool calls are dispatched as they arrive; live tool output
   * is interleaved with model events; arriving steering may preempt the response.
   */
  private async *sample(prepared: PreparedRequest, requests: number): AsyncGenerator<ModelEvent, SampleResult> {
    const {host} = this;
    const result: SampleResult = {
      text: '',
      textBytes: 0,
      reasoned: false,
      reasoningBytes: 0,
      reasoningText: '',
      calls: [],
      preempted: false,
    };
    const flights: InFlight[] = [];
    const usageBefore = this.modelUsage; // totals of earlier parent requests
    let drained = false;
    const stepId = crypto.randomUUID();
    // Preemption requests another model call, so it is off once a budget or the context window has
    // stopped tool use: then steering waits (deferred) instead of bypassing the stop.
    const preemptable = !this.stop;
    // Aborting the request closes only the model stream; dispatched tools keep the turn signal.
    const requestAbort = new AbortController();
    let requested = false;

    try {
      try {
        this.signal.throwIfAborted();
        this.record({type: 'model.requested', stepId, protocol: 2, context: prepared.context});
        requested = true;
        this.turn.requestContext = prepared.context;
        const iterator = host.model
          .stream(
            {
              requestId: requests === 0 ? this.receipt.requestId : crypto.randomUUID(),
              modelId: host.selection.modelId,
              messages: prepared.history,
              maxOutputTokens: this.maxOutputTokens,
              maxEstimatedCostUSD: this.request.maxEstimatedCostUSD,
              reasoningEffort: this.request.reasoningEffort,
              tools: prepared.tools,
              ...(prepared.instructions ? {instructions: prepared.instructions} : {}),
              cacheKey: host.id,
            },
            AbortSignal.any([this.signal, requestAbort.signal]),
          )
          [Symbol.asyncIterator]();
        yield* this.readStream(iterator, requestAbort, preemptable, prepared, result, flights, usageBefore, stepId);
      } catch (error) {
        // The caller closed the stream and closing the model stream failed: that error is the
        // turn's outcome (a nested generator in closing mode would otherwise swallow it).
        if (result.closedByConsumer) throw error;
        result.streamError = error;
      }

      if (flights.length) {
        // Complete calls are answered and recorded even when the response failed afterwards, so a
        // retry or a later turn sees their real outcome instead of repeating them.
        const {results, failure} = yield* this.tools.drain(flights);
        drained = true;
        if (this.childUsage && this.receipt.usage) {
          yield {type: 'usage', usage: this.receipt.usage};
        }
        // Unfinished text of a response that did not complete is not history (Codex discards items
        // that never reached OutputItemDone); its completed calls and their results are.
        const committed = result.terminal && result.terminal.finishReason !== 'length';
        this.steps.push(
          {
            role: 'assistant',
            content: committed ? result.text : '',
            toolCalls: result.calls,
            ...(committed && !result.streamError && !result.preempted && result.providerReplay
              ? {providerReplay: result.providerReplay}
              : {}),
            ...(result.reasoningText ? {reasoning: result.reasoningText} : {}),
          },
          ...result.calls.map((call, index) => toolMessage(call, results[index]!)),
        );
        if (failure && !result.streamError) result.streamError = failure;
        const newEvidence = results.some(r => r.status === 'ok' && !r.content.startsWith('[unchanged]'));
        this.stagnant = newEvidence ? 0 : this.stagnant + 1;
      }
    } finally {
      const cancelled =
        this.signal.aborted ||
        result.closedByConsumer ||
        (result.streamError instanceof FutrynError && result.streamError.code === 'CANCELLED');
      // An abandoned iterator must not leave tools running after the turn is finalized.
      if (flights.length && !drained) {
        this.turnAbort.abort();
        await Promise.all(flights.map(flight => flight.settled));
      }
      if (requested) {
        const errorCode = cancelled
          ? 'CANCELLED'
          : result.streamError !== undefined
            ? this.publicError(result.streamError).code
            : (!result.terminal && !result.preempted) || result.terminal?.finishReason === 'length'
              ? 'PROTOCOL'
              : undefined;
        this.record({
          type: 'model.finished',
          stepId,
          outcome:
            errorCode === 'CANCELLED'
              ? 'cancelled'
              : errorCode
                ? 'failed'
                : result.preempted
                  ? 'preempted'
                  : 'completed',
          ...(errorCode ? {errorCode} : {}),
          inputTokens: result.usage?.inputTokens ?? null,
          outputTokens: result.usage?.outputTokens ?? null,
        });
      }
    }
    return result;
  }

  /** Read events until the stream ends or is preempted; validate each event and act on it. */
  private async *readStream(
    iterator: AsyncIterator<ModelEvent>,
    requestAbort: AbortController,
    preemptable: boolean,
    prepared: PreparedRequest,
    result: SampleResult,
    flights: InFlight[],
    usageBefore: Usage | null,
    stepId: string,
  ): AsyncGenerator<ModelEvent> {
    const {turn, progress} = this;
    let next: Promise<IteratorResult<ModelEvent>> | undefined;
    let failed = false;
    // Code after a `yield` never runs when the caller closes the generator there; only `finally` does.
    let suspended = false;
    try {
      for (;;) {
        if (progress.size) {
          suspended = true;
          yield progress.take();
          suspended = false;
          continue;
        }
        next ??= iterator.next();
        const preempt = preemptable
          ? new Promise<'preempt'>(resolve => {
              turn.wake = () => resolve('preempt');
              if (turn.pending.length) resolve('preempt');
            })
          : undefined;
        const step = await Promise.race([
          next.then(
            r => ({r}),
            (e: unknown) => ({e}),
          ),
          progress.ready(),
          ...(preempt ? [preempt] : []),
        ]);
        turn.wake = undefined;
        if (step === 'preempt') {
          result.preempted = true;
          break;
        }
        if (!step) continue; // progress arrived
        next = undefined;
        if ('e' in step) throw step.e;
        if (step.r.done) break;

        const forward = this.handleEvent(step.r.value, prepared, result, flights, usageBefore, stepId);
        if (forward) {
          suspended = true;
          yield forward;
          suspended = false;
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (suspended) result.closedByConsumer = true;
      progress.clearWaiter();
      turn.wake = undefined;
      if (next) {
        requestAbort.abort();
        await next.catch(() => undefined);
      }
      // Same as `for await`: closing errors surface unless the body is already failing.
      if (failed) await iterator.return?.()?.catch(() => undefined);
      else await iterator.return?.();
    }
  }

  /** Validate and apply one model event. Returns the event to forward to the caller, if any. */
  private handleEvent(
    event: ModelEvent,
    prepared: PreparedRequest,
    result: SampleResult,
    flights: InFlight[],
    usageBefore: Usage | null,
    stepId: string,
  ): ModelEvent | undefined {
    const {host, tools, receipt} = this;
    if (this.signal.aborted) throw new FutrynError('CANCELLED');
    // toolOutputDelta and subagent.* are Cosmew's own events: a provider stream cannot fabricate them.
    if (event.type === 'toolOutputDelta' || event.type.startsWith('subagent.')) throw new FutrynError('PROTOCOL');
    if (result.terminal) throw new FutrynError('PROTOCOL');
    if (event.type === 'textDelta' || event.type === 'toolCallComplete') this.rejectionCandidate = false;

    if (event.type === 'providerReplay') {
      if (result.providerReplay) throw new FutrynError('PROTOCOL');
      result.providerReplay = providerReplaySchema.parse(event.replay);
      return undefined;
    }
    if (event.type === 'textDelta') {
      result.text += event.text;
      result.textBytes += Buffer.byteLength(event.text);
      this.record({type: 'assistant.text', text: event.text});
    }
    if (event.type === 'reasoningDelta') {
      result.reasoned = true;
      result.reasoningBytes += Buffer.byteLength(event.text);
      result.reasoningText += event.text;
    }
    if (event.type === 'usage' || event.type === 'completed') {
      result.usage = attributeUsage(event.usage, {sessionId: host.id});
      this.modelUsage = combineUsage(usageBefore, result.usage);
      receipt.usage = this.childUsage ? combineUsage(this.modelUsage, this.childUsage) : this.modelUsage;
      this.lastInput = event.usage.inputTokens;
      this.lastOutput = event.usage.outputTokens;
    }
    if (event.type === 'context') receipt.context = event.context;
    if (event.type === 'usage' || event.type === 'context') host.store.observeTurn?.(host.id, this.revision!, receipt);

    if (event.type === 'toolCallComplete') {
      // A complete call (adapters emit it only once its arguments parsed) is dispatched now, while
      // the rest of the response streams. Incomplete argument deltas never reach here.
      if (!prepared.offerTools) throw new FutrynError('UNSUPPORTED');
      const repeated = result.calls.some(c => c.id === event.call.id) || tools.journalCalls.has(event.call.id);
      if (repeated) throw new FutrynError('PROTOCOL');
      tools.recordCall(event.call);
      result.calls.push(event.call);
      flights.push(tools.dispatch(event.call));
    }
    // Only Cosmew runs tools: a provider stream can never report a tool result.
    if (event.type === 'toolResult') throw new FutrynError('PROTOCOL');

    if (event.type === 'completed') {
      result.terminal = event;
      // Codex ResponseIncomplete: output cut by the token limit never commits its text, so recovery
      // keeps it labelled incomplete instead of replaying it as a final answer.
      if (event.finishReason !== 'length') this.record({type: 'model.completed', stepId});
      return undefined;
    }
    return event.type === 'usage' ? {type: 'usage', usage: receipt.usage!} : event;
  }

  // -------------------------------------------------------------------------------------------
  // After a response

  /**
   * Codex run_sampling_request + responses_retry: a retryable stream error re-samples with the
   * history recorded so far. Streamed text stays provisional (no `model.completed`), so it is
   * discarded visibly, never committed; completed tools keep their results and never re-run.
   */
  private async *prepareRetry(sample: SampleResult, attempt: number): AsyncGenerator<ModelEvent> {
    const error = sample.streamError;
    if (this.signal.aborted) throw new FutrynError('CANCELLED');
    const maxRetries = this.host.options.streamMaxRetries?.() ?? SAFETY_LIMITS.roundRetries;
    const retryable = error instanceof FutrynError && error.retryable && attempt < maxRetries;
    if (!retryable || !(error instanceof FutrynError)) throw error;
    // Codex notify_stream_error("Reconnecting... n/max"): every retry is visible, with or without partial output.
    yield {type: 'responseDiscarded', reason: 'retry', attempt: attempt + 1, maxRetries};
    const sleep = this.host.options.sleep ?? defaultSleep;
    // Codex: a server Retry-After wins; otherwise backoff(n) = 200 ms × 2^(n-1) with ±10% jitter.
    await sleep(error.retryAfterMs ?? codexBackoffMs(attempt + 1), this.signal);
  }

  /** Decide whether the turn needs another model request (Codex `needs_follow_up`) or is complete. */
  private nextStep(sample: SampleResult): NextStep {
    const terminal = sample.terminal!;
    const {host, steps, stop} = this;
    const {task} = host.state;

    // Codex is_terminal_sampling_outcome(ResponseIncomplete): output cut by the token limit is not a
    // final answer and is not retried. Completed calls above already have recorded results.
    if (terminal.finishReason === 'length') throw new FutrynError('PROTOCOL');

    if (sample.calls.length) {
      // Codex needs_follow_up: tool output always goes back to the model.
      if (this.stagnant >= 3) this.progressNotice = STAGNATION_NOTICE;
      if (this.stagnant >= 6) {
        this.stop = 'stalled';
        throw new FutrynError('STALLED');
      }
      return {kind: 'follow-up'};
    }

    // Codex Completed { end_turn: Some(false) }. Only providers that expose such a signal set it
    // (Anthropic pause_turn); absence is never treated as "continue".
    if (terminal.endTurn === false && !stop) {
      if (sample.text || sample.providerReplay)
        steps.push({
          role: 'assistant',
          content: sample.text,
          ...(sample.providerReplay ? {providerReplay: sample.providerReplay} : {}),
        });
      return {kind: 'follow-up'};
    }
    if (!sample.text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(terminal.finishReason)) {
      throw new FutrynError('PROTOCOL');
    }

    // Codex: needs_follow_up = model_needs_follow_up || has_pending_input. Accepted steering that
    // arrived during this response continues the same turn instead of starting an unrelated one.
    if (this.turn.pending.length && !stop) {
      steps.push({
        role: 'assistant',
        content: sample.text,
        ...(sample.providerReplay ? {providerReplay: sample.providerReplay} : {}),
      });
      return {kind: 'follow-up'};
    }

    // Evidence-based artifact check, like a Codex Stop hook that blocks once: an unverified requested
    // artifact gets one continuation with an explicit prompt. It never turns an answer into a
    // failure, and a denied or blocked mutation is reported by the model, not retried.
    const needsArtifact = !!task && !host.options.analysisOnly?.() && artifactWork(task);
    const verified = !!task?.artifactTargets.every(path => artifactEvidence(task, path));
    const blocked = task?.failures.some(f => f.includes('denied')) || this.tools.writeDenied;
    const canWrite = host.tools?.descriptors().some(d => isFileChangeTool(d.name));
    if (needsArtifact && canWrite && !verified && !stop && !blocked && this.corrections++ < 1) {
      steps.push({
        role: 'assistant',
        content: sample.text,
        ...(sample.providerReplay ? {providerReplay: sample.providerReplay} : {}),
      });
      this.progressNotice = artifactNotice(task!);
      return {kind: 'follow-up'};
    }
    return {kind: 'complete', needsArtifact, verified};
  }

  /** Completion: no follow-up remains. Steering that arrives from now on starts a new turn. */
  private async *complete(
    sample: SampleResult,
    next: Extract<NextStep, {kind: 'complete'}>,
  ): AsyncGenerator<ModelEvent> {
    const {host, receipt, stop} = this;
    const {state, store} = host;
    const terminal = sample.terminal!;

    this.turn.accepting = false;
    const deferred = this.deferPending();
    if (state.task) {
      state.task.state = this.finalTaskState(next);
      if (state.task.state === 'verified') state.task.pending = [];
      store.saveTask?.(host.id, state.task);
    }
    receipt.outcome = 'completed';
    receipt.stopReason = stop ?? 'completed';
    receipt.finishedAt = new Date().toISOString();
    const answer: Message = {
      role: 'assistant',
      content: sample.text,
      ...(sample.providerReplay ? {providerReplay: sample.providerReplay} : {}),
    };
    store.complete(host.id, this.revision!, answer, receipt, this.steps);
    this.completed = true;
    state.messages.push(...this.carried, this.user, ...this.steps, answer);

    if (deferred.length) yield {type: 'inputDeferred', steerIds: deferred, reason: stop ?? 'completed'};
    yield {...terminal, usage: receipt.usage ?? terminal.usage};
  }

  private finalTaskState(next: {needsArtifact: boolean; verified: boolean}): 'verified' | 'unfinished' {
    const task = this.host.state.task!;
    // Historical read/cancellation failures stay visible during recovery, but a later confirmed
    // artifact change and inspection can finish that work. Failed checks remain unresolved.
    const failed = !next.needsArtifact && task.failures.some(f => !/^(?:exec_command|write_stdin)\b/.test(f));
    const openWork = failed || task.pending.some(isPendingCheck);
    return openWork || (next.needsArtifact && !next.verified) ? 'unfinished' : 'verified';
  }

  // -------------------------------------------------------------------------------------------
  // Failure and cleanup

  /** Journal a failed or cancelled turn and return the error the caller should see. */
  private failure(error: unknown): unknown {
    const {host, receipt, signal} = this;
    const {state, store} = host;
    this.turn.accepting = false;
    this.deferPending();
    const reported = this.publicError(error);
    const cancelled = reported.code === 'CANCELLED';
    const toolsRejected =
      this.rejectionCandidate && !signal.aborted && error instanceof FutrynError && error.code === 'INVALID_INPUT';

    if (this.revision !== undefined && !this.completed) {
      receipt.outcome = cancelled ? 'cancelled' : 'failed';
      receipt.stopReason = cancelled
        ? 'cancelled'
        : reported.code === 'CONTEXT_LIMIT'
          ? 'context_window'
          : this.failureStopReason();
      receipt.errorCode = reported.code;
      receipt.finishedAt = new Date().toISOString();
      store.interrupt(host.id, this.revision, receipt, this.tools.appliedSteps);
      this.settled = true;
      if (state.task) {
        state.task.state = 'unfinished';
        state.task.failures.push(cancelled ? 'cancelled' : error instanceof FutrynError ? error.code : 'failed');
        store.saveTask?.(host.id, state.task);
      }
      if (!store.recover) state.messages.push(this.user, ...this.steps);
    }

    // A 400 before any output, right after offering tools, means the provider refused the tool definitions.
    if (toolsRejected) host.onToolsRejected?.();
    return reported;
  }

  private publicError(error: unknown): FutrynError {
    // A cancelled turn reports cancellation, not whichever provider error raced with it.
    if (this.signal.aborted) return new FutrynError('CANCELLED');
    if (
      this.rejectionCandidate &&
      this.host.onToolsRejected &&
      error instanceof FutrynError &&
      error.code === 'INVALID_INPUT'
    )
      return new FutrynError('UNSUPPORTED');
    if (error instanceof FutrynError) return error;
    return new FutrynError('PROTOCOL');
  }

  private failureStopReason(): TurnStopReason {
    const stop = this.stop;
    return stop === 'context_window' || stop === 'safety_limit' || stop === 'stalled' ? stop : 'failed';
  }

  /** Runs however the turn ended: release ownership, stop leftover work, re-read durable history. */
  private cleanup(): void {
    const {host, receipt} = this;
    const {state, store} = host;
    this.turn.accepting = false;
    this.deferPending();
    host.release(this.turn);
    if (!this.completed) this.turnAbort.abort();

    // The caller stopped iterating without an error (e.g. closed the stream): record a cancellation.
    if (this.revision !== undefined && !this.completed && !this.settled) {
      receipt.outcome = 'cancelled';
      receipt.stopReason = 'cancelled';
      receipt.errorCode = 'CANCELLED';
      receipt.finishedAt = new Date().toISOString();
      store.interrupt(host.id, this.revision, receipt, this.tools.appliedSteps);
    }
    if (this.revision !== undefined) {
      const recovery = store.recover?.(host.id);
      if (recovery) {
        state.messages = normalizeHistory(recovery.messages);
        state.pendingInput = recovery.pendingInput ?? [];
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Helpers

  /** Hands accepted-but-undelivered steering to the session queue with an explicit, visible disposition. */
  private deferPending(): string[] {
    const left = this.turn.pending.splice(0);
    this.host.state.pendingInput.push(...left);
    return left.map(item => item.steerId);
  }

  private record(event: ExecutionEventData): number {
    return this.host.store.recordExecution?.(this.host.id, this.receipt.requestId, event) ?? 0;
  }

  private addChildUsage(usage: Usage): void {
    this.childUsage = combineUsage(this.childUsage, usage);
    this.receipt.usage = combineUsage(this.modelUsage, this.childUsage);
    if (this.revision !== undefined) {
      this.host.store.observeTurn?.(this.host.id, this.revision, this.receipt);
    }
  }

  private observeTaskResult(call: ToolCall, result: ToolResult, sequence: number): void {
    const {state, store, id} = this.host;
    if (!state.task) return;
    observeResult(state.task, call, result, sequence);
    store.saveTask?.(id, state.task);
  }

  /** A user budget that is used up, checked before each model round. */
  private budgetStop(round: number): TurnStopReason | undefined {
    const {budget} = this;
    if (budget.maxSteps !== undefined && round >= budget.maxSteps) return 'budget_steps';
    if (budget.maxToolCalls !== undefined && this.tools.executed >= budget.maxToolCalls) return 'budget_tool_calls';
    return this.workExhausted();
  }

  private workExhausted(): TurnStopReason | undefined {
    const {budget, receipt} = this;
    const tokens = receipt.usage ? (receipt.usage.inputTokens ?? 0) + (receipt.usage.outputTokens ?? 0) : 0;
    if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) return 'budget_tokens';
    if (budget.maxDurationMs !== undefined && Date.now() - this.startedAt >= budget.maxDurationMs) return 'budget_time';
    if (budget.maxCostUSD !== undefined && (receipt.usage?.costUSD ?? 0) >= budget.maxCostUSD) return 'budget_cost';
    return undefined;
  }
}
