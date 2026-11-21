/** Half blocks give the cat a 9×8 square-pixel grid in four terminal rows. */
export const COSMEW_MASCOT_FRAMES = [
  [' █▄   ▄█ ', '▄███████▄', '██▄███▄██', ' ▀██▄██▀ '],
  [' █▄   ▄█ ', '▄███████▄', '██▄█▀█▄██', ' ▀█████▀ '],
  [' █▄   ▄█ ', '▄███████▄', '██▀███▀██', ' ▀██▄██▀ '],
] as const;

export const COSMEW_MASCOT_FRAME_MS = 520;
export const COSMEW_MASCOT_COLOR = 'accent';
export const cosmewMascotWidth = (columns: number) => (columns < 32 ? 3 : 9);

export interface CosmewMascotOptions {
  frame?: number;
  width?: number;
  reducedMotion?: boolean;
}

export function renderCosmewMascot(options: CosmewMascotOptions = {}): string[] {
  const width = Math.max(1, Math.floor(options.width ?? 9));
  if (width < 9) return ['▀█▀'.slice(0, width)];
  const frame = options.reducedMotion ? 0 : Math.abs(Math.floor(options.frame ?? 0)) % COSMEW_MASCOT_FRAMES.length;
  return COSMEW_MASCOT_FRAMES[frame]!.map(row => row.slice(0, width));
}
