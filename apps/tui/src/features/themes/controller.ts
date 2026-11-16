import type {OverlayFeature, OverlayLayout, ThemeFrame, TuiHost} from '../../core/feature';
import {stepIndex} from '../../ui';
import {createInitialThemePickerState, type ThemePickerState} from './types';
import {renderThemePickerOverlay} from './view';

export class ThemesFeature implements OverlayFeature {
  readonly overlays = ['themes'] as const;
  private state: ThemePickerState = createInitialThemePickerState();

  constructor(private readonly host: TuiHost) {}

  open(): void {
    const {themeEngine} = this.host;
    const current = themeEngine.getCommittedAppearance().theme;
    const index = themeEngine.listThemes('all').findIndex(theme => theme.id === current);
    this.state = {...createInitialThemePickerState(), selectedIndex: Math.max(0, index)};
  }

  /** Leaving the picker without applying must undo any live preview. */
  close(): void {
    if (this.host.themeEngine.isPreviewing()) this.host.themeEngine.cancelPreview();
  }

  layout(_overlay: 'themes', cols: number, rows: number): OverlayLayout {
    return {width: Math.min(cols - 2, 52), height: Math.min(rows - 2, 9), backdrop: true};
  }

  render(_overlay: 'themes', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderThemePickerOverlay({
      ...size,
      engine: this.host.themeEngine,
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  async handleKey(_overlay: 'themes', key: string): Promise<void> {
    const {host} = this;
    const list = host.themeEngine.listThemes('all');
    if (key === 'Escape') {
      host.themeEngine.cancelPreview();
      host.closeOverlay();
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!list.length) return;
      const selectedIndex = stepIndex(this.state.selectedIndex, key, list.length);
      this.state = {...this.state, selectedIndex};
      host.themeEngine.previewTheme(list[selectedIndex]!.id);
      return;
    }
    if (key === 'Enter') {
      const selected = list[this.state.selectedIndex];
      if (selected) {
        await host.themeEngine.setTheme(selected.id);
        host.setBanner(`Theme: ${selected.name}.`);
      }
      host.closeOverlay();
    }
  }
}
