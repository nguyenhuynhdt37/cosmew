import type {HooksConfig} from './hooks';

/** Valid plugin identifier (lowercase kebab/dot/underscore, max 64 chars). */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type PluginTrustState = 'no-exec' | 'trusted' | 'untrusted' | 'trust-changed';

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Relative paths inside the plugin directory (default: `skills/`). */
  skills?: string[];
  /** Relative paths inside the plugin directory (default: `commands/`). */
  commands?: string[];
  /** Relative paths inside the plugin directory (default: `agents/`). */
  agents?: string[];
  /** Relative path to hooks JSON or inline `HooksConfig`. */
  hooks?: string | HooksConfig;
  /** Relative path to `.mcp.json` / `mcp.json` or inline `mcpServers` map. */
  mcpServers?: string | Record<string, unknown>;
}

export interface PluginGrantSummary {
  kind: 'hook' | 'mcp';
  summary: string;
}

export interface PluginAssetCounts {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  mcpServers: number;
}

/** Content-free view of an installed user plugin (ADR 0125). Never carries secrets or grants authority directly. */
export interface InstalledPluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  path: string;
  enabled: boolean;
  trustState: PluginTrustState;
  /** Deterministic SHA-256 over the plugin manifest, hooks, MCP definitions, and file layout. */
  contentHash: string;
  trustedHash: string | null;
  installedAt: string;
  counts: PluginAssetCounts;
  /** Human-readable description of every hook command / MCP server requiring user SHA-256 trust. */
  grants: PluginGrantSummary[];
  diagnostics: string[];
}

export interface PluginSnapshot {
  supported: boolean;
  directory: string;
  plugins: InstalledPluginView[];
  untrustedCount: number;
  diagnostics: string[];
}

export type PluginManagementAction =
  | {type: 'install'; sourcePath: string}
  | {type: 'uninstall'; id: string}
  | {type: 'enable'; id: string}
  | {type: 'disable'; id: string}
  | {type: 'trust'; id: string; hash: string}
  | {type: 'revoke'; id: string}
  | {type: 'reload'};

export interface PluginManagementResult {
  ok: boolean;
  message: string;
  plugin?: InstalledPluginView;
  snapshot: PluginSnapshot;
}
