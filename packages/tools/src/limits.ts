/** Bounds shared by the read-only tools (ADR 0017; aligned with OpenCode's documented limits). */
export const LIMITS = {
  readLines: 2000,
  readOutputBytes: 50 * 1024,
  lineChars: 2000,
  readFileBytes: 8 * 1024 * 1024,
  results: 100,
  searchFileBytes: 1024 * 1024,
  patternChars: 500,
  deadlineMs: 30000,
} as const;

/** Cut text to a UTF-8 byte budget without splitting a character. */
export function clipBytes(text: string, maxBytes: number): {text: string; clipped: boolean} {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return {text, clipped: false};
  return {text: new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�$/, ''), clipped: true};
}
