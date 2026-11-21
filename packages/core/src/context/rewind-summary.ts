import {type Message, type ModelPort, type PlanState, type Selection, type Usage} from '@cosmew/contracts';
import {extractiveSummary} from './compaction';
import {assembleHandoff, SUMMARY_PREFIX, summarizeWithModel} from './model-compaction';

/** Summarize exactly the checkpoint suffix. Pure until the host commits a fork after cancellation checks. */
export async function summarizeCheckpointSpan(input: {
  model: ModelPort;
  selection: Selection;
  messages: readonly Message[];
  instructions?: string;
  window: number;
  plan?: PlanState | null;
  signal?: AbortSignal;
}): Promise<{message: Message; strategy: 'model' | 'excerpt'; fallback?: true; usage: Usage | null}> {
  input.signal?.throwIfAborted();
  let text: string;
  let strategy: 'model' | 'excerpt' = 'model';
  let usage: Usage | null = null;
  try {
    const summary = await summarizeWithModel({...input, visible: input.messages});
    text = summary.text;
    usage = summary.usage;
  } catch (error) {
    if (input.signal?.aborted) throw error;
    strategy = 'excerpt';
    text = extractiveSummary(input.messages);
  }
  input.signal?.throwIfAborted();
  return {
    message: {role: 'user', content: `${SUMMARY_PREFIX}\n${assembleHandoff(text, input.messages, input.plan)}`},
    strategy,
    ...(strategy === 'excerpt' ? {fallback: true} : {}),
    usage,
  };
}
