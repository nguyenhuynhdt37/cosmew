/** Host-owned MCP configuration operations. These are user actions, never model tool grants. */
export type McpConnectionState =
  'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'needs-auth' | 'failed' | 'disabled';
export type McpServerConfiguration =
  | {transport: 'http'; url: string; headers?: Record<string, string>; enabled?: boolean}
  | {transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean};
export type McpCatalogRecipe =
  | {kind: 'remote'; url: string}
  | {kind: 'npm'; packageName: string; version: string; integrity?: string; bin?: string}
  | {kind: 'manual'; reason: string};
export interface McpCatalogItem {
  id: string;
  name: string;
  description: string;
  version?: string;
  sourceUrl?: string;
  registryListed: boolean;
  tested: boolean;
  recipes: McpCatalogRecipe[];
}
export const MCP_OAUTH_ISSUES = {
  'metadata-unavailable': 'OAuth metadata is missing or unreachable.',
  'metadata-invalid': 'OAuth metadata failed issuer or resource validation.',
  'client-registration-required': 'This server requires a registered OAuth client.',
  'unsupported-flow': 'This server does not offer a compatible OAuth authorization-code flow.',
  'registration-failed': 'The OAuth server rejected or could not complete client registration.',
  'authorization-failed': 'Browser authorization did not complete. Retry sign-in.',
  'token-exchange-failed': 'The OAuth token exchange failed. Retry sign-in.',
} as const;
export type McpOAuthIssue = keyof typeof MCP_OAUTH_ISSUES;

export interface McpManagedServer {
  name: string;
  transport: 'stdio' | 'http';
  source: 'manual' | 'registry' | 'recommended' | 'plugin';
  enabled: boolean;
  connection: McpConnectionState;
  auth: {
    state: 'not-required' | 'unknown' | 'needs-login' | 'authorized' | 'expired';
    scopes?: string[];
    method?: 'github-pat';
    issue?: McpOAuthIssue;
  };
  installation: {
    state: 'unmanaged' | 'ready' | 'missing' | 'not-applicable';
    id?: string;
    packageName?: string;
    version?: string;
  };
  toolCount: number;
  tools: {name: string; description: string}[];
  endpoint?: string;
  diagnostic?: string;
  catalogId?: string;
}
export interface McpManagerSnapshot {
  supported: boolean;
  configPath: string;
  servers: McpManagedServer[];
  problems: string[];
}
export type McpManagementAction =
  | {
      type: 'add';
      name: string;
      config: McpServerConfiguration;
      source?: 'manual' | 'registry' | 'recommended';
      catalogId?: string;
    }
  | {type: 'edit'; name: string; config: McpServerConfiguration}
  | {type: 'remove'; name: string}
  | {type: 'enable' | 'disable' | 'logout' | 'reconnect' | 'doctor'; name: string}
  /** A supplied PAT is accepted only for the official GitHub MCP endpoint. */
  | {type: 'login'; name: string; bearer?: string}
  | {type: 'credentials'; name: string; bearer: string | null; expectedEndpoint?: string}
  | {type: 'search'; query: string; cursor?: string}
  | {type: 'recommended'}
  | {
      type: 'install';
      name: string;
      packageName: string;
      version: string;
      integrity?: string;
      lockfile?: unknown;
      bin?: string;
      catalogId?: string;
    };
export interface McpManagementResult {
  snapshot: McpManagerSnapshot;
  message?: string;
  entries?: McpCatalogItem[];
  nextCursor?: string;
  logout?: {
    localCleared: boolean;
    remoteRevoked: boolean;
    remoteStatus: 'revoked' | 'unsupported' | 'failed' | 'not-needed';
  };
}
