/** Keep recently painted content reusable across remounts without retaining the entire transcript. */
export function renderCache<Key, Value>(limit: number) {
  const entries = new Map<Key, Value>();
  return (key: Key, compute: () => Value): Value => {
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const value = compute();
    entries.set(key, value);
    if (entries.size > limit) entries.delete(entries.keys().next().value!);
    return value;
  };
}
