import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {wideLayout} from '../../core/layout';
import {transcriptLines} from './logic';
import {renderAgents} from './view';
import type {AgentsState} from './types';

const empty = (): AgentsState => ({
  report: {types: [], errors: [], warnings: []},
  children: [],
  index: 0,
  detail: [],
  detailTitle: '',
  offset: 0,
  message: '',
});

/** `/agents` (S5b, ADR 0058): agent types, this session's subagents, transcript view and stop. */
export class AgentsFeature implements OverlayFeature {
  readonly overlays = ['agents'] as const;
  readonly needsWorkspace = true;
  private state: AgentsState = empty();
  constructor(private readonly host: TuiHost) {}

  open(): void {
    this.state = empty();
    this.refresh();
  }

  private refresh(): void {
    const {client} = this.host;
    this.state.report = client.agentTypes();
    this.state.children = client.subagents();
    this.state.index = Math.max(0, Math.min(this.state.children.length - 1, this.state.index));
  }

  layout(_overlay: 'agents', cols: number, rows: number) {
    return wideLayout(cols, rows, true);
  }

  render(_overlay: 'agents', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderAgents(this.state, size, theme);
  }

  async handleKey(_overlay: 'agents', key: string): Promise<void> {
    const state = this.state;
    if (key === 'Escape') {
      if (state.detail.length) {
        state.detail = [];
        state.offset = 0;
      } else this.host.closeOverlay();
      return;
    }
    const down = key === 'Down' || key === 'ArrowDown';
    const up = key === 'Up' || key === 'ArrowUp';
    if (down || up) {
      if (state.detail.length) state.offset = Math.max(0, state.offset + (down ? 1 : -1));
      else state.index = Math.max(0, Math.min(state.children.length - 1, state.index + (down ? 1 : -1)));
      return;
    }
    if (state.detail.length) return;
    try {
      if (key.toLowerCase() === 'r') {
        this.refresh();
        state.message = 'Refreshed.';
        return;
      }
      const child = state.children[state.index];
      if (!child) return;
      if (key === 'Enter') {
        const view = this.host.client.inspectSubagent(child.id) ?? child;
        state.detail = transcriptLines(view);
        state.detailTitle = child.id.slice(0, 8);
        state.offset = 0;
      } else if (key.toLowerCase() === 'x') {
        const stopped = this.host.client.stopSubagent(child.id);
        state.message = stopped ? `Stopping ${child.id.slice(0, 8)}...` : `${child.id.slice(0, 8)} is not running.`;
        this.refresh();
      }
    } catch (error) {
      state.message = this.host.describeError(error);
    }
  }
}
