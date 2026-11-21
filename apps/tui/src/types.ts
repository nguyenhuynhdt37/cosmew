import type {FutrynClient} from '@cosmew/sdk';
import type {ThemeEngine} from './theme/theme';

/** Options accepted by the interactive Ink host (`runInteractiveTui`). */
export interface FutrynTuiOptions {
  client: FutrynClient;
  themeEngine?: ThemeEngine;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
}
