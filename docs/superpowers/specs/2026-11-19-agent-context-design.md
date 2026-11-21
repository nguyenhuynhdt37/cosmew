# Agent context and evidence retention

User intent: improve investigation, search and editing quality using the upstream findings in `reports/Xử lý ngữ cảnh agent.md`. Implementation is authorized by the current request and AGENTS.md; no claim of model-quality parity without live comparative evaluation.

## Approaches and decision

Increasing all output limits risks context flooding; adding delays/call quotas does not establish understanding. Choose recoverable bounded evidence, compaction before tool withdrawal and evidence-driven exploration guidance. Keep existing ports, security and durable transcript boundaries. No new dependencies or external agent runtimes.

## Behavior

- Auto compaction triggers before the tool withdrawal threshold, measures the replacement and continues with tools when it fits. Cancellation and failed/no-gain compaction remain bounded and honest. Preserve original history and tool pairing.
- Bounded redacted outputs have session/workspace-scoped opaque retrieval handles through a registered `tool_output` tool. Persistence owns durable archive writes; retrieval passes dispatcher authorization/audit, checks current source-read policy where applicable and invalidates when the effective permission context or grants are revoked. Handles grant no authority. No direct state-directory filesystem access.
- Archive results before generic clipping, cap storage per output/session, return paging/search coverage and explicit unavailable/expired/truncated diagnostics. Avoid recutting producer pages when context fits. A current artifact page remains bounded.
- Prompt guidance: follow entry points, implementations, callers and relevant tests; resolve contradictions/missing evidence; verify changes. No forced minimum number of calls, delay or fabricated claims of understanding. Keep provider-specific reasoning unchanged pending verified protocol work.

## Verification

Regression at 87% window must compact and retain tools; test no-gain, errors, cancellation and repeated turns. Place evidence in the middle of long output and retrieve it through the real dispatcher/archive. Test redaction, cross-session denial, policy changes, revoked grants, bounds, missing artifacts and no execution on retrieval. Run affected contract/security/end-to-end tests, typecheck and repository checks; record live parity as Needs verification.
