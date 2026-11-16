import type { AppearanceConfig } from '@futryn/contracts';

export interface SettingRow { label: string; value: string }

/** The rows shown in /config, in the order the controller's index maps to. */
export function settingsRows(appearance: AppearanceConfig, effectiveMode: 'dark' | 'light'): SettingRow[] {
  const a = appearance.animations;
  return [
    { label: 'Active Theme', value: `${appearance.theme} (Press Enter to open /theme)` },
    { label: 'Color Mode', value: `${appearance.mode === 'system' ? 'AUTO' : appearance.mode.toUpperCase()} (resolved: ${effectiveMode})` },
    { label: 'Wallpaper', value: 'Unavailable for these themes' },
    { label: 'Animations Enabled', value: a.enabled ? 'ENABLED' : 'DISABLED' },
    { label: 'Motion Mode', value: a.motion.toUpperCase() },
    { label: 'Animation Speed', value: `${a.speed.toFixed(2)}x` },
    { label: 'Cell Size / Density', value: `${a.cellSize}x` },
    { label: 'Readability Veil', value: `${Math.round(a.veil * 100)}%` },
    { label: 'Reduced Motion', value: a.reducedMotion ? 'ON' : 'OFF' },
    { label: 'Pause When Unfocused', value: a.pauseUnfocused ? 'ON' : 'OFF' },
    { label: 'Reactive Agent Effects', value: a.reactiveEffects ? 'ON' : 'OFF' },
    { label: 'Syntax Highlighting', value: appearance.syntaxHighlighting ? 'ON' : 'OFF' },
    { label: 'Sidebar Panel', value: appearance.sidebar ? 'VISIBLE' : 'COLLAPSED' },
  ];
}

export const SETTINGS_ROW_COUNT = 13;

export const clampStep = (value: number, step: number, min: number, max: number, digits = 2): number =>
  Math.max(min, Math.min(max, Number((value + step).toFixed(digits))));
