import type {FutrynClient} from '@futryn/sdk';
import type {ThemeEngine} from './theme/theme';
import type {RenderedBoxLine} from './ui/types';

export type ActiveOverlay =
  | 'none'
  | 'themes'
  | 'theme-editor'
  | 'models'
  | 'connect'
  | 'sessions'
  | 'permissions'
  | 'diff'
  | 'palette'
  | 'settings'
  | 'effort'
  | 'usage'
  | 'context'
  | 'status'
  | 'help';

export interface FrameCell {
  ch: string;
  fg: string;
  bg: string;
  bold: boolean;
  /** Set only when true, so plain cells keep their shape. */
  italic?: boolean;
  selected?: boolean;
}

export interface TranscriptViewport {
  top: number;
  left: number;
  width: number;
  height: number;
  offset: number;
  lines: RenderedBoxLine[];
  disclosures: {row: number; itemId: string; key: string}[];
}

export interface FrameSnapshot {
  transcriptViewport?: TranscriptViewport;
  cols: number;
  rows: number;
  cells: FrameCell[][];
  plainLines: string[];
  plainText: string;
  activeOverlay: ActiveOverlay;
  activeThemeId: string;
  effectiveMode: 'dark' | 'light';
  activeWallpaperId: string | null;
  isPreviewing: boolean;
  isStreaming: boolean;
}

export interface FutrynTuiOptions {
  client: FutrynClient;
  themeEngine?: ThemeEngine;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}
