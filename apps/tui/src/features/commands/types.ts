import type {ActiveOverlay} from '../../types';

/** What a slash command resolves to, before any side effect happens. */
export type EffortPlan =
  {kind: 'banner'; message: string} | {kind: 'open'} | {kind: 'apply'; level: string | null; available: string[]};

export type OverlayCommandTable = Readonly<Record<string, ActiveOverlay>>;
