import {pathToFileURL} from 'node:url';
import type {ServiceProcess} from '@futryn/contracts';
import {JsonRpcConnection, LSP_REQUEST_TIMEOUT_MS} from './rpc';

export interface LspDiagnostic {
  range: {start: {line: number; character: number}; end: {line: number; character: number}};
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface DocumentState {
  version: number;
  text: string;
}

/** Diagnostics publish wait (OpenCode v1 debounce 150 ms) and cap (plan: at most 3 s). */
export const DIAGNOSTIC_DEBOUNCE_MS = 150;
export const DIAGNOSTIC_WAIT_MS = 3_000;

/**
 * One language-server session (ADR 0043): initialize, full-text document sync, pushed diagnostics,
 * requests and an orderly shutdown. Server requests are answered minimally and never execute
 * anything (`workspace/applyEdit` is refused: edits only ever go through Futryn's patch pipeline).
 */
export class LspClient {
  readonly connection: JsonRpcConnection;
  private readonly documents = new Map<string, DocumentState>();
  private readonly diagnostics = new Map<string, {items: LspDiagnostic[]; seq: number}>();
  private publishSeq = 0;
  private readonly waiters = new Set<() => void>();
  capabilities: Record<string, unknown> = {};

  constructor(
    private readonly process: ServiceProcess,
    readonly rootAbsolute: string,
  ) {
    this.connection = new JsonRpcConnection(process);
    this.connection.onNotification('textDocument/publishDiagnostics', params => {
      const {uri, diagnostics, version} = (params ?? {}) as {uri?: string; diagnostics?: unknown[]; version?: unknown};
      if (typeof uri !== 'string' || !Array.isArray(diagnostics)) return;
      const document = this.documents.get(uri);
      if (!document || (version !== undefined && version !== document.version)) return;
      this.diagnostics.set(uri, {items: diagnostics.slice(0, 1000).filter(validDiagnostic), seq: ++this.publishSeq});
      for (const wake of this.waiters) wake();
    });
    this.connection.onRequest('workspace/configuration', params => {
      const items = (params as {items?: unknown[]} | undefined)?.items ?? [];
      return items.map(() => null);
    });
    this.connection.onRequest('window/workDoneProgress/create', () => null);
    this.connection.onRequest('client/registerCapability', () => null);
    this.connection.onRequest('client/unregisterCapability', () => null);
    this.connection.onRequest('workspace/workspaceFolders', () => [
      {uri: pathToFileURL(rootAbsolute).href, name: 'workspace'},
    ]);
    this.connection.onRequest('workspace/applyEdit', () => ({
      applied: false,
      failureReason: 'Edits go through Futryn.',
    }));
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const root = pathToFileURL(this.rootAbsolute).href;
    const result = await this.connection.request<{capabilities?: Record<string, unknown>}>(
      'initialize',
      {
        processId: process.pid,
        rootUri: root,
        rootPath: this.rootAbsolute,
        workspaceFolders: [{uri: root, name: 'workspace'}],
        clientInfo: {name: 'futryn'},
        capabilities: {
          textDocument: {
            synchronization: {didSave: false, dynamicRegistration: false},
            publishDiagnostics: {relatedInformation: false, versionSupport: true},
            definition: {linkSupport: false},
            references: {},
            hover: {contentFormat: ['plaintext', 'markdown']},
            documentSymbol: {hierarchicalDocumentSymbolSupport: true},
            implementation: {linkSupport: false},
            callHierarchy: {},
            rename: {prepareSupport: false},
          },
          workspace: {symbol: {}, workspaceFolders: true, configuration: true, applyEdit: false},
          window: {workDoneProgress: false},
          general: {positionEncodings: ['utf-16']},
        },
      },
      {signal, timeoutMs: 30_000},
    );
    this.capabilities = result?.capabilities ?? {};
    this.connection.notify('initialized', {});
  }

  /** Open the document, or send its full new text when it changed. Returns whether anything was sent. */
  sync(uri: string, languageId: string, text: string): boolean {
    const known = this.documents.get(uri);
    if (!known) {
      if (this.documents.size >= 128) this.closeDocument(this.documents.keys().next().value!);
      this.documents.set(uri, {version: 1, text});
      this.connection.notify('textDocument/didOpen', {textDocument: {uri, languageId, version: 1, text}});
      return true;
    }
    if (known.text === text) return false;
    known.version++;
    known.text = text;
    this.connection.notify('textDocument/didChange', {
      textDocument: {uri, version: known.version},
      contentChanges: [{text}],
    });
    return true;
  }

  closeDocument(uri: string): void {
    if (!this.documents.delete(uri)) return;
    this.diagnostics.delete(uri);
    this.connection.notify('textDocument/didClose', {textDocument: {uri}});
  }

  terminate(): void {
    this.connection.close('terminated');
    this.process.kill();
    this.documents.clear();
    this.diagnostics.clear();
    for (const wake of this.waiters) wake();
  }

  isOpen(uri: string): boolean {
    return this.documents.has(uri);
  }

  knownDiagnostics(uri: string): LspDiagnostic[] | undefined {
    return this.diagnostics.get(uri)?.items;
  }

  /**
   * Diagnostics published after `since` (a publish sequence), waiting for the first push and then
   * a quiet `DIAGNOSTIC_DEBOUNCE_MS`, at most `DIAGNOSTIC_WAIT_MS`. Undefined when none arrived.
   */
  async waitForDiagnostics(uri: string, since: number, signal?: AbortSignal): Promise<LspDiagnostic[] | undefined> {
    const deadline = Date.now() + DIAGNOSTIC_WAIT_MS;
    let lastSeq = -1;
    while (Date.now() < deadline && !signal?.aborted && !this.connection.closed) {
      const entry = this.diagnostics.get(uri);
      if (entry && entry.seq > since) {
        if (entry.seq === lastSeq) return entry.items;
        lastSeq = entry.seq;
        await this.sleep(DIAGNOSTIC_DEBOUNCE_MS, deadline);
        continue;
      }
      await this.sleep(Math.min(100, deadline - Date.now()), deadline);
    }
    const entry = this.diagnostics.get(uri);
    return entry && entry.seq > since ? entry.items : undefined;
  }

  get seq(): number {
    return this.publishSeq;
  }

  /** Per-request deadline (plan W4: 10 s); tests may shorten it. */
  timeoutMs = LSP_REQUEST_TIMEOUT_MS;

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.connection.request<T>(method, params, {signal, timeoutMs: this.timeoutMs});
  }

  async shutdown(): Promise<void> {
    for (const uri of [...this.documents.keys()]) this.closeDocument(uri);
    try {
      if (!this.connection.closed) await this.connection.request('shutdown', null, {timeoutMs: 1000});
      this.connection.notify('exit', null);
    } catch {
      /* the process is stopped below */
    }
    this.terminate();
  }

  private sleep(ms: number, deadline: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.max(1, Math.min(ms, deadline - Date.now())));
      this.waiters.add(wake);
    });
  }
}

function validDiagnostic(value: unknown): value is LspDiagnostic {
  if (!value || typeof value !== 'object') return false;
  const d = value as LspDiagnostic;
  const position = (p: {line: number; character: number} | undefined) =>
    !!p && Number.isSafeInteger(p.line) && p.line >= 0 && Number.isSafeInteger(p.character) && p.character >= 0;
  return (
    typeof d.message === 'string' &&
    d.message.length <= 16384 &&
    !!d.range &&
    position(d.range.start) &&
    position(d.range.end) &&
    (d.range.end.line > d.range.start.line ||
      (d.range.end.line === d.range.start.line && d.range.end.character >= d.range.start.character)) &&
    (d.severity === undefined || (Number.isInteger(d.severity) && d.severity >= 1 && d.severity <= 4)) &&
    (d.source === undefined || typeof d.source === 'string') &&
    (d.code === undefined || typeof d.code === 'string' || typeof d.code === 'number')
  );
}
