import { HannesError, messageSchema, type ConversationStore, type Message, type ModelEvent, type ModelPort, type Selection } from '@hannes/contracts';

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
  async *send(content: string, signal?: AbortSignal, maxOutputTokens = 4096, maxEstimatedCostUSD?: number): AsyncIterable<ModelEvent> {
    if (this.running) throw new HannesError('POLICY');
    let user: Message;
    try { user = messageSchema.parse({ role: 'user', content }); } catch { throw new HannesError('INVALID_INPUT'); }
    if (this.messages.length >= 198 || JSON.stringify(this.messages).length + content.length > 900000) throw new HannesError('INVALID_INPUT');
    this.running = true; let revision: number | undefined; let text = ''; let completed = false;
    let terminal: Extract<ModelEvent, { type: 'completed' }> | undefined;
    try {
      signal?.throwIfAborted();
      revision = this.store.append(this.id, user, 'pending');
      for await (const event of this.model.stream({ requestId: crypto.randomUUID(), modelId: this.selection.modelId, messages: [...this.messages, user], maxOutputTokens, maxEstimatedCostUSD, tools: [] }, signal)) {
        if (signal?.aborted) throw new HannesError('CANCELLED');
        if (terminal) throw new HannesError('PROTOCOL');
        if (event.type === 'textDelta') {
          text += event.text; if (Buffer.byteLength(text) > 262144) throw new HannesError('PROTOCOL');
        }
        if (event.type === 'toolCallComplete') throw new HannesError('UNSUPPORTED');
        if (event.type === 'completed') {
          if (!text.trim() || ['error', 'unknown', 'tool-calls', 'tool_calls'].includes(event.finishReason)) throw new HannesError('PROTOCOL');
          terminal = event;
        } else yield event;
      }
      if (!terminal) throw new HannesError('PROTOCOL');
      this.store.complete(this.id, revision, { role: 'assistant', content: text });
      completed = true; this.messages.push(user, { role: 'assistant', content: text });
      yield terminal;
    } catch (e) {
      if (revision !== undefined && !completed) this.store.interrupt(this.id, revision);
      if (e instanceof HannesError) throw e;
      throw new HannesError(signal?.aborted ? 'CANCELLED' : 'PROTOCOL');
    } finally { this.running = false; }
  }
}
