/** Reserved lifecycle notification. Hooks never carry permission grants. Execution is not built. */
export interface HookRanEvent {
  type: 'hook.ran';
  event: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart' | 'UserPromptSubmit';
  name: string;
  summary: string;
}
export interface HooksSnapshot {
  supported: false;
  hooks: readonly [];
}
export interface McpServersSnapshot {
  servers: {
    name: string;
    status: 'connected' | 'needs-auth' | 'failed' | 'disabled';
    toolCount: number;
    source: string;
  }[];
  supported: {stdioManagement: false; oauthManagement: false};
}
