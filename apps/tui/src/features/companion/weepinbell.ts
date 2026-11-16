import type {ThemeTokens} from '@futryn/contracts';
import type {RenderedBoxLine} from '../../ui';
import type {FynState} from './types';

/** Exact local hydefetch/pokemon-colorscripts sprite, decoded to static pixels.
 * Pokémon artwork retains its original ownership; see docs/adr/0021. No ANSI is executed. */
export const WEEPINBELL_PALETTE: readonly (string | null)[] = [
  null,
  '#000000',
  '#8c6342',
  '#b5844a',
  '#73bd5a',
  '#414141',
  '#4a9c4a',
  '#f7e65a',
  '#cebd52',
  '#a59452',
  '#8cde73',
  '#ffffff',
  '#f79cad',
  '#bd7b84',
];
export const WEEPINBELL_PIXELS = [
  '0000000000001110000000',
  '0000000000012331000000',
  '0000100000133111000000',
  '0001410001231000000000',
  '0014410015225100000000',
  '0164100117558100000000',
  '0146100179779710000000',
  '1646611777997710000011',
  '16666657777777710011a1',
  '166666577777775111aaa1',
  '0166665778877544aaaaa1',
  '001665777bb854444aaa10',
  '0001157781bb54444aaa10',
  '000017778bb8544444a100',
  '0001587778888544411000',
  '0001c58788885551100000',
  '0001cc555555dd10000000',
  '00001cccccddd100000000',
  '0000011dddd11000000000',
  '0000000111100000000000',
  '',
  '',
];

/** Compact art samples the same sprite; motion translates it inside a fixed canvas. */
export function renderWeepinbell(
  tokens: ThemeTokens,
  options?: {compact: boolean; time: number; state: FynState},
): RenderedBoxLine[] {
  const compact = options?.compact ?? false;
  const artSize = compact ? 12 : 22;
  const size = compact ? 14 : 22;
  const time = options?.time ?? 0;
  const working = options?.state === 'thinking' || options?.state === 'streaming';
  const moving = options?.state !== 'sleep' && options?.state !== 'error';
  const bob = compact && moving && time > 0 && Math.sin(time * (working ? 7 : 3)) > 0 ? 1 : 0;
  const sway = compact && moving && time > 0 && Math.sin(time * (working ? 4 : 2)) > 0 ? 1 : 0;
  const pixel = (y: number, x: number) => {
    const px = x - sway,
      py = y - bob;
    if (px < 0 || py < 0 || px >= artSize || py >= artSize) return tokens.background;
    const sourceX = compact ? Math.min(21, Math.floor(((px + 0.5) * 22) / artSize)) : px;
    const sourceY = compact ? Math.min(19, Math.floor(((py + 0.5) * 20) / artSize)) : py;
    return WEEPINBELL_PALETTE[parseInt(WEEPINBELL_PIXELS[sourceY]?.[sourceX] ?? '0', 16)] ?? tokens.background;
  };
  const lines: RenderedBoxLine[] = [];
  for (let y = 0; y < size; y += 2) {
    const spans = [];
    for (let x = 0; x < size; x++) spans.push({text: '▀', fg: pixel(y, x), bg: pixel(y + 1, x)});
    lines.push({spans});
  }
  return lines;
}
