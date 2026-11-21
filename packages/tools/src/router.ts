import type {ToolDescriptor} from '@cosmew/contracts';
import type {ToolOutput} from './context';
import type {McpToolSource} from './handlers/mcp';
import type {ToolHandler} from './handlers/types';
import {ToolRegistry} from './registry';

/** Exact names only: no native-runtime aliases, fallbacks or unregistered handlers. */
export class ToolRouter {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly mcp?: McpToolSource,
  ) {}
  resolve(name: string): {handler: ToolHandler} | ToolOutput {
    const dynamic = this.mcp?.resolve(name);
    if (dynamic) {
      if (!dynamic.available())
        return (
          dynamic.unavailable ?? {
            status: 'error',
            code: 'TOOL_UNAVAILABLE',
            content: 'The MCP tool is no longer connected.',
          }
        );
      return {handler: dynamic};
    }
    const entry = this.registry.get(name);
    if (!entry || !entry.exposed)
      return {
        status: 'error',
        code: 'UNKNOWN_TOOL',
        content: `Unknown tool "${name}". Available: ${this.names().join(', ')}.`,
      };
    if (!entry.handler.available())
      return (
        entry.handler.unavailable ?? {status: 'error', code: 'TOOL_UNAVAILABLE', content: 'The tool is unavailable.'}
      );
    return {handler: entry.handler};
  }
  private names(): string[] {
    const extra: ToolDescriptor[] = this.mcp?.descriptors() ?? [];
    return [...this.registry.descriptors().map(d => d.name), ...extra.map(d => d.name)];
  }
}
