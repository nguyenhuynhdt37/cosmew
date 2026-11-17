import {pathToFileURL} from 'node:url';
import {dirname, extname} from 'node:path';
import {watch, type FSWatcher} from 'node:fs';
import {ignoredDirectory} from '@futryn/workspace';
import {FutrynError, type ServiceProcess} from '@futryn/contracts';
import type {ResolvedPath, WorkspaceRoot} from '@futryn/workspace';
import {LspClient, type LspDiagnostic} from './client';
import {SERVERS, projectRoot, specFor, type ServerSpec} from './servers';

/** Starts a server process inside the command sandbox; throws when no sandbox is available. */
export type LspLauncher = (argv: string[], cwd: string) => ServiceProcess;

/** Restart budget per server (plan W4) and idle shutdown (10 minutes). */
export const LSP_LIMITS = {maxRestarts: 3, restartBaseMs: 250, idleMs: 10 * 60_000, maxErrorsPerFile: 20} as const;

export type LspStatus =
  | {ok: true; spec: ServerSpec; root: string}
  | {ok: false; reason: 'no-server-for-language' | 'not-installed' | 'unavailable' | 'crashed'; message: string};

interface Entry {
  spec: ServerSpec;
  root: string;
  client?: LspClient;
  starting?: Promise<LspClient>;
  startingClient?: LspClient;
  restarts: number;
  failed?: string;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * Language servers for one workspace (ADR 0043): started lazily per (language, project root),
 * at most one each; restarted with backoff at most 3 times; stopped after 10 idle minutes.
 * Authorized open files are re-synced before requests and by a coalesced recursive watcher.
 * Missing watcher support falls back to request-time synchronization.
 */
export class LspManager {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private readonly lifetime = new AbortController();
  private watcher?: FSWatcher;
  private readonly watching = new Map<string, {client: LspClient; spec: ServerSpec}>();
  private readonly changed = new Set<string>();
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      workspace: WorkspaceRoot;
      /** Undefined when the host has no command sandbox: LSP is then unavailable. */
      launch?: LspLauncher;
      available?: () => boolean;
      servers?: readonly ServerSpec[];
      idleMs?: number;
      /** Request deadline; defaults to 10 s. */
      requestTimeoutMs?: number;
      /** Re-evaluate read policy before background sync; absent disables background reads. */
      canRead?(file: ResolvedPath): boolean;
    },
  ) {}

  available(): boolean {
    return !this.closed && !!this.options.launch && this.options.available?.() !== false;
  }

  /** Which server would answer for a file, without starting it. */
  status(file: ResolvedPath): LspStatus {
    const spec = specFor(file.relative, this.options.servers ?? SERVERS);
    if (!spec)
      return {
        ok: false,
        reason: 'no-server-for-language',
        message: `No language server is configured for ${extname(file.relative) || 'this file'}.`,
      };
    if (!this.available())
      return {
        ok: false,
        reason: 'unavailable',
        message: 'Language servers need the native command sandbox, which is not available on this host.',
      };
    const root = projectRoot(file.absolute, this.options.workspace.root, spec);
    const entry = this.entries.get(`${spec.id}\0${root}`);
    if (entry?.failed) return {ok: false, reason: 'crashed', message: entry.failed};
    if (!entry?.client && !spec.commands(root, this.options.workspace.root).length)
      return {
        ok: false,
        reason: 'not-installed',
        message: `No ${spec.id} language server found. Install it: ${spec.install}.`,
      };
    return {ok: true, spec, root};
  }

  private async clientFor(file: ResolvedPath, signal?: AbortSignal): Promise<{client: LspClient; spec: ServerSpec}> {
    const status = this.status(file);
    if (!status.ok) throw Object.assign(new FutrynError('RUNTIME_UNAVAILABLE'), {lspMessage: status.message});
    const key = `${status.spec.id}\0${status.root}`;
    let entry = this.entries.get(key);
    if (!entry) this.entries.set(key, (entry = {spec: status.spec, root: status.root, restarts: 0}));
    if (entry.client && !entry.client.connection.closed) {
      this.touch(entry);
      return {client: entry.client, spec: entry.spec};
    }
    entry.starting ??= this.start(entry, signal).finally(() => {
      entry!.starting = undefined;
    });
    const client = await entry.starting;
    return {client, spec: entry.spec};
  }

  private async start(entry: Entry, signal?: AbortSignal): Promise<LspClient> {
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    if (entry.client) {
      // A crash: back off, then try again within the restart budget.
      if (entry.restarts >= LSP_LIMITS.maxRestarts) {
        entry.failed = `The ${entry.spec.id} language server crashed ${entry.restarts + 1} times and was not restarted.`;
        throw Object.assign(new FutrynError('RUNTIME_UNAVAILABLE'), {lspMessage: entry.failed});
      }
      await Bun.sleep(LSP_LIMITS.restartBaseMs * 2 ** entry.restarts);
      signal.throwIfAborted();
      entry.restarts++;
      entry.client = undefined;
    }
    const commands = entry.spec.commands(entry.root, this.options.workspace.root);
    let lastError: unknown;
    for (const argv of commands) {
      signal.throwIfAborted();
      let process: ServiceProcess;
      try {
        process = this.options.launch!(argv, entry.root);
      } catch (error) {
        lastError = error;
        continue;
      }
      const client = new LspClient(process, entry.root);
      entry.startingClient = client;
      if (this.options.requestTimeoutMs) client.timeoutMs = this.options.requestTimeoutMs;
      try {
        await client.initialize(signal);
        signal.throwIfAborted();
        if (this.closed) throw new FutrynError('CANCELLED');
        entry.startingClient = undefined;
        entry.client = client;
        this.touch(entry);
        return client;
      } catch (error) {
        lastError = error;
        entry.startingClient = undefined;
        if (signal?.aborted) client.terminate();
        else await client.shutdown();
        if (signal?.aborted) throw new FutrynError('CANCELLED');
      }
    }
    if (lastError instanceof FutrynError && lastError.code === 'CANCELLED') throw lastError;
    entry.failed = `The ${entry.spec.id} language server did not start.`;
    throw Object.assign(new FutrynError('RUNTIME_UNAVAILABLE'), {lspMessage: entry.failed});
  }

  private touch(entry: Entry): void {
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      const client = entry.client;
      entry.client = undefined;
      entry.restarts = 0;
      void client?.shutdown();
    }, this.options.idleMs ?? LSP_LIMITS.idleMs);
    (entry.idle as {unref?: () => void}).unref?.();
  }

  /** Re-read the file from disk and sync it to the server. */
  private syncFile(
    client: LspClient,
    spec: ServerSpec,
    file: ResolvedPath,
  ): {uri: string; text: string; changed: boolean} {
    const {bytes} = this.options.workspace.readBytes(file, 8 * 1024 * 1024);
    const text = new TextDecoder().decode(bytes);
    const uri = pathToFileURL(file.absolute).href;
    const changed = client.sync(uri, spec.languageId(extname(file.relative).toLowerCase()), text);
    if (this.options.canRead && !ignoredDirectory(this.options.workspace, dirname(file.relative))) {
      for (const [path, open] of this.watching) {
        if (
          open.client.connection.closed ||
          !open.client.isOpen(pathToFileURL(this.options.workspace.root + '/' + path).href)
        )
          this.watching.delete(path);
      }
      this.watching.set(file.relative, {client, spec});
      this.startWatcher();
    }
    return {uri, text, changed};
  }

  private startWatcher(): void {
    if (this.watcher || this.closed) return;
    try {
      this.watcher = watch(this.options.workspace.root, {recursive: true}, (_event, name) => {
        const path = name?.toString().replace(/\\/g, '/');
        if (!path || !this.watching.has(path)) return;
        this.changed.add(path);
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.flushChanges(), 50);
        this.watchTimer.unref?.();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
      this.watcher.unref();
    } catch {
      /* unsupported watcher: requests still sync the current file */
    }
  }

  private flushChanges(): void {
    this.watchTimer = undefined;
    if (this.closed) return;
    for (const path of this.changed) {
      const open = this.watching.get(path);
      if (!open) continue;
      try {
        const file = this.options.workspace.resolve(path);
        const uri = pathToFileURL(file.absolute).href;
        if (
          file.kind !== 'file' ||
          open.client.connection.closed ||
          !open.client.isOpen(uri) ||
          !this.options.canRead?.(file) ||
          ignoredDirectory(this.options.workspace, dirname(path))
        ) {
          open.client.closeDocument(uri);
          this.watching.delete(path);
          continue;
        }
        this.syncFile(open.client, open.spec, file);
      } catch {
        open.client.closeDocument(pathToFileURL(this.options.workspace.root + '/' + path).href);
        this.watching.delete(path);
      }
    }
    this.changed.clear();
  }

  /** One request about a file (already authorized by the dispatcher). */
  async request<T>(
    file: ResolvedPath,
    method: string,
    params: (uri: string, text: string) => unknown,
    signal?: AbortSignal,
  ): Promise<{result: T; text: string}> {
    const {client, spec} = await this.clientFor(file, signal);
    const {uri, text} = this.syncFile(client, spec, file);
    const result = await client.request<T>(method, params(uri, text), signal);
    return {result, text};
  }

  /** A workspace-wide request answered by the server for `anchor`'s language. */
  async workspaceRequest<T>(anchor: ResolvedPath, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const {client, spec} = await this.clientFor(anchor, signal);
    this.syncFile(client, spec, anchor);
    return client.request<T>(method, params, signal);
  }

  /** Diagnostics the server already published for a file, without starting anything. */
  knownErrors(file: ResolvedPath): LspDiagnostic[] | undefined {
    const status = this.status(file);
    if (!status.ok) return undefined;
    const client = this.entries.get(`${status.spec.id}\0${status.root}`)?.client;
    return client?.knownDiagnostics(pathToFileURL(file.absolute).href)?.filter(d => (d.severity ?? 1) === 1);
  }

  /**
   * Errors after a change (plan W4, OpenCode v1 `edit.ts`): sync the new text, wait for the
   * server's push (debounced, at most 3 s) and return ERROR diagnostics not in `before` (compared
   * by message, source and code, so errors that only moved lines are not new). At most 20.
   * Undefined when no server answers for the file.
   */
  async newErrors(file: ResolvedPath, before: LspDiagnostic[] | undefined, signal?: AbortSignal) {
    if (!this.status(file).ok) return undefined;
    let client: LspClient, spec: ServerSpec;
    try {
      ({client, spec} = await this.clientFor(file, signal));
    } catch {
      return undefined;
    }
    const since = client.seq;
    const {uri, text, changed} = this.syncFile(client, spec, file);
    const after =
      (!changed ? client.knownDiagnostics(uri) : undefined) ?? (await client.waitForDiagnostics(uri, since, signal));
    if (!after) return undefined;
    const key = (d: LspDiagnostic) => JSON.stringify([d.message, d.source ?? '', d.code ?? '']);
    const old = new Map<string, number>();
    for (const d of before ?? []) old.set(key(d), (old.get(key(d)) ?? 0) + 1);
    const fresh: LspDiagnostic[] = [];
    for (const d of after.filter(d => (d.severity ?? 1) === 1)) {
      const count = old.get(key(d)) ?? 0;
      if (count > 0) old.set(key(d), count - 1);
      else fresh.push(d);
    }
    return {
      errors: fresh.slice(0, LSP_LIMITS.maxErrorsPerFile),
      more: Math.max(0, fresh.length - LSP_LIMITS.maxErrorsPerFile),
      text,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watching.clear();
    this.changed.clear();
    for (const entry of this.entries.values()) entry.startingClient?.terminate();
    await Promise.allSettled(
      [...this.entries.values()].map(entry => {
        if (entry.idle) clearTimeout(entry.idle);
        return Promise.allSettled([entry.client?.shutdown(), entry.starting]);
      }),
    );
    this.entries.clear();
  }
}

/** The human/model-readable message for an LSP failure. */
export function lspFailureMessage(error: unknown): string | undefined {
  return (error as {lspMessage?: string} | undefined)?.lspMessage;
}
