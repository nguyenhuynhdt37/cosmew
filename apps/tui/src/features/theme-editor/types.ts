export interface ThemeEditorState {
  targetThemeId: string;
  editMode: 'dark' | 'light';
  selectedTokenIndex: number;
  editingHex: boolean;
  hexDraft: string;
  renaming: boolean;
  nameDraft: string;
  statusMessage?: string;
}

export function createInitialThemeEditorState(themeId = 'auto', mode: 'dark' | 'light' = 'dark'): ThemeEditorState {
  return {
    targetThemeId: themeId,
    editMode: mode,
    selectedTokenIndex: 0,
    editingHex: false,
    hexDraft: '',
    renaming: false,
    nameDraft: '',
  };
}
