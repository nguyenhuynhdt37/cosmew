import type { ThemePickerTab } from '../../theme/theme';

export const THEME_PICKER_TABS: readonly { id: ThemePickerTab; label: string }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'colors', label: 'Colors' },
  { id: 'live', label: 'Live' },
  { id: 'my-themes', label: 'My Themes' },
];

export interface ThemePickerState {
  tab: ThemePickerTab;
  query: string;
  selectedIndex: number;
  statusMessage?: string;
}

export function createInitialThemePickerState(): ThemePickerState {
  return { tab: 'featured', query: '', selectedIndex: 0 };
}
