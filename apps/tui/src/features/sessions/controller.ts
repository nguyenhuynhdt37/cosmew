import { wideLayout } from '../../core/layout';
import type { OverlayFeature, ThemeFrame, TuiHost } from '../../core/feature';
import { editField, stepIndex } from '../../ui';
import { filterSessions } from './logic';
import { createInitialSessionPickerState, type SessionPickerState } from './types';
import { renderSessionPickerOverlay } from './view';

export class SessionsFeature implements OverlayFeature {
  readonly overlays = ['sessions'] as const;
  private state: SessionPickerState = createInitialSessionPickerState();

  constructor(private readonly host: TuiHost) {}

  open(): void { this.state = createInitialSessionPickerState(); }

  layout(_overlay: 'sessions', cols: number, rows: number) { return wideLayout(cols, rows); }

  render(_overlay: 'sessions', size: { width: number; height: number }, theme: ThemeFrame) {
    const { client } = this.host;
    return renderSessionPickerOverlay({
      ...size,
      sessions: client.listSessions(),
      activeSessionId: client.status().activeSessionId,
      state: this.state,
      tokens: theme.tokens,
      borderStyle: theme.borderStyle,
    });
  }

  async handleKey(_overlay: 'sessions', key: string): Promise<void> {
    const { host, state } = this;
    const filtered = filterSessions(host.client.listSessions(), state.query);
    if (key === 'Escape') { host.closeOverlay(); return; }
    if (key === 'Ctrl+N') { await host.runSlashCommand('/new'); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (filtered.length) this.state = { ...state, selectedIndex: stepIndex(state.selectedIndex, key, filtered.length) };
      return;
    }
    if (key === 'Ctrl+X' || key === 'Delete') {
      const target = filtered[state.selectedIndex];
      if (target) {
        host.client.deleteSession(target.id);
        host.syncTranscript();
        host.setBanner(`Deleted session ${target.id.slice(0, 8)}.`);
      }
      return;
    }
    if (key === 'Enter') {
      const target = filtered[state.selectedIndex];
      if (target) {
        try {
          host.client.resumeSession(target.id);
          host.syncTranscript();
          host.closeOverlay();
          host.setBanner(`Resumed session "${target.title || target.id.slice(0, 8)}".`);
        } catch {
          host.setBanner('Could not resume session.');
        }
      }
      return;
    }
    const query = editField(state.query, key, { max: Number.MAX_SAFE_INTEGER });
    if (query !== null) this.state = { ...state, query, selectedIndex: 0 };
  }
}
