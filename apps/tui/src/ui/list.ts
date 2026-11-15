/** Selection arithmetic shared by every pickable list. */

/** Move `index` by one with wrap-around; unchanged when the list is empty. */
export function stepIndex(index: number, key: string, length: number): number {
  if (length <= 0) return index;
  const delta = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
  return (index + delta + length) % length;
}

export const isVerticalKey = (key: string): boolean => key === 'ArrowDown' || key === 'ArrowUp';

export function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), index));
}

/** Window that keeps the selection in the middle of the viewport. */
export function windowCentered(total: number, selected: number, rows: number): number {
  return Math.max(0, Math.min(selected - Math.floor(rows / 2), Math.max(0, total - rows)));
}

/** Window that only scrolls once the selection passes the last visible row. */
export function windowTrailing(selected: number, rows: number): number {
  return Math.max(0, selected - rows + 1);
}
