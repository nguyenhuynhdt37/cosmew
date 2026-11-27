import {generateText, streamText, jsonSchema, type LanguageModel, type ModelMessage, type ToolSet} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';
import {createGoogle} from '@ai-sdk/google';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import Ajv, {type ValidateFunction} from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import {parseRateLimitHeaders} from './limits';
import {resolveThinkingWire} from './effort-wire';
import {
  FutrynError,
  requestSchema,
  type Message,
  type ProviderReplay,
  providerReplaySchema,
  type ModelEvent,
  type ModelInfo,
  type ModelPort,
  type ModelRequest,
  type ToolCall,
  toolCallSchema,
  type Usage,
  usageSchema,
  attributeUsage,
  GENERATION_LIMITS,
  codexBackoffMs,
} from '@cosmew/contracts';

export interface MediaOptions {
  /** Private continuation state is replayed only to its exact originating endpoint/model. */
  replayBinding?: Pick<ProviderReplay, 'providerId' | 'accountId' | 'protocol' | 'modelId' | 'endpointHash'>;
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
 * Cosmew messages → AI SDK messages, including assistant tool calls and tool results. Tool media
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
    if (m.role === 'user' && m.attachments?.length) {
      out.push({
        role: 'user',
        content:
          media.vision === 'unsupported'
            ? m.content + '\n' + mediaNote(m.attachments.length)
            : [
                {type: 'text', text: m.content},
                ...m.attachments.map(a => ({type: 'file' as const, data: a.data, mediaType: a.mime, filename: a.name})),
              ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.providerReplay && media.replayBinding) {
      const replay = providerReplaySchema.parse(m.providerReplay);
      const bound = media.replayBinding;
      if (
        (replay.protocol !== 'chat' || media.replayReasoning) &&
        replay.providerId === bound.providerId &&
        replay.accountId === bound.accountId &&
        replay.protocol === bound.protocol &&
        replay.modelId === bound.modelId &&
        replay.endpointHash === bound.endpointHash
      ) {
        const namespace =
          replay.protocol === 'responses' ? 'openai' : replay.protocol === 'gemini' ? 'google' : 'anthropic';
        out.push({
          role: 'assistant',
          content: replay.parts.map(part => {
            const providerOptions = part.metadata ? {[namespace]: part.metadata} : undefined;
            if (part.type === 'tool-call') {
              const call = m.toolCalls?.find(c => c.id === part.callId);
              if (!call) throw new FutrynError('INVALID_INPUT');
              return {
                type: 'tool-call' as const,
                toolCallId: call.id,
                toolName: call.name,
                input: call.input,
                providerOptions,
              };
            }
            return {type: part.type, text: part.text, providerOptions};
          }),
        });
        continue;
      }
    }
    if (m.role === 'assistant' && m.toolCalls) {
      out.push({
        role: 'assistant',
        content: [
          ...(media.replayReasoning && !m.providerReplay && m.reasoning
            ? [{type: 'reasoning' as const, text: m.reasoning}]
            : []),
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
import {isEncryptedHistoryError, normalizeError, ProviderTransport, wait} from './http';

export function stripProviderReplay(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map(m => {
      if (!m.providerReplay) return m;
      const {providerReplay: _providerReplay, ...rest} = m;
      return rest;
    }),
  };
}

const estimateAttachmentTokens = (attachment: {mime: string; data: unknown}): number => {
  if (typeof attachment.data !== 'string') return 0;
  const decodedBytes = Math.floor((attachment.data.length * 3) / 4);
  return attachment.mime === 'application/pdf' ? Math.max(1600, Math.ceil(decodedBytes / 30)) : 1600;
};

/**
 * Conservative request input token estimate (~3 UTF-8 bytes per token). Media attachments are
 * priced per media budget rather than base64 length so large images/PDFs do not trip cost caps.
 */
export function estimateRequestInputTokens(request: ModelRequest): number {
  let mediaTokens = 0;
  const sanitizedMessages = request.messages.map(message => {
    if (!message.attachments?.length) return message;
    for (const attachment of message.attachments) {
      mediaTokens += estimateAttachmentTokens(attachment);
    }
    return {
      ...message,
      attachments: message.attachments.map(({mime, name}) => ({mime, name})),
    };
  });
  const utf8Bytes =
    Buffer.byteLength(JSON.stringify(sanitizedMessages) ?? '') +
    Buffer.byteLength(JSON.stringify(request.tools ?? []) ?? '') +
    Buffer.byteLength(request.instructions ?? '');
  return Math.ceil(utf8Bytes / 3) + mediaTokens + request.messages.length * 4 + 256;
}

type ChatUsageConverter = NonNullable<Parameters<typeof createOpenAICompatible>[0]['convertUsage']>;
/** Provider usage fields are user supplied JSON. Invalid/negative counters are unknown, never zero. */
const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const firstTokenCount = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== undefined) return count;
  }
  return undefined;
};

const moneyAmount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const firstMoneyAmount = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const amount = moneyAmount(value);
    if (amount !== undefined) return amount;
  }
  return undefined;
};

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
  const prompt = firstTokenCount(raw.prompt_tokens, raw.input_tokens, raw.inputTokens, raw.promptTokens);
  const completion = firstTokenCount(raw.completion_tokens, raw.output_tokens, raw.outputTokens, raw.completionTokens);
  const cached = firstTokenCount(
    raw.prompt_tokens_details?.cached_tokens,
    raw.prompt_tokens_details?.cache_read_tokens,
    raw.input_token_details?.cached_tokens,
    raw.input_token_details?.cache_read_tokens,
    raw.inputTokenDetails?.cacheReadTokens,
    raw.cachedInputTokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_input_tokens,
    raw.cache_read_tokens,
  );
  const cacheWrite = firstTokenCount(
    raw.prompt_tokens_details?.cache_write_tokens,
    raw.prompt_tokens_details?.cache_creation_tokens,
    raw.input_token_details?.cache_write_tokens,
    raw.inputTokenDetails?.cacheWriteTokens,
    raw.prompt_cache_write_tokens,
    raw.cache_write_input_tokens,
  );
  const reasoning = firstTokenCount(
    raw.completion_tokens_details?.reasoning_tokens,
    raw.output_token_details?.reasoning_tokens,
    raw.outputTokenDetails?.reasoningTokens,
    raw.reasoning_tokens,
    raw.reasoningTokens,
  );
  const noCache = firstTokenCount(
    raw.prompt_tokens_details?.no_cache_tokens,
    raw.input_token_details?.no_cache_tokens,
    raw.inputTokenDetails?.noCacheTokens,
  );
  return {
    inputTokens: {
      total: prompt,
      noCache:
        noCache ??
        (prompt !== undefined && cached !== undefined ? Math.max(0, prompt - cached - (cacheWrite ?? 0)) : undefined),
      cacheRead: cached,
      cacheWrite,
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
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
    };
    outputTokenDetails?: {reasoningTokens?: number; textTokens?: number};
    /** AI SDK 4/5 compatibility fields retained by some provider adapters. */
    cachedInputTokens?: number;
    reasoningTokens?: number;
    raw?: unknown;
  },
  info?: ModelInfo,
): Usage => {
  const inputTokens = tokenCount(u.inputTokens);
  const outputTokens = tokenCount(u.outputTokens);
  const cacheReadTokens = firstTokenCount(u.inputTokenDetails?.cacheReadTokens, u.cachedInputTokens);
  const cacheWriteTokens = tokenCount(u.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens = firstTokenCount(u.outputTokenDetails?.reasoningTokens, u.reasoningTokens);
  const raw = u.raw && typeof u.raw === 'object' ? (u.raw as Record<string, unknown>) : undefined;
  // Some gateways return an exact USD amount. Trust it only when the field is explicitly named in USD.
  const reportedCost = firstMoneyAmount(raw?.costUSD, raw?.cost_usd);
  const estimatedCost =
    reportedCost === undefined && info?.pricing && inputTokens !== undefined && outputTokens !== undefined
      ? (inputTokens * info.pricing.inputPerMillion + outputTokens * info.pricing.outputPerMillion) / 1000000
      : undefined;
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    ...(cacheReadTokens !== undefined ? {cacheReadTokens} : {}),
    ...(cacheWriteTokens !== undefined ? {cacheWriteTokens} : {}),
    ...(reasoningTokens !== undefined ? {reasoningTokens} : {}),
    ...(info?.pricing ? {pricingSource: info.metadataSource, pricingAt: info.metadataFetchedAt} : {}),
    costUSD: reportedCost ?? estimatedCost ?? null,
    ...(estimatedCost !== undefined || reportedCost !== undefined ? {costEstimated: estimatedCost !== undefined} : {}),
  };
};
/** Unparseable or non-object arguments still reach the router, which rejects them as INVALID_INPUT. */
const objectInput = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {invalidArguments: String(JSON.stringify(input) ?? input).slice(0, 1000)};

/**
 * Provider SDKs type tool names and ids as arbitrary strings.  Keep the wire boundary strict so a
 * malformed call cannot enter the core journal (the tool router still owns unknown, but well-formed,
 * tool names).  Invalid arguments deliberately remain data for the router to reject.
 */
const normalizeToolCall = (id: unknown, name: unknown, input: unknown): ToolCall => {
  const call = {
    id: typeof id === 'string' ? id : '',
    name: typeof name === 'string' ? name : '',
    input: objectInput(input),
  };
  if (!toolCallSchema.safeParse(call).success) throw new FutrynError('PROTOCOL');
  return call;
};

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
  private attributedUsage(value: Usage): Usage {
    return attributeUsage(value, {
      accountId: this.transport.account.id,
      providerId: this.transport.provider.id,
      modelId: this.modelId,
    });
  }
  private replayBinding() {
    const p = this.transport.provider;
    return {
      providerId: p.id,
      accountId: this.transport.account.id,
      protocol: p.protocol as ProviderReplay['protocol'],
      modelId: this.modelId,
      endpointHash: new Bun.CryptoHasher('sha256').update(p.baseURL).digest('hex'),
    };
  }
  /** SDK content is authoritative for ordering and final signatures; deltas are display-only. */
  private captureReplay(content: readonly unknown[]): ProviderReplay | undefined {
    const protocol = this.transport.provider.protocol;
    if (protocol === 'chat' && !this.transport.provider.replayReasoning) return;
    const namespace = protocol === 'responses' ? 'openai' : protocol === 'gemini' ? 'google' : 'anthropic';
    const keys =
      protocol === 'responses'
        ? ['itemId', 'reasoningEncryptedContent']
        : protocol === 'gemini'
          ? ['thoughtSignature']
          : protocol === 'anthropic'
            ? ['signature', 'redactedData', 'type']
            : [];
    let hasMetadata = false;
    const parts: ProviderReplay['parts'] = [];
    for (const value of content) {
      const part = value as {
        type: string;
        text?: string;
        toolCallId?: string;
        providerMetadata?: Record<string, Record<string, unknown>>;
      };
      if (!['text', 'reasoning', 'tool-call'].includes(part.type)) continue;
      const source = part.providerMetadata?.[namespace];
      const metadata = Object.fromEntries(
        keys.flatMap(key => (typeof source?.[key] === 'string' ? [[key, source[key]]] : [])),
      );
      hasMetadata ||= Object.keys(metadata).length > 0;
      const extra = Object.keys(metadata).length ? {metadata} : {};
      if (part.type === 'tool-call') parts.push({type: 'tool-call', callId: part.toolCallId!, ...extra});
      else parts.push({type: part.type as 'text' | 'reasoning', text: part.text ?? '', ...extra});
    }
    if (!hasMetadata && !(protocol === 'chat' && parts.some(part => part.type === 'reasoning'))) return;
    const parsed = providerReplaySchema.safeParse({version: 1, ...this.replayBinding(), parts});
    if (!parsed.success) {
      const onlyContentSizeLimit = parsed.error.issues.every(
        issue =>
          issue.message === 'continuation state exceeds limit' ||
          (issue.code === 'too_big' &&
            !issue.path.includes('metadata') &&
            issue.path[0] === 'parts' &&
            (issue.path.length === 1 || issue.path[2] === 'text')),
      );
      if (onlyContentSizeLimit) return;
      throw new FutrynError('PROTOCOL');
    }
    return parsed.data;
  }
  private async options(input: ModelRequest, signal?: AbortSignal) {
    let request: ModelRequest;
    try {
      request = requestSchema.parse(input);
    } catch {
      throw new FutrynError('INVALID_INPUT');
    }
    if (request.modelId !== this.modelId) throw new FutrynError('INVALID_INPUT');
    const p = this.transport.provider;
    const effort = request.reasoningEffort;
    const thinking =
      effort && (p.protocol === 'anthropic' || p.protocol === 'gemini')
        ? resolveThinkingWire(p, p.protocol, this.info, effort, request.maxOutputTokens)
        : undefined;
    const maxOutputTokens = thinking?.maxOutputTokens ?? this.outputCap(request);
    // The Anthropic SDK adds the budget back to max_tokens. Keep the wire cap
    // within the request/model ceiling and reserve at least one output token.
    const sdkMaxOutputTokens =
      maxOutputTokens === undefined ? undefined : maxOutputTokens - (thinking?.thinkingBudget ?? 0);
    // Unknown capability is tried (ADR 0017); only a model known to reject tools is refused up front.
    if (request.tools.length && this.info?.capabilities.tools === 'unsupported') throw new FutrynError('UNSUPPORTED');
    if (request.maxEstimatedCostUSD !== undefined) {
      const prices = this.info?.pricing;
      if (!prices) throw new FutrynError('BUDGET');
      // Deliberately an estimate guard, not an exact tokenizer or provider billing ceiling.
      const inputEstimate = estimateRequestInputTokens(request);
      const outputEstimate =
        maxOutputTokens ?? this.info?.outputLimit ?? GENERATION_LIMITS.anthropicFallbackOutputTokens;
      if (
        (inputEstimate * prices.inputPerMillion + outputEstimate * prices.outputPerMillion) / 1000000 >
        request.maxEstimatedCostUSD
      )
        throw new FutrynError('BUDGET');
    }
    if (
      effort &&
      !thinking &&
      (this.info?.capabilities.reasoning === 'unsupported' || !this.info?.reasoningEfforts?.includes(effort))
    )
      throw new FutrynError('UNSUPPORTED', false, null, 'levels');
    if (this.info?.contextLimit && maxOutputTokens !== undefined && maxOutputTokens >= this.info.contextLimit)
      throw new FutrynError('CONTEXT_LIMIT');
    const key = await this.transport.credential(signal);
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
    // passed to the Cosmew ToolRouter, which answers the model with INVALID_INPUT / UNKNOWN_TOOL, as
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
    let ajv2020: Ajv2020 | undefined;
    for (const descriptor of request.tools) {
      let validate: ValidateFunction;
      try {
        const dialect = descriptor.inputSchema.$schema;
        const validator =
          dialect === 'https://json-schema.org/draft/2020-12/schema' ||
          dialect === 'https://json-schema.org/draft/2020-12/schema#'
            ? (ajv2020 ??= new Ajv2020({
                strict: true,
                coerceTypes: false,
                removeAdditional: false,
                useDefaults: false,
                validateFormats: true,
                logger: false,
              }))
            : ajv;
        validate = validator.compile(descriptor.inputSchema);
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
    const providerOptions =
      p.protocol === 'responses'
        ? {
            store: false,
            include: ['reasoning.encrypted_content'],
            ...(request.cacheKey ? {promptCacheKey: promptCacheKey(request.cacheKey)} : {}),
            ...(request.reasoningEffort
              ? {
                  reasoningEffort: request.reasoningEffort,
                  forceReasoning: true,
                  // Explicit null suppresses the AI SDK's implicit detailed summary.
                  reasoningSummary: p.id === 'openai' && p.baseURL === 'https://api.openai.com/v1' ? 'auto' : null,
                }
              : {}),
          }
        : p.protocol === 'chat' && request.reasoningEffort
          ? {reasoningEffort: request.reasoningEffort}
          : undefined;
    // The OpenAI-compatible AI SDK adapter names its provider options after the configured
    // provider (`<id>.chat` -> `<id>`). This is the only generic Chat transport option we
    // pass through: model metadata must explicitly advertise the effort first (above).
    const providerOptionsByProtocol =
      thinking?.providerOptions ??
      (providerOptions === undefined
        ? undefined
        : p.protocol === 'responses'
          ? {openai: providerOptions}
          : {[p.id]: providerOptions});
    return {
      model,
      ...(request.instructions ? {system: request.instructions} : {}),
      messages: toModelMessages(request.messages, {
        protocol: p.protocol,
        replayBinding: this.replayBinding(),
        vision: this.info?.capabilities.vision,
        replayReasoning: p.protocol === 'chat' && p.replayReasoning === true,
      }),
      ...(sdkMaxOutputTokens !== undefined ? {maxOutputTokens: sdkMaxOutputTokens} : {}),
      ...(providerOptionsByProtocol ? {providerOptions: providerOptionsByProtocol} : {}),
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
    const hasReplay = request.messages.some(m => m.providerReplay);
    let started = false;
    let observedOutput = false;
    try {
      for await (const event of this.doStream(request, signal)) {
        if (event.type === 'started') started = true;
        else observedOutput = true;
        yield event;
      }
    } catch (e) {
      // A streamed tool may already have executed in core. Retrying here after
      // observable output would duplicate work without the loop's discard protocol.
      if (hasReplay && !observedOutput && !signal?.aborted && isEncryptedHistoryError(e)) {
        for await (const event of this.doStream(stripProviderReplay(request), signal, started)) {
          yield event;
        }
        return;
      }
      throw e;
    }
  }

  private async *doStream(request: ModelRequest, signal?: AbortSignal, skipStarted = false): AsyncIterable<ModelEvent> {
    const options = await this.options(request, signal);
    let complete = false;
    const calls = new Set<string>();
    const pending = new Set<string>();
    // A call whose arguments did not parse may be a stream cut mid-arguments (the AI SDK flushes unfinished
    // calls as `invalid`). It is held until a clean finish proves the response complete (ADR 0033); parsed
    // calls are emitted at once so the agent loop can dispatch them while the response still streams.
    const held: ToolCall[] = [];
    try {
      if (!skipStarted) yield {type: 'started', requestId: request.requestId};
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
          const call = normalizeToolCall(part.toolCallId, part.toolName, part.input);
          if ('invalid' in part && part.invalid) held.push(call);
          else yield {type: 'toolCallComplete', call};
        } else if (part.type === 'finish') {
          const quota = options.responseHeaders.value ? parseRateLimitHeaders(options.responseHeaders.value) : [];
          const reported = this.attributedUsage(
            usageSchema.parse({...usage(part.totalUsage, this.info), ...(quota.length ? {quota} : {})}),
          );
          yield {type: 'usage', usage: reported};
          if (part.finishReason === 'error' || ['other', 'interrupted'].includes(part.finishReason) || pending.size)
            throw new FutrynError('PROTOCOL');
          for (const call of held.splice(0)) yield {type: 'toolCallComplete', call};
          // Codex Completed { end_turn: Some(false) }: the only such signal these transports expose is
          // Anthropic's `pause_turn` (the AI SDK folds it into "stop" but keeps the raw reason).
          const raw = (part as {rawFinishReason?: unknown}).rawFinishReason;
          const providerReplay = this.captureReplay(await result.content);
          if (providerReplay) yield {type: 'providerReplay', replay: providerReplay};
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
  ): Promise<{text: string; calls: ToolCall[]; usage: Usage; finishReason: string; providerReplay?: ProviderReplay}> {
    const hasReplay = request.messages.some(m => m.providerReplay);
    // OAuth Responses generation delegates to stream(), which owns its one retry.
    const streamOwnsRecovery =
      this.transport.provider.auth === 'oauth' && this.transport.provider.protocol === 'responses';
    try {
      return await this.doGenerate(request, signal);
    } catch (e) {
      if (hasReplay && !streamOwnsRecovery && !signal?.aborted && isEncryptedHistoryError(e)) {
        return await this.doGenerate(stripProviderReplay(request), signal);
      }
      throw e;
    }
  }

  private async doGenerate(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<{text: string; calls: ToolCall[]; usage: Usage; finishReason: string; providerReplay?: ProviderReplay}> {
    // ChatGPT plan inference requires stream=true and store=false, including validation probes.
    if (this.transport.provider.auth === 'oauth' && this.transport.provider.protocol === 'responses') {
      let text = '';
      const calls: ToolCall[] = [];
      let providerReplay: ProviderReplay | undefined;
      let completion: {usage: Usage; finishReason: string} | undefined;
      for await (const event of this.stream(request, signal)) {
        if (event.type === 'textDelta') text += event.text;
        else if (event.type === 'toolCallComplete') calls.push(event.call);
        else if (event.type === 'providerReplay') providerReplay = event.replay;
        else if (event.type === 'completed') completion = event;
      }
      if (!completion) throw new FutrynError('PROTOCOL');
      return {
        text,
        calls,
        usage: completion.usage,
        finishReason: completion.finishReason,
        ...(providerReplay ? {providerReplay} : {}),
      };
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
      const providerReplay = this.captureReplay(result.content);
      const quota = options.responseHeaders.value ? parseRateLimitHeaders(options.responseHeaders.value) : [];
      return {
        ...(providerReplay ? {providerReplay} : {}),
        text: result.text,
        calls: result.toolCalls.map(call => normalizeToolCall(call.toolCallId, call.toolName, call.input)),
        usage: this.attributedUsage(
          usageSchema.parse({...usage(result.totalUsage, this.info), ...(quota.length ? {quota} : {})}),
        ),
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
