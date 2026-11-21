# TUI v4 — trạng thái bàn phím (P2)

Ngày: 2026-11-20. Spec: `keys.md` (mục 1-10). Đối chiếu: Claude Code thật chạy trong PTY (`cap2.py`, không gửi prompt cho model;
một lần bấm nhầm `Ctrl+X Ctrl+S` khi ô nhập có chữ `bc` đã gửi đúng một prompt hai ký tự `bc`) và Cosmew chạy trong PTY với HOME thật.

## Mô-đun

| Mô-đun | Vai trò |
|---|---|
| `apps/tui/src/ink/hooks/keymap/keystroke.ts` | Parser phím (`ctrl+`, `shift+`, `alt\|opt\|option\|meta+`, `cmd\|command\|super\|win+`, `esc`, `return`, chord cách nhau bằng dấu cách, không phân biệt hoa thường), dịch phím Ink, danh sách phím cố định |
| `keymap/defaults.ts` | 17 context, bảng phím mặc định và id hành động (nguồn duy nhất cho dispatch, help, `/keybindings`, kiểm tra hợp lệ), thứ hạng context |
| `keymap/keymap.ts` | Ghép mặc định + `keybindings.json`, kiểm tra hợp lệ (cảnh báo, không bao giờ ném lỗi), `null` bỏ phím, `command:<name>` |
| `keymap/router.ts` | Dispatcher thuần (không React): context trong cùng trước, handler trả `false` = nhường, chord có timeout 3 s (đồng hồ giả được) + thông báo `Chord cancelled`, phím cố định, `onKey` thô cho chữ gõ |
| `keymap/react.tsx` | `KeymapProvider` (một `useInput` cho cả app), `useKeybindings(handlersByContext, {isActive, onKey})` (không có provider thì tự có router riêng) |
| `keymap/user-config.ts` | `~/.cosmew/keybindings.json` (chỉ cấp user, theo `HOME`), nạp lại bằng poll mtime, nhật ký `~/.cosmew/debug/keybindings.log`, mẫu `/keybindings` |
| `keymap/help.ts` | Bảng `?` và `/help` sinh từ keymap, chỉ liệt kê phím có backend |
| `hooks/use-keymap.ts` | `useKeymap` cũ (close/submit/previous/next...) nay chạy trên keymap trung tâm (chỉ mũi tên, không j/k) |

Đã chuyển sang keymap trung tâm: composer (`use-composer.ts`), shell (`integrated-shell.tsx`), `ListPicker`, hộp quyền,
câu hỏi, Help/Settings/Rules (Tabs), model picker, `/effort`, Rewind, `/diff`. Phần còn dùng `useTextInput` (gõ chữ vào ô
tìm/nhập, phím số hộp quyền, `Ctrl+X` thu hồi grant ở hộp quyền) là nhập văn bản, không phải phím lệnh.
Dispatch: `Global` được thử cuối cùng; chord `ctrl+x ...` chỉ bắt đầu khi có thành phần đang bật xử lý một chord bắt đầu bằng nó
(trong dialog `Ctrl+X` vẫn là phím thường).

## Bảng phím

Trạng thái: **done** (có test), **Not implemented** (hiện thông báo, không nuốt phím, không giả thành công), **gap** (không làm được ở Ink).
Test: `K` = `features/composer/keys.test.tsx`, `S` = `testing/keys.test.tsx`, `M` = `hooks/keymap/keymap.test.ts`, `F` = `testing/fullscreen.test.tsx`,
`C` = `features/composer/composer.test.tsx`, `P` = `features/picker/{dialogs,v4-dialogs}.test.tsx`, `I` = `testing/integration.test.tsx`.

### Mục 1 — Global / Chat

| Phím | Trạng thái | Test / ghi chú |
|---|---|---|
| Ctrl+C | done: đang chạy = ngắt (không thoát); rảnh+chữ = xoá, Ctrl+Y lấy lại; rảnh+rỗng = `Press Ctrl-C again to exit` rồi thoát trong 800 ms; trong dialog 2 lần đóng | K `Ctrl+C on text clears it…`, S `Ctrl+C while a turn runs…`, S `in a dialog Ctrl+C and Ctrl+D…`, S `a permission dialog closed with Ctrl+C twice…`, I `ready Ctrl+C confirms…`. Cửa sổ 800 ms theo PTY Claude Code thật (hint hiện ở dòng footer < 0,75 s) |
| Ctrl+D | done: rỗng = hint rồi thoát trong 800 ms; có chữ = xoá ký tự sau con trỏ; dialog 2 lần đóng | K `Ctrl+D: text is edited…`, S `Ctrl+D on an empty prompt…`, S `Ctrl+D with text…` |
| Esc | done (đang chạy: ngắt; dialog: đóng; menu gợi ý: đóng; tìm lịch sử: huỷ) | C `Shell owns Esc…`, I `slash commands leave their result…` |
| Esc Esc | done: có chữ = xoá + lưu nháp vào lịch sử (↑ gọi lại); rỗng = Rewind | K `Esc Esc clears the input and files the draft…`, C `double Esc…`, I (Rewind) |
| Enter | done (đang chạy: xếp hàng/steer qua SDK) | C `steering goes through the real SDK…` |
| Ctrl+X Enter | done (bỏ qua menu gợi ý; cùng đường gửi/xếp hàng của Enter) | K `Ctrl+X Enter submits the typed text…`. Backend: `submitWhileBusy` quyết steer/queue |
| Ctrl+Enter, Ctrl+X Ctrl+S | done (gửi nháp + ngắt turn để gửi hàng đợi) | K `Ctrl+Enter, and Ctrl+X Ctrl+S…`; Ctrl+Enter chỉ có khi terminal hỗ trợ kitty keyboard |
| Ctrl+J, Alt+Enter, Shift+Enter, `\`+Enter | done | C `backslash Enter, Shift+Enter, Alt+Enter and Ctrl+J…`; M `Ink keys translate…` |
| Shift+Tab | done | P `the mode cycling hook…`, P hộp quyền (accept edits) |
| Alt/Opt+P | done (giữ nháp) | C `task/model shortcuts…`, I `a question and a picker…` |
| Alt+O (fast mode) | Not implemented (không có API provider) | K `Ctrl+G, Ctrl+X Ctrl+E and Ctrl+Z…` |
| Alt+T (thinking) | Not implemented (dùng `/effort`) | cùng test |
| Shift+↑/↓ | done (effort; model không có effort: mở rộng vùng chọn theo dòng) | C `advertised effort shortcuts…` |
| Ctrl+L | done (vẽ lại bằng `suspendTerminal` rỗng; giữ nháp) | K `Ctrl+L asks the host to redraw…`, S `Ctrl+L redraws…` |
| Ctrl+_ / Ctrl+Shift+- | done (Ctrl+_ là byte `0x1f`; kitty `ctrl+shift+-` có trong bảng) | K `Ctrl+_ undoes edits…`, C `undo restores exact collapsed paste…` |
| Ctrl+G, Ctrl+X Ctrl+E | done (`$VISUAL`/`$EDITOR`, file tạm 0600) | K (cầu nối), S (không dùng); luồng editor thật đã có từ G3 |
| Ctrl+S | done (cất/khôi phục cả chế độ `!` và nội dung dán) | K `Ctrl+S stashes a ! command…`, C `undo restores exact collapsed paste…`, C `an occupied stash…` |
| Ctrl+V | done: SDK attachImage, chip + xoá/chọn; clipboard PNG macOS có giới hạn. Native clipboard Needs verification | composer/keys: image paste, denied attach, stale session; clipboard-image.test.ts |
| Ctrl+Z | done (SIGTSTP qua `suspendTerminal`) | K (cầu nối) |
| Ctrl+X Ctrl+K | done (nhắc, bấm lần 2 trong 3 s dừng subagent nền qua `stopSubagent`) | K `Ctrl+X Ctrl+K asks first…` |
| Ctrl+B, Ctrl+X Ctrl+B | done: backgroundCurrentTask; không có tác vụ movable thì báo lý do | composer/keys.test.tsx |
| Ctrl+T | done | C `task/model shortcuts…`, I `host orders one spinner…` |
| Ctrl+O | done | I `Ctrl+O shows the detailed transcript footer…` |
| Ctrl+R | done (tìm điền sẵn bằng dòng đầu của nháp như Claude Code thật; Enter/Tab đưa kết quả vào ô nhập; Esc huỷ) | K `Ctrl+R: Tab and Enter…`, C `history restores unsent draft…` |
| ↑/↓, Ctrl+P/Ctrl+N | done: nhiều dòng thì di chuyển con trỏ trước. Lấy lại tin xếp hàng: done, retractQueuedInput đồng bộ; snapshot cũ không phải quyền rút | K `Up/Down move the caret…`, C `finishing-turn input uses the SDK queue…` |
| Tab | done (chấp nhận gợi ý; không gõ ký tự Tab; hộp quyền: mở/đóng ô comment) | K `Tab accepts…`, S `permission dialog: Enter says yes, Tab…` |
| `?` | done (ô rỗng bật/tắt; có chữ thì chèn) | C `empty question mark opens shortcuts…` |
| `/`, `!`, `@`, `$` | done (có từ trước) | autocomplete/composer tests |
| `:` emoji | done (bảng 40 mã thông dụng, chỉ khi `:tên:` là một từ trọn) | K `:shortcode: becomes an emoji…` |

Soạn thảo (không remap qua bảng): Ctrl+A/E (đầu/cuối dòng logic), Ctrl+K, Ctrl+U (lặp ở đầu dòng = nối dòng), Ctrl+W, Ctrl+Y, Alt+Y,
Alt+B/F/D, Option+Backspace / Ctrl+Backspace (xoá từ), Home/End, ←/→, Shift+←/→/↑/↓/Home/End chọn. **done**. Các lần xoá liên tiếp gộp vào một mục kill-ring
(giống Claude Code thật); Ctrl+U/K hiện `ctrl+y to paste deleted text`. Test: K `Ctrl+U/K/W kill text…`, K `Option+Backspace and Ctrl+Backspace…`,
K `Shift+arrows and Shift+Home…`, C `Ctrl+A/E/K/U/W and Shift selection…`. PTY: chuỗi Alt+B/Alt+D/Ctrl+W/Ctrl+Y/Alt+Backspace/Ctrl+U/Alt+Y của Cosmew cho đúng
cùng kết quả từng bước với Claude Code thật (`out-keys3` so với `out-fkeys`).

### Mục 2-4 — Autocomplete, Confirmation, Select, Tabs

| Phím | Trạng thái | Test |
|---|---|---|
| Autocomplete: ↑/↓/Ctrl+P/N, Tab, Esc, Enter | done | K `Tab accepts…`, autocomplete.test.tsx, C `file suggestions…` |
| Confirmation: Enter, Esc, ↑/↓, Tab, Shift+Tab, 1..N, Ctrl+C/D 2 lần | done (Space `confirm:toggle`: gap, hộp quyền không có mục bật/tắt) | P `once and session numbered choices…`, P `Edit prompts offer the accept-edits switch…`, S `permission dialog: Enter says yes…` |
| Select: ↓ J Ctrl+N, ↑ K Ctrl+P, PageUp/Down, Home/End, Enter, Esc | done (J/K chỉ khi danh sách không có ô tìm đang nhận chữ) | S `Select keys…` |
| Tabs: Tab/→, Shift+Tab/←, ↑/↓ focus | done (Help, Settings, Rules, câu hỏi nhiều mục); ↑/↓ chỉ ở Settings | P `help, permissions and settings tabs respond…`, P `multiple question tabs…` |
| Settings: `/` tìm, Enter/Space đổi, Esc | done: slash không lọt vào query; Space ngoài search đổi giá trị, trong search là chữ; Esc đóng search trước | picker/v4-dialogs.test.tsx |
| Model picker: ←/→ effort | done; `s` áp dụng model/effort session-only qua SDK 1.39 | P `models select advertised effort…`, `model picker s and effort slider s…` |
| `/effort`: ←/→, Enter, Esc | done; `s` áp dụng effort chỉ phiên này | S `effort slider…` |

### Mục 5-7 — Transcript, cuộn, tìm lịch sử, footer, diff, rewind

| Phím | Trạng thái | Test |
|---|---|---|
| Transcript: `q`, Esc, Ctrl+C thoát; `?` | done | S `transcript viewer: footer lists its keys…` |
| `{` `}` nhảy prompt | done (fullscreen; đo vị trí Yoga của từng prompt) | F `detailed transcript: { and } jump…` |
| `[` ghi hội thoại ra scrollback gốc | done ở fullscreen (rời alternate screen bằng `suspendTerminal`, in, quay lại); chế độ inline: báo "already in the terminal scrollback" | S (nhánh inline); fullscreen.test.tsx + native-pty.test.ts: rời alternate screen trước ghi và vào lại sau ghi |
| `v` mở bằng `$VISUAL`/`$EDITOR` | done (bản sao file tạm 0600) | fullscreen.test.tsx: chạy editor executable thật, bản sao 0600, giữ nguyên hội thoại và resume Ink |
| Cuộn: PageUp/Down nửa viewport, Ctrl+Home/Ctrl+End (+ follow), ↑/↓ trong transcript | done | F `detailed transcript…`, F `scrolling with PgUp/PgDn…` |
| Wheel, chọn bằng chuột, Ctrl+Shift+C / Cmd+C | gap (Ink 8 không có sự kiện chuột/chọn văn bản) | |
| Footer: ←/→, ↑/↓ (Ctrl+P/N), Enter, Esc, `x` trên agent đang chạy | done (↓ từ ô rỗng vào footer; Enter/↓ mở `/agents`; x dừng agent) | K `footer: Down on an empty input…`. P2 thêm backgroundTasks: shell + agent, unified panel với output/stop |
| Tìm lịch sử: ↑/↓, Enter/Tab, Esc | done | K `Ctrl+R: Tab and Enter…` |
| Tìm lịch sử: Ctrl+S đổi phạm vi | done: session → project → everywhere; title + cột thời gian từ stored sessions | C `Ctrl+R shows stored timestamps…` |
| `/diff` dialog: ↑/↓ J/K file, ←/→ nguồn, Enter, PageUp/Down, Space/B, g/G | done | S `diff dialog keys…` |
| Diff panel ≥110 cột: Ctrl+X B, Ctrl+↑/↓ | done: Current → Uncommitted → Branch, skip unavailable có lý do; stale completion không đổi base | diff/panel.test.tsx, testing/p2-integration.test.tsx |
| Rewind: ↑/↓, Home/End, Enter, Esc | done: both/conversation/code/summarize + optional focus; Never mind huỷ | panels/panels.test.tsx |

### Mục 8-10

| Mục | Trạng thái | Test |
|---|---|---|
| Phím cố định Ctrl+C/D/M/[/I/H | done: user không gán được (cảnh báo), mặc định giữ nguyên | M `reserved keys keep their meaning…`, M `validation…` |
| Chord 3 s, `Chord cancelled` | done | M `chords: ctrl+x waits…` (đồng hồ giả), S `a half-typed ctrl+x chord…` |
| Vim mode | ngoài phạm vi: `/config` → `Editor mode = Not implemented` | P `settings reports every supported section…` |
| `~/.cosmew/keybindings.json` | done: cùng schema/context/action id, `null` bỏ phím, `command:<name>`, cảnh báo một lần + ghi `~/.cosmew/debug/keybindings.log` (chưa có đường debug sẵn trong repo, đường này mới) | M `user keybindings…`, `validation…`, `hot reload…` (HOME tạm), `keybindings.json lives under the (temporary) HOME…` |
| Nạp lại khi file đổi | done (poll mtime 1 s, không phụ thuộc mới) | M `hot reload…` |
| `/keybindings` | done: tạo file mẫu (mặc định ghi trong `$docs`) rồi mở editor, nạp lại ngay khi editor thoát; có trong menu `/` và `/help` | M `template lists every default…`, S `/keybindings is a real command…` |
| Bảng `?` và `/help` sinh từ keymap | done: theo remap, có Ctrl+V/Ctrl+B; bỏ Alt+O/T khi không có backend | M `help columns come from the keymap…`, C/panels tests |

## Lỗi thật tìm thấy khi làm

- Ctrl+L, Ctrl+D, Ctrl+N, Ctrl+S, Ctrl+T, Ctrl+C trong `SLASH_COMMANDS.shortcut` (`/model`, `/diff`, `/clear`, `/resume`, `/theme`, `/exit`) bị shell tự chạy
  (`commandForShortcut`), nên Ctrl+D mở `/diff`, Ctrl+N xoá hội thoại và Ctrl+L mở bộ chọn model thay cho thao tác của Claude Code. Đã bỏ đường này; các chuỗi `shortcut`
  trong `packages/sdk/src/commands.ts` giờ chỉ còn là metadata cũ (không dùng, không sửa vì ngoài phạm vi; coordinator nên xoá).
- Ctrl+P mở `/help` (đúng ra là lịch sử trước). Ctrl+C khi đang chạy không ngắt mà chuẩn bị thoát; trong dialog thoát hẳn app. Đã sửa.
- Esc Esc không lưu nháp vào lịch sử; ↑ không đi tiếp trong nhập nhiều dòng sau khi gọi lại lịch sử; Ctrl+U không nối dòng; Alt+B/F/D/Y, Option+Backspace,
  Ctrl+J(`\n` do Ink giải mã thành chữ), Shift+Home/End, `:` emoji chưa có. Đã thêm.
- Test cũ phải đổi theo hành vi mới: `fullscreen.test.tsx` và `integration.test.tsx` mở `/help` bằng Ctrl+P (nay `/help` và Alt+P),
  `reference-frames.test.tsx`/`panels.test.tsx` (bảng `?` nay có `/keybindings to customize`), `composer.test.tsx` (Ctrl+R điền sẵn), `foundation.test.tsx` (API keymap mới),
  `picker/logic.test.ts` (dòng Terminal shortcuts), `tests/end-to-end/tui-modes.test.ts` (bỏ Ctrl+N làm phím "hội thoại mới").

## P2 — bằng chứng và giới hạn hiện hành

- `testing/p2-integration.test.tsx`: 80/109 cột từ chối panel, 120×36 auto-open sau receipt thành công, `/diff` đóng panel,
  thông báo durable completion đúng session và một lần, plan ở 80×12 + Esc huỷ SDK request.
- `composer/keys.test.tsx`: queue authoritative/retract trước nháp, snapshot sau delivery không lấy lại được, send-now không ngắt khi không có queue;
  ảnh chỉ gửi khi attach thành công, chip độc lập payload, không gắn kết quả clipboard vào session đã đổi. Ctrl+Enter cần kitty keyboard;
  terminal không có kitty dùng Ctrl+X Ctrl+S (cùng `chat:sendNow`).
- `plan-approval/plan-approval.test.tsx`: manual/acceptEdits/feedback/Esc, lựa chọn ở 80×12, FORCE_COLOR=3 và màu dark từ L12 `.colors.json`.
- `transcript/p2-events.test.tsx`: hook.ran giữ thứ tự, chỉ hiện chi tiết, đếm PostToolUse; completion không chiếm đích event của turn đang chạy.
- `[` được kiểm tra qua PTY thật với alternate-screen leave/enter. `v` chạy executable editor thật với bản sao 0600 qua suspendTerminal.
- Còn thiếu SDK: selective retract queue có shell; diff session/branch bases; plan artifact path + API sửa plan/approve+feedback; rewind summarize; model/effort session-only;
  fast/thinking toggle; history scopes. Các nhánh này không giả thành công.
- Clipboard PNG macOS chỉ kiểm tra parser/bounds/cancellation + attach API; đọc clipboard OS thật Needs verification.
- Wheel/chọn chuột/Ctrl+Shift+C vẫn chưa có hỗ trợ Ink. Không thay golden; bốn golden 80/36 được chạy kiểm tra.

Chi tiết audit tám mục và bằng chứng cuối: [p2-status.md](p2-status.md). Footer x dùng `footer:close` (alias `footer:stop` vẫn nhận); shell/agent có `↓ to manage`.


## P3 — SDK 1.39 / SQLite 10

Trạng thái P3 thay các giới hạn SDK của phần P2 lịch sử ở trên: selective `retractQueuedEntries` giữ shell khi queue hỗn hợp;
Shift+Tab approve+feedback atomic; Ctrl+G chỉnh bản sao plan và footer có editor/path; summarize rewind có focus;
Ctrl+X B cycle nguồn diff trong DiffPanel; `s` model/effort chỉ phiên này; Ctrl+S ở Ctrl+R đổi scope với cột thời gian.
Tests: contracts/input-retraction, plan-approval, checkpoints, p3-history-settings, workspace-diff-bases;
TUI composer/keys, composer/composer, picker/dialogs, plan-approval, testing/plan-editor, panels và diff/panel.
Alt+O/Alt+T vẫn Not implemented vì adapter chưa có fast/thinking flag; reasoning effort không giả thành toggle.
Không đổi giới hạn Ink mouse/wheel hay clipboard native. Chi tiết và nghiệm chứng: [P3](p2-status.md#p3--sdkbackend-và-tui-cùng-wave).
