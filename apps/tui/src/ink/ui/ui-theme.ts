import {mixHex} from '../../theme/presets';
import {useTheme} from '../theme';
/** Presentation aliases only: the existing ThemeEngine owns mode, customization and NO_COLOR. */
export function useUiTheme() {
  const theme = useTheme();
  const light = theme.mode === 'light';
  const tokens = {
    accent: theme.tokens.accent,
    bashMode: light ? '#ad7fa8' : '#fd5db1',
    planMode: light ? '#05727e' : '#8abeb7',
    /** Selection pointer and chosen option (measured, spec 9). */
    selected: light ? '#05727e' : '#8abeb7',
    /** File paths and inline names. */
    path: theme.tokens.info,
    /** Rules, panel frames and the spinner. */
    rule: theme.tokens.border,
    acceptEdits: light ? '#7952b3' : '#af87ff',
    bypass: theme.tokens.error,
    dim: theme.tokens.foregroundMuted,
    success: theme.tokens.success,
    /** The `⏺` marker of a finished tool or event (measured, spec 9); `success` stays for other uses. */
    toolSuccess: light ? '#4e9a06' : '#b5bd68',
    error: theme.tokens.error,
    panel: theme.tokens.backgroundPanel,
    planDivider: light ? theme.tokens.foregroundMuted : '#73767b',
    userMessage: theme.tokens.composerBackground,
  };
  return {
    ...theme,
    uiTokens: tokens,
    color: (token: keyof typeof tokens) => (theme.colors ? tokens[token] : undefined),
    diffTint: (token: 'diffAdded' | 'diffRemoved') =>
      theme.colors ? mixHex(theme.tokens.backgroundPanel, theme.tokens[token], light ? 0.12 : 0.16) : undefined,
    diffHunk: () => (theme.colors ? mixHex(theme.tokens.syntaxFunction, theme.tokens.diffAdded, 0.25) : undefined),
    diffSelection: () => (theme.colors ? mixHex(theme.tokens.selection, theme.tokens.info, 0.18) : undefined),
  };
}
export type UiThemeToken = keyof ReturnType<typeof useUiTheme>['uiTokens'];
