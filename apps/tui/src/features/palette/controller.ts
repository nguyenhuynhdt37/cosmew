import { wideLayout } from '../../core/layout';
import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { editField, stepIndex } from '../../ui';
import { filterPaletteCommands } from './logic';
import { createInitialCommandPaletteState, type CommandPaletteState } from './types';
import { renderCommandPaletteOverlay } from './view';

export class PaletteFeature implements OverlayFeature {
  readonly overlays = ['palette'] as const;
  private state: CommandPaletteState = createInitialCommandPaletteState();

  constructor(private readonly host: TuiHost) {}

  open(): void { this.state = createInitialCommandPaletteState(); }

  layout(_overlay: 'palette', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'palette', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderCommandPaletteOverlay({ ...size, state: this.state, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  async handleKey(_overlay: 'palette', key: string): Promise<void> {
    const matches = filterPaletteCommands(this.state.query);
    if (key === 'Escape') { this.host.closeOverlay(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (matches.length) this.state = { ...this.state, selectedIndex: stepIndex(this.state.selectedIndex, key, matches.length) };
      return;
    }
    if (key === 'Enter') {
      const chosen = matches[this.state.selectedIndex];
      this.host.closeOverlay();
      if (chosen) await this.host.runSlashCommand(chosen.command);
      return;
    }
    const query = editField(this.state.query, key, { max: Number.MAX_SAFE_INTEGER });
    if (query !== null) this.state = { ...this.state, query, selectedIndex: 0 };
  }
}
