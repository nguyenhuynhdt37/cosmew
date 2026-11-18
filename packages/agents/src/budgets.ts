import {
  DEFAULT_AGENT_MAX_DEPTH,
  DEFAULT_AGENT_MAX_THREADS,
  combineUsage,
  type HostAgentsConfig,
  type ModelInfo,
  type SubagentChildLimits,
  type SubagentParentLimits,
  type TurnBudget,
  type Selection,
  type Usage,
} from '@futryn/contracts';
import type {AgentProfile} from './profiles';

export function defaultAgentsConfig(): HostAgentsConfig {
  return {
    enabled: true,
    maxThreads: DEFAULT_AGENT_MAX_THREADS,
    maxDepth: DEFAULT_AGENT_MAX_DEPTH,
    roles: {},
  };
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function normalizeAgentsConfig(raw?: Partial<HostAgentsConfig>): HostAgentsConfig {
  const base = defaultAgentsConfig();
  if (!raw) return base;
  const maxThreads =
    typeof raw.maxThreads === 'number' && Number.isSafeInteger(raw.maxThreads) && raw.maxThreads >= 1
      ? Math.min(64, raw.maxThreads)
      : base.maxThreads;
  const maxDepth =
    typeof raw.maxDepth === 'number' && Number.isSafeInteger(raw.maxDepth) && raw.maxDepth >= 0
      ? Math.min(8, raw.maxDepth)
      : base.maxDepth;
  return {
    enabled: raw.enabled !== false,
    maxThreads,
    maxDepth,
    ...(raw.defaultModel?.trim() ? {defaultModel: raw.defaultModel.trim()} : {}),
    ...(raw.defaultReasoningEffort?.trim() ? {defaultReasoningEffort: raw.defaultReasoningEffort.trim()} : {}),
    ...(positive(raw.maxChildTokens) ? {maxChildTokens: Math.floor(raw.maxChildTokens)} : {}),
    ...(positive(raw.maxChildDurationMs)
      ? {maxChildDurationMs: Math.max(1000, Math.floor(raw.maxChildDurationMs))}
      : {}),
    ...(positive(raw.maxChildCostUSD) ? {maxChildCostUSD: raw.maxChildCostUSD} : {}),
    roles: raw.roles ? {...raw.roles} : {},
  };
}

/** Codex `next_thread_spawn_depth` (`codex-rs/core/src/agent/registry.rs:92`). */
export function nextAgentDepth(currentDepth: number): number {
  return Math.max(0, Math.trunc(currentDepth)) + 1;
}

/** Codex `exceeds_thread_spawn_depth_limit` (`codex-rs/core/src/agent/registry.rs:97`). */
export function exceedsAgentDepth(childDepth: number, maxDepth: number): boolean {
  return childDepth > maxDepth;
}

export interface ResolvedSubagentModel {
  selection: Selection;
  modelInfo: ModelInfo;
  reasoningEffort?: string;
}

/**
 * Precedence for child model and reasoning effort (Codex `child_config.rs` + OpenCode `subagent.ts`):
 * 1. Explicit tool call argument (`requestedModel` / `requestedEffort`)
 * 2. Role-specific host config (`[agents.<role>] model` / `reasoning_effort`)
 * 3. Global subagent host config (`[agents] default_model` / `default_reasoning_effort`)
 * 4. Parent session's current model and reasoning effort.
 */
export function resolveSubagentModelAndEffort(options: {
  parentSelection: Selection;
  parentReasoningEffort?: string;
  profile: AgentProfile;
  config: HostAgentsConfig;
  requestedModel?: string;
  requestedEffort?: string;
  lookupModel(modelRef: string, defaultAccountId: string): {selection: Selection; model: ModelInfo} | undefined;
  availableModelIds(accountId: string): string[];
}): {ok: true; value: ResolvedSubagentModel} | {ok: false; code: 'INVALID_INPUT'; message: string} {
  const {
    parentSelection,
    parentReasoningEffort,
    profile,
    config,
    requestedModel,
    requestedEffort,
    lookupModel,
    availableModelIds,
  } = options;

  const cleanModel = requestedModel?.trim() || undefined;
  const cleanEffort = requestedEffort?.trim() || undefined;
  const desiredModel = cleanModel ?? profile.model ?? config.defaultModel ?? parentSelection.modelId;

  const found = lookupModel(desiredModel, parentSelection.accountId);
  if (!found) {
    const listed = availableModelIds(parentSelection.accountId).slice(0, 5).join(', ');
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `Unknown model "${desiredModel}" for subagent.${listed ? ` Available models: ${listed}` : ''}`,
    };
  }
  if (found.model.capabilities.tools === 'unsupported') {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `Model "${found.selection.modelId}" does not support tools and cannot run a subagent.`,
    };
  }

  const sameModelAsParent =
    found.selection.accountId === parentSelection.accountId && found.selection.modelId === parentSelection.modelId;
  const desiredEffort =
    cleanEffort ??
    profile.reasoningEffort ??
    config.defaultReasoningEffort ??
    (sameModelAsParent ? parentReasoningEffort : found.model.defaultReasoningEffort);

  const supportedEfforts = found.model.reasoningEfforts ?? [];
  if (cleanEffort && supportedEfforts.length > 0 && !supportedEfforts.includes(cleanEffort)) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: `Reasoning effort "${cleanEffort}" is not supported for model "${found.selection.modelId}". Supported reasoning efforts: ${supportedEfforts.join(', ')}`,
    };
  }
  const effectiveEffort =
    desiredEffort && supportedEfforts.includes(desiredEffort)
      ? desiredEffort
      : found.model.defaultReasoningEffort && supportedEfforts.includes(found.model.defaultReasoningEffort)
        ? found.model.defaultReasoningEffort
        : undefined;

  return {
    ok: true,
    value: {
      selection: found.selection,
      modelInfo: found.model,
      ...(effectiveEffort ? {reasoningEffort: effectiveEffort} : {}),
    },
  };
}

export function accumulateSubagentUsage(current: Usage | null, child: Usage | null | undefined): Usage | null {
  if (!child) return current;
  return combineUsage(current, child);
}

const tokensOf = (usage: Usage | null | undefined): number =>
  usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0;

/**
 * What a child may spend (S5c security fix). It inherits the parent turn's caps minus what the parent and
 * the children still running (not yet folded into the parent's receipt) used: `maxOutputTokens` and
 * `maxEstimatedCostUSD` become the child's per-request caps, the user's work budget (tokens, cost, time)
 * shrinks to the remainder, and the optional `[agents] max_child_*` ceilings apply on top. A parent whose cap
 * is already spent gets a refusal instead of a child.
 */
export function inheritChildLimits(
  parent: SubagentParentLimits | undefined,
  runningChildrenUsage: Usage | null,
  config: HostAgentsConfig,
): {ok: true; limits: SubagentChildLimits} | {ok: false; message: string} {
  const budget: TurnBudget = {...(parent?.budget ?? {})};
  let maxOutputTokens = parent?.maxOutputTokens;
  let maxEstimatedCostUSD = parent?.maxEstimatedCostUSD;
  if (parent) {
    const spent = runningChildrenUsage ? combineUsage(parent.usage, runningChildrenUsage) : parent.usage;
    const spentTokens = tokensOf(spent);
    const spentOutput = spent?.outputTokens ?? 0;
    const spentCost = spent?.costUSD ?? 0;
    const exhausted = (what: string) => ({
      ok: false as const,
      message: `The parent turn's ${what} is already used up (including subagents), so no new subagent was started. Finish the work yourself or ask the user to raise the limit.`,
    });
    if (budget.maxTokens !== undefined) {
      const left = budget.maxTokens - spentTokens;
      if (left <= 0) return exhausted('token budget');
      budget.maxTokens = left;
    }
    if (budget.maxCostUSD !== undefined) {
      const left = budget.maxCostUSD - spentCost;
      if (left <= 0) return exhausted('cost budget');
      budget.maxCostUSD = left;
    }
    if (budget.maxDurationMs !== undefined) {
      const left = budget.maxDurationMs - parent.elapsedMs;
      if (left <= 0) return exhausted('time budget');
      budget.maxDurationMs = left;
    }
    if (maxOutputTokens !== undefined) {
      const left = maxOutputTokens - spentOutput;
      if (left <= 0) return exhausted('output token cap');
      maxOutputTokens = left;
    }
    if (maxEstimatedCostUSD !== undefined) {
      const left = maxEstimatedCostUSD - spentCost;
      if (left <= 0) return exhausted('estimated cost cap');
      maxEstimatedCostUSD = left;
    }
    if (budget.maxTokens !== undefined && maxOutputTokens !== undefined)
      maxOutputTokens = Math.min(maxOutputTokens, budget.maxTokens);
  }
  if (config.maxChildTokens !== undefined)
    budget.maxTokens = Math.min(budget.maxTokens ?? Infinity, config.maxChildTokens);
  if (config.maxChildDurationMs !== undefined)
    budget.maxDurationMs = Math.min(budget.maxDurationMs ?? Infinity, config.maxChildDurationMs);
  if (config.maxChildCostUSD !== undefined)
    budget.maxCostUSD = Math.min(budget.maxCostUSD ?? Infinity, config.maxChildCostUSD);
  return {
    ok: true,
    limits: {
      ...(maxOutputTokens !== undefined ? {maxOutputTokens: Math.max(1, Math.floor(maxOutputTokens))} : {}),
      ...(maxEstimatedCostUSD !== undefined ? {maxEstimatedCostUSD} : {}),
      budget,
    },
  };
}
