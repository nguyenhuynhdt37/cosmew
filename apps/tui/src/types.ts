import type {FutrynClient} from '@futryn/sdk';
import type {ThemeEngine} from './theme/theme';
import type {RenderedBoxLine} from './ui/types';

export type ActiveOverlay =
  | 'none'
  | 'memory'
  | 'agents'
  | 'themes'
  | 'theme-editor'
  | 'models'
  | 'connect'
  | 'sessions'
  | 'permissions'
  | 'question'
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
  /** Visible rows; legacy consumers without totalLines may still supply a full document. */
  lines: RenderedBoxLine[];
  totalLines?: number;
  hasNewOutput?: boolean;
  readRows?: (offset: number, count: number) => RenderedBoxLine[];
  freeze?: () => {totalLines: number; readRows: (offset: number, count: number) => RenderedBoxLine[]};
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
