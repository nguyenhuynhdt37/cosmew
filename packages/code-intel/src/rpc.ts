import {FutrynError, type ServiceProcess} from '@cosmew/contracts';

/**
 * JSON-RPC 2.0 over LSP base-protocol framing (`Content-Length` headers), ADR 0043. Bounded: a
 * header block over 8 KiB or a body over 64 MiB closes the connection; every request has a
 * deadline and honours an AbortSignal (sending `$/cancelRequest`).
 */
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const LSP_REQUEST_TIMEOUT_MS = 10_000;

type Pending = {resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>};

export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private closedReason: string | null = null;
  private readonly closeListeners = new Set<(reason: string) => void>();

  constructor(private readonly process: ServiceProcess) {
    process.onData(chunk => this.receive(chunk));
    process.onExit(code => this.close(`exited (${code ?? 'signal'})`));
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListeners.add(listener);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  request<T>(method: string, params: unknown, options: {timeoutMs?: number; signal?: AbortSignal} = {}): Promise<T> {
    if (this.closedReason) return Promise.reject(new FutrynError('RUNTIME_UNAVAILABLE'));
    if (options.signal?.aborted) return Promise.reject(new FutrynError('CANCELLED'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        finish();
        this.notify('$/cancelRequest', {id});
        reject(new FutrynError('CANCELLED'));
      };
      const timer = setTimeout(() => {
        finish();
        this.notify('$/cancelRequest', {id});
        reject(new FutrynError('TIMEOUT'));
      }, options.timeoutMs ?? LSP_REQUEST_TIMEOUT_MS);
      options.signal?.addEventListener('abort', onAbort, {once: true});
      this.pending.set(id, {
        resolve: value => {
          finish();
          resolve(value as T);
        },
        reject: error => {
          finish();
          reject(error);
        },
        timer,
      });
      this.send({jsonrpc: '2.0', id, method, params});
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedReason) this.send({jsonrpc: '2.0', method, params});
  }

  close(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new FutrynError('RUNTIME_UNAVAILABLE'));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.process.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private receive(chunk: Uint8Array): void {
    if (this.closedReason) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) this.fail('oversized header');
        return;
      }
      if (end > MAX_HEADER_BYTES) return this.fail('oversized header');
      const header = this.buffer.subarray(0, end).toString('ascii');
      const lengths = header.split('\r\n').filter(line => /^content-length:/i.test(line));
      const match = lengths.length === 1 ? /^content-length: *([0-9]+) *$/i.exec(lengths[0]!) : null;
      if (!match) return this.fail('missing content length');
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) return this.fail('oversized body');
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message: {id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown};
      try {
        message = JSON.parse(body);
      } catch {
        return this.fail('invalid json');
      }
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        (message as {jsonrpc?: string}).jsonrpc !== '2.0'
      )
        return this.fail('invalid message');
      try {
        this.dispatch(message);
      } catch {
        return this.fail('invalid message');
      }
    }
  }

  private dispatch(message: {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  }) {
    if (message.method && message.id !== undefined) {
      // A server request: answer known ones, refuse the rest (never execute anything).
      const handler = this.requestHandlers.get(message.method);
      let result: unknown = null;
      let error: unknown;
      try {
        if (handler) result = handler(message.params);
        else error = {code: -32601, message: 'Method not supported by Cosmew'};
      } catch {
        error = {code: -32603, message: 'Internal error'};
      }
      this.send(error ? {jsonrpc: '2.0', id: message.id, error} : {jsonrpc: '2.0', id: message.id, result});
      return;
    }
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new FutrynError('PROTOCOL'));
      else pending.resolve(message.result ?? null);
    }
  }

  private fail(reason: string): void {
    this.close(reason);
    this.process.kill();
  }
}
