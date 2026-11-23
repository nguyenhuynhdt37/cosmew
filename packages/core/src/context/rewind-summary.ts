import {FutrynError, type Message, type ModelPort, type PlanState, type Selection, type Usage} from '@cosmew/contracts';
import {extractiveSummary} from './compaction';
import {assembleHandoff, SUMMARY_PREFIX, summarizeWithModel} from './model-compaction';

/** Summarize the checkpoint suffix without context writes; the host accounts billing separately. */
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
    const summary = await summarizeWithModel({
      ...input,
      visible: input.messages,
      onUsage: reported => {
        usage = reported;
      },
    });
    text = summary.text;
  } catch (error) {
    if (input.signal?.aborted || (error instanceof FutrynError && error.code === 'STORAGE')) throw error;
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
