# Commands, usage, context and account continuation

2026-11-15. Implements the authorized [audit](commands-usage-context-audit.md) under [ADR 0009](../adr/0009-command-telemetry-and-account-continuation.md), contract 1.3 / SQLite schema 2. No new dependency, package edge, plugin host or general tool execution.

## Use

- `/usage` (alias `/cost`): last turn, session input/output subtotals, coverage of reported/historical turns, price-covered turn count, per-model subtotals, estimated API cost with source/date, cache/reasoning breakdown and premium-request units. Provider-reported account quota snapshots have a separate, dated section. Unknown values remain unknown; missing-price turns are not counted as free.
- `/context`: local history plus draft estimate, model context/input limit and API output reserve (runtime reserve remains unknown when not exposed), metadata provenance, and the last dated runtime measurement. Local estimates are `UTF-8 bytes / 4 + message overhead`, not a reviewed exact tokenizer. Runtime-added hidden context prevents a precise current percentage; an old runtime snapshot is not presented as the next request's exact size. Session cumulative tokens are not occupancy.
- `/status`: account/provider/auth mode/model/session, historical connectivity time, request phase, effective reasoning effort, usage/context summaries and secondary backend capabilities. `/doctor` performs the live connectivity check. All three reports scroll with arrows and PgUp/PgDn and close with Esc; frames remain bounded on short terminals.
- `/effort`: open the keyboard slider; Left/Right stages an advertised level, Enter saves and Esc cancels. `/effort high` sets an advertised value, `/effort auto` clears the saved preference, `/effort status` reports it. `/model effort` remains a compatibility alias. In `/model`, Left/Right stages effort for the highlighted model; Enter commits model/effort and Esc discards the draft. Ctrl+E remains an adjustment shortcut. Unsupported models explain that the transport has not advertised effort support; no fake toggle is offered. Effort preferences persist per account/model.
- `/switch` (alias `/account`): choose a connected account by numbered list. `/switch 2` or `/switch second` opens confirmation directly. The confirmation explicitly says committed chat history will be transferred. Cancel is selected initially. Confirmation discovers the target catalog, keeps the same model when available or uses that account's previously saved default. If neither exists, the TUI asks for a target model before changing the source session. There is no silent choice of an arbitrary model. Esc cancels. The resulting session has a new ID, is bound to the selected account/model, and retains committed history; the original session is preserved. Usage and permission grants are not transferred. Failed discovery leaves the current session intact.
- `/accounts` retains Switch/Add/Rename/Reconnect/Remove administration. Its ordinary switch action starts fresh; `/switch` is the explicit continuation path.
- `/logout` now requires confirmation, reversing the previous direct-logout increment at the user's request. One saved account goes directly to a named confirmation; multiple accounts get a focused picker followed by confirmation. `/logout second` targets a saved alias/ID directly. Cancel is selected initially, Esc cancels, failures remain retryable. Other accounts remain connected. Environment values and remote credentials are not revoked.

The slash registry/parser lives in the SDK. Autocomplete/help/palette share it; the selected absolute menu row stays in view and is the row Enter executes. Aliases normalize before argument validation. Literal subcommand completion works without replacing explicit arguments with fuzzy suggestions. `/usege` suggests `/usage`. Read-only usage/context/status/help/theme commands can be opened during streaming; account/model/session mutations require cancellation first. Read-only commands do not replace the active turn's shutdown/cancellation task.

Reasoning phases distinguish preparing, waiting for provider, provider reasoning summary and answer text. Only returned provider summaries/text are shown in a separate collapsible region (Ctrl+R); no private chain of thought is invented. Summary text is bounded and passes an independent secret-redacting stream filter plus terminal sanitization. Summaries are transient and are not part of durable conversation messages or usage receipts. If a provider supplies no summary, waiting is shown without invented content.

The line CLI uses the same parser and report projections, preserving documented administration/wizard compatibility. `/usage`, `/cost`, `/context`, `/status`, `/effort`, `/switch <alias-or-index>` and `/resume <id>` work in line chat. Interactive sign-out/context transfer asks for confirmation; an explicit noninteractive scripted command is its authorization. `hannes usage|cost|context|status <session-id>` can inspect a persisted session. A target without a compatible/saved model requires model configuration or the TUI picker.

## Data and provider coverage

Usage observations are durably saved during a turn. Final usage and answer completion share a transaction; failures/cancellation retain reported observations without committing a successful answer. Restarts/resume restore receipts. Existing schema-1 sessions load with explicitly unknown historical usage. Failed or uncleanly terminated turns are not represented as successful or free. No request is retried to reconstruct missing accounting.

- API adapters preserve reported input/output and positive cache/reasoning subsets. Ambiguous zero-valued detail defaults introduced by the API SDK remain unknown; native runtime events can preserve explicitly reported zero subsets; list-price calculations remain estimated. Cache-bearing requests without cache prices have unknown USD cost. Model metadata/prices have source/time; subscription premium multipliers are never converted to dollars.
- Codex maps `item/reasoning/summaryTextDelta`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, model-supported efforts and `turn/start.effort`. Full raw reasoning deltas are not requested or mapped.
- Copilot maps `assistant.reasoning_delta`, deduplicated per-call `assistant.usage`, `session.usage_info`, quota snapshots, model limits/efforts and `session.create.reasoningEffort`.
- Gemini model discovery retains `inputTokenLimit`/`outputTokenLimit`. Official OpenRouter catalog discovery retains context/output limits and converts documented per-token price strings to per-million prices once. Explicit Models.dev advisory metadata remains available; generic/manual model IDs do not imply known limits/prices/effort support.
- Gemini/Qwen ACP usage/effort/quota not supplied through the implemented contract remains unavailable, with explicit diagnostics. No consumer subscription is equated with raw API credits or unlimited quota.

## Verification and limits

Automated checks cover command selection beyond a page, aliases/arguments, tiny report frames, restart/resume/account isolation, unknown-vs-zero, price provenance, cache cost uncertainty, quota-vs-USD distinction, reasoning-summary redaction, partial cancelled/failed usage, migration/future-version rejection, effort wire parameters and context-transfer cancellation/model choice. Actual Bun.Terminal E2E covers reports, paging, account continuation with a real local HTTP response and logout confirmation. Native OS-vault and installed Copilot state-roundtrip probes remain separate opt-ins.

Deterministic provider/runtime fixtures and local HTTP/PTY tests establish FUTRYN behavior, not authenticated vendor acceptance. Authenticated live Codex/Copilot/Gemini/Qwen generation was not repeated for this increment. Exact model tokenization, automatic compaction, authoritative billing reconciliation, and quota refresh where an official runtime does not send a snapshot remain unavailable; the UI does not simulate them.

## References

Accessed 2026-11-15 via Context7 current indexes, with installed-source/schema inspection where noted. Dynamic documentation indexes are not immutable release snapshots:

- [Claude commands](https://code.claude.com/docs/en/commands), [costs](https://code.claude.com/docs/en/costs): `/usage`, `/cost` alias, locally estimated costs and separate subscription usage.
- [Codex app-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol): model effort metadata, turn effort, token/rate-limit updates and summary notifications. Local schemas generated with installed Codex 0.167.0 were inspected for exact field names.
- [Copilot usage/billing](https://github.com/github/copilot-sdk/blob/main/docs/features/usage-and-billing.md), [streaming events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md): cached/reasoning token subsets, premium multiplier, context/quota snapshots. Installed CLI 1.0.107 and the SDK source snapshots from the subscription research informed field mapping.
- [OpenRouter model schema](https://openrouter.ai/docs/guides/overview/models): `context_length`, `top_provider.max_completion_tokens`, string prices per token.
- Installed, already-reviewed AI SDK/OpenAI adapter declarations and parser source were inspected for reasoning-summary streams, token detail fields and `forceReasoning` when authoritative model metadata advertises effort. No dependency change.

## Observed checks on this host

| Check | Result |
|---|---|
| `bun run typecheck` | Pass |
| `bun run lint` | Pass |
| `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests` | 144 pass, 0 fail, 14 files |
| `HANNES_TEST_KEYRING=1 bun run test:integration` | 40 pass, 0 fail |
| `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun run test:e2e` | 70 pass, 0 fail |
| Final focused command/usage/context suite | 12 pass, 0 fail; includes actual PTY, cancellation during switch and preservation of populated schema-1 history |
| Visual QA | Actual framebuffer rendered/inspected for usage, context, status and named-account logout confirmation at 100×30; fixture data only |
| Authenticated live provider inference | Not repeated; no vendor acceptance claim |

The account switch has a loading state and AbortSignal propagation. Esc/Ctrl+C cancels in-flight target discovery without changing the account or creating a transferred session; shutdown aborts and drains the switch task before storage closes. Cancel remains the initial choice on logout/context-transfer confirmations.

## Readability follow-up (2026-11-15)

The reports now open as compact summaries in a bounded 58-column card, with muted labels and aligned values. Usage shows input/output, estimated cost or subscription billing, last-turn counts and reporting coverage. Context shows the local estimate, model window, output reserve and an explicitly approximate meter when applicable. Status shows the current account/model and essential request/session state. Unknown values are a dash or a short unavailable state rather than repeated paragraphs.

**D** toggles full detail and resets scrolling. Pricing provenance, token subsets, estimator method, historical runtime measurements and backend capabilities remain available there. Arrow/PgUp/PgDn navigation remains available for small terminals; read-only views preserve session/selection and do not issue provider requests. The underlying usage ledger, accounting rules and API/subscription distinction are unchanged. The line CLI retains complete diagnostic reports.

Report modals hide stale background banners. Account pickers show readable registry provider names; logout and context-transfer confirmation copy uses plain language while preserving the named target, Cancel default and explicit history-transfer warning. No public contract, storage schema or dependency change.

Visual QA inspected actual framebuffer renderings at 100×30 for usage, context, status and logout with deterministic fixture data. Regression coverage checks concise defaults, D/d detail toggling, small-terminal paging and session preservation, alongside the real PTY flows.

Follow-up checks: `bun run typecheck` and `bun run lint` pass; `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests` reports **145 pass, 0 fail**, including actual PTY and native-vault checks. No authenticated vendor inference was repeated for these presentation changes.

## Selection, context measurement and logout removal (2026-11-15)

[ADR 0010](../adr/0010-terminal-selection-and-logout-removal.md), contract 1.4:

- Drag over visible chat/report text to select. Ctrl+C or Ctrl+Y sends the selected text to the terminal clipboard using OSC 52; Esc clears it. While selected, the display is frozen but the provider stream continues. Resize or another action clears selection. Shift+drag is available for native terminal selection/copy. Clipboard support depends on the terminal/host; no clipboard contents are read.
- Context summaries and the chat footer show measured **used / total** when a runtime measurement is available. A new draft or missing measurement uses a visibly marked local estimate. Observed model windows survive catalog refresh/restart for the same account/model. The compact composer reserves room for the context indicator on ordinary chat widths, keeping it ahead of less essential hints.
- A successful user logout deletes credentials and removes the account/preferences from the list. There is no successful-logout tombstone to reactivate. Failed credential deletion remains fenced/retryable; in-place reconnect still preserves the identity intentionally. Confirmation remains required. Previously saved conversations are preserved, but removing credentials does not implicitly rebind their identity to another login.
- Selecting the account already active performs no new activation, request or session change. The switch chooser marks the active row, skips it during navigation and selects another account initially. A→B→A switching remains available.

Tests cover real SGR drag input through a PTY, fragmented input, inverse selection highlighting and the actual OSC 52 payload; reverse/multiline selection, masked-key copying, frozen selection during generation, clipboard bounds, duplicate-account no-ops, measured context/cache retention and successful removal vs failed cleanup. These are terminal/protocol checks; changing a specific emulator's OS clipboard and authenticated live-provider generation remain separate acceptance.

Final verification: `bun run typecheck` and `bun run lint` pass. `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests` reports **151 pass, 0 fail across 15 files**. Separate integration and terminal/end-to-end runs report **40 pass** and **71 pass**, respectively. Visual inspection of the rendered fixture framebuffer confirms selected chat text and the copy/clear hint. No authenticated live-provider inference was performed for this increment.


## Immediate context and Claude effort command follow-up (2026-11-15)

The composer shows a dedicated **Context used / total tokens** row before the first message, after selecting a model and during chat. A bounded theme-token meter and percentage appear when available; `~` marks estimates. Runtime-hidden occupancy remains explicitly local and has no fabricated percentage. Missing window metadata says **not reported**. Narrow layouts keep the maximum window visible. `/model` shows **Max context** with exact token counts instead of `ctx`, in a bounded dialog; long labels cannot displace the limit.

The canonical command is now `/effort [level|auto|status]`. Legacy `/model effort` resolves through the same parser in CLI/TUI/autocomplete. The slider and `/model` Left/Right controls only offer model-advertised levels, commit on Enter and cancel on Esc. Preferences remain per account/model under existing storage/contracts. Unsupported effort modes produce diagnostics. Claude-specific ultracode, environment precedence, deferred mid-request updates and session-only overrides are not implemented; FUTRYN still requires cancelling an active response before changing effort.

Reference: current [Claude model configuration](https://code.claude.com/docs/en/model-config), [commands](https://code.claude.com/docs/en/commands), [keybindings](https://code.claude.com/docs/en/keybindings), accessed via Context7 `/websites/code_claude` on 2026-11-15 (dynamic index, no immutable revision claim). Reused the existing SDK effort validation and transport mapping; no new dependency or public schema change. Earlier `/model effort`-only instructions are superseded.

Verification on this host: typecheck and lint pass; full opt-in suite **153 pass, 0 fail** (15 files); separate integration **40 pass** and end-to-end **71 pass**. A final focused command/context run after strengthening account-scoped effort commits reports **18 pass**. The actual Bun.Terminal test opens `/effort`, sends Left/Right input, checks the focused value, cancels without persisting it, and verifies context appears before the first message. Rendered fixture framebuffers were visually inspected for welcome/chat, model selection and effort selection. Authenticated vendor inference was not repeated.
