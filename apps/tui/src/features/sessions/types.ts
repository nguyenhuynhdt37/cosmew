export interface SessionPickerState {
  query: string;
  selectedIndex: number;
}

export function createInitialSessionPickerState(): SessionPickerState {
  return { query: '', selectedIndex: 0 };
}
