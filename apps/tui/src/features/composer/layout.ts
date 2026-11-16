import {graphemes, textWidth} from '../../input/text';

interface VisualRow {
  text: string;
  start: number;
}
/** Two width variants, one draft each. Append reflows only the final visual row. */
const cache = new Map<number, {value: string; rows: VisualRow[]}>();
export function composerVisualRows(value: string, width: number): VisualRow[] {
  const prior = cache.get(width);
  if (prior?.value === value) return prior.rows;
  const append = prior && value.startsWith(prior.value);
  const rows = append ? prior.rows.slice(0, -1) : [];
  const from = append ? prior.rows.at(-1)!.start : 0;
  let offset = from;
  for (const line of value.slice(from).split('\n')) {
    let text = '',
      start = offset,
      columns = 0;
    for (const {segment, index} of graphemes(line)) {
      const cells = textWidth(segment);
      if (columns + cells > width && text) {
        rows.push({text, start});
        text = '';
        start = offset + index;
        columns = 0;
      }
      text += segment;
      columns += cells;
    }
    rows.push({text, start});
    if (columns === width) rows.push({text: '', start: offset + line.length});
    offset += line.length + 1;
  }
  cache.delete(width);
  cache.set(width, {value, rows});
  while (cache.size > 2) cache.delete(cache.keys().next().value!);
  return rows;
}
