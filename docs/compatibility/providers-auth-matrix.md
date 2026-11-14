# Provider and authentication verification matrix

2026-11-14. **Product MVP acceptance: pending.** Implemented means executable Hannes code; fixture-tested means deterministic HTTP/subprocess tests; live-verified means a named operation actually contacted the service. No commercial generation is live-verified in this environment. Model count is not a support claim.

| Provider/integration | Implemented path | Deterministic evidence | Live status / limitation |
|---|---|---|---|
| OpenAI API | Native Responses; optional custom Chat; keyring/env accounts, models, selection, chat, logout | Responses/Chat discovery, generation, tools-as-data, stream, errors, CLI switching | Pending API credentials and actual model smoke test |
| Anthropic API | Native Messages + models; keyring/env; full CLI account lifecycle | Messages generation/stream/tool data; discovery; multi-provider CLI | Pending API credentials |
| Google Gemini API | Native Gemini; paginated generation-model discovery; keyring/env | Native request/stream, tool data, filtering embedding-only models, CLI | Pending API credentials |
| OpenRouter | Chat adapter, public models, authenticated key probe, keyring/env and official headless OAuth PKCE | Chat/account tests; S256, exchange/expiry/cancel; full OAuth TUI→vault→HTTP chat fixture | Public catalog + Models.dev enrichment previously live passed; browser OAuth authorization and authenticated generation pending |
| Custom compatible endpoints | Explicit URL + Chat/Responses/Messages/Gemini + discovery/manual model | All four protocols exercised; manual Responses gateway CLI | Experimental for each new endpoint until its own live verification; no universal compatibility claim |
| Ollama | `/api/tags` discovery, `/v1` Chat, explicit no-auth | Native route/no-auth CLI fixtures | Local daemon connection refused at `127.0.0.1:11434`; live generation blocked until started/model installed |
| User's 9Router configuration | URL + chosen protocol + manual model or provider listing, as user clarified | Manual gateway login does real generation against fixture HTTP service | No service URL/model/credentials supplied; identity-specific protocol/live compatibility unverified |
| Models.dev | Explicit advisory limits/prices sync, cached provenance | Normalization fixture; never upgrades unknown capabilities | Public metadata sync live passed; metadata is not provider entitlement/verified capabilities |

All named live-pending providers are **implemented but pending live verification**, not production-certified. Tool-call normalization has fixtures; Hannes tool execution is disabled. Streaming is an adapter capability verified against fixtures, not automatically a verified property of every catalog model. Model capability fields remain unknown unless independently established; price metadata is advisory and unavailable values stay null.

## Additional provider assessment

No extra packages/presets are installed simply because the SDK ecosystem lists them. The existing configurable gateway path can be evaluated against explicit endpoints; it does not turn the following into verified named integrations. Each requires current official endpoint/model/auth confirmation and provider-specific fixtures/live evidence before promotion.

| Candidate | Assessment and current status |
|---|---|
| DeepSeek, xAI, Groq, Cerebras | Compatible Chat is an experimental configuration option; native options/reasoning/usage semantics not conformance-tested. Named support Not implemented. |
| Mistral | Separate native provider/options and streaming differences require own tests. Custom Chat is experimental; named support Not implemented. |
| Together AI, Fireworks | Gateway Chat may be configurable; model namespaces, usage and special tool behavior need provider fixtures. Named support Not implemented. |
| Qwen-compatible endpoints | Explicit compatible API URL/key may use custom gateway. Qwen subscription OAuth is a different entitlement; no client impersonation. Named support Not implemented. |
| Z.AI/GLM, Moonshot/Kimi, MiniMax | API versus coding-plan/region endpoints and auth cannot be conflated. Explicit gateway configuration is experimental; named support Not implemented. |
| LM Studio, vLLM | Explicit loopback Chat configuration is experimental; daemon/version/model/stream behavior unverified. Named support Not implemented. |
| Azure OpenAI | Provider identity/deployment/version and credential method differ; design allows a new adapter factory. Native integration Not implemented; no Azure credentials/tests. |
| AWS Bedrock | Requires evaluated signing/credential-chain adapter and region/model entitlements; not ordinary Chat. Not implemented; no credentials/tests. |
| Google Vertex AI | Requires ADC/service-account lifecycle and project/region policy; not consumer Gemini OAuth. Not implemented; no credentials/tests. |

The selection boundary does not expose SDK types, so adding a native adapter does not require core to import it. See [research](../delivery/provider-auth-research.md) for pinned sources and [catalog](../delivery/dependency-catalog.md) for evaluated packages.

## Authentication and subscription matrix

| Mode | Hannes status | Evidence / alternative |
|---|---|---|
| API key in OS secure storage | Implemented; native macOS keyring and CLI key-stdin tested | Disposable entry roundtrip/delete, CLI key-stdin lifecycle and a real terminal `/login` → chat → `/logout` with masked key/history checks against HTTP fixtures; Linux/Windows pending |
| Environment variable reference | Implemented/tested | Only variable name persisted; logout fences identity, not the parent shell variable |
| Explicit no-auth | Implemented/tested | Local/public configuration only; public discovery does not establish paid generation entitlement |
| API key refresh | Not applicable | API keys are replaced via stable-ID reauthentication; no invented refresh/revoke protocol |
| OpenAI ChatGPT/Codex | Official Codex CLI/SDK supports subscription auth; Hannes delegated integration Not implemented | Use official Codex CLI separately or an OpenAI API key. SDK is agent execution with its own tool/runtime surfaces, not raw API entitlement. |
| Google/Gemini CLI subscription | Official sign-in documented for Gemini CLI/Code Assist; Hannes delegated integration Not implemented | Use official CLI separately or Gemini API key; do not copy first-party client credentials. |
| GitHub Copilot | Official Copilot SDK supports signed-in users and an application's own OAuth tokens; Hannes integration Not implemented | Own OAuth app or supported CLI credentials through official SDK, plus permission mediation required; no borrowed client ID/raw endpoint claim. |
| Qwen Code subscription | Official device/SDK flows are application-specific; Hannes integration Not implemented | Official Qwen Code separately, or explicit API-compatible endpoint/key with actual entitlements. |
| Claude subscription / Agent SDK | SDK is available under Anthropic commercial terms; Hannes delegated integration Not implemented | Review allowed third-party auth/terms and mediate tool execution first; use Anthropic API key here. |

The delegated-agent blocker is precise: this repository has no implemented general permission dispatcher/sandbox/agent-tool mediation. Launching a provider SDK that can read files or run commands would bypass the required Hannes security gate. No such process is launched and no other application's auth files/cookies are read. These integrations are future work, not working OAuth buttons.


Provider Connect follow-up: [ADR 0007](../adr/0007-provider-connect-and-commands.md), [command/acceptance evidence](../delivery/provider-connect-acceptance.md). Device-code/delegated-CLI authentication and external auth plugins remain Not implemented. OpenRouter OAuth uses its own API credits and does not grant access through another consumer subscription.
