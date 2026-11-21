/// <reference lib="webworker" />
import {evaluateRead} from '@cosmew/security';
import {WorkspaceRoot, looksBinary} from '@cosmew/workspace';
import {LIMITS} from '../limits';
import type {FileHits, GrepMode} from './ripgrep';

/**
 * Built-in grep used when no trusted ripgrep is available. Runs in a Worker so a pathological
 * JavaScript regular expression can be stopped by terminating the thread. Every file is
 * re-resolved through the workspace (symlink escapes are skipped) and secret/protected files are
 * never opened. Context lines are a ripgrep feature and are not produced here.
 */
declare const self: Worker;

export interface GrepWorkerRequest {
  root: string;
  files: string[];
  pattern: string;
  ignoreCase?: boolean;
  multiline?: boolean;
  mode: GrepMode;
  stateDirectory?: string;
  /** Granted directories a candidate path may resolve into. The project root is always included. */
  roots?: string[];
  /** Stop collecting line text after this many matching lines (counts stay exact). */
  maxLines: number;
}

self.onmessage = (event: MessageEvent<GrepWorkerRequest>) => {
  const {root, files, pattern, ignoreCase, multiline, mode, stateDirectory, roots, maxLines} = event.data;
  const workspace = new WorkspaceRoot(root);
  const flags = (ignoreCase ? 'i' : '') + (multiline ? 'gs' : '');
  const regex = new RegExp(pattern, flags);
  const hits: FileHits[] = [];
  let skippedSecret = 0;
  let collected = 0;
  for (const path of files) {
    let file;
    try {
      file = workspace.resolve(path, roots ?? []);
    } catch {
      continue;
    }
    if (file.kind !== 'file') continue;
    const decision = evaluateRead(file.relative, file.absolute, {stateDirectory});
    if (decision.effect === 'ask') skippedSecret++;
    if (decision.effect !== 'allow') continue;
    let bytes: Uint8Array;
    try {
      ({bytes} = workspace.readBytes(file, LIMITS.searchFileBytes));
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue;
    const text = new TextDecoder().decode(bytes);
    const hit: FileHits = {path: file.relative, lines: [], count: 0};
    if (multiline) {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
      const lineAt = (offset: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid]! <= offset) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };
      for (const match of text.matchAll(regex)) {
        hit.count++;
        if (mode !== 'content' || collected >= maxLines) continue;
        const first = lineAt(match.index);
        const last = lineAt(match.index + Math.max(0, match[0].length - 1));
        for (let n = first; n <= last; n++) {
          hit.lines.push({
            line: n + 1,
            text: text.slice(starts[n], (starts[n + 1] ?? text.length + 1) - 1).replace(/\r$/, ''),
            match: true,
          });
          collected++;
        }
      }
    } else {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.length > LIMITS.lineChars ? lines[i]!.slice(0, LIMITS.lineChars) : lines[i]!;
        if (!regex.test(line)) continue;
        hit.count++;
        if (mode === 'content' && collected < maxLines) {
          hit.lines.push({line: i + 1, text: line, match: true});
          collected++;
        }
      }
    }
    if (hit.count) hits.push(hit);
  }
  self.postMessage({hits, skippedSecret});
};
