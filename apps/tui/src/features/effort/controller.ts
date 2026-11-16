import type {OverlayFeature, ThemeFrame, TuiHost} from '../../core/feature';
import {wideLayout} from '../../core/layout';
import {renderReportOverlay} from '../reports';

/** Reasoning-effort picker; values come from the active model's advertised levels. */
export class EffortFeature implements OverlayFeature {
  readonly overlays = ['effort'] as const;
  private index = 0;

  constructor(private readonly host: TuiHost) {}

  private values(): string[] {
    return ['default', ...(this.host.client.status().activeModel?.reasoningEfforts ?? [])];
  }

  open(): void {
    const {client} = this.host;
    this.index = Math.max(0, this.values().indexOf(client.status().reasoningEffort ?? 'default'));
  }

  layout(_overlay: 'effort', cols: number, rows: number) {
    const wide = wideLayout(cols, rows, true);
    return {...wide, width: Math.min(cols - 2, 58)};
  }

  render(_overlay: 'effort', size: {width: number; height: number}, theme: ThemeFrame) {
    const values = ['auto', ...(this.host.client.status().activeModel?.reasoningEfforts ?? [])];
    return renderReportOverlay({
      title: 'Reasoning effort',
      rows: [
        `Effort: [ ${values[this.index]} ]`,
        values.map((value, index) => (index === this.index ? `[ ${value} ]` : value)).join(' ─ '),
        '',
        this.index === 0 ? 'Auto uses the provider default.' : 'Higher effort can increase latency and usage.',
        '',
      ],
      width: size.width,
      height: size.height,
      offset: 0,
      footer: '←/→ Adjust · Enter Save · Esc Cancel',
      tokens: theme.tokens,
    }).lines;
  }

  handleKey(_overlay: 'effort', key: string): void {
    const {host} = this;
    const values = this.values();
    if (key === 'Escape') {
      host.closeOverlay();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      this.index = Math.max(
        0,
        Math.min(values.length - 1, this.index + (key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1)),
      );
    } else if (key === 'Enter') {
      try {
        host.client.setReasoningEffort(values[this.index] ?? 'default');
        host.setBanner(`Effort: ${values[this.index] === 'default' ? 'auto (provider default)' : values[this.index]}.`);
        host.closeOverlay();
      } catch (error) {
        host.setBanner(host.describeError(error));
      }
    }
  }
}
