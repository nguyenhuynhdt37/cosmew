import {createHash} from 'node:crypto';
import {FutrynError} from '@cosmew/contracts';
import {MemoryDirectory} from './memory-directory';

export interface McpSettingsDocument {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
}
export interface McpSettingsRead {
  document: McpSettingsDocument;
  revision: string;
}
/** User-only MCP file. Mutations preserve unrelated fields and compare the exact original bytes. */
export class FileMcpSettings {
  constructor(private readonly directory: string) {}
  private access<T>(run: (directory: MemoryDirectory) => T): T {
    const directory = MemoryDirectory.openPrivate(this.directory);
    try {
      directory.lock('.mcp-settings.lock');
      return run(directory);
    } finally {
      directory.close();
    }
  }
  private decode(directory: MemoryDirectory): McpSettingsRead {
    const text = directory.read('mcp.json', 256 * 1024);
    const revision = createHash('sha256')
      .update(text ?? '')
      .digest('hex');
    try {
      const document = text === undefined ? {mcpServers: {}} : JSON.parse(text);
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error();
      document.mcpServers ??= {};
      if (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers))
        throw new Error();
      return {document, revision};
    } catch {
      throw new FutrynError('STORAGE');
    }
  }
  read(): McpSettingsRead {
    return this.access(directory => this.decode(directory));
  }
  update(revision: string, change: (document: McpSettingsDocument) => void): McpSettingsRead {
    return this.access(directory => {
      const current = this.decode(directory);
      if (revision !== current.revision) throw new FutrynError('STORAGE');
      const next = structuredClone(current.document);
      change(next);
      const text = JSON.stringify(next, null, 2) + '\n';
      if (
        Buffer.byteLength(text) > 256 * 1024 ||
        (Object.keys(next.mcpServers).length > 16 &&
          Object.keys(next.mcpServers).length >= Object.keys(current.document.mcpServers).length)
      )
        throw new FutrynError('BUDGET');
      directory.atomic('mcp.json', text);
      return this.decode(directory);
    });
  }
}
