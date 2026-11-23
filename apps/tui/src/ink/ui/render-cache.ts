/** Keep recently painted content reusable across remounts without retaining the entire transcript. */
export function renderCache<Key, Value>(
  limit: number,
  options?: {maxWeight: number; weight(key: Key, value: Value): number},
) {
  const entries = new Map<Key, {value: Value; weight: number}>();
  let retained = 0;
  return (key: Key, compute: () => Value): Value => {
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.value;
    }
    const value = compute();
    const weight = options?.weight(key, value) ?? 1;
    // Huge transient snapshots should neither persist nor flush the useful small cache.
    if (options && weight > options.maxWeight) return value;
    entries.set(key, {value, weight});
    retained += weight;
    while (entries.size > limit || (options && retained > options.maxWeight)) {
      const oldest = entries.keys().next().value!;
      retained -= entries.get(oldest)!.weight;
      entries.delete(oldest);
    }
    return value;
  };
}
