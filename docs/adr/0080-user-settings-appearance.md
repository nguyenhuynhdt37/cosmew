# ADR 0080: User settings appearance and one-time SQLite import

Date: 2026-11-21. Status: accepted, implemented for Tasks 1–2 only.
Amends the appearance persistence of ADR 0006/0012. Contract remains 1.40;
SQLite schema remains 10. No dependencies added. Sandbox defaults and startup
onboarding/account verification are unchanged by this ADR.

## Decision

The CLI injects an optional SDK `AppearanceStore` with synchronous `read()` and
`write(patch)` plus optional notices. The CLI-owned `FileAppearanceStore` reads
only the user state directory's `settings.json` (normally `~/.cosmew/settings.json`;
existing state-directory overrides/legacy root selection still apply). The TUI
uses the SDK only. Other SDK hosts without the port retain their existing backing
store behavior.

User JSON keys are `theme`, `themeMode` (`system|dark|light`), `reducedMotion`,
`syntaxHighlighting`, plus the existing `animations`, `sidebar`, and `wallpaper`
appearance fields to round-trip the complete configuration. `reducedMotion`
overrides the nested animation value on read. Invalid fields fall back individually.
The permission parser returns the original raw object alongside its normalized
permission/sandbox view, preserving unknown top-level keys. Appearance writes
merge into that raw object; they never serialize the normalized permission view.

On first load of a valid JSON object with no appearance keys (including a missing
file), read the legacy SQLite global appearance via `importLegacyAppearance` and
write a complete JSON appearance. Defaults are written when no legacy selection
exists. Any appearance key in JSON prevents re-import, including invalid values.
SQLite data stays in place, untouched by this import or subsequent appearance
edits. If writing fails, the import lives in memory and can be retried on the next
launch; a durable one-time marker cannot be saved to a read-only file.

**Workspace override ruling:** with the injected store, explicit SDK `project`
edits override the user preference for this client/session only. No project JSON
appearance is read, even from a trusted repository file. Legacy SQLite project
appearance rows are left in place but ignored. Restart uses user appearance. This
keeps override precedence while removing SQLite/project-controlled appearance
persistence. The config scope hint labels project scope as session-only.

## TUI preferences (2026-11-22)

The same user-only JSON store handles the optional SDK `UserPreferencesStore`.
`autoCompact` (true), `verbose` (false), and `showTurnDuration` (true) are
top-level booleans. Missing or invalid values use the defaults. Enter on the
corresponding Config row applies the change live. Failed writes keep the
requested preferences for the current client and use the existing notice path.
SDK embeddings without the port keep their preferences in memory. Repository
settings and the appearance scope toggle do not control these preferences.

Auto-compact off skips the model and excerpt checkpoints at the automatic
pressure threshold. Manual compaction and context size limits still apply.
Verbose starts in the detailed transcript view with expanded tool rows.
Ctrl+O remains a session view toggle. Show turn duration controls the completed
turn timing line. Reduce motion retains the existing appearance key.

## File behavior

Reads cache mtime/ctime, size, inode and mode; external permission-setting writes
invalidate that cache. Only bounded (64 KiB), regular, user-owned files are read;
links and unreadable/unsafe paths are not replaced. Missing files use defaults.
Writes use a unique exclusive 0600 temporary file in the same directory then
rename; failed temporaries are cleaned up. Permissions, sandbox and unknown keys
are semantically preserved. Read-only files are checked before rename, since
rename can otherwise replace them through a writable directory. Errors return
notices, retain the in-memory appearance and do not crash the UI. `/config` prints
the notice; the picker keeps it visible instead of closing after a failed save.

Malformed JSON returns appearance defaults without modifying the file. On an
explicit write, recover only complete, independently parsable top-level members
(including permission/sandbox/unknown members), save the exact original bytes as
`settings.json.bak` before replacing the file, then rebuild. Damaged or incomplete
members cannot be reconstructed and remain available in the backup. An existing
different backup is never overwritten: saving stays session-only until resolved.
No recovery path evaluates file contents or approves repository settings.

## Theme selection

`/config` displays `Theme`; Enter opens the existing picker, Esc returns to Config.
The picker and `/config theme=<id>` share `themeSelection`, setting theme and mode
together. Unknown command values report `Unknown theme` without mutation.
`auto` selects system mode; dark/light palettes pin the corresponding mode, so a
fresh ThemeEngine does not silently rewrite the selection.

The picker includes `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`.
Daltonized palettes use blue/orange diff and success/error hues for red-green
color blindness. ANSI palettes quantize existing semantic tokens to the standard
16-color RGB reference palette; they use the existing terminal color renderer.
No assets or upstream color tables were copied.

## Evidence and limits

Local source references: `apps/tui/src/theme/theme.ts`, `presets.ts`,
`apps/cli/src/bootstrap/permission-settings.ts`, `packages/security/src/settings.ts`;
reviewed 2026-11-21. User-provided upstream target: Claude Code 2.1.330, audit and
Decisions/Global Constraints in
`docs/superpowers/plans/2026-11-21-config-onboarding-sandbox-parity.md` (2026-11-21).
**Needs verification:** exact Claude daltonized colors, ANSI output and visual
matching in terminals; these palettes implement intent, not measured parity.
No live upstream binary/color measurements were performed in these tasks.

Hermetic tests cover command normalization/restart, nested picker return, user
JSON round-trip/key preservation, cache invalidation, actual SQLite read-only
import, corruption/backup, unsafe/read-only paths and session workspace overrides.
Tests supply empty temporary home/state directories; they never read real user
settings. Full-suite and port-binding e2e runs belong to the coordinator: this
execution sandbox cannot bind ports, so this work makes no e2e compatibility claim.
