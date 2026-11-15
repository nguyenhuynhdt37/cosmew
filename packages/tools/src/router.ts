import type {ToolOutput} from './context';
import type {ToolHandler} from './handlers/types';
import {ToolRegistry} from './registry';

/** Exact names only: no native-runtime aliases, fallbacks or unregistered handlers. */
export class ToolRouter {
  constructor(private readonly registry: ToolRegistry) {}
  resolve(name: string): {handler: ToolHandler} | ToolOutput {
    const entry = this.registry.get(name);
    if (!entry || !entry.exposed) return {status:'error',code:'UNKNOWN_TOOL',content:`Unknown tool "${name}". Available: ${this.registry.descriptors().map(d=>d.name).join(', ')}.`};
    if (!entry.handler.available()) return entry.handler.unavailable ?? {status:'error',code:'TOOL_UNAVAILABLE',content:'The tool is unavailable.'};
    return {handler: entry.handler};
  }
}
