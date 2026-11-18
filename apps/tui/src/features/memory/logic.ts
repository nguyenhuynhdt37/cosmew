import type {MemoryState} from './types';
export function memoryRows(state: MemoryState): string[] {
  if (state.detail) return state.detail.split('\n');
  return state.entries.length
    ? state.entries.map(
        (entry, n) =>
          `${n === state.index ? '>' : ' '} ${entry.name} (${entry.type})${entry.unused ? ' · lâu không dùng — cân nhắc xoá (D)' : ''} — ${entry.description} · ${entry.usage_count} lần dùng${entry.last_usage ? ` · ${entry.last_usage}` : ''}`,
      )
    : ['No memories.'];
}
