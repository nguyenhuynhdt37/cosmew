# Ctrl+O Transcript Mode Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution here:** each task is one Codex run (`codex exec -m gpt-6.1-sol -c model_reasoning_effort='"medium"' -s workspace-write`), run sequentially. The coordinator (Claude) writes the brief from the task, then runs `bun run typecheck`, `bun run lint` and the tests itself, and feeds failures back to Codex.

**Goal:** Make Cosmew's Ctrl+O transcript mode behave like Claude Code 2.1.330: same keys, footer variants, search, show-all toggle, help legend and status text.

**Architecture:** Ctrl+O already exists (`useDetailedTranscript`, `DetailedFooter`, `Transcript` with `detailed`, Transcript keymap context). This plan closes the measured gaps only. Pure logic (footer text, search index, show-all window) lives in new files under `apps/tui/src/ink/features/transcript/`; `integrated-shell.tsx` only wires keys and state. Everything stays inside the TUI: no SDK or contract change.

**Tech Stack:** Bun 1.4.4, TypeScript, React 19, Ink 8 (`ink-testing-library`), existing keymap (`apps/tui/src/ink/hooks/keymap/`), existing PTY and golden harnesses.

**Spec:** `docs/delivery/tui-v4/spec.md` (section 3, Ctrl+O), `docs/delivery/tui-v4/keys.md` section 5, reference frame `docs/delivery/tui-v4/reference/live-120x36/L08-ctrl-o.txt`. Task 1 produces `docs/delivery/tui-v4/transcript-mode-parity.md`, which becomes the authoritative spec for Tasks 2-8.

## Evidence: what Claude Code 2.1.330 does (read from the installed binary, 2026-11-21)

- Context `Transcript` default bindings: `ctrl+e` `transcript:toggleShowAll`; `ctrl+c`, `escape`, `q` `transcript:exit`; `ctrl+u`/`ctrl+d` half page; `ctrl+b`/`ctrl+f` full page; `ctrl+n`/`ctrl+p` and `j`/`k` and `up`/`down` line; `g`/`shift+g`, `home`/`end` top/bottom; `space` page down, `b` page up.
- Footer (rule above, dim, truncated): `[status ]Showing detailed transcript · <ctrl+o> to toggle · <variant>` with variant = `n/N to navigate` while a search is active, else `↑/↓ to scroll · v to open in <editor> · ? for shortcuts` when it fits (otherwise `? for shortcuts`), else `v to open in <editor>`, else `ctrl+e to show all` / `ctrl+e to collapse`. `status` is `dialog waiting` or `working`.
- Right side of the footer: the status text, else the search badge `N of M`, else `verbose`.
- Search: bar titled `Search transcript`; badge text `indexing…` while building, `indexed in <ms>ms` after, `no matches`, `N of M`; `n` / `N` (`shift+n`) cycle matches.
- Help legend (`?`): `move half a page`, `move a page`, `go to top/bottom`, `jump between prompts`, `cycle matches`, `print to scrollback`. `v` with no editor prints `no $VISUAL/$EDITOR set`.
- Cosmew already has: exit keys, `{`/`}`, `[`, `v`, `?` notice, PgUp/PgDn, Ctrl+Home/End, ↑/↓, footer with `verbose`. Missing: `ctrl+e` show all, search, the vim-style scroll keys, footer variants and status prefix, the legend text.
- Exact strings, the search key (`/`), search-bar layout and the show-all window size are **not** yet confirmed: Task 1 measures them.

## Global Constraints

- Keys are defined only in the central keymap (`defaults.ts`, 17 contexts, Claude action ids) so `~/.cosmew/keybindings.json` can remap them. Reserved keys (Ctrl+C/D/M/[/I/H) stay reserved.
- `apps/tui` talks to the SDK only. No contract, SDK, persistence or tool change. No new dependency.
- Layout stays the pinned fullscreen layout of ADR 0066; transcript scrolling keeps using the existing scroll controller (`scroll.pageUp/pageDown/toTop/toBottom/scrollBy/showRow`).
- Footer and notices fit the terminal width with no wrap; widths 24, 80, 100, 120 are tested.
- Capture of the real `claude` uses a PTY with every `CLAUDE*` environment variable stripped and makes **no model request**; redact email, org, paths and uuids before saving frames.
- Do not touch `apps/tui/src/input/mouse-input.ts` or `apps/tui/src/ink/hooks/use-terminal-wheel.tsx` (another session's in-progress files). Shared dirty tree: never stash, reset or revert hunks that are not yours.
- Run tests sequentially, never alongside another test run (parallel runs cause `EADDRINUSE`).
- Update docs in the same change; unverified behavior is written as "Needs verification".

## Review Focus

- Search for text with ANSI/OSC sequences or wide characters in tool output: matches must be on visible text, highlight must not corrupt the frame. Pinned in Task 6.
- A transcript with 5,000+ items: search indexing and show-all must stay responsive and never block input. Pinned in Tasks 5 and 6.
- Typing `j`, `k`, `g`, `q` or `n` while the search bar is open must edit the query, not scroll or exit. Pinned in Tasks 4 and 6.
- Ctrl+O pressed during a streaming turn or a permission dialog: the mode toggles, the footer shows `working` / `dialog waiting`, the turn is not interrupted. Pinned in Task 3.
- User remapped `transcript:*` keys in `keybindings.json`: footer hints and legend show the remapped keys. Pinned in Tasks 2, 3 and 7.

---

### Task 1: Capture the real behavior and write the parity spec

**Files:**
- Create: `docs/delivery/tui-v4/transcript-mode-parity.md`
- Create: `docs/delivery/tui-v4/reference/transcript-2.1.330/*.txt` (+ `.colors.json`)

**Interfaces:**
- Produces: the parity doc with (a) the full Transcript keymap table, (b) every footer variant with its exact text and truncation rule, (c) the search key, bar layout, badge states, (d) the show-all window rule (how many items by default, what `ctrl+e` reveals), (e) the `?` legend frame. Later tasks quote it.

- [ ] **Step 1: Re-extract strings from `~/.local/share/claude/versions/2.1.330`** (Python `re` over the binary; `strings | rg` is too slow/noisy) for: the `Transcript` bindings, the footer composer, the search bar and badge, the help legend, the constant that limits the default window, the key that opens search.
- [ ] **Step 2: Capture frames in a PTY (pyte, `CLAUDE*` env stripped, fresh empty session, no prompt sent):** Ctrl+O; `?` inside; search open with empty and non-empty query, no-match; `ctrl+e`; at widths 100 and 40. Save under `reference/transcript-2.1.330/`; redact personal data.
- [ ] **Step 3: Write `transcript-mode-parity.md`** with the five items above, each with the evidence file or binary string it came from, and `Needs verification` for anything not observed (including show-all behavior with long histories, which an empty session cannot show).
- [ ] **Step 4: Verify:** `git diff --check` and no personal data (`rg -n -i "huynh|@gmail|/Users/"` over the new files returns nothing).

### Task 2: Keymap actions, defaults and legend source

**Files:**
- Modify: `apps/tui/src/ink/hooks/keymap/defaults.ts`, `apps/tui/src/ink/hooks/keymap/help.ts`
- Test: `apps/tui/src/ink/testing/keys.test.tsx`

**Interfaces:**
- Consumes: the key table from Task 1.
- Produces: Transcript-context actions `transcript:toggleShowAll` (`ctrl+e`), `transcript:search` (key from Task 1), `transcript:nextMatch` (`n`), `transcript:previousMatch` (`N`/`shift+n`), plus scroll bindings in the `Scroll`/`Transcript` contexts: `scroll:halfPageUp` (`ctrl+u`), `scroll:halfPageDown` (`ctrl+d`), `scroll:fullPageUp` (`ctrl+b`, `b`), `scroll:fullPageDown` (`ctrl+f`, `space`), `scroll:lineUp` (`k`, `ctrl+p`), `scroll:lineDown` (`j`, `ctrl+n`), `scroll:top` (`g`), `scroll:bottom` (`shift+g`).

- [ ] **Step 1: Write failing tests** in `keys.test.tsx`: the defaults table equals the Task 1 table; a `keybindings.json` overlay remapping `transcript:toggleShowAll` to `ctrl+k` is honored; Ctrl+C/D stay reserved (a rebind attempt is rejected); `keyLabels(keymap,'Transcript','transcript:toggleShowAll')` returns `['ctrl+e']`.
- [ ] **Step 2: Run** `bun test apps/tui/src/ink/testing/keys.test.tsx` and confirm the failures name the missing actions.
- [ ] **Step 3: Add the bindings** with `b('Transcript', ...)` rows in `defaults.ts`; add each action id to the known-action lists in `help.ts`.
- [ ] **Step 4: Run the same test file** and `bun run typecheck`; expect PASS.

### Task 3: Footer composer and status text

**Files:**
- Create: `apps/tui/src/ink/features/transcript/detailed-footer.tsx` (moved from `DetailedFooter` in `integrated-shell.tsx`), `apps/tui/src/ink/features/transcript/footer-logic.ts`
- Modify: `apps/tui/src/ink/integrated-shell.tsx` (import and pass props only)
- Test: `apps/tui/src/ink/features/transcript/footer-logic.test.ts`, `apps/tui/src/ink/testing/fullscreen.test.tsx`

**Interfaces:**
- Produces: `composeDetailedFooter(input: {width: number; toggleKey: string; showAllKey?: string; editorKey?: string; helpKey?: string; editorName?: string; showingAll: boolean; searchActive: boolean; status?: 'dialog waiting' | 'working'; badge?: string}): {left: string; right: string}` and `<DetailedFooter {...input} />`.
- Consumes: key labels from the keymap (`keyLabels`).

- [ ] **Step 1: Write failing tests** in `footer-logic.test.ts` using the strings from Task 1: widths 120 → `Showing detailed transcript · ctrl+o to toggle · ↑/↓ to scroll · v to open in code · ? for shortcuts` + right `verbose`; width 60 → `… · ? for shortcuts` fallback; `searchActive` → `… · n/N to navigate`; `status:'working'` → left starts with `working` followed by the separator recorded in Task 1; `badge:'2 of 7'` replaces `verbose`; remapped toggle key shows the remapped label; output never exceeds `width` cells (property test over widths 24-200).
- [ ] **Step 2: Run** `bun test apps/tui/src/ink/features/transcript/footer-logic.test.ts` and confirm it fails (module missing).
- [ ] **Step 3: Implement `composeDetailedFooter`** (pure, uses `stringCells`) and the Ink component; delete the old inline `DetailedFooter` and update its import in `integrated-shell.tsx`.
- [ ] **Step 4: Wire `status`** from existing shell state: `dialog waiting` when a permission/question overlay is pending, `working` while a turn runs; add a `fullscreen.test.tsx` case: Ctrl+O during a streaming turn toggles the mode, shows `working`, and the turn is not interrupted.
- [ ] **Step 5: Run** both test files and `bun run typecheck`; expect PASS. Re-record affected golden frames only after reviewing the diff (`UPDATE_GOLDEN=1`).

### Task 4: Transcript scroll keys

**Files:**
- Modify: `apps/tui/src/ink/integrated-shell.tsx` (the `Scroll` and `Transcript` handlers near `'scroll:lineUp'`), `apps/tui/src/ink/hooks/use-keymap.ts` if the handler map needs the new ids
- Test: `apps/tui/src/ink/testing/fullscreen.test.tsx`

**Interfaces:**
- Consumes: Task 2 actions; scroll controller `{pageUp, pageDown, halfPageUp?, halfPageDown?, toTop, toBottom, scrollBy}`. If `halfPageUp/halfPageDown` do not exist on the controller, add them there (half of the viewport rows, at least 1).

- [ ] **Step 1: Write failing tests** in `fullscreen.test.tsx`: in detailed mode `j`/`k` move one line, `ctrl+d`/`ctrl+u` half a viewport, `ctrl+f`/`space` and `ctrl+b`/`b` a page, `g`/`G` top/bottom, `home`/`end` too; outside detailed mode `j`, `k`, `g`, `space` type into the prompt unchanged; with the Task 6 search bar open the same keys reach the query (add this assertion in Task 6).
- [ ] **Step 2: Run** `bun test apps/tui/src/ink/testing/fullscreen.test.tsx -t "detailed transcript"` and confirm failures.
- [ ] **Step 3: Bind the handlers** only when `viewing && !searchOpen`; keep existing PgUp/PgDn and wheel behavior.
- [ ] **Step 4: Run** the file and `bun run typecheck`; expect PASS.

### Task 5: Show all (`ctrl+e`) window

**Files:**
- Create: `apps/tui/src/ink/features/transcript/show-all.ts`
- Modify: `apps/tui/src/ink/features/transcript/index.tsx`, `apps/tui/src/ink/integrated-shell.tsx`
- Test: `apps/tui/src/ink/features/transcript/show-all.test.ts`, `transcript.test.tsx`

**Interfaces:**
- Produces: `visibleWindow<T>(items: readonly T[], showAll: boolean, limit?: number): {items: readonly T[]; hidden: number}` using the default limit measured in Task 1 (exported as `DETAILED_RECENT_LIMIT`); `Transcript` gets prop `showAll?: boolean`; shell state `showAll` resets to `false` each time Ctrl+O enters the mode.

- [ ] **Step 1: Write failing tests:** `visibleWindow` with fewer items than the limit hides nothing and the footer shows no show-all hint; with more, the oldest are hidden, `hidden` is correct, a `Showing last N of M · ctrl+e to show all` line (exact text from Task 1) appears at the top; `ctrl+e` reveals all and the hint becomes `ctrl+e to collapse`; 5,000 items render window in under 200 ms in the test (guards the Review Focus item).
- [ ] **Step 2: Run** the two test files and confirm failures.
- [ ] **Step 3: Implement `visibleWindow` and the prop;** wire `transcript:toggleShowAll` (only while `viewing`); pass `showingAll` to the footer from Task 3.
- [ ] **Step 4: Run** the tests and `bun run typecheck`; expect PASS. If Task 1 could not confirm the real window rule, keep the documented best guess and mark it `Needs verification` in the parity doc.

### Task 6: Transcript search

**Files:**
- Create: `apps/tui/src/ink/features/transcript/search.ts`, `apps/tui/src/ink/features/transcript/search-bar.tsx`
- Modify: `apps/tui/src/ink/features/transcript/index.tsx` (highlight), `apps/tui/src/ink/integrated-shell.tsx` (state and key routing)
- Test: `apps/tui/src/ink/features/transcript/search.test.ts`, `apps/tui/src/ink/testing/fullscreen.test.tsx`

**Interfaces:**
- Produces: `buildSearchIndex(items: TranscriptItem[]): SearchIndex` (visible plain text per item, ANSI/OSC stripped via the existing sanitizer); `findMatches(index: SearchIndex, query: string): {itemIndex: number; start: number; end: number}[]` (case-insensitive substring, empty query → `[]`); `searchStatus(state: {building: boolean; ms?: number; query: string; count: number; current: number}): string | null` returning exactly `indexing…`, `indexed in <ms>ms`, `no matches`, `<current> of <count>`; `<SearchBar query onChange onClose />`.
- Consumes: Task 2 actions, Task 3 `badge` prop, scroll `showRow`.

- [ ] **Step 1: Write failing tests:** `findMatches` on text containing ANSI colors, an OSC 8 link and a double-width character returns offsets on the visible text; `searchStatus` returns the four strings above; the bar opens with the search key, typing `jkgqn` edits the query (does not scroll or exit); `Enter`/`n` go to the next match and scroll it into view (`showRow`), `N` goes back and wraps; `Esc` closes the bar first and a second `Esc` leaves the mode; footer shows `n/N to navigate` and the `N of M` badge while a query has matches.
- [ ] **Step 2: Run** the two files and confirm failures.
- [ ] **Step 3: Implement** index (built once per transcript revision, lazily on first open, chunked with `setImmediate` yields so input stays live), matching, highlight of the current match using theme colors, and key routing so no `transcript:*`/`scroll:*` binding fires while the bar is open.
- [ ] **Step 4: Run** the tests and `bun run typecheck`; expect PASS. Add the 5,000-item responsiveness test (query typing never waits on indexing more than one frame).

### Task 7: Help legend, `v` messages and docs

**Files:**
- Modify: `apps/tui/src/ink/integrated-shell.tsx` (`quickKeys`, `openTranscriptInEditor`), `apps/tui/src/ink/hooks/keymap/help.ts`
- Modify docs: `docs/delivery/tui-v4/keys.md` (section 5), `docs/delivery/tui-v4/keys-status.md`, `docs/delivery/tui-v4/g3-status.md`
- Test: `apps/tui/src/ink/testing/keys.test.tsx`

**Interfaces:**
- Produces: legend lines `move half a page`, `move a page`, `go to top/bottom`, `jump between prompts`, `cycle matches`, `print to scrollback` (exact layout from Task 1) built from the live keymap; `v` with no `$VISUAL`/`$EDITOR` prints `no $VISUAL/$EDITOR set`.

- [ ] **Step 1: Write failing tests:** `?` in detailed mode shows the legend with default keys; after remapping `transcript:dumpScrollback` the legend shows the new key; `v` with both env vars unset shows the message and does not suspend the terminal.
- [ ] **Step 2: Run** `bun test apps/tui/src/ink/testing/keys.test.tsx` and confirm failures.
- [ ] **Step 3: Implement** the legend and the message; update the three docs (status table rows for Ctrl+O, `ctrl+e`, search, scroll keys).
- [ ] **Step 4: Run** the file, `bun run typecheck`; expect PASS.

### Task 8: Verification against the reference

**Files:**
- Test: `tests/end-to-end/tui-ink-pty.test.ts` (new PTY case), `apps/tui/src/ink/features/transcript/reference-frames.test.tsx` (new frame cases)
- Modify: `docs/delivery/tui-v4/transcript-mode-parity.md` (result table)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add frame tests** comparing Cosmew's footer and legend at widths 100 and 40 with `reference/transcript-2.1.330/*` after normalizing the product name and editor name.
- [ ] **Step 2: Add a PTY case:** start `fyn`, Ctrl+O, `/` + query + `n`, `ctrl+e`, `?`, `q`; assert the screen at each step and that the process stays alive.
- [ ] **Step 3: Coordinator runs** `bun run typecheck`, `bun run lint`, `bun test tests`, `bun test apps/tui`, one at a time, and records pass/skip/fail counts in the parity doc with a per-row `matches / differs / Needs verification` table.
- [ ] **Step 4: Manual check by the user** in their real terminal: Ctrl+O, search, `ctrl+e`, `?`, `[`, `v`, then Ctrl+O back to the prompt.

No automatic commit: the repository holds unrelated user changes; each task is reviewed from a scoped diff.
