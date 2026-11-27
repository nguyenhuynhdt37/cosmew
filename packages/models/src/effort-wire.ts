import type {AnthropicLanguageModelOptions} from '@ai-sdk/anthropic';
import {anthropicModelCatalog, getAnthropicLanguageModelEntry} from '@ai-sdk/anthropic/internal';
import type {GoogleLanguageModelOptions} from '@ai-sdk/google';
import {getGoogleLanguageModelEntry} from '@ai-sdk/google/internal';
import {FutrynError, budgetEfforts, type ModelInfo, type Provider} from '@cosmew/contracts';

type BudgetEffort = (typeof budgetEfforts)[number];
type ThinkingProtocol = 'anthropic' | 'gemini';

export function thinkingProtocolFor(protocol: Provider['protocol']): ThinkingProtocol | undefined {
  if (protocol === 'anthropic' || protocol === 'vertex-anthropic') return 'anthropic';
  if (protocol === 'gemini' || protocol === 'vertex') return 'gemini';
  return undefined;
}

const budgetFractions: Record<BudgetEffort, number> = {
  minimal: 0.05,
  low: 0.2,
  medium: 0.35,
  high: 0.5,
  xhigh: 0.75,
  max: 0.9,
};

function isBudgetEffort(effort: string): effort is BudgetEffort {
  return budgetEfforts.some(level => level === effort);
}

type WireOptions =
  | {anthropic: Pick<AnthropicLanguageModelOptions, 'thinking' | 'effort'>}
  | {google: Pick<GoogleLanguageModelOptions, 'thinkingConfig'>};

type Wire = {providerOptions: WireOptions; maxOutputTokens?: number; thinkingBudget?: number};

/** Resolve a provider control once for both the catalog's selectable levels and actual requests. */
export function resolveThinkingWire(
  provider: Provider,
  protocol: ThinkingProtocol,
  info: ModelInfo | undefined,
  effort: string,
  requestedCap?: number,
): Wire {
  const fail = (reason: NonNullable<ConstructorParameters<typeof FutrynError>[4]>) =>
    new FutrynError('UNSUPPORTED', false, null, protocol, reason);
  if (!info || info.capabilities.reasoning === 'unknown') throw fail('unknown');
  if (info.capabilities.reasoning === 'unsupported') throw fail('unsupported');

  const evidence = info.reasoningOptions;
  const levels = info.reasoningEfforts ?? evidence?.efforts;
  const budgetMin = evidence?.efforts ? undefined : evidence?.budgetMin;
  const advertised = levels?.includes(effort) ?? false;
  const modelDeclaration = provider.reasoning?.models?.[info.id];
  const declaredLevels = modelDeclaration?.efforts ?? provider.reasoning?.efforts;
  const canRequestNone = advertised || evidence?.toggle || (budgetMin !== undefined && !declaredLevels);

  const anthropic = protocol === 'anthropic' ? getAnthropicLanguageModelEntry(info.id) : undefined;
  const google = protocol === 'gemini' ? getGoogleLanguageModelEntry(info.id) : undefined;
  const claude = anthropic?.capabilities.language.reasoning;
  const gemini = google?.capabilities.language.reasoning;
  const geminiUsesLevel = google?.requestConfig.language.thinkingFormat === 'level';
  // The SDK's fallback format is "budget" even for older Gemini IDs that lack thinking.
  if (google && /(?:^|[/\.])gemini-(?:1\.\d|2\.0)(?:-|$)/i.test(info.id)) throw fail('mapping');

  if (effort === 'none') {
    if (claude && !claude.canDisable) throw fail('disable');
    if (gemini && (geminiUsesLevel || gemini.minBudget !== 0)) throw fail('disable');
    if (!canRequestNone) throw fail('mapping');
    return {
      providerOptions: claude
        ? {anthropic: {thinking: {type: 'disabled'}}}
        : {google: {thinkingConfig: {thinkingBudget: 0, includeThoughts: false}}},
    };
  }

  if (budgetMin === undefined) {
    if (!advertised) throw fail('mapping');
    if (anthropic && claude) {
      // SDK documented families may also appear with a dated revision in the catalog.
      const family = Object.keys(anthropicModelCatalog)
        .filter(id => info.id === id || info.id.startsWith(id + '-'))
        .sort((a, b) => b.length - a.length)[0];
      const native = family ? anthropicModelCatalog[family]?.providerOptions.language.effort : undefined;
      if (
        native === false ||
        (native !== true && !evidence?.efforts) ||
        !(
          effort === 'low' ||
          effort === 'medium' ||
          effort === 'high' ||
          effort === 'max' ||
          (effort === 'xhigh' && claude.supportsXhighEffort)
        )
      )
        throw fail('mapping');
      return {
        providerOptions: {
          anthropic: {
            effort,
            ...(claude.adaptive ? {thinking: {type: 'adaptive', display: 'summarized'}} : {}),
          },
        },
      };
    }

    // The bundled docs restrict the original Gemini 3 Pro to low/high. The SDK's
    // generic level catalog also lists medium for that family.
    const originalPro = /(?:^|[/\.])gemini-3-pro(?:-|$)/i.test(info.id);
    if (
      !geminiUsesLevel ||
      !gemini?.efforts?.some(level => level === effort) ||
      (originalPro && effort !== 'low' && effort !== 'high') ||
      !(effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh')
    )
      throw fail('mapping');
    return {providerOptions: {google: {thinkingConfig: {thinkingLevel: effort, includeThoughts: true}}}};
  }

  if (
    !isBudgetEffort(effort) ||
    (declaredLevels && !declaredLevels.includes(effort)) ||
    (claude && !claude.budget) ||
    geminiUsesLevel
  )
    throw fail('mapping');

  const sdkAnthropicCap = anthropic?.requestConfig.language;
  const modelCap = Math.min(
    info.outputLimit ?? Infinity,
    sdkAnthropicCap?.knownModel ? sdkAnthropicCap.maxOutputTokens : Infinity,
  );
  const maxOutputTokens = Math.min(modelCap, requestedCap ?? Infinity);
  const minimum = Math.max(budgetMin, claude ? 1024 : 1, gemini?.minBudget ?? 0);
  const maximum = Math.min(maxOutputTokens - 1, gemini?.maxBudget ?? Infinity);
  if (!Number.isFinite(maxOutputTokens) || maximum < minimum) throw fail('budget');

  const configuredBudget = modelDeclaration?.budgets?.[effort] ?? provider.reasoning?.budgets?.[effort];
  const defaultBudget = Math.floor((Number.isFinite(modelCap) ? modelCap : maxOutputTokens) * budgetFractions[effort]);
  const budget = Math.max(minimum, Math.min(configuredBudget ?? defaultBudget, maximum));
  return claude
    ? {
        providerOptions: {anthropic: {thinking: {type: 'enabled', budgetTokens: budget}}},
        maxOutputTokens,
        thinkingBudget: budget,
      }
    : {providerOptions: {google: {thinkingConfig: {thinkingBudget: budget, includeThoughts: true}}}, maxOutputTokens};
}

export function selectableReasoningEfforts(provider: Provider, info: ModelInfo): ModelInfo {
  const protocol = thinkingProtocolFor(provider.protocol);
  if (!protocol) return info;
  const candidates = info.reasoningEfforts?.length
    ? info.reasoningEfforts
    : info.reasoningOptions?.budgetMin !== undefined && !info.reasoningOptions.efforts
      ? ['none', ...budgetEfforts]
      : info.reasoningOptions?.toggle
        ? ['none']
        : [];
  const reasoningEfforts = candidates.filter(effort => {
    try {
      resolveThinkingWire(provider, protocol, info, effort);
      return true;
    } catch (error) {
      if (error instanceof FutrynError && error.code === 'UNSUPPORTED') return false;
      throw error;
    }
  });
  const resolved = {...info};
  if (reasoningEfforts.length) resolved.reasoningEfforts = reasoningEfforts;
  else delete resolved.reasoningEfforts;
  if (resolved.defaultReasoningEffort && !reasoningEfforts.includes(resolved.defaultReasoningEffort))
    delete resolved.defaultReasoningEffort;
  return resolved;
}
