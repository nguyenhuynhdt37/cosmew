import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { wideLayout } from '../../core/layout';
import { renderHelpOverlay } from './view';

const MAX_OFFSET = 40;

export class HelpFeature implements OverlayFeature {
  readonly overlays = ['help'] as const;
  private offset = 0;

  constructor(private readonly host: TuiHost) {}

  open(): void { this.offset = 0; }

  layout(_overlay: 'help', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'help', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderHelpOverlay({ ...size, scrollOffset: this.offset, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  handleKey(_overlay: 'help', key: string): void {
    if (key === 'ArrowDown' || key === 'PageDown') this.offset = Math.min(MAX_OFFSET, this.offset + (key === 'PageDown' ? 8 : 1));
    else if (key === 'ArrowUp' || key === 'PageUp') this.offset = Math.max(0, this.offset - (key === 'PageUp' ? 8 : 1));
    else if (key === 'Escape' || key === 'Enter') this.host.closeOverlay();
  }
}
