import type {ModelPort, Usage} from '@cosmew/contracts';

/** Account one stream's final reported snapshot even when its consumer rejects the result. */
export function accountModelUsage(model: ModelPort, record: (usage: Usage) => void): ModelPort {
  return {
    generate: (request, signal) => model.generate(request, signal),
    async *stream(request, signal) {
      let usage: Usage | null = null;
      try {
        for await (const event of model.stream(request, signal)) {
          if (event.type === 'usage' || event.type === 'completed') usage = event.usage ?? usage;
          yield event;
        }
      } finally {
        if (usage) record(usage);
      }
    },
  };
}
