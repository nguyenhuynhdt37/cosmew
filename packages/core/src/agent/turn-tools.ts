import {
  type Attachment,
  FutrynError,
  toolResultSchema,
  type ExecutionEventData,
  type Message,
  type ModelEvent,
  type ToolCall,
  type ToolPort,
  type ToolResult,
  type TurnBudget,
  type TurnStopReason,
} from '@futryn/contracts';
import type {ProgressQueue} from './progress-queue';
import {ExecutionGate} from './tool-runtime';

const UNCHANGED =
  '[unchanged] This call returned exactly the same content as the identical call earlier in this turn. The content is not repeated; use the earlier result.';

const budgetRefusal = (limit: number) =>
  `[tool budget] The tool-call budget of ${limit} set for this turn is reached, so this call was not run. Answer from the evidence gathered and say what is still missing.`;

/** One dispatched call: `settled` never rejects; a cancellation or failure travels in `error`. */
export interface InFlight {
  call: ToolCall;
  settled: Promise<{result: ToolResult; error?: unknown}>;
}

/** JSON with sorted keys, so two equal inputs never look different. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(key => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key]));
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The history message that answers a tool call. */
export function toolMessage(call: ToolCall, result: ToolResult): Message {
  const content =
    result.status === 'ok'
      ? result.content || '(empty)'
      : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`;
  return {
    role: 'tool',
    content: result.skillDirectory ? `Skill directory: ${result.skillDirectory}\n\n${content}` : content,
    toolCallId: call.id,
    toolName: call.name,
    ...(result.status === 'ok' && result.attachments?.length ? {attachments: result.attachments} : {}),
  };
}

/** A result without its media: what the journal and the UI receive (ADR 0041). */
export function withoutAttachments(result: ToolResult): ToolResult {
  if (!result.attachments) return result;
  const {attachments: _attachments, ...rest} = result;
  return rest;
}

export interface TurnToolsOptions {
  port?: ToolPort;
  budget: TurnBudget;
  /** The turn's signal: cancels queued and running calls. */
  signal: AbortSignal;
  progress: ProgressQueue;
  parallelSlots: number;
  /** Append to the execution journal; returns the event's sequence number. */
  record(event: ExecutionEventData): number;
  /** A time, token or cost budget that is used up, if any. */
  workExhausted(): TurnStopReason | undefined;
  /** Persist a result's media apart from the journal (ADR 0041). */
  saveAttachments?(callId: string, attachments: Attachment[]): void;
  /** Called after each result is journaled (task progress tracking). */
  onSettled(call: ToolCall, result: ToolResult, sequence: number): void;
}

/**
 * Tool execution for one turn (Codex `ToolCallRuntime`). Every call goes through `run`: the user
 * budget, the injected ToolPort (permission engine), journaling and the reread check.
 */
export class TurnTools {
  /** Calls actually dispatched this turn; refused over-budget calls are not counted. */
  executed = 0;
  /** A write was denied this turn: further writes are refused without asking again. */
  writeDenied = false;
  readonly outcomes = new Map<string, ToolResult>();
  /** Call ids already written to the journal. */
  readonly journalCalls = new Set<string>();
  /** Write calls that may have changed files; an interrupted turn keeps them in history. */
  readonly appliedSteps: Message[] = [];
  /** Successful read results by tool + arguments, to spot rereads of unchanged content. */
  private readonly seen = new Map<string, string>();
  private readonly gate: ExecutionGate;

  constructor(private readonly options: TurnToolsOptions) {
    this.gate = new ExecutionGate(options.parallelSlots);
  }

  descriptor(call: ToolCall) {
    return this.options.port?.descriptors().find(d => d.name === call.name);
  }

  recordCall(call: ToolCall): void {
    if (this.journalCalls.has(call.id)) return;
    this.options.record({type: 'tool.call', call});
    this.journalCalls.add(call.id);
  }

  async run(call: ToolCall, toolSignal?: AbortSignal): Promise<ToolResult> {
    this.recordCall(call);
    const refusal = this.refusal(call);
    if (refusal) {
      this.settle(call, refusal);
      return refusal;
    }

    this.executed++;
    const capability = this.descriptor(call)?.capability;
    const started = Date.now();
    this.options.record({
      type: 'tool.intent',
      callId: call.id,
      executionId: crypto.randomUUID(),
      capability: capability ?? 'unknown',
    });

    let result: ToolResult;
    try {
      const output = await this.options.port!.invoke(
        call,
        toolSignal,
        chunk => this.options.progress.publish(call, chunk),
        event => this.options.progress.publishSubagent(event),
      );
      result = toolResultSchema.parse(output);
      if (result.callId !== call.id || result.name !== call.name) throw new FutrynError('PROTOCOL');
    } catch (error) {
      // Codex answers an aborted call "aborted by user after Xs". Futryn cannot prove that an
      // interrupted call had no effect, so the outcome stays explicitly unknown.
      const seconds = Math.max(0.1, (Date.now() - started) / 1000).toFixed(1);
      const unknown = this.errorResult(
        call,
        'EXECUTION_UNKNOWN',
        `Execution was interrupted after ${seconds}s without a confirmed outcome. Inspect current state before another mutation; do not replay this call or restore its approval.`,
      );
      try {
        this.settle(call, unknown);
      } catch {
        /* The journal finish still marks the turn interrupted. */
      }
      throw error;
    }

    if (capability === 'fs.write' && result.status !== 'denied') {
      this.appliedSteps.push({role: 'assistant', content: '', toolCalls: [call]}, toolMessage(call, result));
    }
    if (result.status === 'ok' && capability === 'fs.read') result = this.markUnchanged(call, result);
    if (capability === 'fs.write' && result.status === 'denied') this.writeDenied = true;
    this.settle(call, result);
    return result;
  }

  /** Codex `ToolCallRuntime::handle_tool_call`: wait for the shared/exclusive slot, then run the call. */
  dispatch(call: ToolCall): InFlight {
    const {signal} = this.options;
    const settled = (async () => {
      let release: (() => void) | undefined;
      try {
        release = await this.gate.acquire(this.descriptor(call)?.parallel !== true, signal);
      } catch {
        /* cancelled while queued */
      }
      if (!release || signal.aborted) {
        release?.();
        // Codex aborted_before_dispatch: nothing ran, so this outcome is confirmed, not unknown.
        const aborted = this.errorResult(
          call,
          'CANCELLED',
          'aborted before dispatch: the turn was cancelled before this call started. Nothing was run.',
        );
        try {
          this.settle(call, aborted);
        } catch {
          /* recovery reports the call as not executed */
        }
        return {result: aborted, error: new FutrynError('CANCELLED')};
      }
      try {
        return {result: await this.run(call, signal)};
      } catch (error) {
        const result =
          this.outcomes.get(call.id) ??
          this.errorResult(call, 'EXECUTION_UNKNOWN', 'Execution was interrupted without a confirmed outcome.');
        return {result, error};
      } finally {
        release();
      }
    })();
    return {call, settled};
  }

  /** Codex `drain_in_flight`: results in model-output order, with live command output in between. */
  async *drain(flights: InFlight[]): AsyncGenerator<ModelEvent, {results: ToolResult[]; failure?: unknown}> {
    const {progress} = this.options;
    const results: ToolResult[] = [];
    let failure: unknown;
    for (const flight of flights) {
      let outcome: {result: ToolResult; error?: unknown} | undefined;
      void flight.settled.then(value => {
        outcome = value;
        progress.wake();
      });
      while (!outcome || progress.size) {
        if (progress.size) {
          yield progress.take();
          continue;
        }
        await progress.ready();
      }
      results.push(outcome.result);
      failure ??= outcome.error;
      yield {type: 'toolResult', result: withoutAttachments(outcome.result)};
    }
    return {results, failure};
  }

  /** A reason not to run this call at all: a used-up budget or an earlier denied write. */
  private refusal(call: ToolCall): ToolResult | undefined {
    const {budget} = this.options;
    if (budget.maxToolCalls !== undefined && this.executed >= budget.maxToolCalls) {
      return this.errorResult(call, 'TOOL_BUDGET', budgetRefusal(budget.maxToolCalls));
    }
    // Codex tool_start_denial: a work budget used up while the call waited for its slot refuses it.
    const spent = this.options.workExhausted();
    if (spent) {
      return this.errorResult(
        call,
        'TOOL_BUDGET',
        `[budget] The ${spent.replace('budget_', '')} budget set for this turn is used up, so this call was not run.`,
      );
    }
    if (this.writeDenied && this.descriptor(call)?.capability === 'fs.write') {
      return {
        callId: call.id,
        name: call.name,
        status: 'denied',
        code: 'DENIED',
        content: 'A write was denied in this turn. No mutation was retried; wait for a new user instruction.',
      };
    }
    return undefined;
  }

  /** An identical reread returns a short notice instead of the same content again. */
  private markUnchanged(call: ToolCall, result: ToolResult): ToolResult {
    const key = call.name + '\0' + stable(call.input);
    // Attachments are part of what was read: a changed image with the same summary is not unchanged.
    const seen = result.content + (result.attachments ? '\0' + stable(result.attachments) : '');
    if (this.seen.get(key) === seen) {
      const {attachments: _attachments, ...rest} = result;
      return {...rest, content: UNCHANGED};
    }
    this.seen.set(key, seen);
    return result;
  }

  private settle(call: ToolCall, result: ToolResult): void {
    this.outcomes.set(call.id, result);
    // Media is stored apart from the journal, bounded by the store (ADR 0041).
    if (result.attachments?.length) this.options.saveAttachments?.(call.id, result.attachments);
    const sequence = this.options.record({type: 'tool.result', result: withoutAttachments(result)});
    this.options.onSettled(call, result, sequence);
  }

  private errorResult(call: ToolCall, code: string, content: string): ToolResult {
    return {callId: call.id, name: call.name, status: 'error', code, content};
  }
}
