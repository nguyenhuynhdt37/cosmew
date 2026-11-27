import {MAX_ATTACHMENT_BYTES, type Attachment} from '@cosmew/contracts';

/** Bounded media caps for untrusted MCP tool, resource, and prompt payloads (ADR 0121). */
export const MAX_MCP_ATTACHMENT_BYTES = Math.min(5 * 1024 * 1024, MAX_ATTACHMENT_BYTES);
export const MAX_MCP_ATTACHMENTS = 4;

export type McpMediaMime = Attachment['mime'];

const ALLOWED_MIMES: ReadonlySet<string> = new Set<McpMediaMime>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
const ascii = (text: string) => [...text].map(c => c.charCodeAt(0));
const asciiAt = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

export function sniffMcpMedia(bytes: Uint8Array): McpMediaMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return 'application/pdf';
  return null;
}

export function validMcpMedia(bytes: Uint8Array, mime: McpMediaMime): boolean {
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

function containsRegisteredSecret(bytes: Uint8Array, redact: (text: string) => string): boolean {
  const latin1 = Buffer.from(bytes).toString('latin1');
  const utf8 = Buffer.from(bytes).toString('utf8');
  return redact(latin1) !== latin1 || redact(utf8) !== utf8;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

export type McpMediaValidation =
  | {ok: true; attachment: Attachment; summary: string}
  | {ok: false; reason: 'unsupported' | 'invalid' | 'oversize' | 'secret'};

/**
 * Validates untrusted base64 media from an MCP server against magic bytes, minimal container
 * structure, size bounds, and registered secret redaction before attaching it for vision models.
 */
export function validateMcpMediaAttachment(input: {
  data: unknown;
  mimeType?: unknown;
  name?: string;
  redact: (text: string) => string;
}): McpMediaValidation {
  const declared = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : undefined;
  if (declared && !ALLOWED_MIMES.has(declared)) return {ok: false, reason: 'unsupported'};
  if (typeof input.data !== 'string') return {ok: false, reason: 'invalid'};
  const clean = input.data.replace(/\s+/g, '');
  if (!clean.length) return {ok: false, reason: 'invalid'};
  const maxBase64Len = Math.ceil(MAX_MCP_ATTACHMENT_BYTES / 3) * 4;
  if (clean.length > maxBase64Len) return {ok: false, reason: 'oversize'};
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
    return {ok: false, reason: 'invalid'};
  }
  const bytes = Buffer.from(clean, 'base64');
  if (!bytes.length) return {ok: false, reason: 'invalid'};
  if (bytes.length > MAX_MCP_ATTACHMENT_BYTES) return {ok: false, reason: 'oversize'};
  const sniffed = sniffMcpMedia(bytes);
  if (!sniffed) return {ok: false, reason: declared ? 'invalid' : 'unsupported'};
  if (declared && declared !== sniffed) return {ok: false, reason: 'invalid'};
  if (!validMcpMedia(bytes, sniffed)) return {ok: false, reason: 'invalid'};
  if (containsRegisteredSecret(bytes, input.redact)) return {ok: false, reason: 'secret'};
  const fallbackName = sniffed === 'application/pdf' ? 'mcp-resource.pdf' : 'mcp-image';
  const safeName =
    (input.name ? input.redact(input.name) : fallbackName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) ||
    fallbackName;
  const kind = sniffed === 'application/pdf' ? 'PDF' : 'image';
  return {
    ok: true,
    attachment: {
      mime: sniffed,
      data: clean,
      name: safeName,
    },
    summary: `[Attached MCP ${kind} (${sniffed}, ${formatByteSize(bytes.length)})]`,
  };
}
