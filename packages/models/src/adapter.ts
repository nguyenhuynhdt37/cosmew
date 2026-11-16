import {generateText, streamText, jsonSchema, type LanguageModel, type ModelMessage, type ToolSet} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogle} from '@ai-sdk/google';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import Ajv, {type ValidateFunction} from 'ajv';
import {parseRateLimitHeaders} from './limits';
import {
  FutrynError,
  requestSchema,
  type Message,
  type ModelEvent,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type ToolCall,
  type Usage,
  usageSchema,
} from '@futryn/contracts';

/** Futryn messages → AI SDK messages, including assistant tool calls and tool results. */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'tool')
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.toolCallId!,
            toolName: m.toolName!,
            output: {type: 'text', value: m.content},
          },
        ],
      };
    if (m.role === 'assistant' && m.toolCalls)
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{type: 'text' as const, text: m.content}] : []),
          ...m.toolCalls.map(c => ({type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input})),
        ],
      };
    return {role: m.role, content: m.content} as ModelMessage;
  });
}
import {normalizeError, ProviderTransport} from './http';

const usage = (
  u: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {cacheReadTokens?: number; cacheWriteTokens?: number};
    outputTokenDetails?: {reasoningTokens?: number};
  },
  info?: ModelInfo,
): Usage => ({
  inputTokens: u.inputTokens ?? null,
  outputTokens: u.outputTokens ?? null,
  ...((u.inputTokenDetails?.cacheReadTokens ?? 0) > 0 ? {cacheReadTokens: u.inputTokenDetails?.cacheReadTokens} : {}),
  ...((u.inputTokenDetails?.cacheWriteTokens ?? 0) > 0
    ? {cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens}
    : {}),
  ...((u.outputTokenDetails?.reasoningTokens ?? 0) > 0 ? {reasoningTokens: u.outputTokenDetails?.reasoningTokens} : {}),
  ...(info?.pricing ? {pricingSource: info.metadataSource, pricingAt: info.metadataFetchedAt} : {}),
  costUSD:
    info?.pricing &&
    !u.inputTokenDetails?.cacheReadTokens &&
    !u.inputTokenDetails?.cacheWriteTokens &&
    u.inputTokens !== undefined &&
    u.outputTokens !== undefined
      ? (u.inputTokens * info.pricing.inputPerMillion + u.outputTokens * info.pricing.outputPerMillion) / 1000000
      : null,
  ...(info?.pricing &&
  !u.inputTokenDetails?.cacheReadTokens &&
  !u.inputTokenDetails?.cacheWriteTokens &&
  u.inputTokens !== undefined &&
  u.outputTokens !== undefined
    ? {costEstimated: true}
    : {}),
});
/** Unparseable or non-object arguments still reach the router, which rejects them as INVALID_INPUT. */
const objectInput = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {invalidArguments: String(JSON.stringify(input) ?? input).slice(0, 1000)};

export class ProviderAdapter implements ModelPort {
  constructor(
    private readonly transport: ProviderTransport,
    private readonly modelId: string,
    private readonly info?: ModelInfo,
  ) {}
  private async options(input: ModelRequest, signal?: AbortSignal) {
    let request: ModelRequest;
    try {
      request = requestSchema.parse(input);
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
    if (request.modelId !== this.modelId || JSON.stringify(request).length > 1048576)
      throw new FutrynError('INVALID_INPUT');
    // Unknown capability is tried (ADR 0017); only a model known to reject tools is refused up front.
    if (request.tools.length && this.info?.capabilities.tools === 'unsupported') throw new FutrynError('UNSUPPORTED');
    if (request.maxEstimatedCostUSD !== undefined) {
      const prices = this.info?.pricing;
      if (!prices) throw new FutrynError('BUDGET');
      // Deliberately an estimate guard, not an exact tokenizer or provider billing ceiling.
      const inputEstimate =
        Buffer.byteLength(JSON.stringify(request.messages)) +
        Buffer.byteLength(JSON.stringify(request.tools)) +
        Buffer.byteLength(request.instructions ?? '') +
        request.messages.length * 16 +
        1024;
      const outputEstimate = Math.min(request.maxOutputTokens, this.info?.outputLimit ?? request.maxOutputTokens);
      if (
        (inputEstimate * prices.inputPerMillion + outputEstimate * prices.outputPerMillion) / 1000000 >
        request.maxEstimatedCostUSD
      )
        throw new FutrynError('BUDGET');
    }
    if (
      request.reasoningEffort &&
      (!this.info?.reasoningEfforts?.includes(request.reasoningEffort) ||
        this.transport.provider.protocol !== 'responses')
    )
      throw new FutrynError('UNSUPPORTED');
    if (
      this.info?.contextLimit &&
      Math.min(request.maxOutputTokens, this.info.outputLimit ?? request.maxOutputTokens) >= this.info.contextLimit
    )
      throw new FutrynError('CONTEXT_LIMIT');
    const key = await this.transport.credential();
    const p = this.transport.provider;
    // Rate-limit headers of the latest response; read once the turn finishes.
    const responseHeaders: {value?: Headers} = {};
    const customFetch = ((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      // Always resolve auth explicitly, never allow the SDK's environment fallback.
      if (!key) {
        headers.delete('authorization');
        headers.delete('x-api-key');
        headers.delete('x-goog-api-key');
      }
      return this.transport.request(url, {...init, headers}).then(response => {
        responseHeaders.value = response.headers;
        return response;
      });
    }) as typeof fetch;
    const settings = {baseURL: p.baseURL, apiKey: key ?? 'hannes-no-credential', fetch: customFetch};
    let model: LanguageModel;
    if (p.protocol === 'anthropic') model = createAnthropic(settings)(this.modelId);
    else if (p.protocol === 'gemini') model = createGoogle(settings)(this.modelId);
    else if (p.protocol === 'responses') model = createOpenAI(settings).responses(this.modelId);
    else
      model = createOpenAICompatible({...settings, name: p.id, includeUsage: p.streamUsage ?? false}).chatModel(
        this.modelId,
      );
    // Adapters convert, never decide (ADR 0029): a call with wrong arguments or an unknown name is
    // passed to the Futryn ToolRouter, which answers the model with INVALID_INPUT / UNKNOWN_TOOL, as
    // Codex responds-to-model. Only genuine wire faults (duplicate ids, >32 calls, oversize) fail here.
    const tools: ToolSet = {};
    const names = new Set<string>();
    const ajv = new Ajv({
      strict: true,
      coerceTypes: false,
      removeAdditional: false,
      useDefaults: false,
      validateFormats: true,
      logger: false,
    });
    for (const descriptor of request.tools) {
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(descriptor.inputSchema);
        if (('$async' in validate && validate.$async) || names.has(descriptor.name)) throw new Error();
      } catch {
        throw new FutrynError('INVALID_INPUT');
      }
      names.add(descriptor.name);
      tools[descriptor.name] = {
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema, {
          validate: value => ({success: true, value}),
        }),
      };
    }
    const controller = new AbortController();
    const abortSignal = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(p.timeoutMs),
    ]);
    return {
      model,
      ...(request.instructions ? {system: request.instructions} : {}),
      messages: toModelMessages(request.messages),
      maxOutputTokens: Math.min(request.maxOutputTokens, this.info?.outputLimit ?? request.maxOutputTokens),
      ...(request.reasoningEffort
        ? {
            providerOptions: {
              openai: {reasoningEffort: request.reasoningEffort, reasoningSummary: 'auto', forceReasoning: true},
            },
          }
        : {}),
      maxRetries: 0,
      abortSignal,
      tools: request.tools.length ? tools : undefined,
      experimental_telemetry: {isEnabled: false, recordInputs: false, recordOutputs: false},
      controller,
      responseHeaders,
    };
  }
  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const options = await this.options(request, signal);
    let bytes = 0;
    let complete = false;
    const calls = new Set<string>();
    const pending = new Set<string>();
    // A call whose arguments did not parse may be a stream cut mid-arguments (the AI SDK flushes unfinished
    // calls as `invalid`). It is held until a clean finish proves the response complete (ADR 0033); parsed
    // calls are emitted at once so the agent loop can dispatch them while the response still streams.
    const held: ToolCall[] = [];
    try {
      yield {type: 'started', requestId: request.requestId};
      const result = streamText({...options, onError: () => {}, onChunk: () => {}});
      for await (const part of result.fullStream) {
        options.abortSignal.throwIfAborted();
        if (part.type === 'error') throw part.error;
        if (part.type === 'tool-error') throw new FutrynError('PROTOCOL');
        if (part.type === 'tool-input-start') {
          if (pending.size >= 32) throw new FutrynError('PROTOCOL');
          pending.add(part.id);
        }
        if (part.type === 'abort') throw new FutrynError('CANCELLED');
        if (part.type === 'reasoning-delta') {
          bytes += Buffer.byteLength(part.text);
          if (bytes > 262144) throw new FutrynError('PROTOCOL');
          yield {type: 'reasoningDelta', text: part.text};
        } else if (part.type === 'text-delta') {
          bytes += Buffer.byteLength(part.text);
          if (bytes > 262144) throw new FutrynError('PROTOCOL');
          yield {type: 'textDelta', text: part.text};
        } else if (part.type === 'tool-call') {
          if (calls.has(part.toolCallId) || calls.size >= 32 || (JSON.stringify(part.input) ?? '').length > 65536)
            throw new FutrynError('PROTOCOL');
          calls.add(part.toolCallId);
          pending.delete(part.toolCallId);
          const call = {id: part.toolCallId, name: part.toolName, input: objectInput(part.input)};
          if ('invalid' in part && part.invalid) held.push(call);
          else yield {type: 'toolCallComplete', call};
        } else if (part.type === 'finish') {
          const quota = options.responseHeaders.value ? parseRateLimitHeaders(options.responseHeaders.value) : [];
          const reported = usageSchema.parse({...usage(part.totalUsage, this.info), ...(quota.length ? {quota} : {})});
          yield {type: 'usage', usage: reported};
          if (part.finishReason === 'error' || ['other', 'interrupted'].includes(part.finishReason) || pending.size)
            throw new FutrynError('PROTOCOL');
          for (const call of held.splice(0)) yield {type: 'toolCallComplete', call};
          // Codex Completed { end_turn: Some(false) }: the only such signal these transports expose is
          // Anthropic's `pause_turn` (the AI SDK folds it into "stop" but keeps the raw reason).
          const raw = (part as {rawFinishReason?: unknown}).rawFinishReason;
          complete = true;
          yield {
            type: 'completed',
            finishReason: part.finishReason.replaceAll('-', '_'),
            usage: reported,
            ...(raw === 'pause_turn' ? {endTurn: false} : {}),
          };
        }
      }
      if (!complete) throw new FutrynError('PROTOCOL');
    } catch (e) {
      throw normalizeError(e, options.abortSignal);
    } finally {
      options.controller.abort();
    }
  }
  async generate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<{text: string; calls: ToolCall[]; usage: Usage; finishReason: string}> {
    const options = await this.options(request, signal);
    try {
      const result = await generateText(options);
      if (
        Buffer.byteLength(result.text) > 262144 ||
        result.finishReason === 'error' ||
        ['other', 'interrupted'].includes(result.finishReason) ||
        result.toolCalls.length > 32 ||
        new Set(result.toolCalls.map(c => c.toolCallId)).size !== result.toolCalls.length ||
        result.toolCalls.some(c => JSON.stringify(c.input).length > 65536)
      )
        throw new FutrynError('PROTOCOL');
      return {
        text: result.text,
        calls: result.toolCalls.map(call => ({
          id: call.toolCallId,
          name: call.toolName,
          input: objectInput(call.input),
        })),
        usage: usageSchema.parse(usage(result.totalUsage, this.info)),
        finishReason: result.finishReason.replaceAll('-', '_'),
      };
    } catch (e) {
      throw normalizeError(e, options.abortSignal);
    } finally {
      options.controller.abort();
    }
  }
}
