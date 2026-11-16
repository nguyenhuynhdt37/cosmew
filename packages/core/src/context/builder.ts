import {createHash} from 'node:crypto';
import {FutrynError, isFileChangeTool, type Message} from '@futryn/contracts';
export const contextHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Conservative UTF-8 estimate; provider metadata supplies the actual window and measured usage. */
export const estimateContextTokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '') / 3);

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
    return {
      ...message,
      content:
        content.slice(0, Math.floor(limit / 2)) +
        `\n[Futryn context truncation: sha256 ${contextHash(content)}; output omitted, not a complete read]\n` +
        content.slice(-Math.floor(limit / 4)),
    };
  });
}
