# Auth/account/model lifecycle regression scenarios

Scope: PA1/TUI1/SUB1. User-reported 2026-11-15: model missing after logout/fallback, Esc ineffective during redirected re-login, unexpected conversation content. No live credentials or production profile modified during this audit.

| Scenario | Expected invariant | Executable coverage |
| --- | --- | --- |
| Logout active A, usable B remains | Discover B, select saved advertised model, ready for fresh chat | usage-context: available fallback |
| B saved model retired | Select an actual discovered model | usage-context: retired-model fallback |
| B discovery rejects auth | Stay signed out; show reconnect flow, no selected stale model | usage-context: rejected fallback |
| Esc while B discovery pending | Remain signed out; late completion cannot select B | usage-context: cancelled fallback |
| Logout inactive B | Preserve A model and session | usage-context: inactive logout |
| Logout last account | No model/account selected; explicit login required | provider-connect: named logout; PTY lifecycle |
| Switch to signed-out profile | Reauthenticate same profile before continuing | usage-context: signed-out recovery |
| Esc / Ctrl+C during switch-triggered login | Abort authentication, close overlay, no credential/profile revival | subscriptions: each of Codex, Copilot, Gemini CLI, Qwen Code with a slow real subprocess fixture |
| Esc after subscription redirect in a real terminal | Return to startup account chooser, stop auth subprocess and restore terminal on exit | subscriptions: actual PTY slow-auth Esc |
| Cancel reconnect of current account | Clear unusable active session/selection, retain durable source messages | usage-context: current-account reconnect cancellation |
| Esc during ordinary login validation | Close overlay; cleanup cannot reopen it or create a usable profile | provider-connect: cancelled no-auth login |
| OpenRouter redirect | Start in background so key handling remains responsive; wait for challenge before pasting code | provider-connect: OAuth HTTP/key-vault fixture |
| Discovery completes after picker closed or selection changed | Ignore obsolete UI result; do not override newer selection | usage-context: dismissed discovery, late switch |
| First Codex login | Runnable model slug selected, hidden models omitted; missing limit stays unknown | subscriptions: catalog-slug |
| New-account chat after logout | Source history remains stored under old account; never included in new request | usage-context: fallback request body assertions |

Root cause of blocked Esc: recovery kept `pendingAction: switch`, so its busy authentication screen took the switch-cancellation branch even though only `authAbort` was running. Branch on the actual running switch controller instead. Ordinary busy authentication now closes on Esc; completion is fenced by abort and overlay ownership. OpenRouter begin-auth now also runs in the owned cancellable background task.

No repository source contains the reported sentence about an uncommitted `/diff` fix. Its origin cannot be established from this inspection; it is not treated as a proven provider error. Regression requests verify old conversation messages do not cross the logout/new-chat boundary. Concurrent unrelated security/tool implementation changes are outside this fix and are not committed here.

Fixtures and PTY evidence are distinct from live vendor authentication. Live browser redirect/entitlement acceptance remains Needs verification.

Verification on the final working tree: `bun run lint` (typecheck and whitespace checks) passes; `bun test tests`: **221 pass, 5 skip, 0 fail**, 226 tests across 22 files. The suite includes unrelated concurrent read-tool/security work; the account regressions are the scenarios listed above. Five opt-in native keyring/installed-runtime checks remain skipped. The new real PTY slow-auth Esc test passes; no live vendor account sign-in was performed.
