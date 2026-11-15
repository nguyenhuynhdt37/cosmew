import { wideLayout } from '../../core/layout';
import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { createInitialDiffViewState, type DiffViewState } from './types';
import { renderDiffViewerOverlay } from './view';

export class DiffFeature implements OverlayFeature {
  readonly overlays = ['diff'] as const;
  readonly needsWorkspace = true;
  private state: DiffViewState = createInitialDiffViewState();

  constructor(private readonly host: TuiHost) {}

  open(): void { this.state = createInitialDiffViewState(); }

  layout(_overlay: 'diff', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'diff', size: { width: number; height: number }, theme: ThemeFrame) {
    return renderDiffViewerOverlay({ ...size, report: this.host.client.getWorkspaceDiff(), state: this.state, tokens: theme.tokens, borderStyle: theme.borderStyle });
  }

  handleKey(_overlay: 'diff', key: string): void {
    const report = this.host.client.getWorkspaceDiff();
    if (key === 'Escape') { this.host.closeOverlay(); return; }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab') {
      if (report.files.length === 0) return;
      const delta = key === 'ArrowLeft' ? -1 : 1;
      this.state = { selectedFileIndex: (this.state.selectedFileIndex + delta + report.files.length) % report.files.length, scrollOffset: 0 };
      return;
    }
    if (key === 'PageDown') { this.state = {...this.state, scrollOffset:this.state.scrollOffset + Math.max(1, this.layout('diff', this.host.cols, this.host.rows).height - 4)}; return; }
    if (key === 'PageUp') { this.state = {...this.state, scrollOffset:Math.max(0,this.state.scrollOffset - Math.max(1,this.layout('diff', this.host.cols, this.host.rows).height - 4))}; return; }
    if (key === 'ArrowDown') this.state = { ...this.state, scrollOffset: this.state.scrollOffset + 1 };
    else if (key === 'ArrowUp') this.state = { ...this.state, scrollOffset: Math.max(0, this.state.scrollOffset - 1) };
  }
}
