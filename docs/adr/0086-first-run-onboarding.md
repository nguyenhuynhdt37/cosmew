# ADR 0086 — Resumable first-run onboarding

Accepted 2026-11-21. Amends ADR 0014 and ADR 0075.

Cosmew's first interactive launch asks the user to select a theme, offers the shared Connect flow with
`Skip for now`, and shows security notes. Enter acknowledges the notes. The existing folder consent
dialog follows for an untrusted workspace. The user can open the TUI without an account. Help, non-TTY
output and `fyn exec` omit onboarding.

The user settings file records each completed step in `onboardingCompleted` (`theme`, `auth`, `security`)
through the existing atomic file writer. A restarted run uses the first outstanding step. Existing
users with an account and a saved theme begin at the security notes. An account already present
satisfies the authentication step. Unreadable or read-only settings allow session-only progress. A
corrupt file starts with defaults and retains its original contents in the existing backup on a
successful write. Folder consent continues to be persisted separately by workspace.

Evidence inspected 2026-11-21 from the installed Claude Code `~/.local/share/claude/versions/2.1.330`
using Python byte regexes. Byte offsets 337653811–337654520 show conditional `preflight`, unconditional
`theme`, conditional `api-key` and `oauth` (including `allowContinueWithoutLogin`), unconditional
`security`, and conditional `terminal-setup`. Offsets 337613408 and 337652728–337653430 show
“Let's get started.”, “To change this later, run /theme”, “Security notes:”, “Claude can make mistakes.”,
and “Due to prompt injection risks, only use it with code you trust”. Cosmew adapts the safety wording
and uses its Connect feature instead of Claude's provider-specific steps. `/terminal-setup` still
reports “Not implemented”. Upstream offers Esc to “continue without logging in” (offset 330434288).
Cosmew uses an explicit “Skip for now” row as requested.

## Verification on first send

The interactive startup gate does not run a model probe or start advisory model metadata
refresh. The first submitted prompt verifies the selected account and model with the existing
small generation probe, which may be billable. With no account there is no provider request.
The TUI keeps the draft and attachments until verification succeeds. Failures use a bounded
reason (missing account, rejected credentials, network, model or billing) and give the user the
account picker or Connect flow. For billing, the TUI names the affected account, explains that it
needs credits or a subscription, and displays a redacted provider hint when available. The SDK
caches successful and failed checks on its client by account ID,
credential generation and model. A cancelled check can be retried. Changes to the active account
or model during a probe prevent the draft from going out under the changed selection.

`fyn exec` still requires explicit folder consent and a usable selection. It verifies before
starting the turn and returns a structured failure on error. Provider billing is non-retryable.
Headless verification emits `PROVIDER_BILLING` in the existing failure format and exits with
status 3. `fyn model doctor --generate` reports the same billing code and optional safe hint.
