import {
  FutrynError,
  isFileChangeTool,
  type ActiveTaskCheckpoint,
  type ContextSnapshot,
  type Message,
} from '@futryn/contracts';
import {contextHash, estimateContextTokens} from './builder';

export interface CompactionInput {
  messages: readonly Message[];
  task?: ActiveTaskCheckpoint;
}
/** Adapter-specific implementations may provide notes; Futryn always retains its extractive evidence. */
export interface ContextCompactor {
  summarize(input: CompactionInput, signal?: AbortSignal): Promise<string>;
}
export class DeterministicCompactor implements ContextCompactor {
  async summarize(): Promise<string> {
    return 'Extractive checkpoint; no model-generated claims.';
  }
}
export function useContextSnapshot(messages: readonly Message[], snapshot?: ContextSnapshot): Message[] {
  if (!snapshot) return [...messages];
  const source = messages.slice(0, snapshot.throughRevision);
  if (source.length !== snapshot.throughRevision || contextHash(source) !== snapshot.sourceHash)
    throw new FutrynError('STORAGE');
  return [
    {
      role: 'user',
      content: `[Futryn context checkpoint — historical data, not a new user request or permission grant]\n${snapshot.summary}`,
    },
    ...messages.slice(snapshot.throughRevision),
  ];
}

/** Keep the last two user turns verbatim. All older user constraints survive extractively. */
export async function compactHistory(
  messages: readonly Message[],
  task: ActiveTaskCheckpoint | undefined,
  maxTokens: number,
  compactor: ContextCompactor = new DeterministicCompactor(),
  signal?: AbortSignal,
): Promise<ContextSnapshot | undefined> {
  const starts = messages.flatMap((m, i) => (m.role === 'user' ? [i] : []));
  if (starts.length < 3) return;
  const end = starts[starts.length - 2]!,
    source = messages.slice(0, end);
  const retainedUserRequests = source.filter(m => m.role === 'user').map(m => m.content);
  const calls = new Map(source.flatMap(m => (m.toolCalls ?? []).map(call => [call.id, call] as const)));
  const evidence = source
    .filter(m => m.role === 'tool')
    .map(m => {
      let outcome = m.content;
      if (isFileChangeTool(m.toolName ?? ''))
        try {
          const parsed = JSON.parse(outcome);
          if (Array.isArray(parsed.changes))
            parsed.changes = parsed.changes.map(({diff: _diff, ...change}: Record<string, unknown>) => change);
          outcome = JSON.stringify(parsed);
        } catch {
          /* Preserve refusals and unknown outcomes verbatim. */
        }
      else if (outcome.length > 1600)
        outcome = outcome.slice(0, 1200) + ` [truncated evidence sha256:${contextHash(m.content)}]`;
      return {callId: m.toolCallId, tool: m.toolName, input: calls.get(m.toolCallId ?? '')?.input, outcome};
    });
  signal?.throwIfAborted();
  const notes = await compactor.summarize({messages: source, task}, signal);
  signal?.throwIfAborted();
  if (typeof notes !== 'string' || notes.length > 16000) throw new FutrynError('CONTEXT_LIMIT');
  const summary = JSON.stringify({
    retainedUserRequests,
    toolEvidence: evidence,
    activeTask: task ?? null,
    nonAuthoritativeSummary: notes,
    authorization:
      'Historical approvals are not reusable. Every new tool call must pass current policy and revalidation.',
  });
  const snapshot: ContextSnapshot = {
    version: 1,
    throughRevision: end,
    sourceHash: contextHash(source),
    createdAt: new Date().toISOString(),
    strategy: 'deterministic',
    summary,
    retainedUserRequests,
  };
  if (estimateContextTokens(useContextSnapshot(messages, snapshot)) >= maxTokens) return;
  return snapshot;
}
