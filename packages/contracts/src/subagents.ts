import {z} from 'zod';
import {modelIdSchema, type Selection, type Usage} from './models';

/** Codex `DEFAULT_AGENT_MAX_THREADS` (`codex-rs/core/src/config/mod.rs:277`, pinned 090be4df). */
export const DEFAULT_AGENT_MAX_THREADS = 6;
/** Codex `DEFAULT_AGENT_MAX_DEPTH` (`codex-rs/core/src/config/mod.rs:287`, pinned 090be4df). */
export const DEFAULT_AGENT_MAX_DEPTH = 1;

export const BUILTIN_SUBAGENT_TYPES = ['explore', 'worker', 'general', 'plan'] as const;
export const subagentTypeSchema = z.enum(BUILTIN_SUBAGENT_TYPES);
export type SubagentType = z.infer<typeof subagentTypeSchema>;

export const subagentStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'closed']);
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
});
export type AgentToolInput = z.infer<typeof agentToolInputSchema>;

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
  roles: Record<string, HostAgentRoleConfig>;
}

export interface SubagentPromptAttribution {
  agentId: string;
  agentType: string;
  description: string;
}

export interface SubagentExecutionPort {
  available?(): boolean;
  description?(): string;
  run(
    callId: string,
    input: unknown,
    signal?: AbortSignal,
    onEvent?: (event: SubagentEvent) => void,
  ): Promise<{
    status: 'ok' | 'denied' | 'error';
    code?: string;
    content: string;
    target?: string;
  }>;
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
