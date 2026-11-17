import {MAX_ATTACHMENT_BYTES, type Attachment} from '@futryn/contracts';

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
