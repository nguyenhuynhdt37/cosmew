export interface CommandPaletteState {
  query: string;
  selectedIndex: number;
}

export function createInitialCommandPaletteState(): CommandPaletteState {
  return { query: '', selectedIndex: 0 };
}
