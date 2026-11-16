export interface DiffViewState {
  view?: 'all' | 'staged' | 'unstaged' | 'untracked';
  selectedFileIndex: number;
  scrollOffset: number;
}

export function createInitialDiffViewState(): DiffViewState {
  return {selectedFileIndex: 0, scrollOffset: 0};
}
