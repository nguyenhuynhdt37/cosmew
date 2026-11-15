import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { wideLayout } from '../../core/layout';
import { stepIndex } from '../../ui';
import { SETTINGS_ROW_COUNT, clampStep } from './logic';
import type { SettingsOverlayState } from './types';
import { renderSettingsOverlay } from './view';

export class SettingsFeature implements OverlayFeature {
  readonly overlays = ['settings'] as const;
  /** Selection persists between openings so the user returns to the row they left. */
  private state: SettingsOverlayState = { selectedIndex: 0 };

  constructor(private readonly host: TuiHost) {}

  open(): void { /* intentionally keeps the previous selection */ }

  layout(_overlay: 'settings', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'settings', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderSettingsOverlay({
      ...size,
      appearance: this.host.themeEngine.getActiveAppearance(),
      effectiveMode: theme.effectiveMode,
      selectedIndex: this.state.selectedIndex,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  async handleKey(_overlay: 'settings', key: string): Promise<void> {
    const { host } = this;
    if (key === 'Escape') { host.closeOverlay(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.state = { selectedIndex: stepIndex(this.state.selectedIndex, key, SETTINGS_ROW_COUNT) };
      return;
    }
    if (!(key === 'Enter' || key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight')) return;

    const engine = host.themeEngine;
    const app = engine.getActiveAppearance();
    const anim = app.animations;
    const dir = key === 'ArrowLeft' ? -1 : 1;
    switch (this.state.selectedIndex) {
      case 0: host.openOverlay('themes'); break;
      case 1: {
        const modes: ('dark' | 'light' | 'system')[] = ['dark', 'light', 'system'];
        await engine.setMode(modes[(modes.indexOf(app.mode) + dir + modes.length) % modes.length]!);
        break;
      }
      case 2: host.setBanner('Wallpaper is unavailable for these themes.'); break;
      case 3: await engine.updateAnimation({ enabled: !anim.enabled }); break;
      case 4: await engine.updateAnimation({ motion: anim.motion === 'smooth' ? 'grid' : 'smooth' }); break;
      case 5: await engine.updateAnimation({ speed: clampStep(anim.speed, dir * 0.25, 0.1, 16) }); break;
      case 6: await engine.updateAnimation({ cellSize: Math.max(1, Math.min(4, anim.cellSize + dir)) }); break;
      case 7: await engine.updateAnimation({ veil: clampStep(anim.veil, dir * 0.05, 0, 0.95) }); break;
      case 8: await engine.updateAnimation({ reducedMotion: !anim.reducedMotion }); break;
      case 9: await engine.updateAnimation({ pauseUnfocused: !anim.pauseUnfocused }); break;
      case 10: await engine.updateAnimation({ reactiveEffects: !anim.reactiveEffects }); break;
      case 11: await engine.updateAppearance({ syntaxHighlighting: !app.syntaxHighlighting }); break;
      case 12: await engine.updateAppearance({ sidebar: !app.sidebar }); break;
    }
  }
}
