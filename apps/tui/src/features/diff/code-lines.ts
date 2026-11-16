import type { DiffLine, ThemeTokens } from '@futryn/contracts';
import type { RenderedBoxLine } from '../../ui';
import { mixHex } from '../../theme/presets';

/** Shared by workspace review and actual patch receipts; proposals never become receipts. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0, newLine = 0, inHunk = false, oldRemaining = 0, newRemaining = 0;
  for (const content of diff.slice(0, 131072).split('\n').slice(0, 2048)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(content);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1); inHunk = oldRemaining > 0 || newRemaining > 0;
      lines.push({type:'hunk',oldLine:null,newLine:null,content});
    } else if (!inHunk && /^(diff |--- |\+\+\+ )/.test(content)) inHunk = false;
    else if (inHunk && content.startsWith('+')) { lines.push({type:'add',oldLine:null,newLine:newLine++,content:content.slice(1)}); newRemaining--; }
    else if (inHunk && content.startsWith('-')) { lines.push({type:'del',oldLine:oldLine++,newLine:null,content:content.slice(1)}); oldRemaining--; }
    else if (inHunk && content.startsWith(' ')) { lines.push({type:'context',oldLine:oldLine++,newLine:newLine++,content:content.slice(1)}); oldRemaining--; newRemaining--; }
    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
  }
  return lines;
}

/** Fixed number gutters and colored surfaces, with wrapped code instead of dropped suffixes. */
export function renderDiffCodeLine(line: DiffLine, width: number, tokens: ThemeTokens): RenderedBoxLine[] {
  const changed = line.type === 'add' || line.type === 'del';
  const ink = line.type === 'add' ? tokens.diffAdded : line.type === 'del' ? tokens.diffRemoved : tokens.diffContext;
  const bg = changed ? mixHex(tokens.overlayBackground, ink, 0.13) : tokens.overlayBackground;
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  const gutter = line.type === 'hunk' ? ' '.repeat(13) : `${String(line.oldLine ?? '').padStart(5)} ${String(line.newLine ?? '').padStart(5)} ${sign}`;
  const size = Math.max(1, width - gutter.length - 1);
  const result: RenderedBoxLine[] = [];
  for (let offset = 0; offset < Math.max(1, line.content.length); offset += size) {
    const prefix = offset === 0 ? gutter : ' '.repeat(gutter.length);
    result.push({spans:[
      {text:prefix.slice(0, width),fg:changed ? ink : tokens.foregroundSubtle,bg},
      {text:(' '+line.content.slice(offset, offset + size)).slice(0, Math.max(0,width-prefix.length)).padEnd(Math.max(0,width-prefix.length)),fg:line.type==='hunk'?tokens.info:ink,bg,bold:line.type==='hunk'},
    ]});
  }
  return result;
}
