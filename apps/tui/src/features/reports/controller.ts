import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { wideLayout } from '../../core/layout';
import { reportRows } from './logic';
import { REPORT_TITLES, type ReportKind, type ReportState } from './types';
import { renderReportOverlay } from './view';

/** Read-only /status, /usage and /context reports sharing one scrollable dialog. */
export class ReportsFeature implements OverlayFeature {
  readonly overlays = ['status', 'usage', 'context'] as const;
  private state: ReportState = { offset: 0, details: false };
  private limitsLoading = false;
  private limitsAbort: AbortController | null = null;

  constructor(private readonly host: TuiHost) {}

  open(overlay: ReportKind): void {
    this.state = { offset: 0, details: false };
    if (overlay === 'usage') this.refreshLimits();
  }

  close(): void { this.limitsAbort?.abort(); this.limitsAbort = null; this.limitsLoading = false; }

  async shutdown(): Promise<void> { this.close(); }

  /** Fetch live provider limits in the background; the dialog repaints when they arrive. */
  private refreshLimits(): void {
    if (this.limitsLoading) return;
    const abort = new AbortController();
    this.limitsAbort = abort;
    this.limitsLoading = true;
    void this.host.client.refreshLimits(abort.signal).finally(() => {
      if (this.limitsAbort === abort) { this.limitsLoading = false; this.limitsAbort = null; }
    });
  }

  layout(_overlay: ReportKind, cols: number, rows: number) {
    const wide = wideLayout(cols, rows, true);
    return this.state.details ? wide : { ...wide, width: Math.min(cols - 2, 58) };
  }

  render(overlay: ReportKind, size: { width: number; height: number }, theme: ThemeFrame) {
    const report = renderReportOverlay({
      title: REPORT_TITLES[overlay],
      rows: reportRows(this.host.client, overlay, this.host.composerDraft, this.state.details),
      width: size.width,
      height: size.height,
      offset: this.state.offset,
      details: this.state.details,
      tokens: theme.tokens,
    });
    this.state.offset = report.offset;
    return report.lines;
  }

  handleKey(overlay: ReportKind, key: string): void {
    const page = Math.max(1, Math.floor(this.host.rows * 0.6));
    if (overlay === 'usage' && key.toLowerCase() === 'r') { this.refreshLimits(); return; }
    if (key.toLowerCase() === 'd') { this.state = { ...this.state, details: !this.state.details, offset: 0 }; return; }
    if (key === 'ArrowDown' || key === 'PageDown') this.state.offset += key === 'PageDown' ? page : 1;
    else if (key === 'ArrowUp' || key === 'PageUp') this.state.offset = Math.max(0, this.state.offset - (key === 'PageUp' ? page : 1));
    if (key === 'Escape' || key === 'Enter') this.host.closeOverlay();
  }
}
