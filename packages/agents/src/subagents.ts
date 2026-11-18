import {
  FutrynError,
  agentToolInputSchema,
  type AgentToolInput,
  type ConversationStore,
  type HostAgentsConfig,
  type Message,
  type ModelEvent,
  type ModelInfo,
  type Selection,
  type SubagentEvent,
  type SubagentExecutionPort,
  type SubagentPromptAttribution,
  type SubagentSessionRecord,
  type SubagentSummaryView,
  type SubagentTranscriptStep,
  type ToolCall,
  type Usage,
} from '@futryn/contracts';
import {exceedsAgentDepth, nextAgentDepth, normalizeAgentsConfig, resolveSubagentModelAndEffort} from './budgets';
import {buildAgentToolDescription, resolveAgentProfile, type AgentProfile} from './profiles';
import {SubagentScheduler, type ActiveSubagentTask} from './scheduler';

const INHERITED_CONTEXT_PREAMBLE =
  '[Inherited parent conversation context: the preceding messages belong to your parent session and are provided as background context only. Earlier tasks, roles, and action-specific approvals belong to the parent. Follow your own subagent role and complete the assigned task below.]';

export interface ChildRunContext {
  agentId: string;
  parentConversationId: string;
  parentTurnId: string | null;
  callId: string;
  depth: number;
  maxDepth: number;
  profile: AgentProfile;
  description: string;
  prompt: string;
  selection: Selection;
  modelInfo: ModelInfo;
  reasoningEffort?: string;
  forkContext: boolean;
  initialMessages: Message[];
  attribution: SubagentPromptAttribution;
}

export interface SubagentManagerDeps {
  /** Depth of the conversation owning this manager (`0` for the root user session). */
  depth?: number;
  /** Shared scheduler across the root session tree. */
  scheduler?: SubagentScheduler;
  getConfig(): Partial<HostAgentsConfig> | undefined;
  getParentState(): {
    sessionId: string;
    turnId?: string;
    selection: Selection;
    reasoningEffort?: string;
    analysisOnly: boolean;
    /** Committed + completed in-turn messages of the parent up to the current round. */
    messages: Message[];
  };
  lookupModel(modelRef: string, defaultAccountId: string): {selection: Selection; model: ModelInfo} | undefined;
  availableModelIds(accountId: string): string[];
  store: ConversationStore;
  runChildTurn(context: ChildRunContext, signal: AbortSignal): AsyncIterable<ModelEvent>;
  addParentUsage(usage: Usage): void;
  onSubagentEvent?(event: SubagentEvent): void;
  redact(text: string): string;
}

export function formatSubagentToolCallTarget(call: ToolCall): string {
  const input = (call.input && typeof call.input === 'object' ? call.input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');
  if (call.name === 'read' || call.name === 'edit' || call.name === 'write') return str('path');
  if (call.name === 'glob') return str('pattern') || '**/*';
  if (call.name === 'grep') return str('pattern') ? `"${str('pattern')}"` : '';
  if (call.name === 'exec_command') return str('cmd').replace(/\s+/g, ' ').slice(0, 80);
  if (call.name === 'lsp') return `${str('operation')} ${str('path')}`.trim();
  if (call.name === 'web_search') return str('query');
  if (call.name === 'web_fetch') return str('url');
  if (call.name === 'skill') return str('name');
  if (call.name === 'apply_patch') return 'patch';
  return '';
}

export function formatSubagentResultContent(options: {
  agentId: string;
  agentType: string;
  description: string;
  toolCount: number;
  usage: Usage | null;
  steps: readonly SubagentTranscriptStep[];
  summary: string;
}): string {
  const {agentId, agentType, description, toolCount, usage, steps, summary} = options;
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? 0;
  const hasUsage = usage && (usage.inputTokens != null || usage.outputTokens != null);
  const tokenText = hasUsage ? `${inTok + outTok} tokens (${inTok} in / ${outTok} out)` : '0 tokens';
  const header = `Subagent [${agentType}] "${description}" (agent_id: ${agentId}, tools: ${toolCount}, usage: ${tokenText})`;
  const toolSteps = steps.filter(s => s.kind === 'tool' && s.toolName);
  const activity = toolSteps.length
    ? [
        'Activity:',
        ...toolSteps.slice(-25).map(step => {
          const target = step.target ? ` ${step.target}` : '';
          const status = step.status ?? 'ok';
          return `- ${step.toolName}${target} [${status}]`;
        }),
      ].join('\n')
    : '';
  return [header, activity, `Result:\n${summary.trim() || '(no summary text returned)'}`].filter(Boolean).join('\n\n');
}

export interface ParsedSubagentResult {
  agentId?: string;
  agentType: string;
  description: string;
  toolCount: number;
  totalTokens: number;
  steps: SubagentTranscriptStep[];
  summary: string;
}

export function parseSubagentResultContent(
  content: string,
  fallback?: {agentType?: string; description?: string},
): ParsedSubagentResult {
  const headerMatch = /^Subagent \[([^\]]+)\] "([^"]*)" \(agent_id: ([^,]+), tools: (\d+), usage: (\d+) tokens/.exec(
    content,
  );
  if (!headerMatch) {
    return {
      agentType: fallback?.agentType ?? 'agent',
      description: fallback?.description ?? '',
      toolCount: 0,
      totalTokens: 0,
      steps: [],
      summary: content.trim(),
    };
  }
  const agentType = headerMatch[1]!;
  const description = headerMatch[2]!;
  const agentId = headerMatch[3]!;
  const toolCount = Number(headerMatch[4] ?? 0);
  const totalTokens = Number(headerMatch[5] ?? 0);
  const steps: SubagentTranscriptStep[] = [];
  const activityBlock = /\n\nActivity:\n([\s\S]*?)(?=\n\nResult:\n|$)/.exec(content)?.[1];
  if (activityBlock) {
    for (const line of activityBlock.split('\n')) {
      const m = /^- ([a-zA-Z0-9_.-]+)(?: (.*))? \[(running|ok|denied|error)\]$/.exec(line.trim());
      if (m) {
        steps.push({
          kind: 'tool',
          toolName: m[1]!,
          ...(m[2] ? {target: m[2]} : {}),
          status: m[3] as 'running' | 'ok' | 'denied' | 'error',
        });
      }
    }
  }
  const resultIndex = content.indexOf('\n\nResult:\n');
  const summary = resultIndex >= 0 ? content.slice(resultIndex + '\n\nResult:\n'.length).trim() : content.trim();
  if (summary) steps.push({kind: 'text', text: summary});
  return {
    agentId,
    agentType,
    description,
    toolCount,
    totalTokens,
    steps,
    summary,
  };
}

/**
 * Filter parent messages safe to copy into a `fork_context: true` child conversation.
 * Incomplete or unanswered tool calls from the parent's currently executing round are omitted so
 * the child never starts with an orphan tool call.
 */
export function prepareForkedParentMessages(messages: readonly Message[]): Message[] {
  const answeredToolCallIds = new Set(messages.filter(m => m.role === 'tool' && m.toolCallId).map(m => m.toolCallId!));
  const forked: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const answeredCalls = message.toolCalls.filter(call => answeredToolCallIds.has(call.id));
      if (!answeredCalls.length) {
        if (message.content.trim()) {
          forked.push({role: 'assistant', content: message.content});
        }
        continue;
      }
      forked.push({
        ...message,
        toolCalls: answeredCalls,
      });
      continue;
    }
    if (message.role === 'tool') {
      if (message.toolCallId && answeredToolCallIds.has(message.toolCallId)) {
        forked.push({...message});
      }
      continue;
    }
    forked.push({...message});
  }
  return forked;
}

export class SubagentManager implements SubagentExecutionPort {
  readonly scheduler: SubagentScheduler;
  private readonly currentDepth: number;

  constructor(private readonly deps: SubagentManagerDeps) {
    this.currentDepth = deps.depth ?? 0;
    this.scheduler =
      deps.scheduler ?? new SubagentScheduler(() => normalizeAgentsConfig(this.deps.getConfig()).maxThreads);
  }

  config(): HostAgentsConfig {
    return normalizeAgentsConfig(this.deps.getConfig());
  }

  available(): boolean {
    const cfg = this.config();
    if (!cfg.enabled) return false;
    return !exceedsAgentDepth(nextAgentDepth(this.currentDepth), cfg.maxDepth);
  }

  description(): string {
    return buildAgentToolDescription(this.config().roles);
  }

  async run(
    callId: string,
    rawInput: unknown,
    signal?: AbortSignal,
    onEvent?: (event: SubagentEvent) => void,
  ): Promise<{status: 'ok' | 'denied' | 'error'; code?: string; content: string; target?: string}> {
    signal?.throwIfAborted();
    const cleanedInput = sanitizeRawAgentInput(rawInput);
    const parsed = agentToolInputSchema.safeParse(cleanedInput);
    if (!parsed.success) {
      return {
        status: 'error',
        code: 'INVALID_INPUT',
        content:
          'Invalid arguments for agent. Expected {agent_type: "explore"|"worker"|"general"|"plan", description, prompt, model?, reasoning_effort?, background?, fork_context?}.',
      };
    }
    const input = parsed.data;
    const description = this.deps.redact(input.description.trim()).slice(0, 200);
    const prompt = input.prompt.trim();
    if (!description || !prompt) {
      return {
        status: 'error',
        code: 'INVALID_INPUT',
        content: 'Both description and prompt must be non-empty strings.',
      };
    }

    const cfg = this.config();
    if (!cfg.enabled) {
      return {
        status: 'denied',
        code: 'DENIED',
        content: 'Subagents are disabled by configuration.',
        target: description,
      };
    }

    const childDepth = nextAgentDepth(this.currentDepth);
    if (exceedsAgentDepth(childDepth, cfg.maxDepth)) {
      return {
        status: 'error',
        code: 'AGENT_DEPTH_LIMIT',
        content: 'Agent depth limit reached. Solve the task yourself.',
        target: description,
      };
    }

    const profile = resolveAgentProfile(input.agent_type, cfg.roles);
    if (!profile) {
      return {
        status: 'error',
        code: 'INVALID_INPUT',
        content: `Unknown agent_type "${this.deps.redact(input.agent_type)}". Available agent types: explore, worker, general, plan.`,
        target: description,
      };
    }

    if (input.background === true) {
      return {
        status: 'error',
        code: 'UNSUPPORTED',
        content:
          'Background subagents are not supported in synchronous mode; omit background or set background: false.',
        target: description,
      };
    }

    const parent = this.deps.getParentState();
    if (parent.analysisOnly && !profile.readOnly) {
      return {
        status: 'denied',
        code: 'MODE_RESTRICTED',
        content: 'Plan and Review modes permit only read-only subagents (explore, plan). Nothing was executed.',
        target: description,
      };
    }

    const resolvedModel = resolveSubagentModelAndEffort({
      parentSelection: parent.selection,
      parentReasoningEffort: parent.reasoningEffort,
      profile,
      config: cfg,
      requestedModel: input.model,
      requestedEffort: input.reasoning_effort,
      lookupModel: (ref, accountId) => this.deps.lookupModel(ref, accountId),
      availableModelIds: accountId => this.deps.availableModelIds(accountId),
    });
    if (!resolvedModel.ok) {
      return {
        status: 'error',
        code: resolvedModel.code,
        content: this.deps.redact(resolvedModel.message),
        target: description,
      };
    }

    const slot = this.scheduler.tryReserveSlot();
    if (!slot.ok) {
      return {
        status: 'error',
        code: 'AGENT_LIMIT_REACHED',
        content: `Agent thread limit reached (max_threads = ${slot.maxThreads}). Wait for running subagents to finish.`,
        target: description,
      };
    }

    const {selection, modelInfo, reasoningEffort} = resolvedModel.value;
    const forkContext = input.fork_context === true;
    const startedAt = Date.now();
    const childAbort = new AbortController();
    const onParentAbort = () => childAbort.abort();
    signal?.addEventListener('abort', onParentAbort, {once: true});
    if (signal?.aborted) childAbort.abort();

    let agentId: string | undefined;
    let latestUsage: Usage | null = null;
    let usageReported = false;
    const reportUsageOnce = () => {
      if (usageReported) return;
      usageReported = true;
      const storedUsage = agentId ? this.deps.store.get?.(agentId)?.turns?.at(-1)?.usage : undefined;
      const finalUsage = storedUsage ?? latestUsage;
      if (finalUsage) {
        latestUsage = finalUsage;
        this.deps.addParentUsage(finalUsage);
      }
    };

    const emit = (event: SubagentEvent) => {
      onEvent?.(event);
      this.deps.onSubagentEvent?.(event);
    };

    try {
      const initialMessages = forkContext ? prepareForkedParentMessages(parent.messages) : [];
      agentId = this.deps.store.create(selection);
      for (const message of initialMessages) {
        this.deps.store.append(agentId, message, 'committed');
        if (message.attachments?.length && message.toolCallId) {
          this.deps.store.saveAttachments?.(agentId, message.toolCallId, message.attachments);
        }
      }

      const sessionRecord: SubagentSessionRecord = {
        id: agentId,
        parentConversationId: parent.sessionId,
        parentTurnId: parent.turnId ?? null,
        callId,
        depth: childDepth,
        agentType: profile.id,
        description,
        prompt: this.deps.redact(prompt),
        selection,
        forkContext,
        background: false,
        status: 'running',
        createdAt: new Date(startedAt).toISOString(),
        finishedAt: null,
      };
      this.deps.store.saveSubagentSession?.(sessionRecord);

      const task: ActiveSubagentTask = {
        agentId,
        parentConversationId: parent.sessionId,
        parentTurnId: parent.turnId ?? null,
        callId,
        depth: childDepth,
        agentType: profile.id,
        description,
        modelId: selection.modelId,
        reasoningEffort,
        forkContext,
        background: false,
        status: 'running',
        startedAt,
        toolCount: 0,
        usage: null,
        steps: [],
        abortController: childAbort,
      };
      this.scheduler.registerTask(task);

      emit({
        type: 'subagent.started',
        callId,
        agentId,
        agentType: profile.id,
        description,
        modelId: selection.modelId,
        ...(reasoningEffort ? {reasoningEffort} : {}),
        ...(forkContext ? {forkContext: true} : {}),
        background: false,
      });

      const effectivePrompt = forkContext ? `${INHERITED_CONTEXT_PREAMBLE}\n\n${prompt}` : prompt;
      const runContext: ChildRunContext = {
        agentId,
        parentConversationId: parent.sessionId,
        parentTurnId: parent.turnId ?? null,
        callId,
        depth: childDepth,
        maxDepth: cfg.maxDepth,
        profile,
        description,
        prompt: effectivePrompt,
        selection,
        modelInfo,
        reasoningEffort,
        forkContext,
        initialMessages,
        attribution: {
          agentId,
          agentType: profile.id,
          description,
        },
      };

      let finalText = '';
      let responseStart = 0;
      const runningTools = new Map<string, string>();

      for await (const event of this.deps.runChildTurn(runContext, childAbort.signal)) {
        if (event.type === 'started') {
          responseStart = finalText.length;
        } else if (event.type === 'textDelta') {
          finalText += event.text;
        } else if (event.type === 'responseDiscarded') {
          finalText = finalText.slice(0, responseStart);
        } else if (event.type === 'usage') {
          latestUsage = event.usage;
          task.usage = event.usage;
          emit({
            type: 'subagent.progress',
            callId,
            agentId,
            agentType: profile.id,
            description,
            ...(task.currentTool ? {currentTool: task.currentTool} : {}),
            toolCount: task.toolCount,
            usage: latestUsage,
            steps: cloneSteps(task.steps),
          });
        } else if (event.type === 'toolCallComplete') {
          task.toolCount++;
          const target = this.deps.redact(formatSubagentToolCallTarget(event.call)).slice(0, 200);
          const label = target ? `${event.call.name} ${target}` : event.call.name;
          runningTools.set(event.call.id, label);
          task.currentTool = label;
          task.steps.push({
            kind: 'tool',
            callId: event.call.id,
            toolName: event.call.name,
            ...(target ? {target} : {}),
            status: 'running',
          });
          if (task.steps.length > 64) task.steps.splice(0, task.steps.length - 64);
          emit({
            type: 'subagent.progress',
            callId,
            agentId,
            agentType: profile.id,
            description,
            currentTool: task.currentTool,
            toolCount: task.toolCount,
            usage: latestUsage,
            steps: cloneSteps(task.steps),
          });
        } else if (event.type === 'toolResult') {
          runningTools.delete(event.result.callId);
          task.currentTool = [...runningTools.values()].at(-1);
          const step = task.steps.findLast(s => s.kind === 'tool' && s.callId === event.result.callId);
          if (step) {
            step.status = event.result.status;
            step.output = this.deps.redact(event.result.content).slice(0, 500);
          }
          emit({
            type: 'subagent.progress',
            callId,
            agentId,
            agentType: profile.id,
            description,
            ...(task.currentTool ? {currentTool: task.currentTool} : {}),
            toolCount: task.toolCount,
            usage: latestUsage,
            steps: cloneSteps(task.steps),
          });
        } else if (event.type === 'completed') {
          latestUsage = event.usage;
          task.usage = event.usage;
        }
      }

      if (signal?.aborted || childAbort.signal.aborted) {
        throw new FutrynError('CANCELLED');
      }

      reportUsageOnce();
      const finishedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startedAt);
      const summary = this.deps.redact(finalText.trim());
      if (summary) {
        task.steps.push({kind: 'text', text: summary.slice(0, 4000)});
      }
      task.status = 'completed';
      task.finishedAt = Date.now();
      task.currentTool = undefined;
      this.deps.store.updateSubagentSession?.(agentId, {status: 'completed', finishedAt});

      emit({
        type: 'subagent.finished',
        callId,
        agentId,
        agentType: profile.id,
        description,
        status: 'completed',
        toolCount: task.toolCount,
        usage: latestUsage,
        durationMs,
        summary: summary.slice(0, 4000),
        steps: cloneSteps(task.steps),
      });

      return {
        status: 'ok',
        target: description,
        content: formatSubagentResultContent({
          agentId,
          agentType: profile.id,
          description,
          toolCount: task.toolCount,
          usage: latestUsage,
          steps: task.steps,
          summary,
        }),
      };
    } catch (error) {
      reportUsageOnce();
      const cancelled =
        signal?.aborted || childAbort.signal.aborted || (error instanceof FutrynError && error.code === 'CANCELLED');
      const errorCode = cancelled ? 'CANCELLED' : error instanceof FutrynError ? error.code : 'EXECUTION_FAILED';
      const finishedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - startedAt);
      const status = cancelled ? 'cancelled' : 'failed';

      if (agentId) {
        const task = this.scheduler.getTask(agentId);
        if (task) {
          task.status = status;
          task.finishedAt = Date.now();
          task.currentTool = undefined;
        }
        try {
          this.deps.store.updateSubagentSession?.(agentId, {status, finishedAt, errorCode});
        } catch {
          /* preserve original error/cancellation */
        }
        emit({
          type: 'subagent.finished',
          callId,
          agentId,
          agentType: profile.id,
          description,
          status,
          toolCount: task?.toolCount ?? 0,
          usage: latestUsage,
          durationMs,
          errorCode,
          steps: task ? cloneSteps(task.steps) : [],
        });
      }

      if (signal?.aborted) {
        throw new FutrynError('CANCELLED');
      }
      const safeMessage =
        error instanceof FutrynError ? error.message : 'The subagent encountered an unexpected error.';
      return {
        status: 'error',
        code: errorCode,
        target: description,
        content: `Subagent [${profile.id}] "${description}" failed (${errorCode}): ${this.deps.redact(safeMessage)}`,
      };
    } finally {
      signal?.removeEventListener('abort', onParentAbort);
      if (agentId) {
        this.scheduler.removeTask(agentId);
      }
      slot.reservation.release();
    }
  }

  /** Reconstruct a subagent's durable summary and transcript from the conversation store. */
  inspectSubagent(agentId: string): SubagentSummaryView | undefined {
    const meta = this.deps.store.getSubagentSession?.(agentId);
    if (!meta) return undefined;
    const session = this.deps.store.get?.(agentId);
    const messages = session?.recovery?.messages ?? session?.messages ?? [];
    const steps: SubagentTranscriptStep[] = [];
    let toolCount = 0;
    let lastAssistantText = '';
    const callsById = new Map<string, ToolCall>();

    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const call of msg.toolCalls) {
          callsById.set(call.id, call);
          toolCount++;
          const target = this.deps.redact(formatSubagentToolCallTarget(call)).slice(0, 200);
          steps.push({
            kind: 'tool',
            callId: call.id,
            toolName: call.name,
            ...(target ? {target} : {}),
            status: 'running',
          });
        }
      } else if (msg.role === 'tool' && msg.toolCallId) {
        const match = /^\[(denied|error)(?:: ([A-Z_]+))?\] /.exec(msg.content);
        const status: 'ok' | 'denied' | 'error' =
          match?.[1] === 'denied' ? 'denied' : match?.[1] === 'error' ? 'error' : 'ok';
        const step = steps.findLast(s => s.kind === 'tool' && s.callId === msg.toolCallId);
        if (step) {
          step.status = status;
          step.output = this.deps.redact(msg.content).slice(0, 500);
        }
      } else if (msg.role === 'assistant' && msg.content.trim()) {
        lastAssistantText = this.deps.redact(msg.content.trim());
      }
    }
    if (lastAssistantText) {
      steps.push({kind: 'text', text: lastAssistantText.slice(0, 4000)});
    }
    const usage = session?.turns?.at(-1)?.usage ?? null;
    return {
      id: meta.id,
      parentConversationId: meta.parentConversationId,
      parentTurnId: meta.parentTurnId,
      callId: meta.callId,
      depth: meta.depth,
      agentType: meta.agentType,
      description: meta.description,
      selection: session?.selection ?? meta.selection ?? {accountId: '', modelId: ''},
      forkContext: meta.forkContext,
      background: meta.background,
      status: meta.status,
      toolCount,
      usage,
      createdAt: meta.createdAt,
      finishedAt: meta.finishedAt,
      ...(meta.errorCode ? {errorCode: meta.errorCode} : {}),
      steps,
      summary: lastAssistantText,
    };
  }

  listSubagents(parentConversationId: string): SubagentSummaryView[] {
    const records = this.deps.store.listSubagentSessions?.(parentConversationId) ?? [];
    return records
      .map(record => this.inspectSubagent(record.id))
      .filter((item): item is SubagentSummaryView => item !== undefined);
  }
}

function sanitizeRawAgentInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy = {...(raw as Record<string, unknown>)};
  if (copy.model === '') delete copy.model;
  if (copy.reasoning_effort === '') delete copy.reasoning_effort;
  return copy;
}

function cloneSteps(steps: readonly SubagentTranscriptStep[]): SubagentTranscriptStep[] {
  return steps.map(step => ({...step}));
}

export type {AgentToolInput};
