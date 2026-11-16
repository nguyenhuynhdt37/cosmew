import {FutrynError} from '@futryn/contracts';
import type {ResolvedPath} from '@futryn/workspace';
import type {z} from 'zod';
import {runRead, readInput} from '../builtin/read';
import {candidateFiles, runGlob, globInput, grepInput} from '../builtin/search';
import {LIMITS} from '../limits';
import type {ToolDispatcherOptions, ToolOutput} from '../context';

/** Filesystem operations on workspace-checked targets; invoked after orchestration. */
export class FileSystemRuntime {
  constructor(private readonly options: Pick<ToolDispatcherOptions, 'workspace' | 'stateDirectory' | 'searchDeadlineMs'>) {}
  read(file: ResolvedPath, input: z.infer<typeof readInput>) { return runRead(this.options.workspace, file, input); }
  glob(file: ResolvedPath, input: z.infer<typeof globInput>) { return runGlob(this.options.workspace, file, input, this.options.stateDirectory); }
  instruction(file: ResolvedPath, maxBytes: number) { return this.options.workspace.readBytes(file, maxBytes); }
  grep(base: ResolvedPath, input: z.infer<typeof grepInput>, signal?: AbortSignal): Promise<ToolOutput> {
    const deadline = Date.now() + (this.options.searchDeadlineMs ?? LIMITS.deadlineMs);
    const { files, incomplete } = candidateFiles(this.options.workspace, base, input.glob, deadline);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../builtin/grep-worker.ts', import.meta.url).href);
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate(); };
      const onAbort = () => { stop(); reject(new FutrynError('CANCELLED')); };
      const timer = setTimeout(() => { stop(); reject(new FutrynError('TIMEOUT')); }, Math.max(1, deadline - Date.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.onmessage = (event: MessageEvent<{ matches: string[]; total: number; skippedSecret: number }>) => {
        stop();
        const { matches, total, skippedSecret } = event.data;
        const notes = [
          total > matches.length ? `showing ${matches.length} of ${total} matches; narrow the search` : '',
          incomplete ? 'file list was cut short' : '',
          skippedSecret ? `${skippedSecret} secret-looking file(s) skipped; use read to open one with permission` : '',
        ].filter(Boolean);
        const body = matches.length ? matches.join('\n') : 'No matches.';
        resolve({ status: 'ok', content: body + (notes.length ? `\n\n[${notes.join('; ')}]` : ''), target: base.relative, truncated: total > matches.length || incomplete || undefined });
      };
      worker.onerror = () => { stop(); reject(new FutrynError('PROTOCOL')); };
      if (signal?.aborted) { onAbort(); return; }
      try { worker.postMessage({ root: this.options.workspace.root, files, pattern: input.pattern, ignoreCase: input.ignoreCase, stateDirectory: this.options.stateDirectory }); }
      catch (error) { stop(); reject(error); }
    });
  }
}
