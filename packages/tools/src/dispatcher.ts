import type {CommandOutputChunk, SubagentEvent, ToolCall, ToolPort} from '@cosmew/contracts';
import type {ToolDispatcherOptions} from './context';
import {createHandlers} from './handlers';
import {InstructionReader} from './handlers/instructions';
import {McpToolSource} from './handlers/mcp';
import {mcpResourceHandler} from './handlers/mcp-resource';
import {toolSearchHandler} from './handlers/tool-search';
import {ToolRegistry} from './registry';
import {ToolRouter} from './router';
import {ToolOrchestrator} from './orchestrator';
import {FileSystemRuntime} from './runtimes/filesystem';
export {
  commandGrantTarget,
  type ApprovalDecision,
  type ApprovalRequest,
  type ToolAuditRecord,
  type ToolDispatcherOptions,
} from './context';

/** Compatible ToolPort facade; composition only. All invocations use the same orchestrator. */
export class ToolDispatcher implements ToolPort {
  private readonly registry = new ToolRegistry();
  private readonly mcpTools: McpToolSource;
  private readonly orchestrator: ToolOrchestrator;
  private readonly instructions: InstructionReader;
  constructor(private readonly options: ToolDispatcherOptions) {
    const filesystem = new FileSystemRuntime(options);
    this.mcpTools = new McpToolSource(options);
    for (const handler of createHandlers(options, filesystem)) this.registry.register(handler);
    this.registry.register(toolSearchHandler(options, this.mcpTools));
    this.registry.register(mcpResourceHandler(options));
    this.orchestrator = new ToolOrchestrator(options, new ToolRouter(this.registry, this.mcpTools));
    this.instructions = new InstructionReader(options, this.orchestrator, filesystem);
  }
  descriptors() {
    // Exposure is separate from invocation: explicit slash/mentions still use the dispatcher.
    const builtin = this.registry
      .descriptors()
      .filter(d => d.name !== 'restore_checkpoint' && (d.name !== 'skill' || !!this.options.skills?.instructions()));
    const remote = this.mcpTools.descriptors().filter(tool => !builtin.some(existing => existing.name === tool.name));
    return [...builtin, ...remote];
  }
  commandsReady(): boolean {
    return this.registry.get('exec_command')?.handler.available() === true;
  }
  invoke(
    call: ToolCall,
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    onEvent?: (event: SubagentEvent) => void,
  ) {
    return this.orchestrator.invoke(call, signal, onOutput, onEvent);
  }
  invokeUserSkill(name: string, signal?: AbortSignal) {
    return this.orchestrator.invoke(
      {id: crypto.randomUUID(), name: 'skill', input: {name}},
      signal,
      undefined,
      undefined,
      true,
    );
  }
  readInstruction(path: string, maxBytes: number, signal?: AbortSignal) {
    return this.instructions.readInstruction(path, maxBytes, signal);
  }
}
