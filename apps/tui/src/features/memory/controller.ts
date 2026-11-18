import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {wideLayout} from '../../core/layout';
import {renderMemory} from './view';
import type {MemoryState} from './types';
export class MemoryFeature implements OverlayFeature {
  readonly overlays = ['memory'] as const;
  readonly needsWorkspace = true;
  private state: MemoryState = {entries: [], index: 0, detail: '', offset: 0, message: ''};
  constructor(private readonly host: TuiHost) {}
  open(): void {
    this.state = {
      entries: this.host.client.memories(),
      index: 0,
      detail: '',
      offset: 0,
      message: this.host.client.memoryDirectory() ? '' : 'Memories disabled.',
    };
  }
  layout(_overlay: 'memory', cols: number, rows: number) {
    return wideLayout(cols, rows, true);
  }
  render(_overlay: 'memory', size: {width: number; height: number}, theme: ThemeFrame) {
    return renderMemory(this.state, size, theme);
  }
  async handleKey(_overlay: 'memory', key: string): Promise<void> {
    const state = this.state;
    if (key === 'Escape') {
      if (state.detail) {
        state.detail = '';
        state.offset = 0;
      } else this.host.closeOverlay();
      return;
    }
    if (key === 'Down' || key === 'ArrowDown') {
      if (state.detail) state.offset++;
      else {
        state.index = Math.max(0, Math.min(state.entries.length - 1, state.index + 1));
        state.offset = state.index;
      }
      return;
    }
    if (key === 'Up' || key === 'ArrowUp') {
      if (state.detail) state.offset = Math.max(0, state.offset - 1);
      else {
        state.index = Math.max(0, state.index - 1);
        state.offset = state.index;
      }
      return;
    }
    try {
      if (key.toLowerCase() === 'o') {
        await this.host.runSlashCommand('/memory open');
        return;
      }
      const entry = state.entries[state.index];
      if (!entry) return;
      if (key === 'Enter') {
        const result = await this.host.client.readMemory(entry.name);
        state.detail = result.content;
        state.offset = 0;
      }
      if (key.toLowerCase() === 'd') {
        const result = await this.host.client.deleteMemory(entry.name);
        this.open();
        this.state.message = result.content;
      }
    } catch (error) {
      state.message = this.host.describeError(error);
    }
  }
}
