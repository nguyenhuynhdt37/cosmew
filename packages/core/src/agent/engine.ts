import { HannesError, messageSchema, type ConversationStore, type Message, type ModelEvent, type ModelPort, type Selection, type ToolCall, type ToolPort, type TurnReceipt, type Usage } from '@hannes/contracts';

/** Tool rounds allowed in one user turn before the model must answer in text (ADR 0017). */
export const MAX_TOOL_ROUNDS = 8;

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
    let totalText = 0;
    /** True while round 0 offered tools and nothing has come back yet. */
    let rejectionCandidate = false;
    const inlineIds = new Set<string>();
    try {
      signal?.throwIfAborted();
      revision = this.store.append(this.id, user, 'pending', receipt);
      for (let round = 0; ; round++) {
        // The last allowed round offers no tools, so the model has to answer in text.
        const available = this.tools && round < MAX_TOOL_ROUNDS && this.messages.length + steps.length < 180 ? this.tools.descriptors() : [];
        const tools = available.map(d => ({ name: d.name, description: d.description, inputSchema: d.inputSchema }));
        const offerTools = tools.length > 0;
        rejectionCandidate = round === 0 && offerTools;
        let text = ''; const calls: ToolCall[] = [];
        const before = receipt.usage; // totals of earlier rounds
        let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
        for await (const event of this.model.stream({ requestId: round === 0 ? receipt.requestId : crypto.randomUUID(), modelId: this.selection.modelId, messages: [...this.messages, user, ...steps], maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, tools }, signal, this.model.inlineTools && this.tools ? async (call, toolSignal) => {
          if (this.messages.length + steps.length > 196 || !available.some(d => d.name === call.name) || inlineIds.size >= 32 || inlineIds.has(call.id)) throw new HannesError('POLICY');
          inlineIds.add(call.id);
          if (signal?.aborted) throw new HannesError('CANCELLED');
          const result = await this.tools!.invoke(call, toolSignal ?? signal);
          if (signal?.aborted) throw new HannesError('CANCELLED');
          steps.push({role: 'assistant', content: '', toolCalls: [call]}, {role: 'tool', content: result.status === 'ok' ? result.content || '(empty)' : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`, toolCallId: call.id, toolName: call.name});
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
            const result = await this.tools!.invoke(call, signal);
            yield { type: 'toolResult', result };
            steps.push({ role: 'tool', content: result.status === 'ok' ? result.content || '(empty)' : `[${result.status}${result.code ? ': ' + result.code : ''}] ${result.content}`, toolCallId: call.id, toolName: call.name });
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
      if (revision !== undefined && !completed) { receipt.outcome = signal?.aborted || (e instanceof HannesError && e.code === 'CANCELLED') ? 'cancelled' : 'failed'; receipt.finishedAt = new Date().toISOString(); this.store.interrupt(this.id, revision, receipt); }
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
