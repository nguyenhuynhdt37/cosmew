export type ThemeLayout = 'side' | 'stacked' | 'compact';

/** List beside the preview on wide terminals, below it on medium ones, a short sample on small ones. */
export function themeLayout(width: number, rows: number | undefined): ThemeLayout {
  const tall = rows === undefined || rows >= 19;
  if (width < 46 || !tall) return 'compact';
  return width >= 70 ? 'side' : 'stacked';
}

/** Width of the theme list in the side layout; the preview gets the rest. */
export function sideListWidth(width: number): number {
  return Math.max(22, Math.min(30, Math.floor(width * 0.34)));
}

/** Picker tabs: one theme for every background, or the day (light) / night (dark) slot of Sync with system. */
export type ThemeTab = 'single' | 'day' | 'night';
const TABS: readonly ThemeTab[] = ['single', 'day', 'night'];

export function stepTab(tab: ThemeTab, step: 1 | -1): ThemeTab {
  return TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]!;
}

/** Synced appearances open on the slot that is showing now. */
export function initialTab(syncWithSystem: boolean, systemDark: boolean): ThemeTab {
  if (!syncWithSystem) return 'single';
  return systemDark ? 'night' : 'day';
}

export function slotMode(tab: Exclude<ThemeTab, 'single'>): 'light' | 'dark' {
  return tab === 'day' ? 'light' : 'dark';
}

/** Footer label for a binding: its first chord, capitalised; empty when the user unbound it. */
export function firstChordLabel(label: string): string {
  const first = label.split('/')[0]?.trim() ?? '';
  if (!first || first === 'unbound') return '';
  return first[0]!.toUpperCase() + first.slice(1);
}
