import { FutrynError, messageSchema, type ConversationStore, type ProjectContextPort, type Message, type ModelEvent, type ModelPort, type Selection, type ToolCall, type ToolPort, type ToolResult, type TurnBudget, type TurnReceipt, type TurnStopReason, type Usage, toolResultSchema } from '@futryn/contracts';
import { budgetExhaustedNotice, explorationGuidance } from './guidance';
import { normalizeHistory, estimateContextTokens, truncateToolResults } from '../context/builder';
import { compactHistory, useContextSnapshot, type ContextCompactor } from '../context/compaction';
import { taskForRequest, observeResult, artifactWork, recoveryContext } from './progress';
import type { ActiveTaskCheckpoint, ContextSnapshot, ExecutionEventData } from '@futryn/contracts';

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
  /** Retries of a model round that failed before producing anything (Codex: bounded stream retries). */
  roundRetries: 2,
  /** Context window assumed when the model does not report one (conservative). */
  unknownContextTokens: 128000,
  /** Fraction of the usable window after which tools are withdrawn for a final answer. */
  contextReserve: 0.85,
  /** Read-only calls of one response executed concurrently (writes and commands stay serial). */
  readConcurrency: 4,
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

/** Conversation runtime. Tools run only through the injected ToolPort; no provider SDK enters core. */
export class Conversation {
  readonly id: string;
  private messages: Message[] = [];
  private running = false;
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
      this.task=recovery?.task;this.snapshot=recovery?.compaction;
    } else {
      this.id = store.create(selection);
    }
  }
  history(): readonly Message[] { return this.messages.map(m => ({ ...m })); }
  async *send(content: string, signal?: AbortSignal, maxOutputTokens = 4096, maxEstimatedCostUSD?: number, reasoningEffort?: string): AsyncIterable<ModelEvent> {
    if (this.running) throw new FutrynError('POLICY');
    let user: Message;
    try { user = messageSchema.parse({ role: 'user', content }); } catch { throw new FutrynError('INVALID_INPUT'); }
    const turnAbort=new AbortController();signal=signal?AbortSignal.any([signal,turnAbort.signal]):turnAbort.signal;
    const budget: TurnBudget = this.options.budget?.() ?? {};
    const sleep = this.options.sleep ?? defaultSleep;
    const startedAt = Date.now();
    const receipt: TurnReceipt = { requestId: crypto.randomUUID(), accountId: this.selection.accountId, modelId: this.selection.modelId, startedAt: new Date(startedAt).toISOString(), finishedAt: null, outcome: 'pending', usage: null, context: null };
    this.running = true; let revision: number | undefined; let completed = false; let settled=false;
    let stagnant=0, corrections=0;
    let progressNotice='';
    let recoveryNeeded=false;
    const record=(event:ExecutionEventData)=>this.store.recordExecution?.(this.id,receipt.requestId,event)??0;
    const journalCalls=new Set<string>();
    const progress:ModelEvent[]=[];let wakeProgress:(()=>void)|undefined;let queuedBytes=0;
    const publishOutput=(call:ToolCall,chunk:import('@futryn/contracts').CommandOutputChunk)=>{if(queuedBytes+Buffer.byteLength(chunk.text)>64000||progress.length>=128)return;progress.push({type:'toolOutputDelta',callId:call.id,name:call.name,...chunk});queuedBytes+=Buffer.byteLength(chunk.text);wakeProgress?.();};
    const recordCall=(call:ToolCall)=>{if(!journalCalls.has(call.id)){record({type:'tool.call',call});journalCalls.add(call.id);}};
    /** Tool rounds of this turn: assistant tool-call messages and their tool results. */
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
    const capability = (call: ToolCall) => this.tools?.descriptors().find(d => d.name === call.name)?.capability;
    /** Every call goes through here: user budget, the injected ToolPort (permission engine), reread check. */
    const run = async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolResult> => {
      recordCall(call);
      if (budget.maxToolCalls !== undefined && executed >= budget.maxToolCalls) {
        const refused:ToolResult={callId:call.id,name:call.name,status:'error',code:'TOOL_BUDGET',content:budgetRefusal(budget.maxToolCalls)};record({type:'tool.result',result:refused});outcomes.set(call.id,refused);return refused;
      }
      if(writeDenied&&capability(call)==='fs.write'){
        const refused:ToolResult={callId:call.id,name:call.name,status:'denied',code:'DENIED',content:'A write was denied in this turn. No mutation was retried; wait for a new user instruction.'};record({type:'tool.result',result:refused});outcomes.set(call.id,refused);return refused;
      }
      executed++;
      const kind = capability(call);
      recordCall(call);
      record({type:'tool.intent',callId:call.id,executionId:crypto.randomUUID(),capability:kind??'unknown'});
      let result:ToolResult;
      try { result=toolResultSchema.parse(await this.tools!.invoke(call, toolSignal,chunk=>publishOutput(call,chunk)));if(result.callId!==call.id||result.name!==call.name)throw new FutrynError('PROTOCOL'); }
      catch(error){
        const unknown:ToolResult={callId:call.id,name:call.name,status:'error',code:'EXECUTION_UNKNOWN',content:'Execution was interrupted without a confirmed outcome. Inspect current state before another mutation; do not replay this call or restore its approval.'};
        const sequence=record({type:'tool.result',result:unknown});
        if(this.task){observeResult(this.task,call,unknown,sequence);this.store.saveTask?.(this.id,this.task);}
        throw error;
      }
      if (kind === 'fs.write' && result.status !== 'denied') appliedSteps.push({ role: 'assistant', content: '', toolCalls: [call] }, toolMessage(call, result));
      if(result.status==='ok'&&kind==='fs.read'){
        const key=call.name+'\0'+stable(call.input);
        if(seen.get(key)===result.content)result={...result,content:UNCHANGED};
        else seen.set(key,result.content);
      }
      if(kind==='fs.write'&&result.status==='denied')writeDenied=true;
      outcomes.set(call.id,result);
      const sequence=record({type:'tool.result',result});
      if(this.task){observeResult(this.task,call,result,sequence);this.store.saveTask?.(this.id,this.task);}
      return result;
    };
    /** A user budget that is used up, checked before each model round. */
    const exhausted = (round: number): TurnStopReason | undefined => {
      const tokens = receipt.usage ? (receipt.usage.inputTokens ?? 0) + (receipt.usage.outputTokens ?? 0) : 0;
      if (budget.maxSteps !== undefined && round >= budget.maxSteps) return 'budget_steps';
      if (budget.maxToolCalls !== undefined && executed >= budget.maxToolCalls) return 'budget_tool_calls';
      if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) return 'budget_tokens';
      if (budget.maxDurationMs !== undefined && Date.now() - startedAt >= budget.maxDurationMs) return 'budget_time';
      if (budget.maxCostUSD !== undefined && (receipt.usage?.costUSD ?? 0) >= budget.maxCostUSD) return 'budget_cost';
      return undefined;
    };
    const inlineLimit = budget.maxToolCalls !== undefined ? Math.min(SAFETY_LIMITS.bridgeCallsPerTurn, budget.maxToolCalls + SAFETY_LIMITS.bridgeRefusalGrace) : SAFETY_LIMITS.bridgeCallsPerTurn;
    try {
      const recovered=this.store.recover?.(this.id);
      if(recovered?.messages.length)this.messages=normalizeHistory(recovered.messages);
      recoveryNeeded=(recovered?.task??this.task)?.state==='unfinished'||!!recovered?.turns.some(t=>['interrupted','failed','cancelled'].includes(t.state));
      this.task=taskForRequest(content,recovered?.task??this.task);
      this.snapshot=recovered?.compaction??this.snapshot;
      revision=this.store.beginExecution?this.store.beginExecution(this.id,user,receipt):this.store.append(this.id,user,'pending',receipt);
      this.store.saveTask?.(this.id,this.task);
      signal?.throwIfAborted();
      const context = await this.projectContext?.load(signal);
      signal?.throwIfAborted();
      if (context && (!Number.isSafeInteger(context.budgetBytes) || context.budgetBytes < 0 || context.budgetBytes > 65536 || Buffer.byteLength(context.content) > context.budgetBytes)) throw new FutrynError('BUDGET');
      const projectMessages: Message[] = context?.content ? [messageSchema.parse({role:'user',content:context.content})] : [];
      maxOutputTokens=Math.min(maxOutputTokens,this.options.outputLimit?.()??maxOutputTokens);
      const window = Math.max(1, (this.options.contextLimit?.() ?? SAFETY_LIMITS.unknownContextTokens) - maxOutputTokens);
      for (let round = 0; ; round++) {
        stop ??= exhausted(round);
        const normalized=normalizeHistory(this.messages);
        let visible=useContextSnapshot(normalized,this.snapshot);
        const current=normalizeHistory([user,...steps]);
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
        let text = ''; let calls: ToolCall[] = [];
        const before = receipt.usage; // totals of earlier rounds
        let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
        for (let attempt = 0; ; attempt++) {
          // Bounded retry of a round that failed before producing anything (Codex responses_retry);
          // once text, a tool call or an inline execution came back the round is not repeated.
          let produced = false; text = ''; calls = []; terminal = undefined; let textBytes = 0; let reasoningBytes=0;
          try {
            record({type:'model.requested',stepId:crypto.randomUUID()});
            for await (const event of this.model.stream({ requestId: round === 0 && attempt === 0 ? receipt.requestId : crypto.randomUUID(), modelId: this.selection.modelId, messages: history, maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, tools, ...(instructions ? { instructions } : {}) }, signal, this.model.inlineTools && this.tools ? async (call, toolSignal) => {
              produced = true;
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
            } : undefined)) {
              if (signal?.aborted) throw new FutrynError('CANCELLED');
              if(event.type==='toolOutputDelta')throw new FutrynError('PROTOCOL');
              if (terminal) throw new FutrynError('PROTOCOL');
              if (['textDelta', 'reasoningDelta', 'toolCallComplete', 'toolResult', 'activity'].includes(event.type)) produced = true;
              if (event.type === 'textDelta' || event.type === 'toolCallComplete') rejectionCandidate = false;
              if (event.type === 'textDelta') {
                text += event.text; textBytes += Buffer.byteLength(event.text);
                record({type:'assistant.text',text:event.text});
                if (textBytes > SAFETY_LIMITS.textBytesPerResponse) throw new FutrynError('PROTOCOL');
              }
              if(event.type==='reasoningDelta'){reasoningBytes+=Buffer.byteLength(event.text);if(reasoningBytes>SAFETY_LIMITS.textBytesPerResponse){stop='safety_limit';throw new FutrynError('PROTOCOL');}}
              if (event.type === 'usage' || event.type === 'completed') receipt.usage = combine(before, event.usage);
              if (event.type === 'usage' || event.type === 'completed') { lastInput = event.usage.inputTokens; lastOutput = event.usage.outputTokens; }
              if (event.type === 'context') receipt.context = event.context;
              if (event.type === 'usage' || event.type === 'context') this.store.observeTurn?.(this.id, revision, receipt);
              if (event.type === 'toolCallComplete') {
                if (!offerTools) throw new FutrynError('UNSUPPORTED');
                if (calls.length >= SAFETY_LIMITS.callsPerResponse || calls.some(c => c.id === event.call.id) || (!this.model.inlineTools && journalCalls.has(event.call.id))) throw new FutrynError('PROTOCOL');
                recordCall(event.call);
                if (!this.model.inlineTools) calls.push(event.call);
              }
              if(event.type==='toolResult'&&(!this.model.inlineTools||stable(outcomes.get(event.result.callId))!==stable(event.result)))throw new FutrynError('PROTOCOL');
              if (event.type === 'completed') terminal = event;
              else yield event.type === 'usage' ? { type: 'usage', usage: receipt.usage! } : event;
            }
            break;
          } catch (error) {
            const retryable = error instanceof FutrynError && error.retryable && !produced && attempt < SAFETY_LIMITS.roundRetries && !signal?.aborted;
            if (!retryable) throw error;
            await sleep(Math.min(10000, Math.max(error.retryAfterMs ?? 0, 250 * 2 ** attempt)), signal);
          }
        }
        if (!terminal) throw new FutrynError('PROTOCOL');
        if (calls.length) {
          steps.push({ role: 'assistant', content: text, toolCalls: calls });
          // Codex parallel.rs: read-only calls of one response run concurrently; writes and commands
          // run alone and in order. Results are yielded and stored in call order either way.
          let results:ToolResult[]=[];let done=false;let failure:unknown;
          const executing=this.executeBatch(calls,capability,run,signal).then(value=>{results=value;},error=>{failure=error;}).finally(()=>{done=true;wakeProgress?.();});
          try{while(!done||progress.length){if(progress.length){const next=progress.shift()!;if(next.type==='toolOutputDelta')queuedBytes-=Buffer.byteLength(next.text);yield next;}else await new Promise<void>(resolve=>{wakeProgress=resolve;if(done)resolve();});}await executing;if(failure)throw failure;}finally{wakeProgress=undefined;if(!done)turnAbort.abort();await executing;}
          for (const [index, call] of calls.entries()) {
            yield { type: 'toolResult', result: results[index]! };
            steps.push(toolMessage(call, results[index]!));
          }
          stagnant=results.some(result=>result.status==='ok'&&!result.content.startsWith('[unchanged]'))?0:stagnant+1;
          if(stagnant>=3)progressNotice='Progress correction: recent calls produced only identical reads, refusals or failures. Use existing evidence; choose a different justified step or report the blocker. Never retry a denied mutation.';
          if(stagnant>=6){stop='stalled';throw new FutrynError('STALLED');}
          continue;
        }
        if (!text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(terminal.finishReason)) throw new FutrynError('PROTOCOL');
        const needsArtifact=this.task&&!this.options.analysisOnly?.()&&artifactWork(this.task,this.tools?.descriptors().map(d=>d.name)??[]);
        const verified=this.task?.artifactTargets.every(path=>this.task!.verifiedActions.some(a=>a.status==='verified:'+path));
        if(needsArtifact&&!verified&&!stop){
          if(corrections++>=2){stop='stalled';throw new FutrynError('STALLED');}
          steps.push({role:'assistant',content:text});
          progressNotice='Artifact progress correction: the requested artifact has no complete verification read yet. Partial HTML excerpts do not establish full document structure. For these targets, use read with '+JSON.stringify(this.task!.artifactTargets.map(path=>({path,offset:1,limit:2000})))+'. If output remains truncated, report the verification limit rather than claiming completion. If the user still requests implementation, perform the approved change and verify the target. Do not merely promise it. If blocked, report the precise blocker and stop. Do not retry denied writes.';
          if(this.task!.failures.some(f=>f.includes('denied'))){stop='stalled';throw new FutrynError('STALLED');}
          continue;
        }
        if(this.task){this.task.state=needsArtifact?(verified?'verified':'unfinished'):(this.task.failures.length||this.task.pending.some(p=>p.startsWith('Collect command session '))?'unfinished':'verified');this.task.pending=this.task.state==='verified'?[]:this.task.pending;this.store.saveTask?.(this.id,this.task);}
        receipt.outcome = 'completed'; receipt.stopReason = stop ?? 'completed'; receipt.finishedAt = new Date().toISOString();
        const answer: Message = { role: 'assistant', content: text };
        this.store.complete(this.id, revision, answer, receipt, steps);
        completed = true; this.messages.push(user, ...steps, answer);
        yield { ...terminal, usage: receipt.usage ?? terminal.usage };
        return;
      }
    } catch (e) {
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
      if(!completed)turnAbort.abort();
      try{
        if(revision!==undefined&&!completed&&!settled){receipt.outcome='cancelled';receipt.stopReason='cancelled';receipt.finishedAt=new Date().toISOString();this.store.interrupt(this.id,revision,receipt,appliedSteps);}
        if(revision!==undefined){const recovery=this.store.recover?.(this.id);if(recovery)this.messages=normalizeHistory(recovery.messages);}
      }finally{this.running=false;}
    }
  }

  /** Runs one response's calls: consecutive reads concurrently (bounded), everything else serially. */
  private async executeBatch(calls: ToolCall[], capability: (call: ToolCall) => string | undefined, run: (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>, signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(calls.length);
    for (let index = 0; index < calls.length;) {
      signal?.throwIfAborted();
      if (capability(calls[index]!) !== 'fs.read') { results[index] = await run(calls[index]!, signal); index++; continue; }
      let end = index; while (end < calls.length && capability(calls[end]!) === 'fs.read') end++;
      let next = index;
      const worker = async () => { while (next < end) { const at = next++; signal?.throwIfAborted(); results[at] = await run(calls[at]!, signal); } };
      const settled=await Promise.allSettled(Array.from({ length: Math.min(SAFETY_LIMITS.readConcurrency, end - index) }, worker));
      const failed=settled.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
      index = end;
    }
    return results;
  }
}
