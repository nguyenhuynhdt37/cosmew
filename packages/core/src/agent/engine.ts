import { HannesError, messageSchema, type ConversationStore, type ProjectContextPort, type Message, type ModelEvent, type ModelPort, type Selection, type ToolCall, type ToolPort, type ToolResult, type TurnReceipt, type Usage } from '@hannes/contracts';
import { budgetExhaustedNotice, explorationGuidance } from './guidance';

/**
 * Request rounds that may offer tools in one user turn (ADR 0020, was 8 in ADR 0017). A model that
 * issues one call per round needs a round per dependency hop; the round after the last one offers
 * no tools, so the model has to answer.
 */
export const MAX_TOOL_ROUNDS = 16;
/** Tool calls executed in one user turn, on the round-based and the inline path alike (ADR 0020). */
export const MAX_TOOL_CALLS = 32;
/** Inline runtimes get a few refused attempts past the budget before the turn fails closed. */
export const MAX_INLINE_TOOL_ATTEMPTS = MAX_TOOL_CALLS + 4;

const UNCHANGED = '[unchanged] This call returned exactly the same content as the identical call earlier in this turn. The content is not repeated; use the earlier result.';
const BUDGET = `[tool budget] The limit of ${MAX_TOOL_CALLS} tool calls for this turn is reached, so this call was not run. Answer from the evidence gathered and say what is still missing.`;

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
  constructor(
    private readonly selection: Selection,
    private readonly model: ModelPort,
    private readonly store: ConversationStore,
    existing?: { id: string; messages: Message[] },
    private readonly tools?: ToolPort,
    /** Called when the provider rejects the tool definitions themselves (ADR 0017). */
    private readonly onToolsRejected?: () => void,
    private readonly projectContext?: ProjectContextPort,
  ) {
    if (existing) {
      this.id = existing.id;
      this.messages = existing.messages.map(m => messageSchema.parse(m));
    } else {
      this.id = store.create(selection);
    }
  }
  history(): readonly Message[] { return this.messages.map(m => ({ ...m })); }
  async *send(content: string, signal?: AbortSignal, maxOutputTokens = 4096, maxEstimatedCostUSD?: number, reasoningEffort?: string): AsyncIterable<ModelEvent> {
    if (this.running) throw new HannesError('POLICY');
    let user: Message;
    try { user = messageSchema.parse({ role: 'user', content }); } catch { throw new HannesError('INVALID_INPUT'); }
    if (this.messages.length >= 198 || JSON.stringify(this.messages).length + content.length > 900000) throw new HannesError('INVALID_INPUT');
    const receipt: TurnReceipt = { requestId: crypto.randomUUID(), accountId: this.selection.accountId, modelId: this.selection.modelId, startedAt: new Date().toISOString(), finishedAt: null, outcome: 'pending', usage: null, context: null };
    this.running = true; let revision: number | undefined; let completed = false;
    /** Tool rounds of this turn: assistant tool-call messages and their tool results. */
    const steps: Message[] = [];
    const appliedSteps: Message[] = [];
    let totalText = 0;
    /** True while round 0 offered tools and nothing has come back yet. */
    let rejectionCandidate = false;
    const inlineIds = new Set<string>();
    /** Calls actually dispatched this turn; refused over-budget calls are not counted. */
    let executed = 0;
    /** Successful results of this turn by tool + arguments, to spot rereads of unchanged content. */
    const seen = new Map<string, string>();
    /** Every call goes through here: budget, the injected ToolPort (permission engine), reread check. */
    const run = async (call: ToolCall, toolSignal?: AbortSignal): Promise<ToolResult> => {
      if (executed >= MAX_TOOL_CALLS) return { callId: call.id, name: call.name, status: 'error', code: 'TOOL_BUDGET', content: BUDGET };
      executed++;
      const capability=this.tools!.descriptors().find(d=>d.name===call.name)?.capability;
      const result = await this.tools!.invoke(call, toolSignal);
      if(capability==='fs.write'&&result.status!=='denied')appliedSteps.push({role:'assistant',content:'',toolCalls:[call]},toolMessage(call,result));
      if (result.status !== 'ok' || capability !== 'fs.read') return result;
      const key = call.name + '\0' + stable(call.input);
      // The tool did run (and was permission-checked and audited); only the duplicate text is dropped.
      if (seen.get(key) === result.content) return { ...result, content: UNCHANGED };
      seen.set(key, result.content);
      return result;
    };
    try {
      signal?.throwIfAborted();
      const context = await this.projectContext?.load(signal);
      signal?.throwIfAborted();
      if (context && (!Number.isSafeInteger(context.budgetBytes) || context.budgetBytes < 0 || context.budgetBytes > 65536 || Buffer.byteLength(context.content) > context.budgetBytes)) throw new HannesError('BUDGET');
      const projectMessages: Message[] = context?.content ? [messageSchema.parse({role:'user',content:context.content})] : [];
      revision = this.store.append(this.id, user, 'pending', receipt);
      for (let round = 0; ; round++) {
        // The last allowed round offers no tools, so the model has to answer in text.
        const available = this.tools && round < MAX_TOOL_ROUNDS && executed < MAX_TOOL_CALLS && this.messages.length + steps.length < 180 ? this.tools.descriptors() : [];
        const tools = available.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
        const offerTools = tools.length > 0;
        rejectionCandidate = round === 0 && offerTools;
        // Host guidance travels with the tools. Once tools are withdrawn mid-turn the model is told why.
        const names = offerTools ? tools.map(t => t.name) : steps.length ? this.tools?.descriptors().map(d => d.name) ?? [] : [];
        const guidance = names.length ? explorationGuidance(names, { rounds: MAX_TOOL_ROUNDS, calls: MAX_TOOL_CALLS }) : '';
        const instructions = offerTools ? guidance : steps.length ? [guidance, budgetExhaustedNotice()].filter(Boolean).join('\n') : undefined;
        let text = ''; const calls: ToolCall[] = [];
        const before = receipt.usage; // totals of earlier rounds
        let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
        for await (const event of this.model.stream({ requestId: round === 0 ? receipt.requestId : crypto.randomUUID(), modelId: this.selection.modelId, messages: [...projectMessages, ...this.messages, user, ...steps], maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, tools, ...(instructions ? { instructions } : {}) }, signal, this.model.inlineTools && this.tools ? async (call, toolSignal) => {
          if (this.messages.length + steps.length > 196 || !available.some(d => d.name === call.name) || inlineIds.size >= MAX_INLINE_TOOL_ATTEMPTS || inlineIds.has(call.id)) throw new HannesError('POLICY');
          inlineIds.add(call.id);
          if (signal?.aborted) throw new HannesError('CANCELLED');
          const result = await run(call, toolSignal ?? signal);
          if (signal?.aborted) throw new HannesError('CANCELLED');
          steps.push({role: 'assistant', content: '', toolCalls: [call]}, toolMessage(call, result));
          return result;
        } : undefined)) {
          if (signal?.aborted) throw new HannesError('CANCELLED');
          if (terminal) throw new HannesError('PROTOCOL');
          if (event.type === 'textDelta' || event.type === 'toolCallComplete') rejectionCandidate = false;
          if (event.type === 'textDelta') {
            text += event.text; totalText += Buffer.byteLength(event.text);
            if (totalText > 262144) throw new HannesError('PROTOCOL');
          }
          if (event.type === 'usage' || event.type === 'completed') receipt.usage = combine(before, event.usage);
          if (event.type === 'context') receipt.context = event.context;
          if (event.type === 'usage' || event.type === 'context') this.store.observeTurn?.(this.id, revision, receipt);
          if (event.type === 'toolCallComplete') {
            if (!offerTools) throw new HannesError('UNSUPPORTED');
            if (calls.length >= 32 || calls.some(c => c.id === event.call.id)) throw new HannesError('PROTOCOL');
            if (!this.model.inlineTools) calls.push(event.call);
          }
          if (event.type === 'completed') terminal = event;
          else yield event.type === 'usage' ? { type: 'usage', usage: receipt.usage! } : event;
        }
        if (!terminal) throw new HannesError('PROTOCOL');
        if (calls.length) {
          steps.push({ role: 'assistant', content: text, toolCalls: calls });
          for (const call of calls) {
            signal?.throwIfAborted();
            const result = await run(call, signal);
            yield { type: 'toolResult', result };
            steps.push(toolMessage(call, result));
          }
          continue;
        }
        if (!text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(terminal.finishReason)) throw new HannesError('PROTOCOL');
        receipt.outcome = 'completed'; receipt.finishedAt = new Date().toISOString();
        const answer: Message = { role: 'assistant', content: text };
        this.store.complete(this.id, revision, answer, receipt, steps);
        completed = true; this.messages.push(user, ...steps, answer);
        yield { ...terminal, usage: receipt.usage ?? terminal.usage };
        return;
      }
    } catch (e) {
      if (revision !== undefined && !completed) { receipt.outcome = signal?.aborted || (e instanceof HannesError && e.code === 'CANCELLED') ? 'cancelled' : 'failed'; receipt.finishedAt = new Date().toISOString(); this.store.interrupt(this.id, revision, receipt, appliedSteps); if(appliedSteps.length)this.messages.push(user,...appliedSteps); }
      // A 400 before any output, right after offering tools, means the provider refused the tool definitions.
      if (rejectionCandidate && !signal?.aborted && e instanceof HannesError && e.code === 'INVALID_INPUT' && this.onToolsRejected) {
        this.onToolsRejected();
        throw new HannesError('UNSUPPORTED');
      }
      if (e instanceof HannesError) throw e;
      throw new HannesError(signal?.aborted ? 'CANCELLED' : 'PROTOCOL');
    } finally { this.running = false; }
  }
}
