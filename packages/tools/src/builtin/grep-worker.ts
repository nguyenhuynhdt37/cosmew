/// <reference lib="webworker" />
import { evaluateRead } from '@futryn/security';
import { WorkspaceRoot, looksBinary } from '@futryn/workspace';
import { LIMITS } from '../limits';

/**
 * Runs in a Worker so a pathological regular expression can be stopped by terminating the
 * thread; JavaScript cannot interrupt a running RegExp. Every file is re-resolved through the
 * workspace (symlink escapes are skipped) and secret/protected files are never opened.
 */
declare const self: Worker;

self.onmessage = (event: MessageEvent<{ root: string; files: string[]; pattern: string; ignoreCase?: boolean; stateDirectory?: string }>) => {
  const { root, files, pattern, ignoreCase, stateDirectory } = event.data;
  const workspace = new WorkspaceRoot(root);
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const matches: string[] = [];
  let skippedSecret = 0;
  let total = 0;
  for (const path of files) {
    let file;
    try { file = workspace.resolve(path); } catch { continue; }
    if (file.kind !== 'file') continue;
    const decision = evaluateRead(file.relative, file.absolute, { stateDirectory });
    if (decision.effect === 'deny') continue;
    if (decision.effect === 'ask') { skippedSecret++; continue; }
    let bytes: Uint8Array;
    try { ({ bytes } = workspace.readBytes(file, LIMITS.searchFileBytes)); } catch { continue; }
    if (looksBinary(bytes)) continue;
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.length > LIMITS.lineChars ? lines[i]!.slice(0, LIMITS.lineChars) : lines[i]!;
      if (regex.test(line)) {
        total++;
        if (matches.length < LIMITS.results) matches.push(`${file.relative}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  self.postMessage({ matches, total, skippedSecret });
};
