# Vim prompt editing in Claude Code 2.1.330

Inspected 2026-11-22 from the installed binary at `~/.local/share/claude/versions/2.1.330`.
SHA-256 `f7c5093b9dd6560d08af28bc27b123fb55091deae3180ac39df199522da86815`.
Python `re.finditer` searched a read-only memory mapping of the bytes, then bounded reads
examined the surrounding bundled JavaScript. Offsets below are hexadecimal file offsets.
The upstream documentation entry is [Interactive mode](https://code.claude.com/docs/en/interactive-mode#vim-editor-mode).

| Binary anchor | Evidence |
| --- | --- |
| `0x12eb822c` | `label:"Editor mode"`, `options:["normal","vim"]`, legacy `emacs` shown as `normal`, writes `editorMode`. |
| `0x12a4a661`, `0x12a4a730` | Motion table, `d/c/y` operator table, `i/a` scopes and text-object delimiters. Count parser caps a typed count at 10,000. |
| `0x12a4e000–0x12a51000` | Normal and Visual command switches. Operator/motion counts multiply, yank stores text plus a linewise flag, and `u` calls the undo callback. |
| `0x12a5155a–0x12a53780` | INSERT/NORMAL/VISUAL transitions, last-change descriptors including inserted text, character/line selection, Escape, Enter, `?` help, `/` history and edge `j/k` history navigation. |
| `0x1140ab8f`, `0x139b3a3a` | `hideVimModeIndicator` schema names `-- INSERT --` and `-- VISUAL --`. Footer builds `-- ${mode} --`, suppresses NORMAL and history search, and uses dim text. VISUAL LINE uses the same template. |
| `0x139b6324`, `0x139b6c36` | The footer uses the dim hint `? for shortcuts` in its eligible branches. |
| `0x11f15706` | Separate status-line payload exposes `vim.mode`. |

## Cosmew bindings

| Keys | Behavior |
| --- | --- |
| Esc, Enter, `?`, `/` | Esc leaves Insert/Visual or clears a Normal prefix. Enter uses the existing submit path in Insert/Normal and moves down in Visual. Normal `?` shows remapped shortcuts and `/` opens prompt history. |
| `h j k l`, arrows, Space, Backspace | Grapheme movement and cell-column vertical movement. Idle Normal `j/k` can navigate history at the corresponding logical edge. |
| `w b e W B E 0 ^ $`, `gg G gj gk %` | Word, whitespace-delimited word, line, wrapped row and bracket motions. |
| `f F t T ; ,` | Find/till a character, repeat in the same or opposite direction. |
| `d c y`, `dd cc yy`, counts | Delete/change/yank by motion, object or whole line. Counts may precede the operator, motion or both. |
| `iw aw iW aW`, `i/a` with `` " ' ` ( ) b [ ] { } B < > `` | Word and delimiter text objects. Closing delimiters and the bracket aliases are accepted. |
| `x X D C Y s S P p` | Character and line editing, substitute and local unnamed register paste. |
| `u Ctrl+R .` | Undo from composer history, redo, repeat the last change. Ctrl+R searches history in Insert or when Normal has no redo. |
| `i a I A o O r J ~ >> <<` | Insert, append, open line, replace, join, toggle case and indent/outdent. |
| `v V`, motions, `d c y` | Characterwise and linewise Visual, inclusive selection and operators. Visual also supports `x X D C Y s S R r u U ~ p P o J < >`. |

The `Vim` context binds individual command tokens, so remaps also work in
operator sequences. Compose counts, doubled operators and text objects from the
effective bindings. Escape is reserved in the Vim context so the modal escape
path stays available. The global terminal-reserved combinations still apply.
Find and replace read a literal grapheme as their argument. `/keybindings`
documents the defaults and `?` shows the active shortcut labels.

## Needs verification

- Static evidence shows `X` in Visual and includes `u` in Normal. The Normal
  dispatch forwards Ctrl/Meta to the base handler. Normal `X` and the Ctrl+R
  redo/history fallback are the requested Cosmew behavior.
- Live Claude Code behavior for count replacement on dot repeat, delimiter
  edge cases, indentation width, history boundaries and coalesced input needs
  verification. Cosmew uses its own grapheme-safe buffer and two-space indent.
- The binary contains a separate `vimInsertModeRemaps` mechanism and a
  `hideVimModeIndicator` status-line option. Cosmew uses its centralized
  keybindings and built-in footer. Native terminal IME, clipboard and
  fullscreen rendering still need live verification.
