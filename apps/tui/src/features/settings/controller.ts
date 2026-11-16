import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {wideLayout} from '../../core/layout';
import {stepIndex} from '../../ui';
import {SETTINGS_SECTIONS, clampStep, configurationRows} from './logic';
import type {SettingsOverlayState} from './types';
import {renderSettingsOverlay} from './view';

export class SettingsFeature implements OverlayFeature {
  readonly overlays = ['settings'] as const;
  /** Selection persists between openings so the user returns to the row they left. */
  private state: SettingsOverlayState = {selectedIndex: 0, section: 'General', appearanceScope: 'global'};

  constructor(private readonly host: TuiHost) {}

  open(): void {
    /* intentionally keeps the previous selection */
  }

  layout(_overlay: 'settings', cols: number, rows: number) {
    return wideLayout(cols, rows);
  }

  render(_overlay: 'settings', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderSettingsOverlay({
      ...size,
      appearance: this.host.themeEngine.getActiveAppearance(),
      effectiveMode: theme.effectiveMode,
      selectedIndex: this.state.selectedIndex,
      section: this.state.section,
      appearanceScope: this.state.appearanceScope,
      rows: configurationRows(
        this.host.client,
        this.state.section,
        this.host.themeEngine.getActiveAppearance(),
        theme.effectiveMode,
      ),
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  async handleKey(_overlay: 'settings', key: string): Promise<void> {
    const {host} = this;
    if (key === 'Escape') {
      host.closeOverlay();
      return;
    }
    if (key === 'Ctrl+G' && this.state.section === 'Appearance') {
      this.state = {...this.state, appearanceScope: this.state.appearanceScope === 'global' ? 'project' : 'global'};
      host.setBanner(
        `Appearance saves to ${this.state.appearanceScope === 'global' ? 'user defaults' : 'this workspace'}. Workspace overrides take precedence.`,
      );
      return;
    }
    if (key === 'Tab' || key === 'Shift+Tab') {
      const index = SETTINGS_SECTIONS.indexOf(this.state.section);
      const direction = key === 'Tab' ? 1 : -1;
      this.state = {
        ...this.state,
        selectedIndex: 0,
        section: SETTINGS_SECTIONS[(index + direction + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length]!,
      };
      return;
    }
    const rows = configurationRows(
      host.client,
      this.state.section,
      host.themeEngine.getActiveAppearance(),
      host.themeEngine.getActiveAppearance().mode === 'light' ? 'light' : 'dark',
    );
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      this.state = {...this.state, selectedIndex: stepIndex(this.state.selectedIndex, key, rows.length)};
      return;
    }
    if (!(key === 'Enter' || key === ' ' || key === 'ArrowLeft' || key === 'ArrowRight')) return;

    const row = rows[this.state.selectedIndex];
    if (!row) return;
    if (row.disabled) {
      host.setBanner(row.disabled);
      return;
    }
    if (!row.action) return;
    if (host.isStreaming && !row.action.startsWith('appearance-')) {
      host.setBanner('Wait for the active turn before changing agent settings.');
      return;
    }
    const direction = key === 'ArrowLeft' ? -1 : 1;
    try {
      if (row.action.startsWith('budget-')) {
        const choices = {
          'budget-steps': {key: 'maxSteps', values: [undefined, 8, 16, 32, 64]},
          'budget-calls': {key: 'maxToolCalls', values: [undefined, 16, 32, 64, 128]},
          'budget-tokens': {key: 'maxTokens', values: [undefined, 10000, 50000, 100000]},
          'budget-time': {key: 'maxDurationMs', values: [undefined, 60000, 300000, 900000]},
          'budget-cost': {key: 'maxCostUSD', values: [undefined, 1, 5, 10, 50]},
        } as const;
        const preset = choices[row.action as keyof typeof choices];
        const budget = host.client.turnBudget() ?? {};
        const index = (preset.values as readonly (number | undefined)[]).indexOf(budget[preset.key]);
        const value = preset.values[(index + direction + preset.values.length) % preset.values.length];
        if (value === undefined) delete budget[preset.key];
        else budget[preset.key] = value;
        host.client.setDefaultTurnBudget(budget);
        host.setBanner('Saved user work budget. Applies to future turns and restarts; permissions are unchanged.');
        return;
      }
      if (row.action === 'mode') {
        host.client.cycleMode();
        host.setBanner(`Agent mode: ${host.client.mode()}. Applies to the next turn.`);
        return;
      }
      if (!row.action.startsWith('appearance-')) {
        if (row.action === 'accounts') await host.runSlashCommand('/accounts');
        else host.openOverlay(row.action as 'models' | 'effort' | 'permissions' | 'sessions' | 'context' | 'status');
        return;
      }
    } catch (error) {
      host.setBanner(host.describeError(error));
      return;
    }

    const engine = host.themeEngine;
    const app = engine.getActiveAppearance();
    const anim = app.animations;
    const dir = key === 'ArrowLeft' ? -1 : 1;
    try {
      switch (Number(row.action.slice('appearance-'.length))) {
        case 0: {
          const themes = ['auto', 'dark', 'light'];
          await engine.setTheme(
            themes[(themes.indexOf(app.theme) + dir + themes.length) % themes.length]!,
            this.state.appearanceScope,
          );
          break;
        }
        case 1: {
          const modes: ('dark' | 'light' | 'system')[] = ['dark', 'light', 'system'];
          await engine.setMode(
            modes[(modes.indexOf(app.mode) + dir + modes.length) % modes.length]!,
            this.state.appearanceScope,
          );
          break;
        }
        case 2:
          host.setBanner('Wallpaper is unavailable for these themes.');
          break;
        case 3:
          await engine.updateAnimation({enabled: !anim.enabled}, this.state.appearanceScope);
          break;
        case 4:
          await engine.updateAnimation(
            {motion: anim.motion === 'smooth' ? 'grid' : 'smooth'},
            this.state.appearanceScope,
          );
          break;
        case 5:
          await engine.updateAnimation({speed: clampStep(anim.speed, dir * 0.25, 0.1, 16)}, this.state.appearanceScope);
          break;
        case 6:
          await engine.updateAnimation(
            {cellSize: Math.max(1, Math.min(4, anim.cellSize + dir))},
            this.state.appearanceScope,
          );
          break;
        case 7:
          await engine.updateAnimation({veil: clampStep(anim.veil, dir * 0.05, 0, 0.95)}, this.state.appearanceScope);
          break;
        case 8:
          await engine.updateAnimation({reducedMotion: !anim.reducedMotion}, this.state.appearanceScope);
          break;
        case 9:
          await engine.updateAnimation({pauseUnfocused: !anim.pauseUnfocused}, this.state.appearanceScope);
          break;
        case 10:
          await engine.updateAnimation({reactiveEffects: !anim.reactiveEffects}, this.state.appearanceScope);
          break;
        case 11:
          await engine.updateAppearance({syntaxHighlighting: !app.syntaxHighlighting}, this.state.appearanceScope);
          break;
        case 12:
          await engine.updateAppearance({sidebar: !app.sidebar}, this.state.appearanceScope);
          break;
      }
    } catch (error) {
      host.setBanner(host.describeError(error));
    }
  }
}
