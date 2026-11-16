import {
  FutrynError,
  requestSchema,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  type InlineToolExecutor,
} from '@futryn/contracts';

/** Runtime provider adapter: core never imports process, OAuth or SDK objects. */
export class SubscriptionAdapter implements ModelPort {
  constructor(
    private readonly modelId: string,
    private readonly run: (
      request: ModelRequest,
      signal?: AbortSignal,
      executeTool?: InlineToolExecutor,
    ) => AsyncIterable<ModelEvent>,
    readonly inlineTools = false,
  ) {}
  async *stream(
    input: ModelRequest,
    signal?: AbortSignal,
    executeTool?: InlineToolExecutor,
  ): AsyncIterable<ModelEvent> {
    const request = requestSchema.parse(input);
    if (request.modelId !== this.modelId) throw new FutrynError('POLICY');
    if (request.tools.length && (!this.inlineTools || !executeTool)) throw new FutrynError('UNSUPPORTED');
    if (request.maxEstimatedCostUSD !== undefined) throw new FutrynError('BUDGET');
    yield* this.run(request, signal, executeTool);
  }
  async generate(request: ModelRequest, signal?: AbortSignal) {
    let text = '';
    let terminal: Extract<ModelEvent, {type: 'completed'}> | undefined;
    for await (const event of this.stream(request, signal)) {
      if (event.type === 'textDelta') text += event.text;
      if (event.type === 'completed') terminal = event;
    }
    if (!terminal) throw new FutrynError('PROTOCOL');
    return {text, calls: [], usage: terminal.usage, finishReason: terminal.finishReason};
  }
}
