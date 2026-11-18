import {runInkTui} from './ink/runtime';
import type {FutrynTuiOptions} from './types';

/** The Ink TUI is the only terminal UI (ADR 0059). Non-TTY output is one deterministic frame. */
export async function runInteractiveTui(options: FutrynTuiOptions & {initialCommand?: string}): Promise<void> {
  return runInkTui(options);
}
