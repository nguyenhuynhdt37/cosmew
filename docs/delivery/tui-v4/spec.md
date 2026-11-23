# TUI v4 — đặc tả từ khung chụp thật (G1)

Nguồn duy nhất: `reference/` — Claude Code 2.1.328, macOS, terminal giả lập `pyte 0.8.2`, chụp 2026-11-19 bằng PTY sạch (đã bỏ
biến `CLAUDE*`), theme của user `custom:orca`. `idle-100x30/` = 51 khung không gọi model, `live-120x36/` = 58 khung có model thật.
Mỗi khung có `.txt` (`NN|dòng`) và `.colors.json` (`[y, [[x0,x1,fg,bg,bold,italic,reverse,text]…]]`). Đã thay email/org/path/uuid
bằng `<…>`; bỏ khung Ctrl+R (chứa lịch sử prompt thật). Thay `Claude`/`Claude Code`/logo bằng Cosmew khi làm.
Thay cho `claude-code-parity.md` (đặc tả cũ dựa trên bản chụp sai môi trường) và phần inline của ADR 0065.

Ký hiệu: `⏺` là glyph thật (terminal vẽ thành `●`). "Ref" = file trong `reference/`.

## 1. Khung màn hình

- **Fullscreen alternate screen.** Banner + transcript cuộn trong vùng trên; đáy cố định (từ dưới lên): dòng footer, dòng trống,
  [cảnh báo `⚠`], rule `─`, ô nhập, rule `─`, dòng effort căn phải. Ref `idle-100x30/01-ready` (ô nhập ở hàng 26/30).
- Banner Cosmew: mèo phi hành gia pixel 4 hàng màu brand bên trái; ô vuông bằng `▀▄█` tạo lưới 9×8 pixel,
  thay các chấm tròn của mẫu dot-matrix cũ theo yêu cầu ngày 2026-11-21,
  `Cosmew v<ver>` đậm / `<model> with <effort> effort · <gói/tài khoản>` / cwd `/…/<đuôi>` bên phải.
  Header và màn chào dùng chung component; animation theo theme, reduced motion giữ frame đầu, terminal dưới 32 cột dùng mặt mèo gọn.
  Banner nằm **trong** transcript (cuộn đi cùng). Dòng hook khởi động: `  ⎿  SessionStart:startup says: …`.
- Cuộn: PgUp/PgDn cuộn transcript; khi không ở đáy hiện chip trên rule: `Jump to bottom · fn+↓ to scroll` (Ref `live/L09-pgup`).
  Stream mới tự bám đáy chỉ khi đang ở đáy.
  Wheel/trackpad cuộn transcript 3 dòng mỗi sự kiện (ADR 0079); ô nhập/footer giữ vị trí. Chuột không chọn/duyệt hộp thoại.
  Tắt mouse reporting khi mở editor/ghi scrollback và khi thoát; bật lại khi quay về TUI. Chọn chữ bằng override của terminal (thường Shift+kéo).
- Panel diff bên phải tự mở sau khi có file đổi, khi rộng ≥ 110 cột (dưới 110: `/diff` in
  `⎿  Resize your terminal to at least 110 columns to show the diff panel`). Ngăn bằng `│` dọc; xem §8. Ref `live/L02-edit-done`.
- Thoát (Ctrl+C khi rảnh, hai lần) trả lại màn hình chính. Ctrl+C lần đầu: gợi ý phải trên rule `ctrl+y to paste deleted text`
  nếu ô nhập có chữ (xoá chữ), nếu rỗng thì `Press Ctrl-C again to exit` (Needs verification: chưa chụp được — khung L15 vẫn ở
  chế độ interrupted).

## 2. Ô nhập và footer

- Rule trên/dưới full width màu rule; prompt `❯ `. Phiên mới hiển thị gợi ý mờ có thể điền bằng Tab hoặc → rồi sửa trước khi gửi. Gõ văn bản sẽ ẩn gợi ý. Khi đang chạy, ô nhập rỗng hiện `Press up to edit queued messages` nếu có tin chờ.
- Hint dưới ô nhập thay đổi theo menu, trạng thái gửi và phím đã remap. Ở terminal hẹp, chỉ hiện những hint còn đủ chỗ.
- Dòng effort phải phía trên rule trên: `◐ medium · /effort`; lúc đang chạy dòng effort và spinner cùng hàng trên.
- Footer (2 khoảng trắng đầu): `⏸ manual mode on` (default), `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`,
  `⏵⏵ auto mode on (shift+tab to cycle)` (Cosmew: `⏵⏵ bypass permissions on (shift+tab to cycle)`), nối tiếp bằng ` · `:
  `esc to interrupt` khi đang chạy, `← N agent(s)`/`N shell` khi có tác vụ nền. Thứ tự Shift+Tab: manual → accept edits → plan →
  auto/bypass → manual. Ref `idle/05-mode-1..4`, `live/L01-bash-spinner1`.
- `!` ở đầu: prompt thành `!` (màu bash), footer `! for shell mode` (Ref `idle/06-bash-mode`). `#` không còn là chế độ riêng
  (Ref `06b-hash`) — Cosmew giữ `#` memory nếu đã có nhưng dùng prompt `❯`.
- `?` khi rỗng: bảng 3 cột (Ref `idle/02-shortcuts`) thay footer.
- `/` ở đầu prompt lọc lệnh và skill. Tiền tố khớp tên hoặc alias được chọn sẵn. Mục gần đúng vẫn hiện khi gõ sai và cần Tab hoặc phím mũi tên để chọn. Enter chạy mục đã chọn hoặc gửi nguyên văn khi chưa chọn. Tab điền vào draft, Esc đóng menu. Alias đầy đủ giữ nguyên.
- `/` giữa prompt gợi ý lệnh khớp tiền tố. Enter gửi nguyên văn khi chưa chọn. Tab hoặc Enter trên mục đã chọn điền tên vào draft. Với dấu `/` đứng một mình giữa prompt, Tab mở danh sách trước khi điền.
- `@` gợi ý file đã được phép liệt kê. `$` gợi ý skill. Gõ ít nhất hai ký tự sau `:` để tìm emoji. Tab hoặc Enter trên mục đã chọn điền vào draft.
- `\`+Enter xuống dòng (Ref `07-multiline`). Ctrl+R: panel `Search prompts · everywhere`, danh sách trái `<thời gian>  <prompt…>`
  + hộp xem trước bo tròn bên phải, ô `⌕ Filter history…` bo tròn, footer `↑/↓ to navigate · ctrl+s to change scope · Enter to use · Esc to cancel`
  (khung không lưu vì có dữ liệu riêng; bố cục ghi ở đây).
- Tin xếp hàng: `❯ <text>` nền user + `  ⎿  Queued · ctrl+x ctrl+s to send now` (Ref `live/L05-queued`).

## 3. Transcript

- Tin user: `❯ <text>` với **nền** user (light `#f2f3f3`, dark `#353940`), dòng sau thụt 2 (Ref `live/L03-question-dialog`).
- Trả lời: `⏺ ` + Markdown, đoạn tiếp thụt 2; danh sách đánh số; code block thụt + tô màu.
- Tool **gộp** khi chế độ thường: dòng tóm tắt mờ thụt 2 không có `⏺`: `Listed 1 directory`, `Read 1 file`, `Ran 1 shell command`,
  `Ran 1 shell command · 1 failed`, `Made N edits +a -r, read N files` (ảnh user) (Ref `live/L01-bash-permission`, `L13-fail-done`).
- Tool sửa file hiện riêng: `⏺ Update(a.txt)` / `  ⎿  Added 1 line, removed 1 line` / diff thụt 6 (`1 -hello`, `1 +HELLO` nền màu)
  (Ref `live/L02-edit-done`).
- Kết thúc lượt: `✻ <Động từ quá khứ> for 8s · done 11:00 PM` mờ (Crunched/Cooked/Baked/Cogitated/Sautéed…; Cosmew tự có danh sách).
- Ngắt: `  ⎿  Interrupted · What should Cosmew do instead?` (Ref `live/L14-interrupted`).
- Thông báo nền: `⏺ Background command "<mô tả>" completed (exit code 0)` (Ref `live/L07-bg-manage`).
- Ctrl+O (transcript chi tiết): mọi tool hiện `⏺ Bash(sleep 40)` + `⎿  Running in the background (↓ to manage)` + `⎿  3 PostToolUse hooks ran`,
  dòng giờ + model căn phải trước mỗi trả lời (`11:05 PM <model>`), footer
  `Showing detailed transcript · ctrl+o to toggle · ↑/↓ to scroll · v to open in code · ? for shortcuts` + `verbose` phải (Ref `live/L08-ctrl-o`).

## 4. Khi đang chạy

- Spinner một dòng trên ô nhập: glyph xoay (`· ✢ ✳ ✶ ✻ ✽`), `<Động từ>…` màu nhấn, sau vài giây
  `(7s · ↓ 279 tokens · thinking with medium effort)`; dòng dưới `  ⎿  Tip: <mẹo>` (Ref `live/L01-bash-spinner1`, `L02-edit-done`, `L05-queued`).

## 5. Hộp quyền (thay ô nhập, transcript vẫn hiện)

- Edit: rule `─` trên, ` Edit file` (đậm, màu permission), ` a.txt`, rule `╌` , diff ` 1 -hello` / ` 1 +HELLO` / ` 2  world`, rule `╌`,
  ` Do you want to make this edit to a.txt?`, ` ❯ 1. Yes`, `   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)`,
  `   3. No`, dòng trống, ` Esc to cancel · Tab to amend`. Pending tool hiện phía trên `⏺ Update(a.txt)` (Ref `live/L02-edit-permission`).
- Bash/Fetch/MCP: chưa chụp (sandbox tự cho chạy). Chụp bù ở G0b bằng lệnh ngoài sandbox.
- Cosmew giữ đủ phạm vi của mình (lần này / phiên / luôn cho project / không + lý do) nhưng câu chữ theo mẫu trên.

## 6. Câu hỏi và duyệt plan

- Câu hỏi: rule trên, chip ` ☐ Color`, câu hỏi, `❯ 1. Red` + mô tả thụt 5, `2. Blue`, `3. Type something.`, rule, `4. Chat about this`,
  `Enter to select · ↑/↓ to navigate · Esc to cancel` (Ref `live/L03-question-dialog`).
- Duyệt plan: rule `▔` (panel), khung `─`, ` Ready to code?`, ` Here is <Sản phẩm>'s plan:`, rule `╌`, nội dung plan Markdown, rule `─`,
  ` … Would you like to proceed?`, `❯ 1. Yes, and use auto mode` (Cosmew: bypass/accept edits), `2. Yes, manually approve edits`,
  `3. Tell … what to change` + `shift+tab to approve with this feedback`, footer `ctrl+g to edit in <editor> · <đường dẫn plan>` (Ref `live/L12-plan-approval`).

## 7. Panel lệnh (rule `▔▔▔` trên, đáy màn hình, transcript vẫn hiện phía trên)

- `/config` `/status` `/cost`/`/usage`: một panel tab `Settings  Status   Config   Usage   Stats` (Ref `idle/20-cmd-config`, `-status`, `-cost`).
  Config: ô `⌕ Search settings…` bo tròn + danh sách `❯ Tên    giá trị`.
- `/help`: tab `Help  General   Commands   Custom commands`, footer `←/→ to switch · Esc to close` (Ref `20-cmd-help`).
- `/permissions`: tab `Permissions  Recently blocked   Allow   Ask   Deny   Auto mode   Workspace` + ô tìm (Ref `20-cmd-permissions`).
- `/resume`: `Resume session`, ô tìm, nhóm theo project, footer `Ctrl+A to show all projects · Ctrl+B to only show current branch · Esc to close`.
- `/context`: lưới `⛶ ⛁ ⛝` 20×7 bên trái + chú thích theo nhóm bên phải, khối `Auto-compact window`, nhóm `MCP tools`, `Custom agents`, `Skills` (Ref `20-cmd-context`).
- `/mcp` (`✔/⚠/✘/◯` + số tool), `/hooks` (read-only), `/memory`, `/rewind` (= Esc Esc: danh sách prompt + `a.txt +1 -1`/`No code changes`/`⚠ No code restore`,
  `❯ (current)`, `Enter to continue · Esc to cancel`; Ref `live/L11-esc-esc`), `/model`, `/theme`, `/agents`, `/doctor`.
- Lệnh xong in dòng kết quả trong transcript: `❯ /export` + `  ⎿  Export cancelled`, `/diff` + `⎿  Diff panel hidden`.
- Lệnh Cosmew không có backend: in `⎿  Not implemented` (không giả lập).

## 8. Panel diff

Phải, rộng ~52 cột ở 120 cột: dòng `✕` đóng; `1 file changed +1 -1      source: Current ▾`; danh sách file `a.txt   +1 -1`; rule; tiêu đề file +
`[ ask ]` phải; rule; diff có số dòng, nền màu; nền panel khác nền chính (light `#f5f5f5`, dark `#262626`). `/diff` bật/tắt. Ref `live/L02-edit-done`.

Default `/diff` source is **Uncommitted** (working tree against HEAD, including staged,
unstaged and untracked files); SDK defaults and contract 1.40 fields are unchanged.
`Current` labels the explicit session baseline; Ctrl+X B retains the session →
uncommitted → branch cycle. Opening the panel refreshes its selected source. Consent
and session changes invalidate in-flight reports and re-read the SDK snapshot, so a
refresh captured before consent cannot overwrite the enabled report. Empty reports
show `No changes`; denied/error reports show their reason, including unavailable
branch merge bases. The 110-column threshold is unchanged.

## 9. Bảng màu sáng và tối

| Vai trò | Sáng | Tối | Ví dụ |
|---|---|---|---|
| Logo, tiêu đề Markdown | `#995b49` | `#d7a38d` | logo, tiêu đề và đầu bảng |
| Mờ / `⎿` / tóm tắt | `#6e7171` | `#a9abae` | `Ran 1 shell command`, `✻ … for 8s` |
| Rule ô nhập / spinner đang xử lý | `#3465a4` | `#81a2be` | `────`, `Exploring…` |
| Nhấn chọn `❯` | `#05727e` | `#8abeb7` | `❯ 1. Yes`, plan mode |
| Đường dẫn / liên kết | `#526486` | `#afb8d4` | `a.txt`, liên kết Markdown |
| Lệnh / giá trị cấu hình | `#3d6875` | `#98c3cf` | `/config`, khóa TOML/JSON |
| Chế độ shell | `#80586b` | `#cb9faf` | dấu `!`, nhãn `Bash` |
| Nhãn thinking / từ khóa cú pháp | `#6c557a` | `#c0afd1` | `✻ Thinking…`, biến môi trường, giá trị boolean |
| Mã nội dòng / chuỗi trong khối mã | `#49684d` | `#acc6a7` | `` `echo` ``, `"hello"` |
| Nền tin user | `#f2f3f3` (chữ `#2e3434`) | `#353940` (chữ `#ffffff`) | `❯ prompt` |
| Nền panel diff | `#f5f5f5` | `#262626` | panel phải |
| Diff thêm / xoá (nền) | `#e0e4e1` / `#e8e1e2` | `#3a403b` / `#423b3c` | diff |
| Cảnh báo | `#795e37` | `#dfc290` | `Accessing workspace:` |

`auto` phải chọn sáng/tối theo **nền terminal thật** (OSC 11, COLORFGBG), không theo macOS. Chỉ dùng token, không mã màu rời.

Tên lệnh trong gợi ý và `/help` có màu riêng. Dòng nhập Bash, nội dung thinking và đầu ra công cụ dùng chữ trung tính với nhãn có màu. Lệnh shell nhiều dòng được tô cú pháp Bash khi mở rộng.

Trong `/theme`, di chuyển con trỏ để xem màu lệnh, thinking, trạng thái, Bash và diff trên nền của theme. Màn hình hẹp giữ mẫu gọn. Chọn **Code colors** để bật hoặc tắt tô cú pháp ngay trong preview. **Enter** khi đứng ở tên theme sẽ lưu theme. **Esc** hủy theme đang xem trước. Preview cũng báo khả năng màu của terminal.

**Midnight** dùng nền xanh đậm với màu cyan, tím và hổ phách. **Parchment** dùng nền giấy ấm với màu cobalt, mận và xanh lá đậm. Các màu chữ chính được kiểm thử ở mức tương phản 4,5:1 trên nền chính, panel và ô nhập. Terminal chỉ có 16 màu dùng bảng ANSI tương ứng. `NO_COLOR` bỏ màu chữ và nền, giữ nguyên nhãn và ký hiệu.

Auto, Dark và Light dùng nền sẵn có của terminal cho toàn bộ vùng chat. Midnight và Parchment tô nền một lần cho cả khung TUI để khoảng trống, câu trả lời, Thinking và ô nhập cùng một màu. Tin nhắn người dùng và diff dùng màu nền riêng để dễ nhận biết.

## 10. Còn phải chụp (G0b)

Hộp quyền Bash/Fetch/MCP/ngoài sandbox; todo đang chạy + Ctrl+T; footer `1 shell` khi shell nền còn chạy và panel `↓ to manage`;
subagent đang chạy; Ctrl+C hai lần thoát; `/model`, `/theme` riêng từng phiên sạch; trust ở 120 cột; light và dark cố định.


## P2 — trạng thái triển khai SDK 1.38 (2026-11-20)

Các API P1 được nối bằng public SDK, không gọi core/workspace/persistence từ TUI. Background completion chỉ nhận event
đã có `delivery` từ backend, lọc session và deduplicate task id; không tự tạo vòng agent thứ hai. Queue lấy snapshot SDK,
retract atomically tại dòng đầu, prepends trước nháp; text đã claim không bị lấy lại. Ảnh dùng attachImage và pending attachment
SDK, chip chọn/xoá riêng; clipboard PNG macOS được đọc có timeout/bounds (OS thật Needs verification).

Plan approval có Markdown, ba lựa chọn và feedback; Lựa chọn đầu được focus như reference; Enter xác nhận lựa chọn hiện tại, không đổi quyền trước khi xác nhận. Esc huỷ request qua turn signal, không mở rộng quyền.
`Shift+Tab` tại feedback báo chưa có approve+feedback atomic trong SDK; Enter gửi yêu cầu sửa plan và giữ plan mode. Không có artifact path trong PlanProposal nên Ctrl+G báo lý do không hỗ trợ.
Rewind có đủ năm lựa chọn; both/conversation/code gọi rewind, xung đột hiển thị; summarize disabled vì SDK chỉ hỗ trợ ba scope.
MCP nhóm theo source snapshot, management unsupported ghi rõ. Hooks không cấu hình và execution supported:false; event hook.ran
hiện `⎿  <Name> says: …` và số PostToolUse ở detail mode.

Panel diff chiếm 54 cột gồm separator và padding (52 cột body); transcript thu hẹp; composer vẫn đủ chiều rộng.
Chỉ nguồn Current có SDK. Ctrl+X B và ←/→ khi focus báo lý do thiếu base session/branch, không đổi nguồn giả.
`/diff` và auto-open sau receipt sửa file đầu tiên đều giữ focus ở composer: nhập/sửa/gửi prompt và cuộn transcript bên trái vẫn hoạt động.
Panel: Tab chuyển focus vào diff; ↑/↓, j/k chọn file, Enter detail (↑/↓, j/k cuộn), Esc về list rồi prompt; ←/→ đổi nguồn, PgUp/PgDn cuộn. Ctrl+↑/↓ hoặc Meta+↑/↓ và Ctrl+X B vẫn dùng từ prompt. Click file chọn, source đổi nguồn, ✕ đóng; wheel trong panel chỉ cuộn diff. Footer đọc keymap remap; `/diff` lần nữa đóng panel. Xem [interaction audit](diff-interaction-parity.md).
Dưới 110 cột từ chối mở với đúng câu trong §2. Nền panel lấy token `panel` (#f5f5f5 / #262626).

Kiểm tra giao diện: plan và rewind choices 80×12, auto diff 120×36, narrow 80/109; màu FORCE_COLOR=3 của plan so dark reference
L12 `.colors.json`, diff add/remove/panel backgrounds theo §9. `[` kiểm tra PTY alternate screen, `v` kiểm tra editor executable thật.
Không tuyên bố 100% hay nghiệm thu live provider/clipboard; xem `keys-status.md` và `p2-status.md` cho kết quả và yêu cầu SDK.


## P3 — SDK/backend 1.39 (2026-11-20)

Phần này thay các nhánh SDK-blocked của P2. DiffPanel nhận effective base/capabilities từ SDK;
Ctrl+X B (`app:cycleDiffBase`) trong context DiffPanel và ←/→ cycle Current → Uncommitted → Branch, skip nguồn không có và hiện lý do.
Header `source: <Base> ▾`. Report giới hạn và policy-filter; completion cũ không thay nguồn hiện tại.

Plan footer `ctrl+g to edit in <editor> · <plan path>` dùng artifact bền đã redact; Ctrl+G mở bản sao 0600,
suspend/resume terminal, submit text đổi qua SDK và yêu cầu review tiếp. Shift+Tab ở feedback approve+feedback atomically;
Enter feedback vẫn request changes. Không đưa bypass vào lựa chọn nếu launch chưa bật (P3 chỉ đưa acceptEdits/manual).

Rewind Summarize from here bật và có focus instructions tùy chọn; model summary chỉ thay context trong fork,
không sửa journal hay restore code, cancellation không ghi và model failure có extractive fallback.
↑ dùng selective retraction atomic: lấy text trước draft, shell chỉ lấy khi sole queue entry và ô trống (giữ `!`).
ModelPicker `s` và EffortSlider `s` chỉ áp dụng phiên hiện tại. Ctrl+R title `Search prompts · <scope>`, có `<11h ago>`
bên trái prompt; Ctrl+S cycle session → project → everywhere từ stored sessions. Workspace không rõ không lọt project history.
Alt+O/Alt+T giữ Not implemented vì chưa có provider contract tương ứng; xem [ADR0074](../../adr/0074-p3-review-and-session-controls.md).


P3 fix round: nguồn Current so bounded workspace snapshot đầu phiên (kể cả file do Bash tạo/sửa), không chỉ patch receipts;
checkpoint JSON giữ snapshot để resume. `/review` luôn lấy Uncommitted so HEAD, độc lập nguồn đang chọn trong panel;
ask-policy filenames được kèm contentWithheld, không gửi old/new contents. Xem ADR0074 và p2-status.md cho bằng chứng/giới hạn.
