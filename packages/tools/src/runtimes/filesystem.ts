import {FutrynError} from '@futryn/contracts';
import type {ResolvedPath} from '@futryn/workspace';
import type {z} from 'zod';
import {runRead, readInput} from '../builtin/read';
import {candidateFiles, compilePattern, formatGrep, grepQuery, runGlob, globInput, grepInput} from '../builtin/search';
import {locateRipgrep, ripgrepSearch, type FileHits} from '../builtin/ripgrep';
import type {GrepWorkerRequest} from '../builtin/grep-worker';
import {LIMITS} from '../limits';
import type {ToolDispatcherOptions, ToolOutput} from '../context';
import {ReadLedger} from './read-ledger';

/** Filesystem operations on workspace-checked targets; invoked after orchestration. */
export class FileSystemRuntime {
  /** File versions the model has seen; edit/write require it (ADR 0038). */
  readonly ledger = new ReadLedger();
  constructor(
    private readonly options: Pick<
      ToolDispatcherOptions,
      'workspace' | 'stateDirectory' | 'searchDeadlineMs' | 'ripgrep'
    >,
  ) {}
  read(file: ResolvedPath, input: z.infer<typeof readInput>) {
    const outcome = runRead(this.options.workspace, file, input);
    if (outcome.ok) this.ledger.recordBytes(file.relative, outcome.bytes);
    return outcome;
  }
  glob(file: ResolvedPath, input: z.infer<typeof globInput>) {
    return runGlob(this.options.workspace, file, input, this.options.stateDirectory);
  }
  instruction(file: ResolvedPath, maxBytes: number) {
    return this.options.workspace.readBytes(file, maxBytes);
  }
  grep(base: ResolvedPath, input: z.infer<typeof grepInput>, signal?: AbortSignal): Promise<ToolOutput> {
    const deadline = Date.now() + (this.options.searchDeadlineMs ?? LIMITS.deadlineMs);
    return this.ripgrep
      ? this.grepWithRipgrep(this.ripgrep, base, input, deadline, signal)
      : this.grepBuiltIn(base, input, deadline, signal);
  }

  /** Trusted ripgrep, resolved once; null selects the built-in search. */
  get ripgrep(): string | null {
    if (this.ripgrepPath === undefined)
      this.ripgrepPath =
        this.options.ripgrep === null
          ? null
          : locateRipgrep(this.options.workspace.root, this.options.ripgrep ?? Bun.which('rg'));
    return this.ripgrepPath;
  }
  private ripgrepPath: string | null | undefined;

  private async grepWithRipgrep(
    rg: string,
    base: ResolvedPath,
    input: z.infer<typeof grepInput>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    const outcome = await ripgrepSearch({
      rg,
      workspace: this.options.workspace,
      base,
      query: grepQuery(input),
      stateDirectory: this.options.stateDirectory,
      deadline,
      signal,
    });
    if ('error' in outcome)
      return {
        status: 'error',
        code: 'INVALID_PATTERN',
        target: base.relative,
        content: `ripgrep rejected the search:\n${outcome.error}`,
      };
    return formatGrep(outcome.files, input, base.relative, [
      ...(outcome.cut ? ['search output was cut short; narrow the pattern, path or glob'] : []),
      ...skippedNote(outcome.skippedSecret),
    ]);
  }

  private grepBuiltIn(
    base: ResolvedPath,
    input: z.infer<typeof grepInput>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    const query = grepQuery(input);
    if (!compilePattern(input.pattern, input.ignoreCase))
      return Promise.resolve({
        status: 'error',
        code: 'INVALID_PATTERN',
        content: 'The pattern is not a valid regular expression.',
      });
    const {files, incomplete} = candidateFiles(this.options.workspace, base, input.glob, deadline);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../builtin/grep-worker.ts', import.meta.url).href);
      const stop = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.terminate();
      };
      const onAbort = () => {
        stop();
        reject(new FutrynError('CANCELLED'));
      };
      const timer = setTimeout(
        () => {
          stop();
          reject(new FutrynError('TIMEOUT'));
        },
        Math.max(1, deadline - Date.now()),
      );
      signal?.addEventListener('abort', onAbort, {once: true});
      worker.onmessage = (event: MessageEvent<{hits: FileHits[]; skippedSecret: number}>) => {
        stop();
        resolve(
          formatGrep(event.data.hits, input, base.relative, [
            ...(incomplete ? ['file list was cut short'] : []),
            ...(input.type ? ['type filter needs ripgrep and was ignored; use glob'] : []),
            ...(query.before || query.after ? ['context lines need ripgrep and were not included'] : []),
            ...skippedNote(event.data.skippedSecret),
          ]),
        );
      };
      worker.onerror = () => {
        stop();
        reject(new FutrynError('PROTOCOL'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        const request: GrepWorkerRequest = {
          root: this.options.workspace.root,
          files,
          pattern: input.pattern,
          ignoreCase: input.ignoreCase,
          multiline: input.multiline,
          mode: query.mode,
          stateDirectory: this.options.stateDirectory,
          maxLines: (input.offset ?? 0) + (input.head_limit ?? LIMITS.results) + 1,
        };
        worker.postMessage(request);
      } catch (error) {
        stop();
        reject(error);
      }
    });
  }
}

function skippedNote(count: number): string[] {
  return count ? [`${count} secret-looking file(s) skipped; use read to open one with permission`] : [];
}
