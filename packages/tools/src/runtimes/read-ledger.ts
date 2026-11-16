import {contentHash} from '@futryn/workspace';

/**
 * Which file versions the model has actually seen (ADR 0038). `edit` and `write` may change an
 * existing file only when its current content is exactly a version the model read or wrote in
 * this dispatcher, so a change is never based on a guess or on content that changed since.
 * Hashes use the same decoding as write snapshots (UTF-8, BOM kept).
 */
export class ReadLedger {
  private readonly seen = new Map<string, string>();

  recordBytes(path: string, bytes: Uint8Array): void {
    this.record(path, new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes));
  }

  record(path: string, content: string): void {
    this.seen.set(path, contentHash(content));
  }

  forget(path: string): void {
    this.seen.delete(path);
  }

  /** `unread` when never seen, `stale` when the file changed since the model last saw it. */
  check(path: string, currentHash: string): 'current' | 'unread' | 'stale' {
    const seen = this.seen.get(path);
    if (seen === undefined) return 'unread';
    return seen === currentHash ? 'current' : 'stale';
  }
}
