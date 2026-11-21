import {z} from 'zod';
import {modelIdSchema, type Selection, type Usage} from './models';
import type {TurnBudget} from './telemetry';

/** Codex `DEFAULT_AGENT_MAX_THREADS` (`codex-rs/core/src/config/mod.rs:277`, pinned 090be4df). */
export const DEFAULT_AGENT_MAX_THREADS = 6;
/** Codex `DEFAULT_AGENT_MAX_DEPTH` (`codex-rs/core/src/config/mod.rs:287`, pinned 090be4df). */
export const DEFAULT_AGENT_MAX_DEPTH = 1;

export const BUILTIN_SUBAGENT_TYPES = ['explore', 'worker', 'general', 'plan'] as const;
export type BuiltinSubagentType = (typeof BUILTIN_SUBAGENT_TYPES)[number];
/** Built-in role id or the name of a custom agent definition (S5b, `.cosmew/agents/*.md`). */
export const subagentTypeSchema = z.string().min(1).max(64);
export type SubagentType = string;

export const subagentStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'closed']);
/** `completed` doubles as "idle after a turn": a finished child accepts `agent_message` follow-ups until closed. */
export type SubagentStatus = z.infer<typeof subagentStatusSchema>;

/**
 * Input schema for the `agent` tool (Wave 2 S5a): combines OpenCode's `subagent`
 * (`description`, `prompt`, `model`) and Codex's `spawn_agent` (`agent_type`,
 * `reasoning_effort`, `fork_context`) plus `background` for S5b.
 */
export const agentToolInputSchema = z.strictObject({
  agent_type: z.string().min(1).max(64),
  description: z.string().min(1).max(200),
  prompt: z.string().min(1),
  model: z.string().max(200).optional(),
  reasoning_effort: z.string().max(40).optional(),
  background: z.boolean().optional(),
  fork_context: z.boolean().optional(),
  /** S5c: run the child in its own Git worktree (Claude Code `isolation`); only `worktree` exists. */
  isolation: z.enum(['worktree']).optional(),
});
export type AgentToolInput = z.infer<typeof agentToolInputSchema>;

/** `agent_message` (Codex `send_input`): append a follow-up to a running or finished child. */
export const agentMessageInputSchema = z.strictObject({
  id: z.string().min(1).max(200),
  message: z.string().min(1).max(100_000),
});
export type AgentMessageInput = z.infer<typeof agentMessageInputSchema>;
/** Codex `wait`: default 30 s, clamped to 10 s .. 1 h (`multi_agents_common.rs`, `config/mod.rs`). */
export const AGENT_WAIT_DEFAULT_MS = 30_000;
export const AGENT_WAIT_MIN_MS = 10_000;
export const AGENT_WAIT_MAX_MS = 3_600_000;
export const agentWaitInputSchema = z.strictObject({
  ids: z.array(z.string().min(1).max(200)).max(64).optional(),
  timeout_ms: z.number().int().optional(),
});
export type AgentWaitInput = z.infer<typeof agentWaitInputSchema>;
export const agentCloseInputSchema = z.strictObject({id: z.string().min(1).max(200)});
export type AgentCloseInput = z.infer<typeof agentCloseInputSchema>;
export const AGENT_TOOL_NAMES = ['agent', 'agent_message', 'agent_wait', 'agent_close'] as const;

export const subagentTranscriptStepSchema = z.strictObject({
  kind: z.enum(['text', 'tool']),
  text: z.string().max(16384).optional(),
  callId: z.string().max(200).optional(),
  toolName: z.string().max(100).optional(),
  target: z.string().max(1024).optional(),
  status: z.enum(['running', 'ok', 'denied', 'error']).optional(),
  output: z.string().max(4096).optional(),
});
export type SubagentTranscriptStep = z.infer<typeof subagentTranscriptStepSchema>;

/**
 * Public lifecycle and progress events for a subagent run (contract 1.32).
 * Emitted in order: `subagent.started` -> zero or more `subagent.progress` -> `subagent.finished`.
 */
export type SubagentEvent =
  | {
      type: 'subagent.started';
      callId: string;
      agentId: string;
      agentType: SubagentType;
      description: string;
      modelId: string;
      reasoningEffort?: string;
      forkContext?: boolean;
      background?: boolean;
    }
  | {
      type: 'subagent.progress';
      callId: string;
      agentId: string;
      agentType: SubagentType;
      description: string;
      /** Currently running tool of the subagent (e.g. `read src/index.ts`), when active. */
      currentTool?: string;
      /** Total tool calls dispatched by the subagent so far. */
      toolCount: number;
      /** Cumulative token usage of this subagent so far. */
      usage: Usage | null;
      /** Redacted, bounded transcript steps for UI disclosure. */
      steps?: SubagentTranscriptStep[];
      background?: boolean;
    }
  | {
      type: 'subagent.finished';
      callId: string;
      agentId: string;
      agentType: SubagentType;
      description: string;
      status: 'completed' | 'failed' | 'cancelled';
      toolCount: number;
      usage: Usage | null;
      durationMs: number;
      summary?: string;
      errorCode?: string;
      steps?: SubagentTranscriptStep[];
      background?: boolean;
    };

export const subagentSessionRecordSchema = z.strictObject({
  id: z.string().uuid(),
  parentConversationId: z.string().uuid(),
  parentTurnId: z.string().nullable(),
  callId: z.string().min(1).max(200),
  depth: z.number().int().min(1).max(16),
  agentType: subagentTypeSchema,
  description: z.string().min(1).max(200),
  prompt: z.string(),
  selection: z.strictObject({accountId: z.string().uuid(), modelId: modelIdSchema}).optional(),
  forkContext: z.boolean(),
  background: z.boolean(),
  isolation: z.enum(['worktree']).optional(),
  status: subagentStatusSchema,
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorCode: z.string().max(64).optional(),
});
export type SubagentSessionRecord = z.infer<typeof subagentSessionRecordSchema>;

export interface HostAgentRoleConfig {
  model?: string;
  reasoningEffort?: string;
  description?: string;
  developerInstructions?: string;
}

export interface HostAgentsConfig {
  enabled: boolean;
  maxThreads: number;
  maxDepth: number;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  /** S5c: optional per-child ceilings (`[agents] max_child_tokens / max_child_duration_ms / max_child_cost_usd`). */
  maxChildTokens?: number;
  maxChildDurationMs?: number;
  maxChildCostUSD?: number;
  roles: Record<string, HostAgentRoleConfig>;
}

/** Caps and usage of the parent's running turn, which children inherit (S5c security fix). */
export interface SubagentParentLimits {
  maxOutputTokens?: number;
  maxEstimatedCostUSD?: number;
  budget: TurnBudget;
  /** Parent model usage plus subagent usage already folded into the parent's receipt. */
  usage: Usage | null;
  elapsedMs: number;
}

/** What a child turn may use: per-request caps for `send` plus the child's own work budget. */
export interface SubagentChildLimits {
  maxOutputTokens?: number;
  maxEstimatedCostUSD?: number;
  budget: TurnBudget;
}

/** Host-owned Git worktree for an isolated child (S5c). Only `path` is writable for the child. */
export interface SubagentWorktree {
  path: string;
  branch: string;
  /** Main repository's Git directory, readable (never writable) so `git status` works in the worktree. */
  gitCommonDir: string;
}

export interface SubagentWorktreePort {
  /** Create the child's worktree (or reopen it when it still exists); refuses non-Git workspaces. */
  acquire(agentId: string): {ok: true; worktree: SubagentWorktree} | {ok: false; code: string; message: string};
  /** Delete the worktree when nothing changed; keep it (and say so) when it holds changes. */
  finish(agentId: string): {changed: boolean; worktree: SubagentWorktree} | undefined;
}

export interface SubagentPromptAttribution {
  agentId: string;
  agentType: string;
  description: string;
}

export interface SubagentToolOutcome {
  status: 'ok' | 'denied' | 'error';
  code?: string;
  content: string;
  target?: string;
}

export interface SubagentExecutionPort {
  available?(): boolean;
  description?(): string;
  run(
    callId: string,
    input: unknown,
    signal?: AbortSignal,
    onEvent?: (event: SubagentEvent) => void,
  ): Promise<SubagentToolOutcome>;
  /**
   * S5b: true once this session has had a subagent; `agent_message`, `agent_wait` and `agent_close` are only
   * offered then, which keeps every request without subagents byte-identical to S5a.
   */
  hasChildren?(): boolean;
  /** S5b: `agent_message`, `agent_wait` and `agent_close` (Codex send_input / wait / close_agent). */
  message?(input: unknown, signal?: AbortSignal): Promise<SubagentToolOutcome>;
  wait?(input: unknown, signal?: AbortSignal): Promise<SubagentToolOutcome>;
  close?(input: unknown, signal?: AbortSignal): Promise<SubagentToolOutcome>;
}

/** One agent type offered to `agent_type` (S5b): built-in role or a custom definition. */
export interface AgentTypeView {
  name: string;
  source: 'builtin' | 'project' | 'user';
  description: string;
  /** Tool names the type is limited to; `null` means every tool a general subagent receives. */
  tools: string[] | null;
  model?: string;
  reasoningEffort?: string;
  /** Short display path (`.cosmew/agents/x.md`, `~/.cosmew/agents/x.md`) of a custom definition. */
  path?: string;
}
export interface AgentDefinitionDiagnostic {
  path?: string;
  code: string;
}
export interface AgentTypesReport {
  types: AgentTypeView[];
  errors: AgentDefinitionDiagnostic[];
  warnings: AgentDefinitionDiagnostic[];
}

/** Out-of-turn notice for a background subagent that finished (S5b); the summary itself goes to the model. */
export interface SubagentNotice {
  agentId: string;
  parentSessionId: string;
  agentType: string;
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  /** `steered`: joined the running parent turn; `queued`: durable input for the parent's next turn. */
  delivery: 'steered' | 'queued' | 'consumed';
}

export interface SubagentSummaryView {
  id: string;
  parentConversationId: string;
  parentTurnId: string | null;
  callId: string;
  depth: number;
  agentType: SubagentType;
  description: string;
  selection: Selection;
  forkContext: boolean;
  background: boolean;
  status: SubagentStatus;
  toolCount: number;
  usage: Usage | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode?: string;
  steps: SubagentTranscriptStep[];
  summary: string;
}

/** A custom agent definition (`.cosmew/agents/*.md`, `.futryn/agents/*.md`, `.claude/agents/*.md`, ...); all of it is untrusted data (S5b). */
export interface CustomAgentDefinition {
  name: string;
  description: string;
  /** Tool names as written in frontmatter; `null` when `tools` is absent (inherit). Only ever narrows. */
  tools: string[] | null;
  model?: string;
  reasoningEffort?: string;
  source: 'project' | 'user';
  shortPath: string;
  /** Markdown body: the child's task guidance. Never host instructions. */
  body: string;
}
export interface AgentDefinitionsReport {
  definitions: Omit<CustomAgentDefinition, 'body'>[];
  errors: AgentDefinitionDiagnostic[];
  warnings: AgentDefinitionDiagnostic[];
}
