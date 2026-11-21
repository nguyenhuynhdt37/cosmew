/** Claude Code 2.1.330 B5/B7: recent detailed history, separate from the 200-message render cap. */
export const DETAILED_RECENT_LIMIT = 30;

export function visibleWindow<T>(
  items: readonly T[],
  showAll: boolean,
  limit = DETAILED_RECENT_LIMIT,
): {items: readonly T[]; hidden: number} {
  const hidden = showAll ? 0 : Math.max(0, items.length - limit);
  return {items: hidden ? items.slice(hidden) : items, hidden};
}
