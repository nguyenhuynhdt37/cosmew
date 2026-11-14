export type ErrorCode = 'INVALID_INPUT' | 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMIT' | 'TIMEOUT' | 'CANCELLED' | 'TRANSPORT' | 'PROTOCOL' | 'POLICY' | 'STORAGE' | 'UNSUPPORTED' | 'BUDGET' | 'RUNTIME_UNAVAILABLE';
const safeMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Invalid configuration or request. Check help and field formats.',
  AUTH: 'Credential missing, expired or rejected. Run auth login/status; check API entitlements.',
  FORBIDDEN: 'Provider denied access. Check account permissions and API entitlements.',
  NOT_FOUND: 'Provider or model unavailable. Refresh models or check the configured URL/model ID.',
  RATE_LIMIT: 'Provider rate limit reached. Wait before retrying or explicitly choose another account.',
  TIMEOUT: 'Request timed out. Remote processing may have occurred; retry explicitly.',
  CANCELLED: 'Request cancelled. Remote processing may have occurred.',
  TRANSPORT: 'Provider connection failed. Check endpoint, network and TLS settings.',
  PROTOCOL: 'Provider returned an invalid, incomplete or oversized response.',
  POLICY: 'Selection or network policy denied the request. Explicitly configure/select the target.',
  STORAGE: 'Private settings, session store or OS credential store unavailable. Check permissions; no plaintext fallback is used.',
  UNSUPPORTED: 'Authentication or runtime protocol is unsupported. Check the provider method and supported runtime version.',
  RUNTIME_UNAVAILABLE: 'The official provider runtime is not installed or is not on PATH. Install Codex, Copilot CLI, Gemini CLI or Qwen Code for the selected subscription, then retry.',
  BUDGET: 'Estimated cost guard denied the request: pricing is unknown or the estimate exceeds your limit. Refresh metadata or explicitly change the limit; this is not a billing guarantee.',
};
export class HannesError extends Error {
  constructor(public readonly code: ErrorCode, public readonly retryable = false, public readonly retryAfterMs: number | null = null) {
    super(safeMessages[code]); this.name = 'HannesError';
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, retryAfterMs: this.retryAfterMs }; }
}
