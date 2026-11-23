# Composer — Pha 1

Phạm vi implementation: `composer`, `autocomplete`, `history`, `paste`. Không
thay SDK, dispatch/policy, composition root, keymap, dependency hay renderer cũ.

Ô nhập hiển thị phím đang gán. Khi có gợi ý, **Tab** chèn mục đang chọn vào bản nháp,
**↑/↓** đổi mục và **Esc** đóng danh sách. Khi gõ bình thường, dòng gợi ý hiển thị
phím gửi, xuống dòng và đổi chế độ quyền. Gợi ý đổi theo `/keybindings`.

## Nối vào Pha 2

- `Composer(props)` là component tự giữ state. Props bắt buộc `onSubmit(content)`;
  tuỳ chọn `onCommand`, `onRemember`, `busy`, `workspaceAccess`, `isActive`,
  `initialValue`, `initialHistory`, `width`, `maxRows`, `placeholder`,
  `onShellResult`, `onShellOutput`, `onNotice`, `onEmptyHomeEnd`.
- Khi cần điều phối Esc, dùng `useComposer(options)` +
  `ComposerView({controller, width?, maxRows?, placeholder?, isActive?})`.
  Hook trả `draft`, `content` đã mở paste, `setDraft`, `history`, `search`,
  `items`, `selected`, `notice`, `busy`, `submit`, `paste`, `interrupt`.
- Host kiểm consent/auth trước khi cho phép input, đặt `busy` đúng vòng đời turn,
  đăng ký consumers trước khi gọi SDK. `onSubmit` bắt đầu iterator
  `client.sendMessage` ở host và trả ngay khi chấp nhận; `false` giữ draft.
  Callback không nên await toàn bộ generation. Error giữ draft và chỉ báo mã
  lỗi, không đưa exception/provider output thô lên UI.
- `onCommand` nối command router hiện có (canonical registry SDK, bao gồm mọi
  slash/alias, arguments và unsupported diagnostic). Skill slash dùng `onSubmit`
  để SDK tự mediated invocation. Host tiếp tục sở hữu shortcut commands,
  Shift+Tab permissions, Ctrl+O transcript, Ctrl+C/exit và scroll Home/End.
  `onEmptyHomeEnd` cho phép chuyển Home/End ở draft rỗng sang transcript.
- Shell là chủ sở hữu Esc theo contract 0.1: `InkApp.onInterrupt` gọi
  `controller.interrupt()` trước; nếu trả `false` và host đang chạy generation,
  abort controller của host. Composer tự abort shell do nó tạo khi interrupt
  hoặc unmount. Không đăng ký Esc thêm trong composer.
- `!command` gọi đúng `client.runShellCommand` với AbortSignal, không launch
  process. Nối `onShellOutput`/`onShellResult` vào transcript Bash card. Shell
  result denied/error được báo đúng và giữ draft; result ok được đưa vào history.
  `sessionId` báo process còn chạy, host phải hiển thị và thu bằng luồng hiện có.
- `workspaceAccess` chỉ bật sau consent: SDK `listWorkspaceFiles(query)` hiện
  không tự kiểm toolsEnabled. Không gọi khi render; danh sách memo theo query.
  Overlay giữ mounted state và tắt cả phím/paste theo `InputScope`.
- `Autocomplete({items, selected?, visibleRows?, width?})`, `useAutocomplete`,
  `completionContext`, `getCompletions` export từ `autocomplete/index.tsx`.
  `/` dùng `SLASH_COMMANDS` (kể cả aliases, unavailable/shortcut metadata) +
  skills SDK; `@` dùng public file-list API; `$` chỉ dùng catalog skills.
- `History({query, match?, width?})`, `useHistory`, `recordHistory`,
  `searchHistory` export từ `history/index.tsx`.
- `Paste({id, content, width?})` và range helpers (`createPasteState`, `insertPaste`,
  `replaceRange`, `expandPastes`) export từ `paste/index.tsx`. Paste >=5 dòng hoặc >=1000 ký tự thu thành marker, vẫn gửi
  đủ nội dung đã lọc terminal controls. Marker do user tự gõ luôn giữ literal.
  Phím di chuyển/xoá coi mỗi paste thu gọn là một đơn vị, không thể gửi mảnh marker.

## Hành vi và các giới hạn API

Viền bo, placeholder, caret, selection Shift+←/→, xoá/thay selection,
Backspace/Delete, grapheme Unicode, Home/End/Ctrl+A/E, Ctrl+K/U/W, Alt+←/→,
Shift+Enter, `\`+Enter, Alt+Enter/Ctrl+J. ↑/↓ đi theo hàng hiển thị rồi tới
history ở biên; draft trước history được khôi phục nguyên paste metadata.
Ctrl+R tìm ngược và lặp để tìm cũ hơn, Enter phục hồi không tự gửi,
Ctrl+G hoặc host Esc huỷ. Menu cuộn theo selection; Tab nhận, Enter file/skill
mention nhận vào draft; Enter slash giữ hành vi canonical cũ. Hints dùng KEYMAP.
Màu lấy theme capability; text từ metadata/history/paste lọc terminal controls.
Wrap theo cell/CJK/grapheme, giữ tối đa 6 hàng quanh caret; resize reflow,
width <6 dùng plain truncated view. Draft/layout/completions memo theo input,
không quét file mỗi token stream.

- SDK không có kho command history riêng. Hook seed từ user messages của
  `activeSession()` (bao gồm durable recovered session), giữ tối đa 100 bản ghi
  không trùng trong mount. Host có thể truyền `initialHistory`. Chưa có lịch sử
  shell/slash bền qua restart; cần SDK/persistence API riêng nếu muốn đủ parity.
- SDK chỉ có memory read/delete, chưa có public mediated write. `#note` giữ draft
  và báo `Not implemented` nếu thiếu `onRemember`; không giả thành một prompt đã
  ghi nhớ, không ghi filesystem trực tiếp. Đề xuất SDK expose `writeMemory` qua
  cùng dispatcher/mutation policy, rồi host nối callback với input metadata rõ.
- Ink 8 có `usePaste` tách bracketed paste khỏi `useInput`. Feature dùng native
  hook này + `useInputEnabled` của pha 0, không gắn listener stdin riêng. Đề xuất
  pha 0 bọc thành `useTextPaste` nếu muốn mọi input API tập trung trong hooks.
- `submitWhileBusy` dùng SDK thật, draft chỉ xoá khi steered/queued được chấp nhận;
  reject/journal failure giữ nguyên. Host phải drain `takeQueuedMessage()` khi
  generation kết thúc và giữ nguyên lifecycle session/cancellation hiện có.
- Fixture test không chứng minh live provider/OS sandbox. Terminal thật,
  startup gate, tổng thể transcript, raw-mode teardown cần nghiệm thu Pha 2.

## Kiểm thử

`bun test apps/tui/src/ink/features/composer apps/tui/src/ink/features/autocomplete apps/tui/src/ink/features/history apps/tui/src/ink/features/paste`

Dùng helper `ink/testing` + ink-testing-library, SDK thật trên ports fixture;
không có network/process thật. Các ca giữ draft khi thất bại, consent, SDK
steer/queue, AbortSignal shell/unmount, Unicode edits, selection, resize,
paste literal/control-safety, overlay input scope, commands/skills/files/history.
Nguồn API Ink kiểm tại bản cài 8.0.0 `build/hooks/use-{input,paste}.d.ts/.js`,
`build/components/App.js`, ngày 2026-11-18. Context7 lookup cùng ngày thất bại
`fetch failed`; không dựa rolling docs để suy đoán API.

Kết quả Pha 1 (2026-11-18): 33 tests / 112 assertions pass trong 5 file;
`bun run typecheck` pass; Prettier check cho bốn vùng pass. `bun run lint`
bị chặn tại `features/picker/dialogs.test.tsx:22` (TS6133: biến `model`
không dùng, ngoài vùng sở hữu); không sửa file đó. Không chạy toàn suite,
không commit/push.

## Pha 2 integration (2026-11-18)

Các mục nối host ở trên được triển khai trong `ink/integrated-shell.tsx` và runtime,
router `ink/features/commands.ts`; API nền version 0.2 trong
[contracts](../../../../../../docs/delivery/tui-v3/contracts.md).
Evidence từng luồng và giới hạn tại
[parity](../../../../../../docs/delivery/tui-v3/parity.md),
`ink/testing/integration.test.tsx`, `tests/end-to-end/tui-ink-pty.test.ts` và
`tests/contracts/sdk-memory-write.test.ts`. Default/golden legacy không đổi.

## TUI v4 phase C (2026-11-19)

Rows 5–10 use full-width shared `Rule`s and the `❯` prompt. Tab and Right accept
the static startup example into the editable draft. It requires no model call.
Advertised SDK effort renders above the top rule on the right. Shift+↑/↓ calls
`setReasoningEffort` when available.
Autocomplete shows command and alias prefixes, nearby typos, skills, file
mentions and emoji. Typos and inline slash matches start without a selection.
Tab inserts a match. Enter runs a selected leading command, inserts a selected
inline match or sends the unchanged draft if nothing is selected. Arrows select
a match. Esc closes the menu and keeps the draft. Hints use the current keymap.

Behavior checked against the Claude Code command and interactive mode references
on 2026-11-22. Installed Claude Code version 2.1.330. Live visual parity needs
verification. [Commands](https://code.claude.com/docs/en/commands#how-the-command-menu-matches-what-you-type) · [Interactive mode](https://code.claude.com/docs/en/interactive-mode)
Composer shows one contextual key hint row and a footer (mode, temporary message,
current measured context warning, or three-column shortcuts); `StatusLine` is a
compatibility no-op. Context/cost remain available through report dialogs.
`?` on empty input opens shortcuts; input closes it without inserting/submitting.
The panel omits unavailable host actions and model effort when unadvertised.

Row 20: Ctrl+_ restores bounded draft snapshots including paste metadata;
Ctrl+S stashes/restores one exact draft and refuses overwriting an existing stash.
Double Esc clears the draft; single Esc first closes search/menu or interrupts
owned shell work. Busy generation still returns false to the host for cancellation.
Empty double Esc explicitly reports unavailable SDK rewind. `confirmExit()`
returns false with `Press Ctrl-C again to exit`, then true for a second call within
1.5 seconds. Temporary confirmation messages do not publish persistent notices.
Opt+P routes `/model` without clearing the draft; `onToggleTasks` enables Ctrl+T.
G3 integration: the shell passes `onEditor` (Ctrl+G: draft written to a private
temp file, `$VISUAL`/`$EDITOR` run through Ink's `suspendTerminal`, result read
back), `onSuspend` (Ctrl+Z: SIGTSTP inside `suspendTerminal`), `onRewind` (Esc Esc
and `/rewind`) and `onSendQueuedNow` (Ctrl+X Ctrl+S aborts the turn, then sends
the queue). Ctrl+V reports `Not implemented` (no SDK image attachment; `clipboard.ts`
only writes text), so image paste is not listed in the `?`/`/help` tables, which
share `HELP_SHORTCUT_COLUMNS` (`../help/logic.ts`). `backgroundShells` is not wired:
the SDK exposes no background-shell source.

Phase E host integration completed:

- Ready Ctrl+C calls `confirmExit()` before `gate.exit()`; startup cancellation
  stays immediate and shutdown still drains owned tasks.
- Ctrl+S stashes/restores the draft; Ctrl+T calls `usePlan().toggleTodos` through
  `onToggleTasks`. Session/theme dialogs remain explicit slash commands.
- Esc/Shift+Tab/Ctrl+O dismiss shortcuts before interrupting, cycling modes or
  toggling the detailed transcript (G3: Ctrl+O no longer opens the history panel). Other global shortcuts also dismiss the panel.
- Host `inputWidth` is `width - 3`. The inert StatusLine render/import is removed;
  `useStatusLine` still supplies welcome status.
- Host tests verify these bindings and live task ordering; native synthetic PTY
  verifies consent, permission, toggling, resize and two-press exit inline.

Tests use real Ink and public SDK on hermetic ports. They prove formatting,
measurement gating, draft preservation, keyboard dispatch and denial/cancellation
invariants, not native clipboard/editor/suspend or live provider compatibility.
Phase E reviewed and recorded the composed 80/36-column golden frames.

Phase E fix round: host-rendered successful shell results no longer publish a
second success notice/footer. Mode/messages/shortcuts use the two-cell inset;
autocomplete descriptions wrap at word boundaries.

## TUI v4 phase G3 (ô nhập, footer, menu, Ctrl+R)

Đặc tả: `docs/delivery/tui-v4/spec.md` mục 2 và các khung `reference/idle-100x30/01..09`, `live-120x36/L05-queued`.

- Footer (`features/status`): `⏸ manual mode on` (mặc định), `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (...)`,
  bypass giữ màu lỗi riêng; hậu tố ` · esc to interrupt`, ` · ← N agent(s)` (từ `client.subagents()`), ` · N shell(s)`
  (tuỳ chọn `backgroundShells`, SDK chưa có danh sách shell nền). `!` đổi footer thành `! for shell mode`. `?` thay footer bằng bảng 3 cột
  24/35/còn lại (đúng 02-shortcuts); `#` giữ dispatch memory nhưng dùng prompt `❯` thường.
- Khe phải phía trên rule: `ctrl+y to paste deleted text` (sau Ctrl+C / Esc Esc xoá chữ; Ctrl+Y dán lại), `ctrl+g to edit in <editor>` khi
  nhiều dòng, còn lại `◐ <effort> · /effort` (ẩn nếu model không có effort).
- Tin xếp hàng (`QueuedMessages`): `❯ text` nền user + `  ⎿  Queued · ctrl+x ctrl+s to send now`; placeholder
  `Press up to edit queued messages`. Up không rút tin lại được vì SDK chưa có API retract: báo `Not implemented`.
- Menu `/`, `$`, `@`: ngân sách 5 hàng, cột tên 42 ô tính từ pointer, mô tả tối đa 2 dòng + `…`, hàng chọn màu `selected`,
  còn lại `dim`; file là `+ path` dưới cột pointer.
- Ctrl+R: panel `Search prompts · everywhere` (`History`), lọc khi gõ, ↑/↓ chọn, Enter dùng, Esc huỷ, Ctrl+S scope = `Not implemented`
  (lịch sử không có mốc thời gian nên không có cột thời gian). Nháp chỉ đổi khi Enter.
- Callback host: `onRewind` (Esc Esc khi rỗng), `onEditor`/`onSuspend`/`onPasteImage` (Ctrl+G/Z/V), `onSendQueuedNow`
  (Ctrl+X Ctrl+S), `backgroundShells`; thiếu bridge thì in `Not implemented: ...`, không gửi gì.
- Ctrl+C: có chữ thì xoá (không lên đạn thoát); rỗng thì `Press Ctrl-C again to exit`, lần hai thoát.

## P2 SDK integration (2026-11-20)

Queue rows now read `client.queuedInput()` directly: entries disappear once claimed by
runtime, without a second local steering cache. Up on the first visual row calls the
atomic `retractQueuedInput()` and prepends returned text to the current expanded draft;
claimed entries and denied retractions never insert stale display text. Send-now calls
the host only after the draft was accepted; host uses `sendQueuedNow()` and owns inbox
delivery.

`onReadClipboardImage` supplies explicit clipboard bytes/path to SDK `attachImage`;
legacy `onPasteImage` remains a void bridge for existing hosts. `readMacClipboardImage`
in `clipboard.ts` reads PNG via fixed `/usr/bin/osascript`, with timeout and bounded
output (20 MiB decoded); it does not read prompt paths or write temp files. SDK validates
image contents and permissions. Chips show metadata only; Left at the beginning of the
input selects chips, Left/Right move, Delete/Backspace remove, Esc returns to text.
Image-only chat submits an empty string to the host; the host must allow this when
`imageAttachments()` is nonempty. Busy turns, shell/slash/memory submissions and
incomplete clipboard preparation preserve the draft. Clipboard results cannot cross a
session/account/model change. Native clipboard execution remains Needs verification;
hermetic tests cover SDK flow and races, not OS compatibility.

Ctrl+B calls `backgroundCurrentTask()` (or optional `onBackgroundTask`). Shell counts
come from session-scoped `backgroundTasks()`, updates subscribe to task events. Footer
navigation includes shells and agents; x calls SDK stop, and `onOpenBackgroundTasks`
opens `BackgroundTasksDialog`. The panel shows task state glyphs, Enter opens output
tail directly, Esc returns to the list, and x stops the selected running task. The host
continues to own turn/notification delivery and shutdown; this feature creates no loop.
The keymap-generated help restores Ctrl+V and Ctrl+B rows.

The task area below the input shows running shell/agent descriptions separately
from the conversation, capped at three rows (one on short terminals). Footer
count, selection and task panel share the same session-scoped UI projection,
including foreground child agents. Down on empty input selects work even with
queued messages; history navigation and typed drafts retain their existing rules.
