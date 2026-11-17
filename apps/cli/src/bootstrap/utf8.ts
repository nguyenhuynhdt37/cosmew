/** Longest prefix of `text` whose UTF-8 encoding fits `maxBytes`, never splitting a code point. */
export function fitUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // Back off over continuation bytes (10xxxxxx) so the cut lands on a code point boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
