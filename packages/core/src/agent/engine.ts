import { HannesError, messageSchema, type ConversationStore, type Message, type ModelEvent, type ModelPort, type Selection, type TurnReceipt } from '@hannes/contracts';

/** Model-only runtime. No tool execution or provider SDK enters core. */
export class Conversation {
  readonly id: string;
  private messages: Message[] = [];
  private running = false;
  constructor(
    private readonly selection: Selection,
    private readonly model: ModelPort,
    private readonly store: ConversationStore,
    existing?: { id: string; messages: Message[] },
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
    this.running = true; let revision: number | undefined; let text = ''; let completed = false;
    let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
    try {
      signal?.throwIfAborted();
      revision = this.store.append(this.id, user, 'pending', receipt);
      for await (const event of this.model.stream({ requestId: receipt.requestId, modelId: this.selection.modelId, messages: [...this.messages, user], maxOutputTokens, maxEstimatedCostUSD, reasoningEffort, tools: [] }, signal)) {
        if (signal?.aborted) throw new HannesError('CANCELLED');
        if (terminal) throw new HannesError('PROTOCOL');
        if (event.type === 'textDelta') {
          text += event.text; if (Buffer.byteLength(text) > 262144) throw new HannesError('PROTOCOL');
        }
        if (event.type === 'usage' || event.type === 'completed') receipt.usage = event.usage;
        if (event.type === 'context') receipt.context = event.context;
        if (event.type === 'usage' || event.type === 'context') this.store.observeTurn?.(this.id, revision, receipt);
        if (event.type === 'toolCallComplete') throw new HannesError('UNSUPPORTED');
        if (event.type === 'completed') {
          if (!text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(event.finishReason)) throw new HannesError('PROTOCOL');
          terminal = event;
        } else yield event;
      }
      if (!terminal) throw new HannesError('PROTOCOL');
      receipt.outcome = 'completed'; receipt.finishedAt = new Date().toISOString();
      this.store.complete(this.id, revision, { role: 'assistant', content: text }, receipt);
      completed = true; this.messages.push(user, { role: 'assistant', content: text });
      yield terminal;
    } catch (e) {
      if (revision !== undefined && !completed) { receipt.outcome = signal?.aborted || (e instanceof HannesError && e.code === 'CANCELLED') ? 'cancelled' : 'failed'; receipt.finishedAt = new Date().toISOString(); this.store.interrupt(this.id, revision, receipt); }
      if (e instanceof HannesError) throw e;
      throw new HannesError(signal?.aborted ? 'CANCELLED' : 'PROTOCOL');
    } finally { this.running = false; }
  }
}
