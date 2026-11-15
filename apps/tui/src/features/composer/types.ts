export interface ComposerState {
  value: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  draftBeforeHistory: string;
  slashMenuOpen: boolean;
  slashSelectedIndex: number;
  fileMenuOpen: boolean;
  fileSelectedIndex: number;
  fileQuery: string;
  attachedFiles: string[];
}

export function createInitialComposerState(): ComposerState {
  return {
    value: '',
    cursor: 0,
    history: [],
    historyIndex: -1,
    draftBeforeHistory: '',
    slashMenuOpen: false,
    slashSelectedIndex: 0,
    fileMenuOpen: false,
    fileSelectedIndex: 0,
    fileQuery: '',
    attachedFiles: [],
  };
}
