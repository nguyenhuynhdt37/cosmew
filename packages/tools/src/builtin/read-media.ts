import {MAX_ATTACHMENT_BYTES, type Attachment} from '@cosmew/contracts';

/**
 * Media detection for `read` (ADR 0041), after OpenCode `read-filesystem.ts` (sst/opencode
 * 0ac0d7ee, read 2026-11-17): PNG, JPEG, GIF, WebP and PDF are recognised by their leading bytes
 * (never by the file name) and returned to the model as attachments up to 20 MiB.
 */
export type MediaMime = Attachment['mime'];

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));

/** The media type of these leading bytes, or null for anything else. */
export function sniffMedia(bytes: Uint8Array): MediaMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return null;
}

export const MEDIA_SNIFF_BYTES = 16;
export {MAX_ATTACHMENT_BYTES};

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1048576).toFixed(1)} MiB`;

/** Text that accompanies an attachment; it is all a model without vision (or the transcript) sees. */
export function mediaSummary(path: string, mime: MediaMime, bytes: number): string {
  const kind = mime === 'application/pdf' ? 'PDF' : 'image';
  return `Read ${kind} ${path} (${mime}, ${size(bytes)}). The ${kind} is attached for models that can view it; if you cannot see it, say so instead of guessing its contents.`;
}

const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const asciiAt = (b: Uint8Array, at: number, text: string) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * Minimal structural check before bytes are handed to a model as media (W1.5 security review): a
 * file that only starts like an image or PDF is treated as binary, not attached. PNG needs an IHDR
 * with a non-zero size; JPEG an end-of-image marker; GIF a non-zero screen size; WebP a consistent
 * RIFF size and a VP8/VP8L/VP8X chunk; PDF an `%%EOF` trailer.
 */
export function validMedia(bytes: Uint8Array, mime: MediaMime): boolean {
  switch (mime) {
    case 'image/png':
      return bytes.length >= 33 && asciiAt(bytes, 12, 'IHDR') && u32be(bytes, 16) > 0 && u32be(bytes, 20) > 0;
    case 'image/jpeg': {
      const tail = bytes.subarray(Math.max(0, bytes.length - 64));
      return bytes.length >= 4 && tail.some((byte, i) => byte === 0xff && tail[i + 1] === 0xd9);
    }
    case 'image/gif':
      return bytes.length >= 13 && u16le(bytes, 6) > 0 && u16le(bytes, 8) > 0;
    case 'image/webp':
      return (
        bytes.length >= 20 &&
        u32le(bytes, 4) + 8 <= bytes.length &&
        ['VP8 ', 'VP8L', 'VP8X'].some(chunk => asciiAt(bytes, 12, chunk))
      );
    case 'application/pdf':
      return Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024)))
        .toString('latin1')
        .includes('%%EOF');
  }
}

/**
 * Registered secrets must not leave as media either: the bytes are scanned (as latin1 text) with
 * the same redactor that cleans text results; any change means a secret is inside.
 */
export function containsRegisteredSecret(bytes: Uint8Array, redact: (text: string) => string): boolean {
  const text = Buffer.from(bytes).toString('latin1');
  const utf8 = Buffer.from(bytes).toString('utf8');
  return redact(text) !== text || redact(utf8) !== utf8;
}

/** Validate explicit user-supplied image bytes using the read tool's media boundary. */
export function validateImageAttachment(mediaType: string, data: string, redact: (text: string) => string): Attachment {
  if (
    !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType) ||
    typeof data !== 'string' ||
    !data.length ||
    data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    throw new Error('INVALID_IMAGE');
  const bytes = Buffer.from(data, 'base64');
  const mime = sniffMedia(bytes);
  if (bytes.length > MAX_ATTACHMENT_BYTES || mime !== mediaType || !mime || !validMedia(bytes, mime))
    throw new Error('INVALID_IMAGE');
  if (containsRegisteredSecret(bytes, redact)) throw new Error('SECRET_IN_MEDIA');
  return {mime, data, name: 'image'};
}
