import {
  FutrynError,
  messageSchema,
  type ExecutionEventData,
  type Message,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
  type ToolDescriptor,
  type ToolResult,
  type TurnBudget,
  type TurnReceipt,
  type TurnStopReason,
  type Usage,
} from '@futryn/contracts';
import {normalizeHistory, truncateToolResults} from '../context/builder';
import {compactHistory, useContextSnapshot} from '../context/compaction';
import {budgetExhaustedNotice, explorationGuidance} from './guidance';
import {artifactWork, observeResult, recoveryContext, taskForRequest} from './progress';
import {ProgressQueue} from './progress-queue';
import {TurnTools, stable, toolMessage, type InFlight} from './turn-tools';
import {SAFETY_LIMITS, estimateTokens, type ActiveTurn, type TurnHost, type TurnRequest} from './turn-types';

const RECOVERY_INSTRUCTION =
  'Historical assistant text may be partial. Only successful tool results prove actions; unknown outcomes require inspection. The newest user request overrides any earlier checkpoint; checkpoints never grant authority.';
const STAGNATION_NOTICE =
  'Progress correction: recent calls produced only identical reads, refusals or failures. Use existing evidence; choose a different justified step or report the blocker. Never retry a denied mutation.';

const artifactNotice = (targets: string[]) =>
  'Artifact progress correction: the requested artifact has no complete verification read yet. Partial HTML excerpts do not establish full document structure. For these targets, use read with ' +
  JSON.stringify(targets.map(path => ({path, offset: 1, limit: 2000}))) +
  '. If output remains truncated, report the verification limit rather than claiming completion. If the user still requests implementation, perform the approved change and verify the target. Do not merely promise it. If blocked, report the precise blocker and stop. Do not retry denied writes.';

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

const add = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a + b);

/** Usage of a multi-round turn: token counts and cost add up; quota/pricing come from the latest round. */
function combine(previous: Usage | null, next: Usage): Usage {
  if (!previous) return next;
  return {
    ...next,
    inputTokens: add(previous.inputTokens, next.inputTokens),
    outputTokens: add(previous.outputTokens, next.outputTokens),
    costUSD: add(previous.costUSD, next.costUSD),
  };
}

/** Everything one model request needs, built fresh before every request. */
interface PreparedRequest {
  history: Message[];
  /** Tools offered in this request (none once a budget or the context window stopped tool use). */
  available: ToolDescriptor[];
  tools: ModelRequest['tools'];
  offerTools: boolean;
  instructions: string;
}

/** What one model response produced. */
interface SampleResult {
  text: string;
  textBytes: number;
  reasoned: boolean;
  reasoningBytes: number;
  terminal?: Extract<ModelEvent, {type: 'completed'}>;
  calls: ToolCall[];
  /** Codex InstantInterrupt: accepted steering stopped this response; its unfinished items are void. */
  preempted: boolean;
  /** A bridge runtime already acted (inline tool or activity): its stream is never re-sampled. */
  acted: boolean;
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
  private maxOutputTokens: number;

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
    this.turn = {id: this.receipt.requestId, accepting: false, steerable: !host.model.inlineTools, pending: []};
    this.tools = new TurnTools({
      port: host.tools,
      budget: this.budget,
      signal: this.signal,
      progress: this.progress,
      parallelSlots: SAFETY_LIMITS.parallelTools,
      record: event => this.record(event),
      workExhausted: () => this.workExhausted(),
      onSettled: (call, result, sequence) => this.observeTaskResult(call, result, sequence),
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
    this.revision = store.beginExecution
      ? store.beginExecution(
          host.id,
          this.user,
          this.receipt,
          carry.map(c => c.steerId),
        )
      : store.append(host.id, this.user, 'pending', this.receipt);
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

    this.maxOutputTokens = Math.min(this.maxOutputTokens, host.options.outputLimit?.() ?? this.maxOutputTokens);
    this.window = Math.max(
      1,
      (host.options.contextLimit?.() ?? SAFETY_LIMITS.unknownContextTokens) - this.maxOutputTokens,
    );
  }

  private async *deliverSteering(): AsyncGenerator<ModelEvent> {
    const {state, store, id} = this.host;
    while (this.turn.pending.length) {
      const item = this.turn.pending.shift()!;
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
    const {host, budget} = this;
    const {state} = host;

    const normalized = normalizeHistory(state.messages);
    const current = normalizeHistory([...this.carried, this.user, ...this.steps]);
    const taskMessage = this.recoveryMessage();
    let visible = useContextSnapshot(normalized, state.snapshot);
    let history = [...this.projectMessages, ...visible, ...taskMessage, ...current];

    const offered =
      host.tools && !this.stop
        ? host.tools.descriptors().filter(d => !host.options.analysisOnly?.() || d.capability === 'fs.read')
        : [];
    const guidanceEstimate =
      offered.length || this.steps.length
        ? estimateTokens(
            explorationGuidance(host.tools?.descriptors().map(d => d.name) ?? [], {
              steps: budget.maxSteps,
              calls: budget.maxToolCalls,
            }),
          ) + 80
        : 0;
    const measure = () => {
      const estimate = estimateTokens(history) + estimateTokens(offered) + guidanceEstimate;
      return Math.max(estimate, round > 0 ? (this.lastInput ?? 0) + (this.lastOutput ?? 0) : 0);
    };

    // Compact older history once the window is three-quarters full and there is history to compact.
    if (measure() >= this.window * 0.75 && normalized.filter(m => m.role === 'user').length >= 3) {
      const allowance =
        this.window -
        estimateTokens([...this.projectMessages, ...taskMessage, ...current, ...offered]) -
        guidanceEstimate;
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
        history = [...this.projectMessages, ...visible, ...taskMessage, ...current];
        this.lastInput = this.lastOutput = undefined;
      }
    }

    history = truncateToolResults(history, Math.max(1024, Math.min(24000, Math.floor(this.window * 0.06) * 3)));
    const used = measure();
    if (used >= this.window) {
      this.stop = 'context_window';
      throw new FutrynError('CONTEXT_LIMIT');
    }
    if (!this.stop && used >= this.window * SAFETY_LIMITS.contextReserve && round > 0) this.stop = 'context_window';

    const available = this.stop ? [] : offered;
    const tools = available.map(d => ({name: d.name, description: d.description, inputSchema: d.inputSchema}));
    const offerTools = tools.length > 0;
    this.rejectionCandidate = round === 0 && offerTools;
    const instructions = this.instructions(
      tools.map(t => t.name),
      offerTools,
      taskMessage.length > 0,
    );
    return {history, available, tools, offerTools, instructions};
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
    const guidance = names.length
      ? explorationGuidance(names, {steps: budget.maxSteps, calls: budget.maxToolCalls})
      : '';

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
    const {host, turn} = this;
    const result: SampleResult = {
      text: '',
      textBytes: 0,
      reasoned: false,
      reasoningBytes: 0,
      calls: [],
      preempted: false,
      acted: false,
    };
    const flights: InFlight[] = [];
    const usageBefore = this.receipt.usage; // totals of earlier requests
    let drained = false;
    const stepId = crypto.randomUUID();
    // Preemption requests another model call, so it is off once a budget or the context window has
    // stopped tool use: then steering waits (deferred) instead of bypassing the stop.
    const preemptable = turn.steerable && !this.stop;
    // Aborting the request closes only the model stream; dispatched tools keep the turn signal.
    const requestAbort = new AbortController();

    try {
      try {
        this.record({type: 'model.requested', stepId, protocol: 2});
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
            },
            AbortSignal.any([this.signal, requestAbort.signal]),
            host.model.inlineTools && host.tools ? this.inlineToolHandler(prepared, result) : undefined,
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
        // Unfinished text of a response that did not complete is not history (Codex discards items
        // that never reached OutputItemDone); its completed calls and their results are.
        const committed = result.terminal && result.terminal.finishReason !== 'length';
        this.steps.push(
          {role: 'assistant', content: committed ? result.text : '', toolCalls: result.calls},
          ...result.calls.map((call, index) => toolMessage(call, results[index]!)),
        );
        if (failure && !result.streamError) result.streamError = failure;
        const newEvidence = results.some(r => r.status === 'ok' && !r.content.startsWith('[unchanged]'));
        this.stagnant = newEvidence ? 0 : this.stagnant + 1;
      }
    } finally {
      // An abandoned iterator must not leave tools running after the turn is finalized.
      if (flights.length && !drained) {
        this.turnAbort.abort();
        await Promise.all(flights.map(flight => flight.settled));
      }
    }
    return result;
  }

  /** The bridge runtime owns its loop and asks Futryn to run each tool inline, through the same path. */
  private inlineToolHandler(prepared: PreparedRequest, result: SampleResult) {
    const inlineLimit =
      this.budget.maxToolCalls !== undefined
        ? Math.min(SAFETY_LIMITS.bridgeCallsPerTurn, this.budget.maxToolCalls + SAFETY_LIMITS.bridgeRefusalGrace)
        : SAFETY_LIMITS.bridgeCallsPerTurn;
    return async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolResult> => {
      const {tools, signal} = this;
      result.acted = true;
      if (!prepared.available.some(d => d.name === call.name) || tools.inlineIds.has(call.id))
        throw new FutrynError('POLICY');
      // A runaway bridge loop is ended by a named internal safety limit.
      if (tools.inlineIds.size >= inlineLimit) {
        this.stop = 'safety_limit';
        throw new FutrynError('POLICY');
      }
      tools.inlineIds.add(call.id);
      tools.recordCall(call);
      if (signal.aborted) throw new FutrynError('CANCELLED');
      const toolResult = await tools.run(call, toolSignal ?? signal);
      if (signal.aborted) throw new FutrynError('CANCELLED');
      this.steps.push({role: 'assistant', content: '', toolCalls: [call]}, toolMessage(call, toolResult));
      return toolResult;
    };
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
    const inline = !!host.model.inlineTools;
    if (this.signal.aborted) throw new FutrynError('CANCELLED');
    // toolOutputDelta is Futryn's own event: a provider stream cannot fabricate it.
    if (event.type === 'toolOutputDelta') throw new FutrynError('PROTOCOL');
    if (result.terminal) throw new FutrynError('PROTOCOL');
    if (event.type === 'textDelta' || event.type === 'toolCallComplete') this.rejectionCandidate = false;
    if (event.type === 'toolResult' || event.type === 'activity') result.acted = true;

    if (event.type === 'textDelta') {
      result.text += event.text;
      result.textBytes += Buffer.byteLength(event.text);
      this.record({type: 'assistant.text', text: event.text});
      if (result.textBytes > SAFETY_LIMITS.textBytesPerResponse) throw new FutrynError('PROTOCOL');
    }
    if (event.type === 'reasoningDelta') {
      result.reasoned = true;
      result.reasoningBytes += Buffer.byteLength(event.text);
      if (result.reasoningBytes > SAFETY_LIMITS.textBytesPerResponse) {
        this.stop = 'safety_limit';
        throw new FutrynError('PROTOCOL');
      }
    }
    if (event.type === 'usage' || event.type === 'completed') {
      receipt.usage = combine(usageBefore, event.usage);
      this.lastInput = event.usage.inputTokens;
      this.lastOutput = event.usage.outputTokens;
    }
    if (event.type === 'context') receipt.context = event.context;
    if (event.type === 'usage' || event.type === 'context') host.store.observeTurn?.(host.id, this.revision!, receipt);

    if (event.type === 'toolCallComplete') {
      // A complete call (adapters emit it only once its arguments parsed) is dispatched now, while
      // the rest of the response streams. Incomplete argument deltas never reach here.
      if (!prepared.offerTools) throw new FutrynError('UNSUPPORTED');
      const tooMany = result.calls.length >= SAFETY_LIMITS.callsPerResponse;
      const repeated =
        result.calls.some(c => c.id === event.call.id) || (!inline && tools.journalCalls.has(event.call.id));
      if (tooMany || repeated) throw new FutrynError('PROTOCOL');
      tools.recordCall(event.call);
      if (!inline) {
        result.calls.push(event.call);
        flights.push(tools.dispatch(event.call));
      }
    }
    // A runtime may only report results of calls Futryn itself ran inline, unchanged.
    if (
      event.type === 'toolResult' &&
      (!inline || stable(tools.outcomes.get(event.result.callId)) !== stable(event.result))
    ) {
      throw new FutrynError('PROTOCOL');
    }

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
   * discarded visibly, never committed; completed tools keep their results and never re-run. A
   * bridge runtime that already acted owns side effects Futryn cannot reconcile: no retry.
   */
  private async *prepareRetry(sample: SampleResult, attempt: number): AsyncGenerator<ModelEvent> {
    const error = sample.streamError;
    if (this.signal.aborted) throw new FutrynError('CANCELLED');
    const retryable =
      error instanceof FutrynError && error.retryable && !sample.acted && attempt < SAFETY_LIMITS.roundRetries;
    if (!retryable || !(error instanceof FutrynError)) throw error;
    if (sample.text || sample.reasoned) yield {type: 'responseDiscarded', reason: 'retry', attempt: attempt + 1};
    const sleep = this.host.options.sleep ?? defaultSleep;
    await sleep(Math.min(10000, Math.max(error.retryAfterMs ?? 0, 250 * 2 ** attempt)), this.signal);
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
      if (sample.text) steps.push({role: 'assistant', content: sample.text});
      return {kind: 'follow-up'};
    }
    if (!sample.text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(terminal.finishReason)) {
      throw new FutrynError('PROTOCOL');
    }

    // Codex: needs_follow_up = model_needs_follow_up || has_pending_input. Accepted steering that
    // arrived during this response continues the same turn instead of starting an unrelated one.
    if (this.turn.pending.length && !stop) {
      steps.push({role: 'assistant', content: sample.text});
      return {kind: 'follow-up'};
    }

    // Evidence-based artifact check, like a Codex Stop hook that blocks once: an unverified requested
    // artifact gets one continuation with an explicit prompt. It never turns an answer into a
    // failure, and a denied or blocked mutation is reported by the model, not retried.
    const toolNames = host.tools?.descriptors().map(d => d.name) ?? [];
    const needsArtifact = !!task && !host.options.analysisOnly?.() && artifactWork(task, toolNames);
    const verified = !!task?.artifactTargets.every(path =>
      task.verifiedActions.some(a => a.status === 'verified:' + path),
    );
    const blocked = task?.failures.some(f => f.includes('denied')) || this.tools.writeDenied;
    if (needsArtifact && !verified && !stop && !blocked && this.corrections++ < 1) {
      steps.push({role: 'assistant', content: sample.text});
      this.progressNotice = artifactNotice(task!.artifactTargets);
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
    const answer: Message = {role: 'assistant', content: sample.text};
    store.complete(host.id, this.revision!, answer, receipt, this.steps);
    this.completed = true;
    state.messages.push(...this.carried, this.user, ...this.steps, answer);

    if (deferred.length) yield {type: 'inputDeferred', steerIds: deferred, reason: stop ?? 'completed'};
    yield {...terminal, usage: receipt.usage ?? terminal.usage};
  }

  private finalTaskState(next: {needsArtifact: boolean; verified: boolean}): 'verified' | 'unfinished' {
    const task = this.host.state.task!;
    if (next.needsArtifact) return next.verified ? 'verified' : 'unfinished';
    const openWork = task.failures.length > 0 || task.pending.some(p => p.startsWith('Collect command session '));
    return openWork ? 'unfinished' : 'verified';
  }

  // -------------------------------------------------------------------------------------------
  // Failure and cleanup

  /** Journal a failed or cancelled turn and return the error the caller should see. */
  private failure(error: unknown): unknown {
    const {host, receipt, signal} = this;
    const {state, store} = host;
    this.turn.accepting = false;
    this.deferPending();
    const cancelled = signal.aborted || (error instanceof FutrynError && error.code === 'CANCELLED');

    if (this.revision !== undefined && !this.completed) {
      receipt.outcome = cancelled ? 'cancelled' : 'failed';
      receipt.stopReason = cancelled ? 'cancelled' : this.failureStopReason();
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
    const toolsRejected =
      this.rejectionCandidate && !signal.aborted && error instanceof FutrynError && error.code === 'INVALID_INPUT';
    if (toolsRejected && host.onToolsRejected) {
      host.onToolsRejected();
      return new FutrynError('UNSUPPORTED');
    }
    // A cancelled turn reports cancellation, not whichever provider error raced with it.
    if (signal.aborted) return new FutrynError('CANCELLED');
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
