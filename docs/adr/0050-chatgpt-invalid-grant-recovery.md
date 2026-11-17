# ADR 0050 — Recover ChatGPT registration with the issued client

Date: 2026-11-17. Status: implemented; live sign-in, model discovery and one streamed generation verified on this host.

## Evidence

A live Futryn sign-in returned HTTP 400 / `invalid_grant` from
`https://auth.openai.com/api/accounts/oauth/token`. No model API request followed.
The browser previously reported success before exchanging the code. Repeating dynamic registration
discarded the issued client and used a new host ID each time.

Official [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
accessed 2026-11-17 (dynamic documentation, no immutable revision), explicitly requires discarding
the refused code and starting fresh authorization with the issued client retained for that attempt.
It also requires a stable host ID and accepting a reauthorization callback without `client_id`,
while rejecting a supplied client ID that differs from the pending request.
OpenCode `packages/core/src/plugin/provider/chatgpt.ts` at `0ac0d7e` (unchanged at
`95b0de8aa3154c293bccd7d5b324e2b44dac4ad8`) does not implement this recovery branch.

## Decision

- Retain the issued client in the pending attempt. On authorization-code `invalid_grant`, open
  one fresh authorization using that client, fresh state/nonce/PKCE and the same host. Do not reuse
  the refused code, force consent, or loop through repeated registrations. A second refusal fails.
- Keep cancellation, the original login timeout and progress bound to the recovery attempt.
  Cancellation aborts in-flight OAuth/JWKS requests and closes both callback listeners.
- Contract **1.22** adds optional `Settings.chatgptHostID` (UUID, no credential material). The
  composition root initializes it through the existing persistence-owned `SqliteSettings` transaction
  and supplies its `urn:uuid:` form to OAuth. Existing settings load; older strict settings readers
  cannot read the new field. SQLite layout and schema version remain unchanged.
- Delay the browser result until identity verification finishes. Distinguish key-discovery network
  failures from bad identity credentials. Show only HTTP status and allowlisted standard OAuth
  error names, never arbitrary provider error descriptions, codes/verifiers or tokens.
- Discover the selected account's models from `/v1/models` (`models[].slug`, `display_name`,
  `visibility == "list"`), preserving server order; remove the fabricated fallback list. Existing
  saved manual ChatGPT presets use the same discovery path and do not force inference on sign-in.
  A later live attempt passed OAuth and reached `/v1/responses`, which rejected the old `gpt-5.5`
  default with HTTP 400 / `model_not_found`.
- All ChatGPT Responses calls, including explicit generation probes, set `store=false` and
  `stream=true`. The synchronous adapter method consumes the stream through completion. Official
  [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
  accessed 2026-11-17, requires these parameters and account-specific model discovery.

## Verification scope

Local HTTP tests cover recovery with an omitted callback client ID, fresh authorization material,
bounded recovery, cancellation, host persistence, verification errors and credential cleanup.
These establish caller behavior against fixtures. The subsequent isolated live check returned HTTP 200
for token exchange, model discovery and Responses inference, validated the ID token and native keyring,
and completed the adapter's streaming generation probe. See the detailed scope in
[subscription authentication](../delivery/subscription-auth.md#chatgpt-api-sign-in-troubleshooting-2026-11-17).
The final live attempt did not need the recovery branch. Live recovery, refresh/revocation, other
accounts and tool/capability acceptance remain **Needs verification**. This change does not restore
any external agent runtime.
