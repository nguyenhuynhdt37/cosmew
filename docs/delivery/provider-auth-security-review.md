# Provider/Auth security review

2026-11-14; local review of the implemented PA1 slice, not an independent security certification. [ADR 0005](../adr/0005-provider-auth-product.md) defines the threat scope. No unrestricted tools, MCP/plugins, subagents, delegated SDK processes or remote multi-user server are enabled.

## Findings addressed and evidence

| Finding / risk | Implementation and verification |
|---|---|
| Provider errors can expose keys, request bodies and prompts | Static typed HannesError messages, raw SDK/network errors discarded, SDK warnings/telemetry disabled, known-secret redaction before model text reaches transcript/UI. Negative error fixtures and no-secret CLI-output assertions. |
| Keys split across chunks can evade sink redaction | Streaming redactor withholds actual matching suffixes, including API-key prefixes; complete known keys redacted. Tests verify both opaque and `sk-` split credentials. |
| URL/auth forwarding and endpoint substitution | Security policy rejects URL credentials/query/hash, remote HTTP and changed endpoint/account generations. Fetch redirects forbidden. Foreign-origin/redirect fixture confirms zero credential-forwarded target requests. |
| AI SDK bare JSON Schema is not sufficient input validation | Negative fixture exposed wrong-type tool input acceptance. Added evaluated Ajv synchronous draft-07 validators, no mutation/coercion/defaults/async/network schema loading. Invalid tool input now fails. Unknown format/schema/refs fail compilation rather than silently weakening validation. |
| Partial streams could look complete | Reject missing terminal, other/error/interrupted finish and incomplete tool buffers. Core commits only after terminal event plus stream exhaustion. Failed context excluded from future turns; HTTP response/JSON/tool/text/history bounds enforced. |
| Duplicate remote acceptance after retry | SDK retries disabled. Only idempotent catalog GET retries, max 3, jitter + Retry-After capped at 30s and total deadline. No generation/tool replay; explicit user retry required. |
| Silent provider/account failover can leak context | No fallback routes. Explicit selection pinned to account and cached model; account/provider switches create fresh core conversation. Subprocess test confirms previous account's prompts absent from new request. |
| Credential reference reuse could overwrite/delete another account key | Keyring refs unique in settings and account preflight, credential rotation uses new UUID refs, settings failure removes newly created key only. Reuse/rollback tests protect old credential. |
| Logout/deletion races | Fence account and increment auth generation before vault deletion; failed deletion keeps retryable logged-out identity. New fetch/wire chunks check current durable state. Late auth validation cannot revive logout or validate a replacement key. Tests cover deletion failure and generation races. |
| Plaintext or repository credentials | No plaintext fallback. OS secure credential store or explicit env NAME only. Settings root 0700, DB 0600; reject direct symlinks/insecure root and future schema versions. Native macOS CLI test confirms secret absent from DB and deleted on removal. |
| Configuration injection | Strict schemas, no executable repository configuration, fixed public package exports, no provider SDKs in core, no shell execution or secret-valued command arguments. Unknown CLI flags return safe diagnostics without echo. |

## Scope and residual risks

- A local user/root with process-memory, environment, keyring or settings access is trusted. No OS sandbox, tenant isolation, remote service security or hardware-backed storage guarantee is made. Path checks are not protection against a malicious same-UID process racing filesystem operations. Keep private state on trusted local storage.
- SQLite stores conversation prompts/responses locally without application-level encryption. OS/disk protection is required. Account removal retains historical conversations; transcript retention/deletion UX, encrypted DB and recovery remain future work. Known provider credentials are filtered from assistant output, but this is not a universal detector for secrets in arbitrary user-supplied text.
- Environment mode exposes values to the process and user's environment. Hannes stores only names and cannot clear the parent shell. OS backend errors never trigger plaintext fallback. Linux Secret Service and Windows need independent runtime verification; macOS evidence is limited to the tested host.
- Cancellation prevents further local processing but cannot undo accepted provider processing/billing. Already buffered provider bytes or side effects cannot be recalled. No exactly-once remote guarantee is claimed.
- Metadata and estimated cost can be stale; unknown usage/prices stay null. An explicitly configured estimated-cost guard refuses unknown/unaffordable estimates before network, but is not a hard dollar guarantee. Exact provider token counts, hard dollar ceilings and model-specific option validation are not implemented. No hard billing guarantee is advertised.
- Tool schema compilation accepts trusted bounded descriptors only in this slice; hostile regexp/schema resource exhaustion needs isolated validation before future untrusted plugin/tool registration. Ajv code generation is evaluated third-party functionality; no raw execute callbacks are supplied.
- Provider/SDK compatibility outside tested wire fixtures and public catalogs is unverified. A matching protocol name is not support evidence. The original PA1 delivered no OAuth clients, refresh tokens or delegated-agent credentials; future work needs issuer/state/PKCE, refresh/revoke, provider terms and enforceable permission mediation.
- Dependency registry audit initially returned `{}` (no reported advisories); final audit result is recorded with acceptance. Registry integrity/advertised provenance does not independently establish artifact safety. Install hooks remain disabled.

These limitations are release-readiness findings. The Product MVP is not marked complete until applicable acceptance gates have real evidence.

## Interactive login/logout follow-up

The signed-out prompt and `/login` wizard reuse existing policy/vault/account services. One input owner consumes both chat and wizard answers; terminal history is disabled and key echo suppressed. Piped wizard input may use environment references, but cannot pretend to provide hidden terminal input. Extra queued lines after a secret are discarded/rejected. Current-account logout clears in-memory context before deletion, including failed deletion paths. Tests cover fresh setup, saved credentials, failed auth, cancellation and cross-login context isolation; an opt-in real PTY/native keyring test checks that key bytes do not appear in terminal output/history/database or chat messages. Commercial provider live status remains unchanged.


## Provider Connect review, 2026-11-14

[ADR 0007](../adr/0007-provider-connect-and-commands.md) adds only the official OpenRouter headless PKCE driver: cryptographic random verifier, S256, ten-minute/single-use challenges, bounded pinned HTTPS exchange with redirect refusal, no code/verifier/key diagnostics, and no management-key requirement inferred from inconsistent generated API-reference docs. The guide explicitly permits this flow. Live browser authorization remains unverified.

Authentication completion is mediated by composition/SDK; the TUI never receives the issued API key or vault. Custom endpoints cannot acquire OAuth through a provider-ID collision. OpenRouter uses authenticated `/key` before treating public catalog discovery as successful login. SDK, CLI administrative login and guided wizard remove newly entered credentials on validation failure. Failed key deletion fences routing and remains retryable. Model/account changes fence context transfer; permission grants hash the entire target and clear at conversation boundaries. Production permission demo-request generation was removed.

TUI shutdown cancels and drains active auth/chat work before closing SQLite, so termination cannot strand credential rollback.

No dependencies were added. Built-in Web Crypto, fetch, Node SHA-256 and the already evaluated native keyring are used. No external auth plugins, remote execution or delegated-CLI processes are launched. Device-code/refresh-token drivers and external plugin loading remain Not implemented. Local deletion cannot revoke a remote OAuth-issued API key; revocation is through the OpenRouter console. See [current tests/limits](provider-connect-acceptance.md).


SUB1 security review and evidence: [runtime/environment/vault/permission boundaries](subscription-auth.md). Official transports use private temporary profiles, OS-vault credential snapshots, fixed argv, minimized environments, runtime tool controls and denied permission/client filesystem requests. A separate process is not advertised as an OS sandbox; authenticated native-runtime hostile-tool acceptance remains pending.
