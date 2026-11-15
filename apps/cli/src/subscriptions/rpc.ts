import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { HannesError } from '@hannes/contracts';
import { denyRuntimeRequest } from '@hannes/security';

export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: any }
/** Bounded wire transport. No runtime stderr or error body reaches the UI. */
export class SubscriptionRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private seq = 0;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private dynamicToolHandler?: (params: any) => Promise<unknown>;
  private permissionHandler?: (method: string, params: any) => Promise<unknown | undefined>;
  /** Full-access sessions answer runtime permission requests through Hannes (ADR 0027); undefined denies. */
  onPermissionRequest(handler: (method: string, params: any) => Promise<unknown | undefined>): () => void { this.permissionHandler = handler; return () => { this.permissionHandler = undefined; }; }
  onDynamicTool(handler: (params: any) => Promise<unknown>): () => void { this.dynamicToolHandler = handler; return () => { this.dynamicToolHandler = undefined; }; }
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  constructor(command: string, args: string[], env: Record<string, string>, cwd: string, private readonly framing: 'lines' | 'content-length', private readonly stderr: (line: string) => void = () => {}) {
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.on('error', () => this.fail(new HannesError('NOT_FOUND')));
    this.child.on('exit', () => this.fail(new HannesError('TRANSPORT')));
    this.child.stdin.on('error', () => this.fail(new HannesError('TRANSPORT')));
    this.child.stdout.on('data', (data: Buffer) => { try { this.parse(data); } catch { this.fail(new HannesError('PROTOCOL')); this.child.kill(); } });
    let diagnostic = '';
    this.child.stderr.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16384);
      const lines = diagnostic.split(/[\r\n]/); diagnostic = lines.pop() ?? '';
      for (const line of lines) this.stderr(line.slice(0, 8192));
    });
  }
  onMessage(listener: (message: RpcMessage) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private parse(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > 4 * 1024 * 1024) throw new HannesError('PROTOCOL');
    while (this.buffer.length) {
      let bytes: Buffer;
      if (this.framing === 'lines') {
        const end = this.buffer.indexOf(10); if (end < 0) return;
        bytes = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        if (!bytes.toString().trim()) continue;
      } else {
        const boundary = this.buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
        const match = /^Content-Length: (\d+)$/im.exec(this.buffer.subarray(0, boundary).toString());
        if (!match) throw new HannesError('PROTOCOL');
        const length = Number(match[1]); if (length > 4 * 1024 * 1024 || length < 2) throw new HannesError('PROTOCOL');
        if (this.buffer.length < boundary + 4 + length) return;
        bytes = this.buffer.subarray(boundary + 4, boundary + 4 + length); this.buffer = this.buffer.subarray(boundary + 4 + length);
      }
      const message = JSON.parse(bytes.toString('utf8')) as RpcMessage;
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new HannesError('PROTOCOL');
      if (message.method && message.id !== undefined) {
        if (message.method === 'item/tool/call' && this.dynamicToolHandler) {
          const id = message.id;
          void this.dynamicToolHandler(message.params).then(result => { if (!this.closed) this.write({id, result}); }, () => { if (!this.closed) this.write({id, error: {code: -32601, message: 'Tool request denied.'}}); }).catch(() => {});
          continue;
        }
        if (this.permissionHandler) {
          const { id, method, params } = message;
          const deny = () => { try { return denyRuntimeRequest(method); } catch { return undefined; } };
          void this.permissionHandler(method, params).catch(() => undefined).then(result => {
            if (this.closed) return;
            const answer = result ?? deny();
            this.write(answer === undefined ? { id, error: { code: -32601, message: 'FUTRYN does not authorize this runtime request.' } } : { id, result: answer });
          }).catch(() => {});
          continue;
        }
        try { this.write({ id: message.id, result: denyRuntimeRequest(message.method) }); }
        catch { this.write({ id: message.id, error: { code: -32601, message: 'FUTRYN does not authorize runtime tools or filesystem access.' } }); }
        continue;
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const operation = this.pending.get(message.id)!; this.pending.delete(message.id); clearTimeout(operation.timer);
        if (message.error) operation.reject(new HannesError(message.error.code === -32000 || message.error.code === -32001 ? 'AUTH' : 'PROTOCOL'));
        else operation.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    }
  }
  private write(message: RpcMessage): void {
    if (this.closed) throw new HannesError('TRANSPORT');
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.child.stdin.write(this.framing === 'lines' ? body + '\n' : `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }
  request(method: string, params: unknown = {}, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HannesError('TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: '__closed' });
  }
  async close(): Promise<void> {
    this.fail(new HannesError('CANCELLED'));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.kill('SIGTERM');
    });
  }
}
