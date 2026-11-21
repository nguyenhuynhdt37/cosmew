import type {
  ActiveTaskCheckpoint,
  ContextSnapshot,
  ConversationStore,
  Message,
  ModelPort,
  ProjectContextPort,
  RequestContext,
  Selection,
  ToolPort,
  TurnBudget,
  SkillsPort,
  Usage,
} from '@cosmew/contracts';
import {GENERATION_LIMITS} from '@cosmew/contracts';
import {estimateContextTokens} from '../context/builder';
import {AUTO_COMPACT_FRACTION} from '../context/model-compaction';
import type {ContextCompactor} from '../context/compaction';

/**
 * Internal safety limits (ADR 0030). They are not work budgets: a normal turn never reaches them, and
 * each one ends the turn with a named stop reason or error instead of a silent stop. There is no
 * default per-turn round or tool-call ceiling; the loop runs until the model stops asking for tools,
 * a user-configured budget runs out, or the context window is full.
 */
export const SAFETY_LIMITS = {
  /** Retries of a model request whose stream failed (Codex DEFAULT_STREAM_MAX_RETRIES). */
  roundRetries: GENERATION_LIMITS.streamMaxRetries,
  /** Context window assumed when the model does not report one (conservative). */
  unknownContextTokens: 128000,
  /** Fraction of the usable window after which tools are withdrawn for a final answer. */
  contextReserve: AUTO_COMPACT_FRACTION,
  /** Parallel-declared calls holding the shared execution slot at once (ADR 0033). Others run exclusively. */
  parallelTools: 4,
} as const;

/** Conservative token estimate when exact tokenization is unavailable (about 3 characters per token). */
export const estimateTokens = estimateContextTokens;

export interface ConversationOptions {
  skills?: SkillsPort;
  /** Main sessions only; S5 subagents must omit this injected context port. */
  memories?: {context(): string};
  /**
   * Extra lower-trust context messages (custom agent catalog, a child's custom agent definition). They share the
   * repository-context trust boundary: user-role data, never `ModelRequest.instructions`.
   */
  contextNotes?: () => string[];
  /** Host instructions appended by the model adapter, included in context estimates. */
  additionalInstructions?: () => string;
  /** Optional user work budget, read at the start of every turn. */
  budget?: () => TurnBudget | undefined;
  /** Optional override for concurrent shared-slot tool executions. */
  parallelSlots?: () => number | undefined;
  /** Model context window in tokens, when known. */
  contextLimit?: () => number | null | undefined;
  outputLimit?: () => number | null | undefined;
  /** The provider's `stream_max_retries` (host config); absent means the Codex default. */
  streamMaxRetries?: () => number | undefined;
  compactor?: ContextCompactor;
  /** User preference for automatic checkpoints. Manual compaction is independent. */
  autoCompact?: () => boolean;
  /** Model-written compaction (ADR 0054). Default on; `false` keeps only the extractive checkpoint. */
  modelCompaction?: boolean;
  /** Explicit analysis modes cannot be converted into mutating artifact recovery. */
  analysisOnly?: () => boolean;
  /** Injected wait used for retry backoff (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Accepted user input that has not reached the model yet. */
export interface PendingInput {
  steerId: string;
  message: Message;
}

/** The single owner of a running turn. Steering is accepted only while `accepting` is true. */
export interface ActiveTurn {
  id: string;
  accepting: boolean;
  pending: PendingInput[];
  /** Set while a model response streams; arriving steering calls it to preempt the response. */
  wake?: () => void;
  requestContext?: RequestContext;
  /** Fold subagent token/cost usage into this running turn's receipt (Wave 2 S5). */
  addUsage?: (usage: Usage) => void;
  /** Snapshot of committed + in-turn messages up to the current round for `fork_context` (Wave 2 S5). */
  inTurnMessages?: () => Message[];
  /** Caps of this turn and what it (and its subagents) used so far, for subagent budget inheritance (S5c). */
  limits?: () => TurnLimitsSnapshot;
}

export interface TurnLimitsSnapshot {
  maxOutputTokens?: number;
  maxEstimatedCostUSD?: number;
  budget: TurnBudget;
  /** Parent model usage plus subagent usage already folded into the receipt. */
  usage: Usage | null;
  elapsedMs: number;
}

/** Conversation state shared with the running turn, which updates it as the journal advances. */
export interface ConversationState {
  messages: Message[];
  /**
   * Session-owned input queue (Codex keeps pending input when a task finishes): steering a finished
   * turn accepted but never delivered. It is durable in the journal and opens the next turn.
   */
  pendingInput: PendingInput[];
  task?: ActiveTaskCheckpoint;
  snapshot?: ContextSnapshot;
}

/** What a turn needs from its conversation. */
export interface TurnHost {
  id: string;
  selection: Selection;
  model: ModelPort;
  store: ConversationStore;
  tools?: ToolPort;
  projectContext?: ProjectContextPort;
  options: ConversationOptions;
  /** Called when the provider rejects the tool definitions themselves (ADR 0017). */
  onToolsRejected?: () => void;
  state: ConversationState;
  /** The turn became durable and may receive steering. */
  activate(turn: ActiveTurn): void;
  /** The turn is over; it no longer owns the conversation. */
  release(turn: ActiveTurn): void;
}

/** Per-request settings of one `send` call. */
export interface TurnRequest {
  /** Durable finishing-turn inbox entry acknowledged with user acceptance. */
  queuedInputId?: string;
  signal?: AbortSignal;
  /** Absent: no output cap is sent (Codex); the model's own limit applies. */
  maxOutputTokens?: number;
  maxEstimatedCostUSD?: number;
  reasoningEffort?: string;
}
