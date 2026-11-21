export type ErrorCode =
  | 'INVALID_INPUT'
  | 'AUTH'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMIT'
  | 'PROVIDER_BILLING'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'TRANSPORT'
  | 'PROTOCOL'
  | 'POLICY'
  | 'STORAGE'
  | 'UNSUPPORTED'
  | 'BUDGET'
  | 'RUNTIME_UNAVAILABLE'
  | 'CONTEXT_LIMIT'
  | 'STALLED';
const safeMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Invalid configuration or request. Check help and field formats.',
  AUTH: 'Account credentials are missing, expired or could not be verified. Sign in again or check provider access.',
  FORBIDDEN: 'Provider denied access. Check account permissions and API entitlements.',
  NOT_FOUND: 'Provider or model unavailable. Refresh models or check the configured URL/model ID.',
  RATE_LIMIT: 'Provider rate limit reached. Wait before retrying or explicitly choose another account.',
  PROVIDER_BILLING: 'Provider account is out of credits or needs a subscription.',
  TIMEOUT: 'Request timed out. Remote processing may have occurred; retry explicitly.',
  CANCELLED: 'Request cancelled. Remote processing may have occurred.',
  TRANSPORT: 'Provider connection failed. Check endpoint, network and TLS settings.',
  PROTOCOL: 'Provider returned an invalid, incomplete or oversized response.',
  POLICY: 'Selection or network policy denied the request. Explicitly configure/select the target.',
  STORAGE:
    'Private settings, session store or OS credential store unavailable. Check permissions; no plaintext fallback is used.',
  UNSUPPORTED: 'Authentication method or protocol is unsupported. Check the provider method and configuration.',
  RUNTIME_UNAVAILABLE:
    'A required local program (language server, MCP server or token command) is not available. Check that it is installed and on PATH, then retry.',
  STALLED: 'No safe progress after bounded recovery. Review the unfinished task and tool evidence before continuing.',
  CONTEXT_LIMIT:
    'The conversation plus the output reserve no longer fits the model context window. Critical user constraints and recent execution evidence cannot be safely compacted further. Reduce output reserve, explicitly narrow the task, or choose a larger context window.',
  BUDGET:
    'Estimated cost guard denied the request: pricing is unknown or the estimate exceeds your limit. Refresh metadata or explicitly change the limit; this is not a billing guarantee.',
};
/** Fixed diagnostics only: never display arbitrary provider exception text. */
const reasoningMessages = {
  levels:
    'No effort levels known for this model. Declare them in ~/.cosmew/config.toml (model_providers.<id>.reasoning).',
} as const;
const reasoningWireMessages = {
  unknown: 'reasoning capability is unknown.',
  unsupported: 'reasoning capability is unsupported for this model.',
  mapping: 'no wire mapping for the requested effort is supported by the model metadata and installed SDK.',
  disable: 'thinking cannot be disabled with the available model settings.',
  budget: 'there is no room for the minimum thinking budget under the output limit, or the output limit is unknown.',
} as const;
export class CosmewError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null,
    reasoningDetail?: keyof typeof reasoningMessages | 'anthropic' | 'gemini',
    reasoningWireDetail: keyof typeof reasoningWireMessages = 'mapping',
  ) {
    super(
      code !== 'UNSUPPORTED' || !reasoningDetail
        ? safeMessages[code]
        : reasoningDetail === 'levels'
          ? reasoningMessages[reasoningDetail]
          : `Reasoning effort is unsupported for the ${reasoningDetail} protocol: ${reasoningWireMessages[reasoningWireDetail]}`,
    );
    this.name = 'CosmewError';
  }
  toJSON() {
    return {code: this.code, message: this.message, retryable: this.retryable, retryAfterMs: this.retryAfterMs};
  }
}

/** The transport may attach a bounded, redacted diagnostic for a provider billing failure. */
export class ProviderBillingError extends CosmewError {
  constructor(readonly providerHint?: string) {
    super('PROVIDER_BILLING');
    if (providerHint) this.message += ` Provider says: ${providerHint}`;
  }
}

/** Compatibility aliases for consumers before the Cosmew rename. */
export {CosmewError as FutrynError, CosmewError as HannesError};

/** Observer notifications, not durable execution envelopes or permission grants. */
export type InteractionEvent =
  | {type: 'permission.requested'; request: import('./permissions').PermissionPromptRequest}
  | {type: 'question.asked'; request: import('./tools').PendingQuestion};

/** One JSON object per line from `fyn exec --json`; seq orders the entire run. */
export type HeadlessEvent = {contractVersion: typeof import('./models').CONTRACT_VERSION; seq: number} & (
  | import('./models').ModelEvent
  | InteractionEvent
  | {type: 'turn.completed'}
  | {type: 'turn.failed'; error: {code: ErrorCode; message: string}}
);
