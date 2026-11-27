/** Supported lifecycle hook events (ADR 0120). Hooks never carry permission grants. */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit'] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface HookCommandDefinition {
  type: 'command';
  command: string;
  /** Per-hook timeout in seconds (1..60, defaults to 10). */
  timeout?: number;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommandDefinition[];
}

export type HooksConfig = Partial<Record<HookEventName, HookMatcherEntry[]>>;

export interface ConfiguredHook {
  scope: 'user' | 'project' | 'local' | 'plugin';
  pluginId?: string;
  event: HookEventName;
  matcher?: string;
  command: string;
  timeoutMs: number;
}

export interface HookSummaryView {
  scope: 'user' | 'project' | 'local' | 'plugin';
  pluginId?: string;
  event: HookEventName;
  matcher?: string;
  command: string;
  timeoutMs: number;
}

export interface HookRanEvent {
  type: 'hook.ran';
  event: HookEventName;
  name: string;
  summary: string;
  blocked?: boolean;
}

export interface HooksSnapshot {
  supported: boolean;
  enabled?: boolean;
  disabledReason?: string;
  hooks: readonly HookSummaryView[];
  untrustedPendingCount?: number;
}

export interface HookInput {
  event: HookEventName;
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: {status: string; code?: string; content: string};
  prompt?: string;
  stopHookActive?: boolean;
}

export interface HookOutcome {
  action: 'continue' | 'block';
  reason?: string;
  additionalContext?: string;
  events: HookRanEvent[];
}

export interface HookPort {
  snapshot(): HooksSnapshot;
  run(input: HookInput, signal?: AbortSignal): Promise<HookOutcome>;
}

export interface McpServersSnapshot {
  servers: {
    name: string;
    status: import('./mcp-management').McpConnectionState;
    toolCount: number;
    source: string;
  }[];
  supported: {stdioManagement: boolean; oauthManagement: boolean};
}
