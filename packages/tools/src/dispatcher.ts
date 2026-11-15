import { HannesError, toolResultSchema, type ToolCall, type ToolDescriptor, type ToolPort, type ToolResult, type ProjectInstructionReadResult } from '@hannes/contracts';
import { evaluateRead, type SessionGrants } from '@hannes/security';
import { WorkspaceDenied, type ResolvedPath, type WorkspaceRoot } from '@hannes/workspace';
import type { z } from 'zod';
import { readDescriptor, readInput, runRead } from './builtin/read';
import { candidateFiles, compilePattern, globDescriptor, globInput, grepDescriptor, grepInput, runGlob } from './builtin/search';
import { LIMITS, clipBytes } from './limits';

export type ApprovalDecision = 'once' | 'session' | 'deny';

export interface ApprovalRequest {
  tool: string;
  capability: 'fs.read';
  /** Workspace-relative target. */
  target: string;
  reason: string;
}

/** One line of the tool audit trail. `requested` is written before any prompt or execution. */
export interface ToolAuditRecord {
  at: string;
  callId: string;
  tool: string;
  target: string | null;
  phase: 'requested' | 'decided' | 'completed';
  decision?: 'allow' | 'ask' | 'deny' | ApprovalDecision;
  reason?: string;
  outcome?: ToolResult['status'];
  code?: string;
}

export interface ToolDispatcherOptions {
  workspace: WorkspaceRoot;
  grants: SessionGrants;
  /** Ask the user; must resolve to 'deny' when the prompt is dismissed or cancelled. */
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  /** Redact all outputs; incomplete prefixes must withhold any partial registered secret suffix. */
  redact(text: string, incomplete?: boolean): string;
  audit?(record: ToolAuditRecord): void;
  stateDirectory?: string;
  /** Search deadline; defaults to 30 s. */
  searchDeadlineMs?: number;
}

const DESCRIPTORS: ToolDescriptor[] = [readDescriptor, globDescriptor, grepDescriptor];

/**
 * The single enforcement point for TOOLS1. Order: validate arguments → resolve paths inside the
 * workspace → policy decision (deny → ask → allow) → approval for `ask` → audit → execute →
 * redact and bound the output. Executors never see a path that skipped these steps.
 */
export class ToolDispatcher implements ToolPort {
  constructor(private readonly options: ToolDispatcherOptions) {}

  descriptors(): ToolDescriptor[] { return DESCRIPTORS; }

  /** Automatic instruction reads share policy/audit but never prompt for newly required access. */
  async readInstruction(path: string, maxBytes: number, signal?: AbortSignal): Promise<ProjectInstructionReadResult> {
    signal?.throwIfAborted();
    if (!/(^|\/)AGENTS(?:\.override)?\.md$/.test(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) return {status:'error',code:'INVALID_INPUT'};
    const callId = crypto.randomUUID();
    const audit = (record: Omit<ToolAuditRecord,'at'|'callId'|'tool'>) => this.options.audit?.({...record,at:new Date().toISOString(),callId,tool:'read'});
    let requested = false;
    const start = () => {if (!requested) {requested=true; audit({target:null,phase:'requested'});}};
    const finish = (result: ProjectInstructionReadResult): ProjectInstructionReadResult => {
      audit({target:result.status === 'ok' ? result.canonicalPath : null,phase:'completed',outcome:result.status === 'ok' ? 'ok' : result.status === 'denied' ? 'denied' : 'error',code:result.status === 'ok' ? undefined : result.code});
      return result;
    };
    try {
      const file = this.options.workspace.resolve(path);
      start();
      if (file.kind !== 'file') return finish({status:'error',code:'NOT_A_FILE'});
      const gate = await this.authorize('read',file,audit,signal,false);
      if (gate) return finish({status:'denied',code:gate.code ?? 'DENIED'});
      signal?.throwIfAborted();
      const current = evaluateRead(file.relative,file.absolute,{stateDirectory:this.options.stateDirectory});
      if (current.effect === 'deny' || current.effect === 'ask' && !this.options.grants.has('fs.read',file.absolute)) {
        audit({target:file.relative,phase:'decided',decision:'deny',reason:'revalidation'});
        return finish({status:'denied',code:current.effect === 'ask' ? 'APPROVAL_REQUIRED' : 'DENIED'});
      }
      const {bytes,size} = this.options.workspace.readBytes(file,maxBytes);
      if (bytes.includes(0)) return finish({status:'error',code:'BINARY_FILE'});
      const truncated = size > bytes.byteLength;
      let text: string;
      try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:truncated});}
      catch {return finish({status:'error',code:'INVALID_UTF8'});}
      const safe = this.options.redact(text,truncated);
      const content = new TextDecoder().decode(Buffer.from(safe).subarray(0,maxBytes),{stream:true});
      signal?.throwIfAborted();
      return finish({status:'ok',content,canonicalPath:file.relative,fileBytes:size,truncated:truncated || Buffer.byteLength(safe)>maxBytes});
    } catch (error) {
      if (signal?.aborted || error instanceof HannesError && error.code === 'CANCELLED') throw new HannesError('CANCELLED');
      if (error instanceof WorkspaceDenied && error.reason === 'not-found' && !requested) return {status:'missing',code:'NOT_FOUND'};
      start();
      if (error instanceof WorkspaceDenied && error.reason === 'outside-workspace') {audit({target:null,phase:'decided',decision:'deny',reason:error.reason}); return finish({status:'denied',code:'DENIED'});}
      return finish({status:'error',code:'UNREADABLE'});
    }
  }

  async invoke(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const audit = (record: Omit<ToolAuditRecord, 'at' | 'callId' | 'tool'>) =>
      this.options.audit?.({ at: new Date().toISOString(), callId: call.id, tool: call.name, ...record });
    const finish = (result: Omit<ToolResult, 'callId' | 'name'>): ToolResult => {
      const clipped = clipBytes(this.options.redact(result.content), 60000);
      const final = toolResultSchema.parse({ ...result, content: clipped.text, truncated: result.truncated || clipped.clipped || undefined, callId: call.id, name: call.name });
      audit({ target: final.target ?? null, phase: 'completed', outcome: final.status, code: final.code });
      return final;
    };
    const fail = (code: string, content: string, target?: string, status: 'error' | 'denied' = 'error') => finish({ status, code, content, target });

    signal?.throwIfAborted();
    const descriptor = DESCRIPTORS.find(d => d.name === call.name);
    audit({ target: null, phase: 'requested' });
    if (!descriptor) return fail('UNKNOWN_TOOL', `Unknown tool "${call.name}". Available: read, glob, grep.`);

    try {
      if (call.name === 'read') {
        const input = this.parse(readInput, call.input);
        if (!input) return fail('INVALID_INPUT', 'Invalid arguments for read.');
        const file = this.options.workspace.resolve(input.path);
        const gate = await this.authorize(call.name, file, audit, signal);
        if (gate) return finish(gate);
        const outcome = runRead(this.options.workspace, file, input);
        if (!outcome.ok) return fail(outcome.code, readFailure(outcome.code, file.relative), file.relative);
        return finish({ status: 'ok', content: outcome.content, target: file.relative, truncated: outcome.truncated || undefined });
      }
      if (call.name === 'glob') {
        const input = this.parse(globInput, call.input);
        if (!input) return fail('INVALID_INPUT', 'Invalid arguments for glob.');
        const base = this.options.workspace.resolve(input.path ?? '.');
        if (base.kind !== 'directory') return fail('NOT_A_DIRECTORY', `${base.relative} is not a directory.`, base.relative);
        audit({ target: base.relative, phase: 'decided', decision: 'allow', reason: 'listing' });
        const outcome = runGlob(this.options.workspace, base, input, this.options.stateDirectory);
        return finish({ status: 'ok', content: outcome.content, target: base.relative, truncated: outcome.truncated || undefined });
      }
      const input = this.parse(grepInput, call.input);
      if (!input) return fail('INVALID_INPUT', 'Invalid arguments for grep.');
      if (!compilePattern(input.pattern, input.ignoreCase)) return fail('INVALID_PATTERN', 'The pattern is not a valid JavaScript regular expression.');
      const base = this.options.workspace.resolve(input.path ?? '.');
      if (base.kind !== 'directory') return fail('NOT_A_DIRECTORY', `${base.relative} is not a directory.`, base.relative);
      audit({ target: base.relative, phase: 'decided', decision: 'allow', reason: 'search-skips-secrets' });
      return finish(await this.grep(base, input, signal));
    } catch (error) {
      if (error instanceof WorkspaceDenied) {
        // Never echo a path outside the workspace back to the model.
        if (error.reason === 'outside-workspace') { audit({ target: null, phase: 'decided', decision: 'deny', reason: error.reason }); return fail('DENIED', 'Access denied: the path is outside the approved workspace.', undefined, 'denied'); }
        if (error.reason === 'inaccessible') return fail('UNREADABLE', 'File metadata is inaccessible.');
        if (error.reason === 'not-found') return fail('NOT_FOUND', 'No such file or directory in the workspace.');
        return fail('INVALID_INPUT', 'Invalid path.');
      }
      if (error instanceof HannesError && error.code === 'CANCELLED') throw error;
      if (signal?.aborted) throw new HannesError('CANCELLED');
      if (error instanceof HannesError && error.code === 'TIMEOUT') return fail('TIMEOUT', 'The search took longer than 30 seconds and was stopped. Narrow the path, glob or pattern.');
      return fail('EXECUTION_FAILED', 'The tool failed.');
    }
  }

  private parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> | null {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : null;
  }

  /** Policy + approval for one resolved target. Returns a denial result, or null to proceed. */
  private async authorize(tool: string, file: ResolvedPath, audit: (r: Omit<ToolAuditRecord, 'at' | 'callId' | 'tool'>) => void, signal?: AbortSignal, allowPrompt = true): Promise<Omit<ToolResult, 'callId' | 'name'> | null> {
    const decision = evaluateRead(file.relative, file.absolute, { stateDirectory: this.options.stateDirectory });
    audit({ target: file.relative, phase: 'decided', decision: decision.effect, reason: decision.reason });
    if (decision.effect === 'deny') return { status: 'denied', code: 'DENIED', content: `Access denied by policy (${decision.reason}).`, target: file.relative };
    if (decision.effect === 'allow' || this.options.grants.has('fs.read', file.absolute)) return null;
    if (!allowPrompt) return {status:'denied',code:'APPROVAL_REQUIRED',content:'Automatic instruction loading requires an existing permission grant.',target:file.relative};
    const answer = await this.options.approve({ tool, capability: 'fs.read', target: file.relative, reason: decision.reason }, signal);
    signal?.throwIfAborted();
    audit({ target: file.relative, phase: 'decided', decision: answer, reason: 'user' });
    if (answer === 'session') this.options.grants.grant('fs.read', file.absolute);
    if (answer === 'deny') return { status: 'denied', code: 'DENIED', content: 'The user denied reading this file.', target: file.relative };
    return null;
  }

  private grep(base: ResolvedPath, input: z.infer<typeof grepInput>, signal?: AbortSignal): Promise<Omit<ToolResult, 'callId' | 'name'>> {
    const deadline = Date.now() + (this.options.searchDeadlineMs ?? LIMITS.deadlineMs);
    const { files, incomplete } = candidateFiles(this.options.workspace, base, input.glob, deadline);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./builtin/grep-worker.ts', import.meta.url).href);
      const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); worker.terminate(); };
      const onAbort = () => { stop(); reject(new HannesError('CANCELLED')); };
      const timer = setTimeout(() => { stop(); reject(new HannesError('TIMEOUT')); }, Math.max(1, deadline - Date.now()));
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
      worker.onerror = () => { stop(); reject(new HannesError('PROTOCOL')); };
      worker.postMessage({ root: this.options.workspace.root, files, pattern: input.pattern, ignoreCase: input.ignoreCase, stateDirectory: this.options.stateDirectory });
    });
  }
}

function readFailure(code: string, path: string): string {
  if (code === 'IS_DIRECTORY') return `${path} is a directory; use glob to list it.`;
  if (code === 'BINARY_FILE') return `${path} looks like a binary file and was not read.`;
  return `${path} is larger than 8 MiB and was not read.`;
}
