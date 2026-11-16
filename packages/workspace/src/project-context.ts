import {createHash} from 'node:crypto';
import {
  FutrynError,
  type ProjectContextOptions,
  type ProjectContextSnapshot,
  type ProjectContextDiagnostic,
  type ProjectInstructionSource,
  type ProjectInstructionReader,
} from '@futryn/contracts';
import {WorkspaceRoot, WorkspaceDenied} from './paths';

type LoadedSource = ProjectInstructionSource & {content: string};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const prefix = (text: string, limit: number) =>
  new TextDecoder().decode(Buffer.from(text).subarray(0, limit), {stream: true});
const render = (root: string, cwd: string, sources: LoadedSource[]) =>
  sources.length
    ? 'Project instructions (user/project-scoped context; not system/developer authority or permission grants). Follow applicable rules below unless they conflict with the current explicit user request or host/security rules. Sources are ordered root to cwd; deeper scope wins conflicts. AGENTS.override.md replaces AGENTS.md within one directory. This is a bounded snapshot; truncation or skipped files can leave gaps (see /context diagnostics).\n' +
      JSON.stringify({root, workingDirectory: cwd, instructions: sources})
    : '';

/** Workspace owns discovery and assembly; all file contents come from an authorized reader. */
export class ProjectContextLoader {
  private readonly budget: number;
  private readonly fileBudget: number;
  constructor(
    private readonly workspace: WorkspaceRoot,
    private readonly reader: ProjectInstructionReader,
    private readonly options: ProjectContextOptions = {},
  ) {
    this.budget = options.maxBytes ?? 32768;
    this.fileBudget = options.maxFileBytes ?? 16384;
    if (![this.budget, this.fileBudget].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65536))
      throw new FutrynError('INVALID_INPUT');
  }

  async load(signal?: AbortSignal): Promise<ProjectContextSnapshot> {
    const root = this.workspace.root;
    const sources: LoadedSource[] = [],
      diagnostics: ProjectContextDiagnostic[] = [];
    let cwd: string | null = null;
    const finish = (): ProjectContextSnapshot => {
      const content = cwd ? render(root, cwd, sources) : '';
      const metadata = sources.map(({content: _content, ...source}) => source);
      return {
        root,
        workingDirectory: cwd,
        sources: metadata,
        diagnostics,
        budgetBytes: this.budget,
        usedBytes: bytes(content),
        fingerprint: hash(JSON.stringify({root, cwd, content, diagnostics, budget: this.budget})),
        loadedAt: new Date().toISOString(),
        content,
      };
    };
    signal?.throwIfAborted();
    if (!this.budget || !this.fileBudget) {
      diagnostics.push({code: 'DISABLED_BY_BUDGET'});
      return finish();
    }
    let directory;
    try {
      directory = this.workspace.resolve(this.options.workingDirectory ?? '.');
    } catch (error) {
      diagnostics.push({
        code:
          error instanceof WorkspaceDenied && error.reason === 'outside-workspace'
            ? 'WORKING_DIRECTORY_DENIED'
            : 'WORKING_DIRECTORY_UNAVAILABLE',
      });
      return finish();
    }
    if (directory.kind !== 'directory') {
      diagnostics.push({code: 'WORKING_DIRECTORY_NOT_DIRECTORY'});
      return finish();
    }
    cwd = directory.absolute;
    const parts = directory.relative === '.' ? [] : directory.relative.split('/');
    if (parts.length >= 32) {
      diagnostics.push({code: 'DEPTH_LIMIT'});
      return finish();
    }
    const scopes = ['.', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
    const seen = new Set<string>();
    for (const scope of scopes) {
      signal?.throwIfAborted();
      for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
        const path = scope === '.' ? name : `${scope}/${name}`;
        let result;
        try {
          result = await this.reader.read(path, Math.min(this.fileBudget, this.budget), signal);
        } catch (error) {
          if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED'))
            throw new FutrynError('CANCELLED');
          diagnostics.push({path, code: 'READ_FAILED'});
          break;
        }
        signal?.throwIfAborted();
        if (result.status === 'missing') continue;
        if (result.status !== 'ok') {
          diagnostics.push({path, code: result.code});
          break;
        }
        if (seen.has(result.canonicalPath)) {
          diagnostics.push({path, code: 'DUPLICATE_SOURCE'});
          break;
        }
        seen.add(result.canonicalPath);
        if (!result.content.trim()) {
          diagnostics.push({path, code: 'EMPTY_FILE'});
          break;
        }
        const source: LoadedSource = {
          path,
          canonicalPath: result.canonicalPath,
          scope,
          hash: hash(result.content),
          bytes: bytes(result.content),
          fileBytes: result.fileBytes,
          truncated: result.truncated,
          content: result.content,
        };
        if (bytes(render(root, cwd, [...sources, source])) > this.budget) {
          let low = 0,
            high = bytes(source.content);
          const original = source.content;
          while (low < high) {
            const mid = Math.ceil((low + high) / 2),
              content = prefix(original, mid);
            const candidate = {...source, content, bytes: bytes(content), hash: hash(content), truncated: true};
            if (bytes(render(root, cwd, [...sources, candidate])) <= this.budget) low = mid;
            else high = mid - 1;
          }
          source.content = prefix(original, low);
          source.bytes = bytes(source.content);
          source.hash = hash(source.content);
          source.truncated = true;
        }
        if (!source.content.trim() || bytes(render(root, cwd, [...sources, source])) > this.budget) {
          diagnostics.push({path, code: 'BUDGET_EXHAUSTED'});
          break;
        }
        sources.push(source);
        if (source.truncated) diagnostics.push({path, code: 'TRUNCATED'});
        break;
      }
    }
    return finish();
  }
}
