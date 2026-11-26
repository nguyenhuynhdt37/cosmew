import {createHash} from 'node:crypto';
import {FutrynError, isFileChangeTool, type Message} from '@cosmew/contracts';
export const contextHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Durable message fingerprint for ContextSnapshot validation. User attachments are ephemeral and
 * `tool_attachments` may be evicted past `MAX_SESSION_ATTACHMENT_BYTES`, so neither can invalidate
 * a persisted snapshot.
 */
export function snapshotSourceHash(messages: readonly Message[]): string {
  return contextHash(messages.map(({attachments: _attachments, ...durable}) => durable));
}
/** Conservative UTF-8 estimate; provider metadata supplies the actual window and measured usage. */
/**
 * Conservative token estimate (about 3 bytes per token). Attachments (ADR 0041) are not counted by
 * their base64 size: an image is about 1 600 tokens (Anthropic's documented cap for a resized
 * image); a PDF about one token per 30 bytes, at least 1 600.
 */
export function contextSize(value: unknown): {bytes: number; media: number} {
  let media = 0;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && 'mime' in item && 'data' in item && typeof item.data === 'string') {
      const bytes = Math.floor((item.data.length * 3) / 4);
      media += item.mime === 'application/pdf' ? Math.max(1600, Math.ceil(bytes / 30)) : 1600;
      return {mime: item.mime};
    }
    return item;
  });
  return {bytes: Buffer.byteLength(text ?? ''), media};
}

export const estimateContextTokens = (value: unknown) => {
  const {bytes, media} = contextSize(value);
  return Math.ceil(bytes / 3) + media;
};

/** Repair only the protocol envelope, never execution. Missing results explicitly mean unknown. */
export function normalizeHistory(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    while (end < messages.length && messages[end]!.role !== 'user') end++;
    const segment = messages.slice(start, end),
      results = new Map<string, Message>(),
      calls = new Set<string>();
    for (const message of segment)
      if (message.role === 'tool') {
        if (!message.toolCallId || results.has(message.toolCallId)) throw new FutrynError('PROTOCOL');
        results.set(message.toolCallId, message);
      }
    for (const message of segment)
      if (message.role !== 'tool') {
        out.push({...message});
        for (const call of message.toolCalls ?? []) {
          if (calls.has(call.id)) throw new FutrynError('PROTOCOL');
          calls.add(call.id);
          const result = results.get(call.id);
          if (result && result.toolName && result.toolName !== call.name) throw new FutrynError('PROTOCOL');
          out.push(
            result ?? {
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content:
                '[unknown: interrupted execution] No durable result confirms this call. It may not have run, or its effects may have occurred. Inspect current state before any new mutation; do not replay this call or reuse old approval.',
            },
          );
        }
      }
    if ([...results.keys()].some(id => !calls.has(id))) throw new FutrynError('PROTOCOL');
    start = end;
  }
  return out;
}

/** Actual bounded archive references only; never fabricate a handle from a digest or call id. */
export function toolOutputReferences(messages: readonly Message[], max = 32): string[] {
  const references = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' && message.role !== 'user') continue;
    for (const match of message.content.matchAll(
      /\[tool_output output_id=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}; use tool_output to retrieve archived evidence\]/gi,
    )) {
      references.delete(match[0]);
      references.add(match[0]);
    }
  }
  return [...references].slice(-max);
}

/** UTF-8 byte slice with complete code points at both boundaries. */
function utf8Slice(bytes: Buffer, start: number, end: number): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(start, end).toString('utf8');
}

/** Shrink only model-visible read output. Durable receipts and the original transcript stay intact. */
export function truncateToolResults(messages: readonly Message[], maxBytes: number): Message[] {
  const limit = Math.max(256, maxBytes);
  return messages.map(message => {
    if (
      message.role !== 'tool' ||
      isFileChangeTool(message.toolName ?? '') ||
      Buffer.byteLength(message.content) <= limit
    )
      return {...message};
    const content = message.content;
    const bytes = Buffer.from(content);
    const references = toolOutputReferences([message], 1);
    return {
      ...message,
      content:
        utf8Slice(bytes, 0, Math.floor(limit / 2)) +
        `\n[Cosmew context truncation: sha256 ${contextHash(content)}; output omitted, not a complete read]\n` +
        utf8Slice(bytes, bytes.length - Math.floor(limit / 4), bytes.length) +
        (references.length ? `\n${references.join('\n')}` : ''),
    };
  });
}
