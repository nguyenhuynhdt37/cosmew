import {GENERATION_LIMITS} from './limits';
import {z} from 'zod';
import {messageSchema, toolCallSchema} from './models';
import {toolResultSchema} from './tools';

export const turnStateSchema = z.enum(['pending', 'running', 'interrupted', 'completed', 'failed', 'cancelled']);
export type TurnState = z.infer<typeof turnStateSchema>;
export const executionEventDataSchema = z.discriminatedUnion('type', [
  /** `carried`: steering accepted by an earlier turn but never delivered, now part of this turn's input (ADR 0033). */
  z.object({
    type: z.literal('user.accepted'),
    message: messageSchema,
    carried: z.array(z.string().uuid()).max(64).optional(),
  }),
  /** User input accepted into the active turn (Codex steer_input). Model-visible at the next request boundary. */
  z.object({type: z.literal('user.steered'), steerId: z.string().uuid(), message: messageSchema}),
  /** `protocol: 2` marks a request whose streamed text is provisional until `model.completed` (ADR 0033). */
  z.object({type: z.literal('model.requested'), stepId: z.string().uuid(), protocol: z.literal(2).optional()}),
  /** The provider completed this request's response (Codex ResponseEvent::Completed); its text is committed. */
  z.object({type: z.literal('model.completed'), stepId: z.string().uuid()}),
  z.object({type: z.literal('assistant.text'), text: z.string().max(GENERATION_LIMITS.textBytes)}),
  z.object({type: z.literal('tool.call'), call: toolCallSchema}),
  z.object({
    type: z.literal('tool.intent'),
    callId: z.string(),
    executionId: z.string().uuid(),
    capability: z.string(),
  }),
  z.object({type: z.literal('tool.result'), result: toolResultSchema}),
  z.object({type: z.literal('turn.finished'), state: turnStateSchema, errorCode: z.string().optional()}),
]);
export type ExecutionEventData = z.infer<typeof executionEventDataSchema>;
export interface ConversationEvent {
  seq: number;
  turnId: string;
  at: string;
  data: ExecutionEventData;
}
export interface DurableTurn {
  id: string;
  userRevision: number;
  state: TurnState;
  events: ConversationEvent[];
}
export interface ActiveTaskCheckpoint {
  objective: string;
  latestRequest: string;
  artifactTargets: string[];
  verifiedActions: {callId: string; tool: string; status: string; scopeHash?: string}[];
  pending: string[];
  failures: string[];
  lastSafeSequence: number;
  state: 'unfinished' | 'verified';
}
export interface ContextSnapshot {
  version: 1;
  throughRevision: number;
  sourceHash: string;
  createdAt: string;
  strategy: 'deterministic';
  /** Extractive user requirements and result references; never an approval grant. */
  summary: string;
  retainedUserRequests: string[];
}
export interface RecoveredConversation {
  messages: z.infer<typeof messageSchema>[];
  turns: DurableTurn[];
  task?: ActiveTaskCheckpoint;
  compaction?: ContextSnapshot;
  /** Steering a finished turn accepted but never delivered; it opens the next turn (Codex on_task_finished keeps it). */
  pendingInput?: {steerId: string; message: z.infer<typeof messageSchema>}[];
}
export const activeTaskCheckpointSchema = z.object({
  objective: z.string(),
  latestRequest: z.string(),
  artifactTargets: z.array(z.string()),
  verifiedActions: z.array(
    z.object({callId: z.string(), tool: z.string(), status: z.string(), scopeHash: z.string().optional()}),
  ),
  pending: z.array(z.string()),
  failures: z.array(z.string()),
  lastSafeSequence: z.number().int().nonnegative(),
  state: z.enum(['unfinished', 'verified']),
});
export const contextSnapshotSchema = z.object({
  version: z.literal(1),
  throughRevision: z.number().int().nonnegative(),
  sourceHash: z.string().min(1),
  createdAt: z.string().datetime(),
  strategy: z.literal('deterministic'),
  summary: z.string(),
  retainedUserRequests: z.array(z.string()),
});
