export interface ModelPickerState {
  effortDraft?: {modelId: string; value: string};
  query: string;
  selectedIndex: number;
  addingManual: boolean;
  manualDraft: string;
  statusMessage?: string;
}

export function createInitialModelPickerState(): ModelPickerState {
  return {query: '', selectedIndex: 0, addingManual: false, manualDraft: ''};
}
