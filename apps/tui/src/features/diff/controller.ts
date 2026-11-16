import type {WorkspaceDiffReport} from '@futryn/contracts';
import {wideLayout} from '../../core/layout';
import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {createInitialDiffViewState, type DiffViewState} from './types';
import {renderDiffViewerOverlay} from './view';

export class DiffFeature implements OverlayFeature {
  readonly overlays = ['diff'] as const;
  readonly needsWorkspace = true;
  private state: DiffViewState = createInitialDiffViewState();

  constructor(private readonly host: TuiHost) {}

  open(): void {
    this.state = createInitialDiffViewState();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      await this.host.client.refreshWorkspaceDiff?.();
    } catch (error) {
      this.host.setBanner(this.host.describeError(error));
    } finally {
      this.host.requestRender?.();
    }
  }

  private report(): WorkspaceDiffReport {
    const report = this.host.client.getWorkspaceDiff();
    const files = report.files.filter(
      file => !this.state.view || this.state.view === 'all' || file.layer === this.state.view,
    );
    return {
      ...report,
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  layout(_overlay: 'diff', cols: number, rows: number) {
    return cols >= 140
      ? {width: Math.floor(cols * 0.48), height: Math.max(1, rows - 2), backdrop: false}
      : wideLayout(cols, rows, true);
  }

  render(_overlay: 'diff', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderDiffViewerOverlay({
      ...size,
      report: this.report(),
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  handleKey(_overlay: 'diff', key: string): void {
    const report = this.report();
    if (key === 'c' || key === 'C') {
      const file = report.files[Math.max(0, Math.min(this.state.selectedFileIndex, report.files.length - 1))];
      if (file)
        this.host.copyText(
          `${file.path} (${file.layer ?? file.status}) +${file.additions} -${file.deletions}\n${file.lines.map(line => (line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'context' ? ' ' : '') + line.content).join('\n')}`,
        );
      return;
    }
    if (key === 'r' || key === 'R') {
      void this.refresh();
      return;
    }
    if (['a', 's', 'u', 'n'].includes(key)) {
      this.state = {
        view: ({a: 'all', s: 'staged', u: 'unstaged', n: 'untracked'} as const)[key as 'a'],
        selectedFileIndex: 0,
        scrollOffset: 0,
      };
      return;
    }
    if (key === 'Escape') {
      this.host.closeOverlay();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Tab') {
      if (report.files.length === 0) return;
      const delta = key === 'ArrowLeft' ? -1 : 1;
      this.state = {
        ...this.state,
        selectedFileIndex: (this.state.selectedFileIndex + delta + report.files.length) % report.files.length,
        scrollOffset: 0,
      };
      return;
    }
    if (key === 'PageDown') {
      this.state = {
        ...this.state,
        scrollOffset:
          this.state.scrollOffset + Math.max(1, this.layout('diff', this.host.cols, this.host.rows).height - 4),
      };
      return;
    }
    if (key === 'PageUp') {
      this.state = {
        ...this.state,
        scrollOffset: Math.max(
          0,
          this.state.scrollOffset - Math.max(1, this.layout('diff', this.host.cols, this.host.rows).height - 4),
        ),
      };
      return;
    }
    if (key === 'ArrowDown') this.state = {...this.state, scrollOffset: this.state.scrollOffset + 1};
    else if (key === 'ArrowUp') this.state = {...this.state, scrollOffset: Math.max(0, this.state.scrollOffset - 1)};
  }
}
