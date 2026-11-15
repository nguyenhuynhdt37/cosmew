import type {ToolCall, ToolPort} from '@hannes/contracts';
import type {ToolDispatcherOptions} from './context';
import {createHandlers} from './handlers';
import {InstructionReader} from './handlers/instructions';
import {ToolRegistry} from './registry';
import {ToolRouter} from './router';
import {ToolOrchestrator} from './orchestrator';
import {FileSystemRuntime} from './runtimes/filesystem';
export {commandGrantTarget, type ApprovalDecision, type ApprovalRequest, type ToolAuditRecord, type ToolDispatcherOptions} from './context';

/** Compatible ToolPort facade; composition only. All invocations use the same orchestrator. */
export class ToolDispatcher implements ToolPort {
  private readonly registry = new ToolRegistry();
  private readonly orchestrator: ToolOrchestrator;
  private readonly instructions: InstructionReader;
  constructor(options: ToolDispatcherOptions) {
    const filesystem = new FileSystemRuntime(options);
    for (const handler of createHandlers(options,filesystem)) this.registry.register(handler);
    this.orchestrator = new ToolOrchestrator(options,new ToolRouter(this.registry));
    this.instructions = new InstructionReader(options,this.orchestrator,filesystem);
  }
  descriptors() { return this.registry.descriptors(); }
  commandsReady(): boolean { return this.registry.get('exec_command')?.handler.available() === true; }
  invoke(call: ToolCall, signal?: AbortSignal) { return this.orchestrator.invoke(call,signal); }
  readInstruction(path: string, maxBytes: number, signal?: AbortSignal) { return this.instructions.readInstruction(path,maxBytes,signal); }
}
