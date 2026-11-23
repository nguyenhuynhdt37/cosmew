import {attributeUsage, FutrynError, type CompactionOutcome} from '@cosmew/contracts';
import {estimateContextTokens, normalizeHistory} from '../context/builder';
import {compactHistory, useContextSnapshot} from '../context/compaction';
import {
  assembleHandoff,
  modelSnapshot,
  modelSnapshotMessages,
  retainRecentUserMessages,
  summarizeWithModel,
} from '../context/model-compaction';
import {SAFETY_LIMITS, type TurnHost} from './turn-types';

/**
 * `/compact` (ADR 0054; Codex `Op::Compact` → `run_compact_task`): checkpoint an idle conversation.
 * The model writes the handoff; any non-cancellation failure falls back to the extractive checkpoint.
 * Durable history is never modified. Cancellation preserves billed usage without publishing a checkpoint.
 */
export async function compactConversation(
  host: TurnHost,
  instructions: string | undefined,
  signal?: AbortSignal,
): Promise<CompactionOutcome> {
  const {state, store} = host;
  const recovered = store.recover?.(host.id);
  if (recovered?.messages.length) state.messages = normalizeHistory(recovered.messages);
  state.snapshot = recovered?.compaction ?? state.snapshot;
  state.task = recovered?.task ?? state.task;

  const normalized = normalizeHistory(state.messages);
  const visible = useContextSnapshot(normalized, state.snapshot);
  const tokensBefore = estimateContextTokens(visible);
  const unchanged = (reason: string, usage: CompactionOutcome['usage'] = null): CompactionOutcome => ({
    compacted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    usage,
    reason,
  });
  if (!normalized.some(m => m.role === 'user')) return unchanged('empty');
  signal?.throwIfAborted();

  const contextLimit = host.options.contextLimit?.() ?? SAFETY_LIMITS.unknownContextTokens;
  const window = Math.max(1, contextLimit);
  let failure = 'PROTOCOL';
  let usage: CompactionOutcome['usage'] = null;
  try {
    const summary = await summarizeWithModel({
      model: host.model,
      selection: host.selection,
      visible,
      instructions,
      window,
      signal,
      onUsage: reported => {
        usage = attributeUsage(reported, {sessionId: host.id});
        store.addUsage?.(host.id, usage);
      },
    });
    const handoff = assembleHandoff(summary.text, visible, store.loadPlan?.(host.id));
    const snapshot = modelSnapshot(normalized, handoff, retainRecentUserMessages(normalized));
    const tokensAfter = estimateContextTokens(modelSnapshotMessages(snapshot));
    if (tokensAfter >= tokensBefore) return unchanged('not_needed', usage);
    store.saveContextSnapshot?.(host.id, snapshot);
    state.snapshot = snapshot;
    return {compacted: true, strategy: 'model', tokensBefore, tokensAfter, usage};
  } catch (error) {
    if (signal?.aborted || (error instanceof FutrynError && error.code === 'STORAGE')) throw error;
    failure = error instanceof FutrynError ? error.code : 'ERROR';
  }

  // Fallback (never worse than before this feature): the deterministic excerpt checkpoint.
  const snapshot = await compactHistory(
    normalized,
    state.task,
    Math.max(0, tokensBefore - 1),
    host.options.compactor,
    signal,
  );
  if (!snapshot) return unchanged(failure, usage);
  store.saveContextSnapshot?.(host.id, snapshot);
  state.snapshot = snapshot;
  return {
    compacted: true,
    strategy: 'excerpt',
    fallback: true,
    tokensBefore,
    tokensAfter: estimateContextTokens(useContextSnapshot(normalized, snapshot)),
    usage,
    reason: failure,
  };
}
