# ADR 0077 — Claude Code slash-command parity

Date: 2026-11-21. Status: accepted.

## Context

Cosmew's TUI had a central slash-command registry, but several names diverged from
Claude Code: `/review` was the canonical review command, aliases such as
`/checkup` and `/allowed-tools` were missing, and autocomplete did not match
separator-insensitively. That made the interface look like Claude Code while
behaving differently at the prompt.

## Decision

- `/code-review` is canonical and `/review` is its alias. The existing read-only
  review implementation remains the runtime for both forms.
- Add the documented Claude aliases (`/checkup`, `/allowed-tools`,
  `/checkpoint`, `/undo`, `/bg`, `/share`, `/rc`, `/tp`, and the other current
  aliases) to the shared SDK registry.
- Optional arguments follow Claude's command syntax for `/context`, `/config`,
  `/clear`, `/model`, `/effort`, and review commands. `/config` accepts multiple
  `key=value` pairs and reports unsupported keys explicitly.
- Autocomplete ignores `-`, `_`, and `:` when matching command names. Selecting
  a real match canonicalizes it; a typo remains literal and is reported as an
  unknown command.
- Commands whose runtime is not present are registered as hidden, parseable
  entries that return an explicit “not implemented” diagnostic. They do not
  appear in the public help or autocomplete menu, matching Claude Code's
  environment-dependent command menu.

The registry remains the single source for TUI autocomplete, help, CLI parsing,
and command routing. This changes the interactive SDK surface but does not alter
headless event envelopes or the contract version.

## Upstream evidence

Claude Code Commands, accessed 2026-11-21:
<https://code.claude.com/docs/en/commands>

The page documents command recognition at message start, argument handling,
separator-insensitive filtering, typo preservation, aliases, and hidden
environment-dependent commands. Exact availability continues to depend on the
provider and runtime; unsupported Cosmew entries remain explicit diagnostics.
