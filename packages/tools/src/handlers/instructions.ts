import {FutrynError, type ProjectInstructionReadResult} from '@futryn/contracts';
import {WorkspaceDenied} from '@futryn/workspace';
import type {ToolAuditRecord, ToolDispatcherOptions} from '../context';
import {ToolOrchestrator} from '../orchestrator';
import {FileSystemRuntime} from '../runtimes/filesystem';

/** Automatic project context is not a model-exposed tool. It shares read authorization. */
export class InstructionReader {
  constructor(
    private readonly options: ToolDispatcherOptions,
    private readonly orchestrator: ToolOrchestrator,
    private readonly filesystem: FileSystemRuntime,
  ) {}
  /** Automatic instruction reads share policy/audit but never prompt for newly required access. */
  async readInstruction(path: string, maxBytes: number, signal?: AbortSignal): Promise<ProjectInstructionReadResult> {
    signal?.throwIfAborted();
    if (
      !/(^|\/)AGENTS(?:\.override)?\.md$/.test(path) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 65536
    )
      return {status: 'error', code: 'INVALID_INPUT'};
    const callId = crypto.randomUUID();
    const audit = (record: Omit<ToolAuditRecord, 'at' | 'callId' | 'tool'>) =>
      this.options.audit?.({...record, at: new Date().toISOString(), callId, tool: 'read'});
    let requested = false;
    const start = () => {
      if (!requested) {
        requested = true;
        audit({target: null, phase: 'requested'});
      }
    };
    const finish = (result: ProjectInstructionReadResult): ProjectInstructionReadResult => {
      audit({
        target: result.status === 'ok' ? result.canonicalPath : null,
        phase: 'completed',
        outcome: result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : 'error',
        code: result.status === 'ok' ? undefined : result.code,
      });
      return result;
    };
    try {
      const file = this.options.workspace.resolve(path);
      start();
      if (file.kind !== 'file') return finish({status: 'error', code: 'NOT_A_FILE'});
      const authorization = await this.orchestrator.authorizeRead('read', file, audit, signal, false);
      const gate = authorization.gate ?? this.orchestrator.revalidateRead(file, authorization.viaSession, audit, false);
      if (gate) return finish({status: 'denied', code: gate.code ?? 'DENIED'});
      signal?.throwIfAborted();
      const {bytes, size} = this.filesystem.instruction(file, maxBytes);
      if (bytes.includes(0)) return finish({status: 'error', code: 'BINARY_FILE'});
      const truncated = size > bytes.byteLength;
      let text: string;
      try {
        text = new TextDecoder('utf-8', {fatal: true}).decode(bytes, {stream: truncated});
      } catch {
        return finish({status: 'error', code: 'INVALID_UTF8'});
      }
      const safe = this.options.redact(text, truncated);
      const content = new TextDecoder().decode(Buffer.from(safe).subarray(0, maxBytes), {stream: true});
      signal?.throwIfAborted();
      return finish({
        status: 'ok',
        content,
        canonicalPath: file.relative,
        fileBytes: size,
        truncated: truncated || Buffer.byteLength(safe) > maxBytes,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof FutrynError && error.code === 'CANCELLED'))
        throw new FutrynError('CANCELLED');
      if (error instanceof WorkspaceDenied && error.reason === 'not-found' && !requested)
        return {status: 'missing', code: 'NOT_FOUND'};
      start();
      if (error instanceof WorkspaceDenied && error.reason === 'outside-workspace') {
        audit({target: null, phase: 'decided', decision: 'deny', reason: error.reason});
        return finish({status: 'denied', code: 'DENIED'});
      }
      return finish({status: 'error', code: 'UNREADABLE'});
    }
  }
}
