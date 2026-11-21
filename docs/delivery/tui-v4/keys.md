# TUI v4 — bàn phím giống Claude Code (đặc tả phím)

Nguồn: tài liệu chính thức Claude Code, đọc 2026-11-20 — `https://code.claude.com/docs/en/keybindings` (bảng phím mặc định theo context)
và `https://code.claude.com/docs/en/interactive-mode` (hành vi từng phím). Phiên bản tham chiếu 2.1.328 (trang doc nhắc tính năng tới
2.1.305; mục nào doc ghi "Requires vX" mới hơn 2.1.328 thì đánh dấu `≥` và coi là Needs verification). Khung chụp thật của các phím có trong
`reference/` (Esc Esc, Ctrl+O, Ctrl+R, Shift+Tab, `?`, `!`, Ctrl+C...). Quy tắc: phím nào có backend thì làm đúng hành vi; phím nào chưa
có backend thì phải hiện `Not implemented` (không nuốt phím, không giả thành công). Cột **Cosmew** = việc cần làm.

## 1. Global / Chat (ô nhập)

| Phím | Hành động (id) | Hành vi chính xác | Cosmew |
|---|---|---|---|
| Ctrl+C | `app:interrupt` (cố định) | Đang chạy: ngắt. Rảnh + có chữ: **xoá** ô nhập (lưu để Ctrl+Y lấy lại). Rảnh + rỗng: lần 1 hiện `Press Ctrl-C again to exit`, lần 2 thoát. Trong dialog: 2 lần đóng dialog | có; kiểm tra khớp |
| Ctrl+D | `app:exit` (cố định) | Ô nhập rỗng: lần 1 hiện gợi ý, lần 2 trong 800 ms thoát. Có chữ: xoá ký tự sau con trỏ | thêm |
| Esc | `chat:cancel` | Đang chạy: ngắt phản hồi, giữ việc đã làm; tin xếp hàng gửi tiếp. Dialog mở: đóng | có |
| Esc Esc | — | Có chữ: xoá ô nhập + lưu bản nháp vào lịch sử (↑ gọi lại). Rỗng: mở menu rewind | có |
| Enter | `chat:submit` | Gửi. Đang chạy: **xếp hàng** (không ngắt) | kiểm tra |
| Ctrl+X Enter | `chat:queueSubmit` ≥2.1.247 | Gửi dạng chờ đến lượt, kể cả khi menu gợi ý đang chọn | thêm |
| Ctrl+Enter, Ctrl+X Ctrl+S | `chat:sendNow` ≥2.1.275 | Gửi ngay tin xếp hàng + nháp; xem hành vi turn ở interactive-mode "When Claude Code sends what you queued" | có một phần (cần SDK) |
| Ctrl+J, `\`+Enter, Option+Enter, Shift+Enter | `chat:newline` | Xuống dòng, không gửi | có `\`, Shift+Enter; thêm Ctrl+J, Alt+Enter |
| Shift+Tab | `chat:cycleMode` | manual → accept edits → plan → (bypass / auto nếu được phép) | có |
| Option+P / Alt+P | `chat:modelPicker` | Mở chọn model, giữ nháp | có |
| Option+O / Alt+O | `chat:fastMode` | Bật/tắt fast mode | Not implemented nếu không có |
| Option+T / Alt+T | `chat:thinkingToggle` | Bật/tắt extended thinking | Not implemented nếu không có |
| Shift+↑/↓ | — | Đổi mức effort (khung `02-shortcuts`) | có |
| Ctrl+L | `chat:clearInput` | Vẽ lại toàn màn hình, giữ ô nhập và hội thoại | thêm |
| Ctrl+_ , Ctrl+Shift+- | `chat:undo` | Hoàn tác sửa ô nhập (văn bản + con trỏ) | có |
| Ctrl+G, Ctrl+X Ctrl+E | `chat:externalEditor` | Mở `$VISUAL`/`$EDITOR` để sửa nháp | cần bridge host |
| Ctrl+S | `chat:stash` | Có chữ: cất + xoá. Rỗng: khôi phục (cả chế độ `!`, nội dung dán) | có |
| Ctrl+V (Alt+V Windows/WSL) | `chat:imagePaste` | Dán ảnh, chèn chip `[Image #N]` | cần clipboard bridge |
| Ctrl+Z | — | Suspend (Unix), `fg` để quay lại | cần host |
| Ctrl+X Ctrl+K | `chat:killAgents` | Dừng mọi subagent nền, bấm 2 lần trong 3 s | nối `/agents` stop |
| Ctrl+B, Ctrl+X Ctrl+B | `task:background` | Đẩy lệnh/agent đang chạy xuống nền | cần SDK |
| Ctrl+T | `app:toggleTodos` | Ẩn/hiện checklist todo (không phải task nền) | có |
| Ctrl+O | `app:toggleTranscript` | Transcript chi tiết (giờ + model từng câu trả lời) | có |
| Ctrl+R | `history:search` | Mở tìm lịch sử (panel fullscreen) | có |
| ↑ / ↓ , Ctrl+P / Ctrl+N | `history:previous/next` | Nhiều dòng: di chuyển con trỏ trước, tới dòng đầu/cuối mới duyệt lịch sử. Có tin xếp hàng: ↑ ở dòng đầu **lấy lại** tin xếp hàng vào ô nhập | có; phần lấy lại cần SDK |
| Tab | `autocomplete:accept` | Chấp nhận gợi ý; trên hộp quyền mở ô comment | có |
| `?` (ô rỗng) | — | Bật/tắt bảng phím tắt; có chữ thì chèn `?` | có |
| `/`, `!`, `@`, `:` | — | Lệnh/skill, shell mode, đường dẫn file, emoji `:name:` | `:` emoji thêm (nhỏ) |

Soạn thảo văn bản (không remap được): Ctrl+A / Ctrl+E (đầu/cuối dòng logic), Ctrl+K (xoá tới cuối dòng), Ctrl+U (xoá tới đầu dòng; lặp để xoá qua dòng),
Ctrl+W (xoá tới khoảng trắng trước), Ctrl+Y (dán lại phần vừa xoá), Alt+Y sau Ctrl+Y (vòng lịch sử xoá), Alt+B / Alt+F (lùi/tiến một từ — từ = chữ+số,
dấu câu ngăn từ), Alt+D (xoá tới cuối từ), Option+Delete / Ctrl+Backspace (xoá một từ), Home/End, ←/→, Shift+←/→/↑/↓ chọn.
Chord: các phím sau `ctrl+x` chờ tối đa 3 giây; quá hạn → bỏ chord + thông báo ngắn.

## 2. Autocomplete (menu `/` `@` `$`)

↑/↓ chọn · Tab chấp nhận · Esc đóng · Enter gửi dòng đang gõ (menu `/` đã chọn mục thì chạy mục). Mid-prompt `/`: Tab chèn mục đầu; Enter vẫn gửi nguyên văn.

## 3. Confirmation (hộp quyền, câu hỏi, dialog)

Enter = yes · Esc = no · ↑/↓ chọn · Space bật/tắt · Tab: mở/đóng ô comment (amend) trên hộp quyền · Shift+Tab: trên hộp quyền file = chọn "Yes ... for the rest of the session";
nếu ô comment đang mở thì đóng nó · Ctrl+C / Ctrl+D 2 lần đóng dialog · phím số 1..N chọn nhanh (Cosmew giữ) · Left/Right đổi tab trong dialog nhiều tab (câu hỏi nhiều mục).

## 4. Select (mọi danh sách) và Tabs

Select: ↓ J Ctrl+N tiếp · ↑ K Ctrl+P trước · PageUp/PageDown một trang · Home/End đầu/cuối · Enter chọn · Esc huỷ. (J/K chỉ khi danh sách không có ô tìm đang nhận chữ.)
Tabs: Tab / → tab sau · Shift+Tab / ← tab trước · ↑/↓ chuyển tiêu điểm giữa hàng tab và nội dung. Settings: `/` vào tìm kiếm, R thử lại, Enter/Space đổi giá trị, Esc đóng (đã lưu).
Model picker: ←/→ đổi effort, `s` chỉ cho phiên này. Effort slider (`/effort`): ←/→ đổi mức, Enter xác nhận, Esc huỷ.

## 5. Transcript viewer (Ctrl+O) và cuộn (fullscreen)

Transcript viewer: `q`, Ctrl+C, Esc thoát · `?` bật/tắt legend (11 mục, sinh từ keymap đang dùng) ·
`{` / `}` nhảy prompt trước/sau · `[` print to scrollback · `v` mở bản sao bằng `$VISUAL`/`$EDITOR`;
không có editor: `no $VISUAL/$EDITOR set`, không suspend terminal.

`/` mở search, chữ gõ (kể cả j/k/g/q/n) vào query. Enter giữ query khớp và đóng bar; Esc huỷ về query đã giữ,
Esc tiếp theo thoát viewer. Khi bar đóng, `n`/`N` cycle matches (wrap); footer `n/N to navigate`, badge `N of M`.
Bar: `Search transcript…`, `indexing…`, `indexed in <ms>ms`, `no matches`; index/query scan chia chunk, chỉ tạo khi cần.
Ctrl+E show/collapse 30-message window chỉ ở inline; fullscreen history paging vô hiệu hoá toggle theo B4/B7.

Cuộn viewer: ↑/↓, j/k, Ctrl+N/P từng dòng; Ctrl+U/D nửa viewport; space/b, Ctrl+F/B một viewport;
g/G, Home/End đầu/cuối. PageUp/PageDown giữ nửa viewport; Ctrl+Home/End giữ đầu/cuối + follow.
Wheel/selection giữ hành vi hiện có. Footer strict-fit và legend 100/40 cột theo
[reference 2.1.330](transcript-mode-parity.md); live search, renderer normalization và latency host: **Needs verification**.

## 6. Tìm lịch sử (Ctrl+R, fullscreen)

Ctrl+R mở dialog; gõ để lọc; ↑/↓ chọn; **Enter hoặc Tab** đặt kết quả vào ô nhập; Esc huỷ; **Ctrl+S** đổi phạm vi session → project → everywhere. (Khung đã chụp có `Search prompts · everywhere`.)

## 7. Footer / panel nền / diff

Footer: ←/→ chọn mục, ↑/↓ (Ctrl+P/Ctrl+N) di chuyển/bỏ chọn ở trên cùng, Enter mở mục, Esc bỏ chọn, `x` dừng agent/workflow đang chọn. (↓ trong footer `· 1 shell · ← 1 agent · ↓ to manage` mở panel quản lý.)
Diff panel (`/diff`, ≥110 cột): mở ở ô nhập; **Tab** (`DiffPanel.diff:focus`) chuyển focus vào panel, Esc (`diff:blur`) trả về prompt và giữ nháp. Khi focus: ↑/↓ J/K chọn file; Enter mở detail, ↑/↓ J/K cuộn detail; Esc về list trước khi trả về prompt. ←/→ đổi nguồn theo hai hướng; PageUp/Down, Space/B, G/Shift+G cuộn. Ctrl+X B đổi cơ sở so sánh (session → uncommitted → branch); Ctrl+↑/↓ hoặc Meta+↑/↓ vẫn chọn file khi prompt nhận chữ. `/diff` lần nữa hoặc click ✕ đóng panel. Footer dùng keymap hiện tại, không yêu cầu Option as Meta. Diff component riêng dùng cùng list/detail keymap.

Wheel trên diff cuộn diff (không cuộn transcript); click file chọn file, click source đổi nguồn. Shared list-picker/option-list click chỉ highlight, Enter mới kích hoạt/xác nhận; wheel đổi highlight. Click tab đổi tab. Permission/plan/rewind không tự duyệt qua click. Mouse không được terminal gửi thì keyboard vẫn hoạt động; Shift+drag/native selection giữ do terminal quản lý. Bằng chứng upstream và giới hạn: [diff interaction parity](diff-interaction-parity.md).
Rewind (Esc Esc): ↑/↓ chọn, Home/End, Enter tiếp tục, Esc huỷ.

## 8. Phím cố định (không remap), xung đột terminal

Ctrl+C, Ctrl+D, Ctrl+M (=Enter), Ctrl+[ (=Esc), Ctrl+I (=Tab), Ctrl+H (=Backspace). Xung đột terminal: Ctrl+B (tmux), Ctrl+A (screen), Ctrl+Z (suspend). macOS: phím Option cần bật "Option as Meta" của terminal.

## 9. Vim mode (tuỳ chọn, `/config` → Editor mode)

Chế độ INSERT/NORMAL/VISUAL với motion, operator, text object (doc: `interactive-mode#vim-editor-mode`). Esc ở vim = INSERT→NORMAL (không phải `chat:cancel`); NORMAL `?` mở help, `/` mở tìm lịch sử.
Làm sau cùng (pha riêng) nếu user muốn; tới lúc đó `/config` hiện mục Editor mode = `Not implemented`.

## 10. Keybindings tuỳ chỉnh

Claude Code đọc `~/.claude/keybindings.json` (`{"bindings":[{"context":"Chat","bindings":{"ctrl+e":"chat:externalEditor","ctrl+s":null}}]}`), tự nạp lại khi file đổi, cho gán `command:<name>`.
Cosmew: file `~/.cosmew/keybindings.json`, cùng schema, cùng tên context/action ở các bảng trên, cú pháp phím (`ctrl+`, `shift+`, `alt|opt|meta+`, `cmd+`, chord cách bằng dấu cách, chữ thường) và quy tắc
phím cố định; `/keybindings` tạo file mẫu rồi mở editor; kiểm tra hợp lệ (JSON hỏng, modifier sai, context/action lạ, phím cố định, trùng) → cảnh báo trong debug log, giữ mặc định.
File user (không phải của workspace) — không đọc keybindings từ thư mục dự án.
