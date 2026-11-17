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
  GENERATION_LIMITS,
  codexBackoffMs,
} from '@futryn/contracts';

export interface MediaOptions {
  /** Send assistant reasoning back as `reasoning_content` (DeepSeek, ADR 0048). */
  replayReasoning?: boolean;
  /** Wire protocol of the provider; decides where tool media goes (ADR 0041). */
  protocol?: 'chat' | 'anthropic' | 'responses' | 'gemini';
  /** The model's vision capability; `unsupported` never receives media. */
  vision?: 'supported' | 'unsupported' | 'unknown';
}

type UserPart = Exclude<Extract<ModelMessage, {role: 'user'}>['content'], string>[number];

const mediaNote = (count: number) =>
  `[${count} attachment(s) from this result were not sent: the current model cannot view images or PDFs.]`;

/**
 * Futryn messages → AI SDK messages, including assistant tool calls and tool results. Tool media
 * (ADR 0041): Anthropic carries images and PDFs inside the tool result; other protocols cannot, so
 * the media follows the run of tool results as one user message (OpenAI chat: images only). A model
 * known to lack vision gets a note instead of the media.
 */
export function toModelMessages(messages: Message[], media: MediaOptions = {}): ModelMessage[] {
  const out: ModelMessage[] = [];
  let pending: UserPart[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({
      role: 'user',
      content: [{type: 'text', text: 'Attachments returned by the tool results above:'}, ...pending],
    });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'tool') {
      const attachments = m.attachments ?? [];
      const blocked = attachments.length > 0 && media.vision === 'unsupported';
      if (attachments.length && !blocked && media.protocol === 'anthropic') {
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.toolCallId!,
              toolName: m.toolName!,
              output: {
                type: 'content',
                value: [
                  {type: 'text', text: m.content},
                  ...attachments.map(a => ({
                    type: 'file' as const,
                    data: {type: 'data' as const, data: a.data},
                    mediaType: a.mime,
                    filename: a.name,
                  })),
                ],
              },
            },
          ],
        });
        continue;
      }
      let text = m.content;
      if (blocked) text += '\n' + mediaNote(attachments.length);
      else if (attachments.length) {
        const sendable = attachments.filter(a => a.mime !== 'application/pdf' || media.protocol !== 'chat');
        if (sendable.length < attachments.length)
          text += `\n[${attachments.length - sendable.length} PDF attachment(s) not sent: this provider protocol cannot carry PDFs.]`;
        for (const a of sendable) pending.push({type: 'file', data: a.data, mediaType: a.mime, filename: a.name});
      }
      out.push({
        role: 'tool',
        content: [
          {type: 'tool-result', toolCallId: m.toolCallId!, toolName: m.toolName!, output: {type: 'text', value: text}},
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls) {
      out.push({
        role: 'assistant',
        content: [
          ...(media.replayReasoning && m.reasoning ? [{type: 'reasoning' as const, text: m.reasoning}] : []),
          ...(m.content ? [{type: 'text' as const, text: m.content}] : []),
          ...m.toolCalls.map(c => ({type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.input})),
        ],
      });
      continue;
    }
    out.push({role: m.role, content: m.content} as ModelMessage);
  }
  flush();
  return out;
}
import {normalizeError, ProviderTransport, wait} from './http';

type ChatUsageConverter = NonNullable<Parameters<typeof createOpenAICompatible>[0]['convertUsage']>;
/**
 * OpenAI-compatible usage with DeepSeek's cache counters: `prompt_cache_hit_tokens` counts as cache
 * reads when the standard `prompt_tokens_details.cached_tokens` is absent (ADR 0048).
 */
const chatUsage: ChatUsageConverter = usage => {
  if (usage == null)
    return {
      inputTokens: {total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined},
      outputTokens: {total: undefined, text: undefined, reasoning: undefined},
    };
  const raw = usage as Record<string, any>;
  const prompt = raw.prompt_tokens ?? undefined;
  const completion = raw.completion_tokens ?? undefined;
  const cached = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? undefined;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens ?? undefined;
  return {
    inputTokens: {
      total: prompt,
      noCache: prompt !== undefined && cached !== undefined ? prompt - cached : undefined,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completion,
      text: completion !== undefined && reasoning !== undefined ? Math.max(0, completion - reasoning) : undefined,
      reasoning,
    },
    raw: usage,
  } as ReturnType<ChatUsageConverter>;
};

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
  ...(u.inputTokenDetails?.cacheReadTokens != null ? {cacheReadTokens: u.inputTokenDetails?.cacheReadTokens} : {}),
  ...(u.inputTokenDetails?.cacheWriteTokens != null ? {cacheWriteTokens: u.inputTokenDetails?.cacheWriteTokens} : {}),
  ...(u.outputTokenDetails?.reasoningTokens != null ? {reasoningTokens: u.outputTokenDetails?.reasoningTokens} : {}),
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

/** Aborts with a TimeoutError after `ms` without `touch()`; `stop()` disarms it. */
function idleDeadline(ms: number): {signal: AbortSignal; touch: () => void; stop: () => void} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const touch = () => {
    stop();
    if (controller.signal.aborted) return;
    timer = setTimeout(() => controller.abort(new DOMException('Model stream idle', 'TimeoutError')), ms);
  };
  touch();
  return {signal: controller.signal, touch, stop};
}

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
    if (request.modelId !== this.modelId) throw new FutrynError('INVALID_INPUT');
    const maxOutputTokens = this.outputCap(request);
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
      const outputEstimate =
        maxOutputTokens ?? this.info?.outputLimit ?? GENERATION_LIMITS.anthropicFallbackOutputTokens;
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
    if (this.info?.contextLimit && maxOutputTokens !== undefined && maxOutputTokens >= this.info.contextLimit)
      throw new FutrynError('CONTEXT_LIMIT');
    const key = await this.transport.credential(signal);
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
      return this.requestWithRetries(url, {...init, headers}, idle.touch).then(response => {
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
      model = createOpenAICompatible({
        ...settings,
        name: p.id,
        includeUsage: p.streamUsage ?? false,
        convertUsage: chatUsage,
      }).chatModel(this.modelId);
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
    // Codex stream_idle_timeout_ms: the provider timeout bounds silence (waiting for headers or
    // between chunks), not the whole response, so a long streamed answer or file is never cut.
    const idle = idleDeadline(p.streamIdleTimeoutMs ?? GENERATION_LIMITS.streamIdleTimeoutMs);
    const controller = new AbortController();
    const abortSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), idle.signal]);
    controller.signal.addEventListener('abort', idle.stop, {once: true});
    // OpenAI prompt caching (Responses API `prompt_cache_key`): a stable per-conversation value so the
    // provider routes every round of one session to the same cache. It is a hash, never the raw id.
    // Needs verification: xAI `x-grok-conv-id` is not sent until its documentation is cited.
    const openaiOptions =
      p.protocol === 'responses'
        ? {
            ...(p.auth === 'oauth' ? {store: false} : {}),
            ...(request.cacheKey ? {promptCacheKey: promptCacheKey(request.cacheKey)} : {}),
            ...(request.reasoningEffort
              ? {reasoningEffort: request.reasoningEffort, reasoningSummary: 'auto', forceReasoning: true}
              : {}),
          }
        : undefined;
    return {
      model,
      ...(request.instructions ? {system: request.instructions} : {}),
      messages: toModelMessages(request.messages, {
        protocol: p.protocol,
        vision: this.info?.capabilities.vision,
        replayReasoning: p.protocol === 'chat' && p.replayReasoning === true,
      }),
      ...(maxOutputTokens !== undefined ? {maxOutputTokens} : {}),
      ...(openaiOptions ? {providerOptions: {openai: openaiOptions}} : {}),
      maxRetries: 0,
      abortSignal,
      tools: request.tools.length ? tools : undefined,
      experimental_telemetry: {isEnabled: false, recordInputs: false, recordOutputs: false},
      controller,
      responseHeaders,
    };
  }
  /**
   * Output cap sent to the provider. Like Codex none is sent unless the caller asked for one; the
   * Anthropic API requires `max_tokens`, so it gets the model's own output limit.
   */
  private outputCap(request: ModelRequest): number | undefined {
    const limit = this.info?.outputLimit ?? undefined;
    if (request.maxOutputTokens !== undefined) return Math.min(request.maxOutputTokens, limit ?? Infinity);
    if (this.transport.provider.protocol === 'anthropic')
      return limit ?? GENERATION_LIMITS.anthropicFallbackOutputTokens;
    return undefined;
  }

  /**
   * Codex request retries (`request_max_retries`, retry_5xx + retry_transport, not 429): a request
   * that fails before its response streams is resent with backoff; a failed stream is the agent
   * loop's to re-sample.
   */
  private async requestWithRetries(url: string | URL | Request, init: RequestInit, activity: () => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transport.request(url, init, Infinity, activity);
      } catch (error) {
        const retry =
          error instanceof FutrynError &&
          error.code === 'TRANSPORT' &&
          error.retryable &&
          attempt < (this.transport.provider.requestMaxRetries ?? GENERATION_LIMITS.requestMaxRetries) &&
          !init.signal?.aborted;
        if (!retry) throw error;
        activity();
        await wait(error.retryAfterMs ?? codexBackoffMs(attempt + 1), init.signal ?? undefined);
      }
    }
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const options = await this.options(request, signal);
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
          pending.add(part.id);
        }
        if (part.type === 'abort') throw new FutrynError('CANCELLED');
        if (part.type === 'reasoning-delta') {
          yield {type: 'reasoningDelta', text: part.text};
        } else if (part.type === 'text-delta') {
          yield {type: 'textDelta', text: part.text};
        } else if (part.type === 'tool-call') {
          // No size or count ceiling (Codex); a repeated call id is still a broken stream.
          if (calls.has(part.toolCallId)) throw new FutrynError('PROTOCOL');
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
    // ChatGPT plan inference requires stream=true and store=false, including validation probes.
    if (this.transport.provider.auth === 'oauth' && this.transport.provider.protocol === 'responses') {
      let text = '';
      const calls: ToolCall[] = [];
      let completion: {usage: Usage; finishReason: string} | undefined;
      for await (const event of this.stream(request, signal)) {
        if (event.type === 'textDelta') text += event.text;
        else if (event.type === 'toolCallComplete') calls.push(event.call);
        else if (event.type === 'completed') completion = event;
      }
      if (!completion) throw new FutrynError('PROTOCOL');
      return {text, calls, usage: completion.usage, finishReason: completion.finishReason};
    }
    const options = await this.options(request, signal);
    try {
      const result = await generateText(options);
      if (
        result.finishReason === 'error' ||
        ['other', 'interrupted'].includes(result.finishReason) ||
        new Set(result.toolCalls.map(c => c.toolCallId)).size !== result.toolCalls.length
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

/** Stable, non-reversible per-conversation cache key (`prompt_cache_key`). */
export function promptCacheKey(conversationId: string): string {
  return (
    'futryn-' +
    new Bun.CryptoHasher('sha256')
      .update('futryn-prompt-cache:' + conversationId)
      .digest('hex')
      .slice(0, 32)
  );
}
