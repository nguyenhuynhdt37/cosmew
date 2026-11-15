import type { ThemeTokens } from '@hannes/contracts';
import type { RenderedBoxLine } from '../../ui';

/** Exact local hydefetch/pokemon-colorscripts sprite, decoded to static pixels.
 * Pokémon artwork retains its original ownership; see docs/adr/0021. No ANSI is executed. */
export const WEEPINBELL_PALETTE: readonly (string | null)[] = [null, "#000000", "#8c6342", "#b5844a", "#73bd5a", "#414141", "#4a9c4a", "#f7e65a", "#cebd52", "#a59452", "#8cde73", "#ffffff", "#f79cad", "#bd7b84"];
export const WEEPINBELL_PIXELS = [
  "0000000000001110000000",
  "0000000000012331000000",
  "0000100000133111000000",
  "0001410001231000000000",
  "0014410015225100000000",
  "0164100117558100000000",
  "0146100179779710000000",
  "1646611777997710000011",
  "16666657777777710011a1",
  "166666577777775111aaa1",
  "0166665778877544aaaaa1",
  "001665777bb854444aaa10",
  "0001157781bb54444aaa10",
  "000017778bb8544444a100",
  "0001587778888544411000",
  "0001c58788885551100000",
  "0001cc555555dd10000000",
  "00001cccccddd100000000",
  "0000011dddd11000000000",
  "0000000111100000000000",
  "",
  ""
];

export function renderWeepinbell(tokens: ThemeTokens): RenderedBoxLine[] {
  const pixel = (y: number, x: number) => WEEPINBELL_PALETTE[parseInt(WEEPINBELL_PIXELS[y]?.[x] ?? '0', 16)] ?? tokens.background;
  const lines: RenderedBoxLine[] = [];
  for (let y = 0; y < WEEPINBELL_PIXELS.length; y += 2) {
    const spans = [];
    for (let x = 0; x < WEEPINBELL_PIXELS[0]!.length; x++) {
      const top = pixel(y, x), bottom = pixel(y + 1, x);
      spans.push({text:'▀', fg:top, bg:bottom});
    }
    lines.push({spans});
  }
  return lines;
}
