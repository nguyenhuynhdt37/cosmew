import {renderCache} from '../../ui/render-cache';
import type {TranscriptItem} from './logic';

const MAX_RETAINED_WEIGHT = 4 * 1024 * 1024;

/** Count all retained item payloads, including tool arguments and hook/part text. */
export function createPresentationCache<Value>() {
  // Transcript snapshots and their nested payloads are immutable. Reused tool
  // inputs therefore cost one bounded traversal, not a stringify on each delta.
  const weights = new WeakMap<object, number>();
  const weightOf = (value: unknown, depth = 0): number => {
    if (depth > 64) return MAX_RETAINED_WEIGHT + 1;
    if (typeof value === 'string') return Math.min(MAX_RETAINED_WEIGHT + 1, value.length * 2 + 16);
    if (value === null || typeof value !== 'object') return 8;
    const known = weights.get(value);
    if (known !== undefined) return known;
    // Cycles are not valid model JSON; conservatively bypass rather than recurse.
    weights.set(value, MAX_RETAINED_WEIGHT + 1);
    let weight = 32;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      weight += key.length * 2 + 8 + weightOf((value as Record<string, unknown>)[key], depth + 1);
      if (weight > MAX_RETAINED_WEIGHT) break;
    }
    weights.set(value, weight);
    return weight;
  };
  return renderCache<TranscriptItem, Value>(48, {maxWeight: MAX_RETAINED_WEIGHT, weight: item => weightOf(item)});
}
