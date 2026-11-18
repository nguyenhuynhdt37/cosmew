import {z} from 'zod';
import type {CommandOutputChunk} from './command-runtime';
import type {ToolCall} from './models';

/**
 * TOOLS1 (ADR 0017): read-only workspace tools. Descriptors carry no executable code; the
 * dispatcher in `@futryn/tools` is the single enforcement point and `@futryn/security` decides.
 */
export const toolCapabilitySchema = z.enum([
  'fs.read',
  'fs.write',
  'process.execute',
  /** Session state the agent keeps for itself: plan, memory (wave 1, ADR 0042). */
  'agent.state',
  /** Durable agent-state edits (memory write/delete, ADR 0057). */
  'agent.state.write',
  /** Questions to the user (ADR 0042). */
  'user.input',
  /** Language-server queries (ADR 0043). */
  'code.intel',
  /** Web fetch and search (ADR 0044). */
  'network.fetch',
  'network.search',
  'mcp.call',
  /** Delegated subagent execution (Wave 2 S5). */
  'agent.spawn',
]);
export type ToolCapability = z.infer<typeof toolCapabilitySchema>;
/**
 * Capabilities Plan and Review modes may use (plan section 4): reading, code intelligence, the
 * agent's own state, questions, and outside reads that never change the workspace.
 */
export const ANALYSIS_CAPABILITIES: readonly ToolCapability[] = [
  'fs.read',
  'code.intel',
  'agent.state',
  'user.input',
  'network.search',
  'network.fetch',
  'agent.spawn',
];
export const analysisCapability = (capability: ToolCapability | undefined): boolean =>
  capability !== undefined && ANALYSIS_CAPABILITIES.includes(capability);

/** `update_plan` (ADR 0042): Codex schema + `cancelled` (OpenCode) + `activeForm` (Claude Code). */
export const planStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
export const planItemSchema = z.strictObject({
  step: z.string().min(1).max(500),
  status: planStatusSchema,
  activeForm: z.string().min(1).max(200).optional(),
});
export const planStateSchema = z.strictObject({
  explanation: z.string().max(2000).optional(),
  items: z.array(planItemSchema).max(50),
  updatedAt: z.string().datetime(),
});
export type PlanItem = z.infer<typeof planItemSchema>;

/**
 * `request_user_input` (ADR 0042): Codex schema (1–3 questions, `header` ≤ 12 chars, options with
 * label + description, a free-form "Other" added by the client) plus OpenCode's `multiple`.
 */
export const userQuestionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,64}$/),
  header: z.string().min(1).max(12),
  question: z.string().min(1).max(500),
  options: z
    .array(z.strictObject({label: z.string().min(1).max(80), description: z.string().max(300)}))
    .min(1)
    .max(6),
  multiple: z.boolean().optional(),
});
export type UserQuestion = z.infer<typeof userQuestionSchema>;
export interface PendingQuestion {
  questionId: string;
  questions: UserQuestion[];
  createdAt: string;
}
/** Codex `RequestUserInputResponse`: answers by question id (labels, or the user's own text). */
export type UserAnswers = Record<string, {answers: string[]}>;
export type UserInputOutcome =
  {kind: 'answered'; answers: UserAnswers} | {kind: 'dismissed'} | {kind: 'unavailable'; reason: string};
export type PlanState = z.infer<typeof planStateSchema>;

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the arguments, offered to the model. */
  inputSchema: Record<string, unknown>;
  capability: ToolCapability;
  /**
   * Codex `supports_parallel_tool_calls` (tools/router.rs → tools/parallel.rs): only a tool that
   * explicitly declares it may share execution with other parallel tools. Absent means exclusive;
   * concurrency safety is never inferred from a name or capability.
   */
  parallel?: boolean;
}

/**
 * Tools whose successful result is a file-change receipt (`{status, changes[{path, action, diff}]}`,
 * ADR 0038). They share apply_patch's approval, revalidation and receipt, so consumers that keep,
 * render or track write evidence treat them alike.
 */
export const FILE_CHANGE_TOOLS = ['apply_patch', 'edit', 'write', 'lsp_rename'] as const;
export const isFileChangeTool = (name: string): boolean => (FILE_CHANGE_TOOLS as readonly string[]).includes(name);

/** Outcome of evaluating one target against policy. Deny wins over ask, ask over allow. */
export interface PermissionDecision {
  effect: 'allow' | 'ask' | 'deny';
  /** Stable machine-readable reason, e.g. `outside-workspace`, `secret-file`, `default-allow`. */
  reason: string;
}

/**
 * Media a tool hands to the model (ADR 0041): images and PDFs read from the workspace. `data` is
 * base64. Attachments travel next to the text `content`, never inside it; the journal and the
 * transcript keep only the text, and persistence stores the bytes separately with a bound.
 */
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'] as const;
/** Largest single attachment (OpenCode `MAX_MEDIA_INGEST_BYTES`, 20 MiB). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const attachmentSchema = z.strictObject({
  mime: z.enum(ATTACHMENT_MIMES),
  data: z
    .string()
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  name: z.string().min(1).max(256),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const toolResultSchema = z.strictObject({
  /** Media for the model (ADR 0041); at most 8 per result. */
  attachments: z.array(attachmentSchema).max(8).optional(),
  /** Historical authorization binding, never a reusable grant. */
  authorizationScopeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  callId: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  status: z.enum(['ok', 'denied', 'error']),
  /** Bounded, redacted text returned to the model. */
  content: z.string().max(65536),
  /** S3: directory of the discovered skill, informational only, never an access grant. */
  skillDirectory: z.string().max(4096).optional(),
  /** Workspace-relative target shown to the user (never an absolute path outside it). */
  target: z.string().max(1024).optional(),
  truncated: z.boolean().optional(),
  /** Safe error code for `denied` / `error`. */
  code: z.string().max(64).optional(),
  /** exec_command (ADR 0022): exit code of the command; null when it was killed by a signal. */
  exitCode: z.number().int().nullable().optional(),
  /** exec_command: wall-clock run time of the process. */
  sessionId: z.string().uuid().optional(),
  durationMs: z.number().int().min(0).optional(),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

/** What `core` sees: descriptors to offer and one call to run. */
export interface ToolPort {
  descriptors(): ToolDescriptor[];
  invoke(
    call: ToolCall,
    signal?: AbortSignal,
    onOutput?: (chunk: CommandOutputChunk) => void,
    onEvent?: (event: import('./subagents').SubagentEvent) => void,
  ): Promise<ToolResult>;
}
