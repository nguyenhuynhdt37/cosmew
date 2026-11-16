import { FutrynError, messageSchema, type ConversationStore, type ProjectContextPort, type Message, type ModelEvent, type ModelPort, type Selection, type ToolCall, type ToolPort, type ToolResult, type TurnBudget, type TurnReceipt, type TurnStopReason, type Usage, toolResultSchema } from '@futryn/contracts';
import { budgetExhaustedNotice, explorationGuidance } from './guidance';
import { normalizeHistory, estimateContextTokens, truncateToolResults } from '../context/builder';
import { compactHistory, useContextSnapshot, type ContextCompactor } from '../context/compaction';
import { taskForRequest, observeResult, artifactWork, recoveryContext } from './progress';
import { ExecutionGate } from './tool-runtime';
import type { ActiveTaskCheckpoint, ContextSnapshot, ExecutionEventData, SteerOutcome } from '@futryn/contracts';

/**
 * Internal safety limits (ADR 0030). They are not work budgets: a normal turn never reaches them, and
 * each one ends the turn with a named stop reason or error instead of a silent stop. There is no
 * default per-turn round or tool-call ceiling; the loop runs until the model stops asking for tools,
 * a user-configured budget runs out, or the context window is full.
 */
export const SAFETY_LIMITS = {
  /** Tool calls the model may request in one response (provider wire bound). */
  callsPerResponse: 32,
  /** Visible text bytes per model response. */
  textBytesPerResponse: 262144,
  /** Tool calls a bridge runtime that owns its own loop (Codex app-server) may make in one turn. */
  bridgeCallsPerTurn: 256,
  /** Refused attempts allowed past a user tool-call budget before a bridge turn fails closed. */
  bridgeRefusalGrace: 4,
  /** Retries of a model request whose stream failed (Codex: bounded stream retries). */
  roundRetries: 2,
  /** Context window assumed when the model does not report one (conservative). */
  unknownContextTokens: 128000,
  /** Fraction of the usable window after which tools are withdrawn for a final answer. */
  contextReserve: 0.85,
  /** Parallel-declared calls holding the shared execution slot at once (ADR 0033). Others run exclusively. */
  parallelTools: 4,
} as const;

/** Conservative token estimate when exact tokenization is unavailable (about 3 characters per token). */
export const estimateTokens = estimateContextTokens;

export interface ConversationOptions {
  /** Optional user work budget, read at the start of every turn. */
  budget?: () => TurnBudget | undefined;
  /** Model context window in tokens, when known. */
  contextLimit?: () => number | null | undefined;
  outputLimit?: () => number | null | undefined;
  compactor?: ContextCompactor;
  /** Explicit analysis modes cannot be converted into mutating artifact recovery. */
  analysisOnly?: () => boolean;
  /** Injected wait used for retry backoff (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The single owner of a running turn. Steering is accepted only while `accepting` is true. */
interface ActiveTurn { id: string; accepting: boolean; steerable: boolean; pending: { steerId: string; message: Message }[]; wake?: () => void }
/** One dispatched call: `settled` never rejects; a cancellation or failure travels in `error`. */
interface InFlight { call: ToolCall; settled: Promise<{ result: ToolResult; error?: unknown }> }

const UNCHANGED = '[unchanged] This call returned exactly the same content as the identical call earlier in this turn. The content is not repeated; use the earlier result.';
const budgetRefusal = (limit: number) => `[tool budget] The tool-call budget of ${limit} set for this turn is reached, so this call was not run. Answer from the evidence gathered and say what is still missing.`;
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if(signal?.aborted){reject(new FutrynError('CANCELLED'));return;}
  const abort=()=>{clearTimeout(timer);reject(new FutrynError('CANCELLED'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  signal?.addEventListener('abort',abort,{once:true});
});

/** Key order must not make two equal inputs look different. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k])).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const toolMessage = (call: ToolCall, result: ToolResult): Message => ({ role: 'tool', content: result.status === 'ok' ? result.content || '(empty)' : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`, toolCallId: call.id, toolName: call.name });

const add = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a + b);

/** Usage of a multi-round turn: token counts and cost add up; quota/pricing come from the latest round. */
function combine(previous: Usage | null, next: Usage): Usage {
  if (!previous) return next;
  return { ...next, inputTokens: add(previous.inputTokens, next.inputTokens), outputTokens: add(previous.outputTokens, next.outputTokens), costUSD: add(previous.costUSD, next.costUSD) };
}

/**
 * Conversation runtime. Tools run only through the injected ToolPort; no provider SDK enters core.
 *
 * Lifecycle ownership follows Codex (ADR 0033): `send` is the task (it owns one active turn, accepts
 * steering for it and decides completion); each loop iteration is one model request (Codex
 * `run_sampling_request`), whose complete tool calls are dispatched while the response still streams
 * (Codex `try_run_sampling_request` + `ToolCallRuntime`) and drained in model-output order.
 */
export class Conversation {
  readonly id: string;
  private messages: Message[] = [];
  private running = false;
  private active?: ActiveTurn;
  /**
   * Session-owned input queue (Codex keeps pending input when a task finishes): steering a finished
   * turn accepted but never delivered. It is durable in the journal and opens the next turn.
   */
  private pendingInput: { steerId: string; message: Message }[] = [];
  private task?: ActiveTaskCheckpoint;
  private snapshot?: ContextSnapshot;
  constructor(
    private readonly selection: Selection,
    private readonly model: ModelPort,
    private readonly store: ConversationStore,
    existing?: { id: string; messages: Message[] },
    private readonly tools?: ToolPort,
    /** Called when the provider rejects the tool definitions themselves (ADR 0017). */
    private readonly onToolsRejected?: () => void,
    private readonly projectContext?: ProjectContextPort,
    private readonly options: ConversationOptions = {},
  ) {
    if (existing) {
      this.id = existing.id;
      const recovery=store.recover?.(existing.id);
      this.messages = normalizeHistory((recovery?.messages.length?recovery.messages:existing.messages).map(m => messageSchema.parse(m)));
      this.task=recovery?.task;this.snapshot=recovery?.compaction;this.pendingInput=recovery?.pendingInput??[];
    } else {
      this.id = store.create(selection);
    }
  }
  history(): readonly Message[] { return this.messages.map(m => ({ ...m })); }
  /** Accepted instructions that no turn processed yet; the next `send` delivers them first. */
  queuedInput(): readonly { steerId: string; content: string }[] { return this.pendingInput.map(p => ({ steerId: p.steerId, content: p.message.content })); }
  /** Identity of the turn that currently accepts steering, if any. */
  activeTurnId(): string | undefined { return this.active?.accepting ? this.active.id : undefined; }

  /**
   * Codex `Session::steer_input`: queue user input against the active regular turn. The input is
   * journaled before acceptance is reported, and becomes model-visible before the next model request.
   * Runtime-owned loops (inline bridge tools) are not steerable, and steering never changes policy.
   */
  steer(content: string, expectedTurnId?: string): SteerOutcome {
    const turn = this.active;
    if (!turn?.accepting) return { accepted: false, reason: 'no_active_turn' };
    if (expectedTurnId !== undefined && expectedTurnId !== turn.id) return { accepted: false, reason: 'turn_mismatch' };
    if (!turn.steerable || !this.store.recordExecution) return { accepted: false, reason: 'not_steerable' };
    let message: Message;
    try { message = messageSchema.parse({ role: 'user', content: content.trim() }); } catch { return { accepted: false, reason: 'empty_input' }; }
    const steerId = crypto.randomUUID();
    this.store.recordExecution(this.id, turn.id, { type: 'user.steered', steerId, message });
    turn.pending.push({ steerId, message });
    turn.wake?.(); // Codex watch_user_input: arriving input preempts the response being sampled.
    return { accepted: true, turnId: turn.id, steerId };
  }

  async *send(content: string, signal?: AbortSignal, maxOutputTokens = 4096, maxEstimatedCostUSD?: number, reasoningEffort?: string): AsyncIterable<ModelEvent> {
    if (this.running) throw new FutrynError('POLICY');
    let user: Message;
    try { user = messageSchema.parse({ role: 'user', content }); } catch { throw new FutrynError('INVALID_INPUT'); }
    const turnAbort=new AbortController();signal=signal?AbortSignal.any([signal,turnAbort.signal]):turnAbort.signal;
    const budget: TurnBudget = this.options.budget?.() ?? {};
    const sleep = this.options.sleep ?? defaultSleep;
    const startedAt = Date.now();
    const receipt: TurnReceipt = { requestId: crypto.randomUUID(), accountId: this.selection.accountId, modelId: this.selection.modelId, startedAt: new Date(startedAt).toISOString(), finishedAt: null, outcome: 'pending', usage: null, context: null };
    const turn: ActiveTurn = { id: receipt.requestId, accepting: false, steerable: !this.model.inlineTools, pending: [] };
    let carried: Message[] = [];
    /** Hands accepted-but-undelivered steering to the session queue with an explicit, visible disposition. */
    const defer=()=>{const left=turn.pending.splice(0);this.pendingInput.push(...left);return left.map(item=>item.steerId);};
    this.running = true; let revision: number | undefined; let completed = false; let settled=false;
    let stagnant=0, corrections=0;
    let progressNotice='';
    let recoveryNeeded=false;
    const record=(event:ExecutionEventData)=>this.store.recordExecution?.(this.id,receipt.requestId,event)??0;
    const journalCalls=new Set<string>();
    const progress:ModelEvent[]=[];let wakeProgress:(()=>void)|undefined;let queuedBytes=0;
    const publishOutput=(call:ToolCall,chunk:import('@futryn/contracts').CommandOutputChunk)=>{if(queuedBytes+Buffer.byteLength(chunk.text)>64000||progress.length>=128)return;progress.push({type:'toolOutputDelta',callId:call.id,name:call.name,...chunk});queuedBytes+=Buffer.byteLength(chunk.text);wakeProgress?.();};
    const takeProgress=():ModelEvent=>{const next=progress.shift()!;if(next.type==='toolOutputDelta')queuedBytes-=Buffer.byteLength(next.text);return next;};
    const progressReady=()=>new Promise<undefined>(resolve=>{wakeProgress=()=>resolve(undefined);if(progress.length)resolve(undefined);});
    const recordCall=(call:ToolCall)=>{if(!journalCalls.has(call.id)){record({type:'tool.call',call});journalCalls.add(call.id);}};
    /** Tool rounds of this turn: assistant tool-call messages, their tool results and delivered steering. */
    const steps: Message[] = [];
    const appliedSteps: Message[] = [];
    /** True while round 0 offered tools and nothing has come back yet. */
    let rejectionCandidate = false;
    const inlineIds = new Set<string>();
    const outcomes=new Map<string,ToolResult>();
    let writeDenied=false;
    /** Calls actually dispatched this turn; refused over-budget calls are not counted. */
    let executed = 0;
    /** Why tools were withdrawn for a final answer (a budget or the context window), once set. */
    let stop: TurnStopReason | undefined;
    /** Provider-measured tokens of the previous round: its input plus its output form the next prefix. */
    let lastInput: number | null | undefined; let lastOutput: number | null | undefined;
    /** Successful results of this turn by tool + arguments, to spot rereads of unchanged content. */
    const seen = new Map<string, string>();
    const descriptor = (call: ToolCall) => this.tools?.descriptors().find(d => d.name === call.name);
    const capability = (call: ToolCall) => descriptor(call)?.capability;
    const settle=(call:ToolCall,result:ToolResult)=>{outcomes.set(call.id,result);const sequence=record({type:'tool.result',result});if(this.task){observeResult(this.task,call,result,sequence);this.store.saveTask?.(this.id,this.task);}};
    /** Every call goes through here: user budget, the injected ToolPort (permission engine), reread check. */
    const run = async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolResult> => {
      recordCall(call);
      if (budget.maxToolCalls !== undefined && executed >= budget.maxToolCalls) {
        const refused:ToolResult={callId:call.id,name:call.name,status:'error',code:'TOOL_BUDGET',content:budgetRefusal(budget.maxToolCalls)};settle(call,refused);return refused;
      }
      // Codex tool_start_denial: a work budget used up while the call waited for its slot refuses it.
      const spent=exhaustedWork();
      if(spent){const refused:ToolResult={callId:call.id,name:call.name,status:'error',code:'TOOL_BUDGET',content:`[budget] The ${spent.replace('budget_','')} budget set for this turn is used up, so this call was not run.`};settle(call,refused);return refused;}
      if(writeDenied&&capability(call)==='fs.write'){
        const refused:ToolResult={callId:call.id,name:call.name,status:'denied',code:'DENIED',content:'A write was denied in this turn. No mutation was retried; wait for a new user instruction.'};settle(call,refused);return refused;
      }
      executed++;
      const kind = capability(call);
      const started = Date.now();
      record({type:'tool.intent',callId:call.id,executionId:crypto.randomUUID(),capability:kind??'unknown'});
      let result:ToolResult;
      try { result=toolResultSchema.parse(await this.tools!.invoke(call, toolSignal,chunk=>publishOutput(call,chunk)));if(result.callId!==call.id||result.name!==call.name)throw new FutrynError('PROTOCOL'); }
      catch(error){
        // Codex parallel.rs answers an aborted call "aborted by user after Xs". Futryn cannot prove
        // that an interrupted call had no effect, so the outcome stays explicitly unknown.
        const seconds=Math.max(0.1,(Date.now()-started)/1000).toFixed(1);
        const unknown:ToolResult={callId:call.id,name:call.name,status:'error',code:'EXECUTION_UNKNOWN',content:`Execution was interrupted after ${seconds}s without a confirmed outcome. Inspect current state before another mutation; do not replay this call or restore its approval.`};
        try{settle(call,unknown);}catch{/* The journal finish below still marks the turn interrupted. */}
        throw error;
      }
      if (kind === 'fs.write' && result.status !== 'denied') appliedSteps.push({ role: 'assistant', content: '', toolCalls: [call] }, toolMessage(call, result));
      if(result.status==='ok'&&kind==='fs.read'){
        const key=call.name+'\0'+stable(call.input);
        if(seen.get(key)===result.content)result={...result,content:UNCHANGED};
        else seen.set(key,result.content);
      }
      if(kind==='fs.write'&&result.status==='denied')writeDenied=true;
      settle(call,result);
      return result;
    };
    /** Codex ToolCallRuntime::handle_tool_call: wait for the shared/exclusive slot, then run the call. */
    const gate = new ExecutionGate(SAFETY_LIMITS.parallelTools);
    const dispatch = (call: ToolCall): InFlight => ({ call, settled: (async () => {
      let release: (() => void) | undefined;
      try { release = await gate.acquire(descriptor(call)?.parallel !== true, signal); } catch { /* cancelled while queued */ }
      if (!release || signal!.aborted) {
        release?.();
        // Codex aborted_before_dispatch: nothing ran, so this outcome is confirmed, not unknown.
        const aborted: ToolResult = { callId: call.id, name: call.name, status: 'error', code: 'CANCELLED', content: 'aborted before dispatch: the turn was cancelled before this call started. Nothing was run.' };
        try { settle(call, aborted); } catch { /* recovery reports the call as not executed */ }
        return { result: aborted, error: new FutrynError('CANCELLED') };
      }
      try { return { result: await run(call, signal) }; }
      catch (error) { return { result: outcomes.get(call.id) ?? { callId: call.id, name: call.name, status: 'error', code: 'EXECUTION_UNKNOWN', content: 'Execution was interrupted without a confirmed outcome.' }, error }; }
      finally { release(); }
    })() });
    /** Codex drain_in_flight: results in model-output order, with live command output in between. */
    const drain = async function* (flights: InFlight[]): AsyncGenerator<ModelEvent, { results: ToolResult[]; failure?: unknown }> {
      const results: ToolResult[] = []; let failure: unknown;
      for (const flight of flights) {
        let outcome: { result: ToolResult; error?: unknown } | undefined;
        void flight.settled.then(value => { outcome = value; wakeProgress?.(); });
        while (!outcome || progress.length) {
          if (progress.length) { yield takeProgress(); continue; }
          await progressReady();
        }
        results.push(outcome.result); failure ??= outcome.error;
        yield { type: 'toolResult', result: outcome.result };
      }
      return { results, failure };
    };
    /** A user budget that is used up, checked before each model round. */
    const exhausted = (round: number): TurnStopReason | undefined => {
      if (budget.maxSteps !== undefined && round >= budget.maxSteps) return 'budget_steps';
      if (budget.maxToolCalls !== undefined && executed >= budget.maxToolCalls) return 'budget_tool_calls';
      return exhaustedWork();
    };
    function exhaustedWork(): TurnStopReason | undefined {
      const tokens = receipt.usage ? (receipt.usage.inputTokens ?? 0) + (receipt.usage.outputTokens ?? 0) : 0;
      if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) return 'budget_tokens';
      if (budget.maxDurationMs !== undefined && Date.now() - startedAt >= budget.maxDurationMs) return 'budget_time';
      if (budget.maxCostUSD !== undefined && (receipt.usage?.costUSD ?? 0) >= budget.maxCostUSD) return 'budget_cost';
      return undefined;
    }
    const inlineLimit = budget.maxToolCalls !== undefined ? Math.min(SAFETY_LIMITS.bridgeCallsPerTurn, budget.maxToolCalls + SAFETY_LIMITS.bridgeRefusalGrace) : SAFETY_LIMITS.bridgeCallsPerTurn;
    try {
      const recovered=this.store.recover?.(this.id);
      if(recovered?.messages.length)this.messages=normalizeHistory(recovered.messages);
      recoveryNeeded=(recovered?.task??this.task)?.state==='unfinished'||!!recovered?.turns.some(t=>['interrupted','failed','cancelled'].includes(t.state));
      this.task=taskForRequest(content,recovered?.task??this.task);
      this.snapshot=recovered?.compaction??this.snapshot;
      if(recovered)this.pendingInput=recovered.pendingInput??[];
      // Accepted-but-undelivered instructions open this turn, before the new message (Codex records
      // leftover input into history before the next turn). Only a journal can prove they were pending.
      const carry=this.store.beginExecution?this.pendingInput.slice():[];
      revision=this.store.beginExecution?this.store.beginExecution(this.id,user,receipt,carry.map(c=>c.steerId)):this.store.append(this.id,user,'pending',receipt);
      carried=carry.map(c=>c.message);this.pendingInput=this.pendingInput.filter(p=>!carry.includes(p));
      this.store.saveTask?.(this.id,this.task);
      // The turn is durable: from here it is the one active owner and may receive steering.
      this.active=turn;turn.accepting=true;
      signal?.throwIfAborted();
      const context = await this.projectContext?.load(signal);
      signal?.throwIfAborted();
      if (context && (!Number.isSafeInteger(context.budgetBytes) || context.budgetBytes < 0 || context.budgetBytes > 65536 || Buffer.byteLength(context.content) > context.budgetBytes)) throw new FutrynError('BUDGET');
      const projectMessages: Message[] = context?.content ? [messageSchema.parse({role:'user',content:context.content})] : [];
      maxOutputTokens=Math.min(maxOutputTokens,this.options.outputLimit?.()??maxOutputTokens);
      const window = Math.max(1, (this.options.contextLimit?.() ?? SAFETY_LIMITS.unknownContextTokens) - maxOutputTokens);
      // One iteration = one model request. `round` counts completed responses (user step budget);
      // `attempt` counts stream retries of the current one.
      for (let round = 0, attempt = 0, requests = 0; ; requests++) {
        stop ??= exhausted(round);
        // Codex run_turn: pending input is drained into history before every request except the
        // turn's first (whose fresh input is sampled first). Steering is information, not authority.
        if (requests > 0) while (turn.pending.length) {
          const item = turn.pending.shift()!;
          steps.push(item.message);
          if (this.task) { this.task.latestRequest = item.message.content; this.store.saveTask?.(this.id, this.task); }
          yield { type: 'steered', steerId: item.steerId, content: item.message.content };
        }
        const normalized=normalizeHistory(this.messages);
        let visible=useContextSnapshot(normalized,this.snapshot);
        const current=normalizeHistory([...carried,user,...steps]);
        const taskMessage=this.task&&recoveryNeeded&&(this.task.artifactTargets.length>0||this.messages.some(m=>m.role==='assistant'||m.role==='tool'))?[recoveryContext(this.task,this.messages)]:[];
        let history = [...projectMessages,...visible,...taskMessage,...current];
        // Context window (ADR 0030): measured input of the last round or a conservative estimate,
        // whichever is larger. Near the limit the model answers without tools; past it the turn
        // fails honestly. Durable history remains intact; model-visible checkpoints are explicit.
        const tools0 = this.tools && !stop ? this.tools.descriptors().filter(d=>!this.options.analysisOnly?.()||d.capability==='fs.read') : [];
        const guidanceEstimate=(tools0.length||steps.length)?estimateTokens(explorationGuidance(this.tools?.descriptors().map(d=>d.name)??[],{steps:budget.maxSteps,calls:budget.maxToolCalls}))+80:0;
        let estimate = estimateTokens(history) + estimateTokens(tools0) + guidanceEstimate;
        let used = Math.max(estimate, round > 0 ? (lastInput ?? 0) + (lastOutput ?? 0) : 0);
        if(used>=window*0.75&&normalized.filter(m=>m.role==='user').length>=3){
          const allowance=window-estimateTokens([...projectMessages,...taskMessage,...current, ...tools0])-guidanceEstimate;
          const compacted=await compactHistory(normalized,this.task,Math.max(0,allowance),this.options.compactor,signal);
          if(compacted&&compacted.throughRevision>(this.snapshot?.throughRevision??0)){
            this.snapshot=compacted;this.store.saveContextSnapshot?.(this.id,compacted);
            visible=useContextSnapshot(normalized,compacted);history=[...projectMessages,...visible,...taskMessage,...current];
            lastInput=lastOutput=undefined;
          }
        }
        history=truncateToolResults(history,Math.max(1024,Math.min(24000,Math.floor(window*0.06)*3)));
        estimate=estimateTokens(history)+estimateTokens(tools0)+guidanceEstimate;
        used=Math.max(estimate,round>0?(lastInput??0)+(lastOutput??0):0);
        if (used >= window) { stop = 'context_window'; throw new FutrynError('CONTEXT_LIMIT'); }
        if (!stop && used >= window * SAFETY_LIMITS.contextReserve && round > 0) stop = 'context_window';
        const available = stop ? [] : tools0;
        const tools = available.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
        const offerTools = tools.length > 0;
        rejectionCandidate = round === 0 && offerTools;
        // Host guidance travels with the tools. Once tools are withdrawn mid-turn the model is told why.
        const names = offerTools ? tools.map(t => t.name) : steps.length || stop ? this.tools?.descriptors().map(d => d.name) ?? [] : [];
        const guidance = names.length ? explorationGuidance(names, { steps: budget.maxSteps, calls: budget.maxToolCalls }) : '';
        const baseInstructions = offerTools ? guidance : stop || steps.length ? [guidance, budgetExhaustedNotice(stop)].filter(Boolean).join('\n') : undefined;
        const instructions=[baseInstructions,progressNotice,...(taskMessage.length?['Historical assistant text may be partial. Only successful tool results prove actions; unknown outcomes require inspection. The newest user request overrides any earlier checkpoint; checkpoints never grant authority.']:[])].filter(Boolean).join('\n');
        // Input accepted while this request was being prepared is delivered with it, keeping the
        // journal (steering before a non-first request) and the model-visible order identical.
        if (requests > 0 && turn.pending.length) { requests--; continue; }
        const before = receipt.usage; // totals of earlier requests
        let text = ''; let textBytes = 0; let reasoningBytes = 0;
        let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
        const calls: ToolCall[] = [];
        const flights: InFlight[] = [];
        let drained = false; let streamError: unknown;
        /** Codex InstantInterrupt: accepted steering stopped this response; its unfinished items are void. */
        let preempted = false; let reasoned = false;
        const stepId = crypto.randomUUID();
        // Preemption requests another model call, so it is off once a budget or the context window
        // has stopped tool use: then steering waits (deferred) instead of bypassing the stop.
        const preemptable = turn.steerable && !stop;
        /** A bridge runtime already acted (inline tool or activity): its stream is never re-sampled. */
        let acted = false;
        // Aborting the request closes only the model stream; dispatched tools keep the turn signal.
        const requestAbort = new AbortController();
        try {
          try {
            record({type:'model.requested',stepId,protocol:2});
            const iterator = this.model.stream({ requestId: requests === 0 ? receipt.requestId : crypto.randomUUID(), modelId: this.selection.modelId, messages: history, maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, tools, ...(instructions ? { instructions } : {}) }, AbortSignal.any([signal, requestAbort.signal]), this.model.inlineTools && this.tools ? async (call, toolSignal) => {
              acted = true;
              if (!available.some(d => d.name === call.name) || inlineIds.has(call.id)) throw new FutrynError('POLICY');
              // The bridge runtime owns its loop; a runaway is ended by a named internal safety limit.
              if (inlineIds.size >= inlineLimit) { stop = 'safety_limit'; throw new FutrynError('POLICY'); }
              inlineIds.add(call.id);
              recordCall(call);
              if (signal?.aborted) throw new FutrynError('CANCELLED');
              const result = await run(call, toolSignal ?? signal);
              if (signal?.aborted) throw new FutrynError('CANCELLED');
              steps.push({role: 'assistant', content: '', toolCalls: [call]}, toolMessage(call, result));
              return result;
            } : undefined)[Symbol.asyncIterator]();
            let next: Promise<IteratorResult<ModelEvent>> | undefined; let failed = false;
            try {
              for (;;) {
                if (progress.length) { yield takeProgress(); continue; }
                next ??= iterator.next();
                const preempt = preemptable ? new Promise<'preempt'>(resolve => { turn.wake = () => resolve('preempt'); if (turn.pending.length) resolve('preempt'); }) : undefined;
                const step = await Promise.race([next.then(r => ({ r }), (e: unknown) => ({ e })), progressReady(), ...(preempt ? [preempt] : [])]);
                turn.wake = undefined;
                if (step === 'preempt') { preempted = true; break; }
                if (!step) continue;
                next = undefined;
                if ('e' in step) throw step.e;
                if (step.r.done) break;
                const event = step.r.value;
                if (signal?.aborted) throw new FutrynError('CANCELLED');
                if(event.type==='toolOutputDelta')throw new FutrynError('PROTOCOL');
                if (terminal) throw new FutrynError('PROTOCOL');
                if (event.type === 'textDelta' || event.type === 'toolCallComplete') rejectionCandidate = false;
                if (event.type === 'toolResult' || event.type === 'activity') acted = true;
                if (event.type === 'textDelta') {
                  text += event.text; textBytes += Buffer.byteLength(event.text);
                  record({type:'assistant.text',text:event.text});
                  if (textBytes > SAFETY_LIMITS.textBytesPerResponse) throw new FutrynError('PROTOCOL');
                }
                if(event.type==='reasoningDelta'){reasoned=true;reasoningBytes+=Buffer.byteLength(event.text);if(reasoningBytes>SAFETY_LIMITS.textBytesPerResponse){stop='safety_limit';throw new FutrynError('PROTOCOL');}}
                if (event.type === 'usage' || event.type === 'completed') receipt.usage = combine(before, event.usage);
                if (event.type === 'usage' || event.type === 'completed') { lastInput = event.usage.inputTokens; lastOutput = event.usage.outputTokens; }
                if (event.type === 'context') receipt.context = event.context;
                if (event.type === 'usage' || event.type === 'context') this.store.observeTurn?.(this.id, revision, receipt);
                if (event.type === 'toolCallComplete') {
                  // A complete call (adapters emit it only once its arguments parsed) is dispatched now,
                  // while the rest of the response streams. Incomplete argument deltas never reach here.
                  if (!offerTools) throw new FutrynError('UNSUPPORTED');
                  if (calls.length >= SAFETY_LIMITS.callsPerResponse || calls.some(c => c.id === event.call.id) || (!this.model.inlineTools && journalCalls.has(event.call.id))) throw new FutrynError('PROTOCOL');
                  recordCall(event.call);
                  if (!this.model.inlineTools) { calls.push(event.call); flights.push(dispatch(event.call)); }
                }
                if(event.type==='toolResult'&&(!this.model.inlineTools||stable(outcomes.get(event.result.callId))!==stable(event.result)))throw new FutrynError('PROTOCOL');
                if (event.type === 'completed') { terminal = event; record({ type: 'model.completed', stepId }); }
                else yield event.type === 'usage' ? { type: 'usage', usage: receipt.usage! } : event;
              }
            } catch (error) { failed = true; throw error; } finally {
              wakeProgress = undefined; turn.wake = undefined;
              if (next) { requestAbort.abort(); await next.catch(() => undefined); }
              // Same as `for await`: closing errors surface unless the body is already failing.
              if (failed) await iterator.return?.()?.catch(() => undefined); else await iterator.return?.();
            }
          } catch (error) { streamError = error; }
          if (flights.length) {
            // Complete calls are answered and recorded even when the response failed afterwards, so a
            // retry or a later turn sees their real outcome instead of repeating them.
            const { results, failure } = yield* drain(flights); drained = true;
            // Unfinished text of a response that did not complete is not history (Codex discards items
            // that never reached OutputItemDone); its completed calls and their results are.
            steps.push({ role: 'assistant', content: terminal ? text : '', toolCalls: calls }, ...calls.map((call, index) => toolMessage(call, results[index]!)));
            if (failure && !streamError) streamError = failure;
            stagnant=results.some(result=>result.status==='ok'&&!result.content.startsWith('[unchanged]'))?0:stagnant+1;
          }
        } finally {
          // An abandoned iterator must not leave tools running after the turn is finalized.
          if (flights.length && !drained) { turnAbort.abort(); await Promise.all(flights.map(flight => flight.settled)); }
        }
        if (streamError !== undefined) {
          if (signal?.aborted) throw new FutrynError('CANCELLED');
          // Codex run_sampling_request + responses_retry: a retryable stream error re-samples with the
          // history recorded so far. Streamed text stays provisional (no `model.completed`), so it is
          // discarded visibly, never committed; completed tools keep their results and never re-run.
          // A bridge runtime that already acted owns side effects Futryn cannot reconcile: no retry.
          const retryable = streamError instanceof FutrynError && streamError.retryable && !acted && attempt < SAFETY_LIMITS.roundRetries;
          if (!retryable || !(streamError instanceof FutrynError)) throw streamError;
          if (text || reasoned) yield { type: 'responseDiscarded', reason: 'retry', attempt: attempt + 1 };
          await sleep(Math.min(10000, Math.max(streamError.retryAfterMs ?? 0, 250 * 2 ** attempt)), signal);
          attempt++; continue;
        }
        if (preempted) {
          // Codex try_run_sampling_request on preempt: needs_follow_up, pending input drained next.
          if (text || reasoned) yield { type: 'responseDiscarded', reason: 'preempted' };
          attempt = 0; round++; continue;
        }
        if (!terminal) throw new FutrynError('PROTOCOL');
        attempt = 0; round++;
        // Codex is_terminal_sampling_outcome(ResponseIncomplete): output cut by the token limit is not a
        // final answer and is not retried. Completed calls above already have recorded results.
        if (terminal.finishReason === 'length') throw new FutrynError('PROTOCOL');
        if (calls.length) {
          // Codex needs_follow_up: tool output always goes back to the model.
          if(stagnant>=3)progressNotice='Progress correction: recent calls produced only identical reads, refusals or failures. Use existing evidence; choose a different justified step or report the blocker. Never retry a denied mutation.';
          if(stagnant>=6){stop='stalled';throw new FutrynError('STALLED');}
          continue;
        }
        // Codex Completed { end_turn: Some(false) } → needs_follow_up. Only providers that expose such a
        // signal set it (Anthropic pause_turn); absence is never treated as "continue".
        if (terminal.endTurn === false && !stop) { if (text) steps.push({ role: 'assistant', content: text }); continue; }
        if (!text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(terminal.finishReason)) throw new FutrynError('PROTOCOL');
        // Codex: needs_follow_up = model_needs_follow_up || has_pending_input. Accepted steering that
        // arrived during this response continues the same turn instead of starting an unrelated one.
        if (turn.pending.length && !stop) { steps.push({ role: 'assistant', content: text }); continue; }
        // Evidence-based artifact check, run like a Codex Stop hook that blocks once: an unverified
        // requested artifact gets one continuation with an explicit prompt. It never turns an answer
        // into a failure, and a denied or blocked mutation is reported by the model, not retried.
        const needsArtifact=this.task&&!this.options.analysisOnly?.()&&artifactWork(this.task,this.tools?.descriptors().map(d=>d.name)??[]);
        const verified=this.task?.artifactTargets.every(path=>this.task!.verifiedActions.some(a=>a.status==='verified:'+path));
        const blocked=this.task?.failures.some(f=>f.includes('denied'))||writeDenied;
        if(needsArtifact&&!verified&&!stop&&!blocked&&corrections++<1){
          steps.push({role:'assistant',content:text});
          progressNotice='Artifact progress correction: the requested artifact has no complete verification read yet. Partial HTML excerpts do not establish full document structure. For these targets, use read with '+JSON.stringify(this.task!.artifactTargets.map(path=>({path,offset:1,limit:2000})))+'. If output remains truncated, report the verification limit rather than claiming completion. If the user still requests implementation, perform the approved change and verify the target. Do not merely promise it. If blocked, report the precise blocker and stop. Do not retry denied writes.';
          continue;
        }
        // Completion: no follow-up remains. Steering that arrives from now on starts a new turn.
        turn.accepting = false;
        const deferred = defer();
        if(this.task){this.task.state=needsArtifact?(verified?'verified':'unfinished'):(this.task.failures.length||this.task.pending.some(p=>p.startsWith('Collect command session '))?'unfinished':'verified');this.task.pending=this.task.state==='verified'?[]:this.task.pending;this.store.saveTask?.(this.id,this.task);}
        receipt.outcome = 'completed'; receipt.stopReason = stop ?? 'completed'; receipt.finishedAt = new Date().toISOString();
        const answer: Message = { role: 'assistant', content: text };
        this.store.complete(this.id, revision, answer, receipt, steps);
        completed = true; this.messages.push(...carried, user, ...steps, answer);
        if (deferred.length) yield { type: 'inputDeferred', steerIds: deferred, reason: stop ?? 'completed' };
        yield { ...terminal, usage: receipt.usage ?? terminal.usage };
        return;
      }
    } catch (e) {
      turn.accepting = false; defer();
      const cancelled = signal?.aborted || (e instanceof FutrynError && e.code === 'CANCELLED');
      if (revision !== undefined && !completed) {
        receipt.outcome = cancelled ? 'cancelled' : 'failed';
        receipt.stopReason = cancelled ? 'cancelled' : stop === 'context_window' || stop === 'safety_limit' || stop === 'stalled' ? stop : 'failed';
        receipt.finishedAt = new Date().toISOString();
        this.store.interrupt(this.id, revision, receipt, appliedSteps);settled=true;
        if(this.task){this.task.state='unfinished';this.task.failures.push(cancelled?'cancelled':e instanceof FutrynError?e.code:'failed');this.store.saveTask?.(this.id,this.task);}
        if(!this.store.recover)this.messages.push(user,...steps);
      }
      // A 400 before any output, right after offering tools, means the provider refused the tool definitions.
      if (rejectionCandidate && !signal?.aborted && e instanceof FutrynError && e.code === 'INVALID_INPUT' && this.onToolsRejected) {
        this.onToolsRejected();
        throw new FutrynError('UNSUPPORTED');
      }
      // A cancelled turn reports cancellation, not whichever provider error raced with it.
      if (signal?.aborted) throw new FutrynError('CANCELLED');
      if (e instanceof FutrynError) throw e;
      throw new FutrynError('PROTOCOL');
    } finally {
      turn.accepting = false; defer(); if (this.active === turn) this.active = undefined;
      if(!completed)turnAbort.abort();
      try{
        if(revision!==undefined&&!completed&&!settled){receipt.outcome='cancelled';receipt.stopReason='cancelled';receipt.finishedAt=new Date().toISOString();this.store.interrupt(this.id,revision,receipt,appliedSteps);}
        if(revision!==undefined){const recovery=this.store.recover?.(this.id);if(recovery){this.messages=normalizeHistory(recovery.messages);this.pendingInput=recovery.pendingInput??[];}}
      }finally{this.running=false;}
    }
  }
}
