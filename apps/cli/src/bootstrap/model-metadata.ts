import type {ModelInfo} from '@cosmew/contracts';

/** Fresh advisory metadata without levels is a completed lookup, not a reason to retry. */
export function needsEffortMetadata(model: ModelInfo, now = Date.now()): boolean {
  return (
    model.capabilities.reasoning !== 'unsupported' &&
    !model.reasoningEfforts?.length &&
    (model.metadataSource !== 'https://models.dev/api.json' ||
      !model.metadataFetchedAt ||
      !Number.isFinite(Date.parse(model.metadataFetchedAt)) ||
      now - Date.parse(model.metadataFetchedAt) > 24 * 60 * 60 * 1000)
  );
}

/** One bounded request per application, including discovery. A caller cannot cancel other consumers. */
export function sharedModelMetadata(fetchMetadata: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) {
  let request: Promise<unknown> | undefined;
  return () =>
    (request ??= (async () => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      bounded.throwIfAborted();
      let abort: () => void = () => {};
      try {
        return await Promise.race([
          fetchMetadata(bounded),
          new Promise<never>((_, reject) => {
            abort = () => reject(bounded.reason);
            bounded.addEventListener('abort', abort, {once: true});
            if (bounded.aborted) abort();
          }),
        ]);
      } finally {
        bounded.removeEventListener('abort', abort);
      }
    })());
}
