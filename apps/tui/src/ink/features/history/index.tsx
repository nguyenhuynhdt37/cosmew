/** @jsxImportSource react */
import {useState} from 'react';
import {TextLine} from '../../ui';

export function recordHistory(history: readonly string[], content: string): string[] {
  const clean = content.trim();
  return clean ? [...history.filter(item => item !== clean), clean].slice(-100) : [...history];
}
export function searchHistory(history: readonly string[], query: string, before = history.length): number {
  for (let i = Math.min(before, history.length) - 1; i >= 0; i--) {
    if (history[i]!.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return i;
  }
  return -1;
}
export function useHistory(initial: readonly string[] = []) {
  const [entries, setEntries] = useState(() =>
    initial.reduce<string[]>((items, text) => recordHistory(items, text), []),
  );
  return {entries, setEntries, record: (content: string) => setEntries(items => recordHistory(items, content))};
}
export interface HistoryProps {
  query: string;
  match?: string;
  width?: number;
}
export function History({query, match, width}: HistoryProps) {
  return (
    <TextLine
      width={width}
    >{`History (${query}): ${match ?? 'No match'} · Ctrl+R older · Enter restore · Ctrl+G cancel`}</TextLine>
  );
}
