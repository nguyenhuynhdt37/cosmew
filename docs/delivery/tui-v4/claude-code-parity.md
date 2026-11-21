# TUI v4 — giao diện CLI giống Claude Code

> **Đã bị thay (2026-11-19 tối):** đặc tả này dựa trên bản chụp sai môi trường (inline). Nguồn hiện hành: [spec.md](spec.md) + [plan.md](plan.md) + khung thật trong `reference/`. Phần dưới giữ làm lịch sử pha A–E.

Ngày 2026-11-19. Yêu cầu user: "phân tích và điều phối xây lại giao diện cli của hannes này giống 100% như claude code".
Quyết định của user cùng ngày: **render inline như Claude Code**, bỏ fullscreen/alternate screen của ADR 0064 (ADR 0065 thay thế).

Phạm vi: chỉ lớp trình bày `apps/tui` (Ink 8, React 19). Hành vi agent, quyền, sandbox, SDK, contract không đổi.
Ranh giới ADR 0059/0060 giữ nguyên: `apps/tui` chỉ dùng `@cosmew/sdk` + `@cosmew/contracts`.

**Thương hiệu:** giống bố cục, ký hiệu, câu chữ, phím tắt, nhịp tương tác của Claude Code; **không** dùng tên "Claude",
logo Claude, hay chữ "Claude Code" ở bất cứ đâu. Tên sản phẩm là Cosmew, logo 3 dòng là glyph riêng của Cosmew,
chỗ Claude Code viết "Claude" thì Cosmew viết "Cosmew" hoặc tên model.

## Nguồn tham chiếu

- **[C] Chụp thật**: Claude Code `2.1.328`, macOS, PTY 100×40, giả lập bằng `pyte 0.8.2`, thư mục rỗng, 2026-11-19.
  Các khung: trust, welcome, `?` shortcuts, `/` menu, Shift+Tab qua các chế độ. Không gửi prompt (không tốn tiền).
- **[K] Theo hiểu biết, Needs verification**: khung trong lượt chạy (tool, diff, spinner, hộp quyền, todo, picker).
  Chưa chụp vì cần một lượt có model. Pha E chụp lại bằng cách resume một transcript tổng hợp (không gọi model) và sửa đặc tả.
- Cosmew hiện tại: cùng PTY 100×40, `bun apps/cli/src/index.ts`, commit `8bd8064` + working tree 2026-11-19.

## Khung tham chiếu [C] (đã bỏ dòng thông báo plugin/hook riêng của máy chụp)

Trust:

```
────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/…/scratchpad/
 demo

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
```

Welcome + composer rảnh (inline: nội dung cao bằng nội dung, không phủ cả màn):

```
 ▐▛███▛█   Claude Code v2.1.328
▝▜██████▀  Opus 5.5 with medium effort · Claude Pro
 ▝▝   ▝▝   /…/scratchpad/demo

                                                                                ◐ medium · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "fix typecheck errors"
────────────────────────────────────────────────────────────────────────────────────────────────────

  ⏵⏵ accept edits on (shift+tab to cycle)
```

Gõ `?` khi ô nhập rỗng (thay chỗ dòng chế độ, ký tự `?` không vào ô nhập):

```
  ! for shell mode        esc esc to clear input             ctrl+shift+_ to undo
  / for commands          shift+tab to cycle modes           ctrl+z to suspend
  @ for file paths        shift+↑/↓ to change effort         ctrl+v to paste images
  /btw for side question  ctrl+o to see full transcript      opt+p to switch model
                          ctrl+t to toggle tasks             ctrl+s to stash prompt
                          backslash (\) then enter for       ctrl+g to edit in $EDITOR
                          newline                            /keybindings to customize
```

Gõ `/` (menu nằm **trên** đường kẻ của composer, cột tên ~40 ký tự, mô tả xuống dòng trong cột 2, tối đa 2 dòng rồi `…`):

```
  ❯ /superpowers:systematic-debugging       (superpowers) Use when encountering any bug, test
                                            failure, or unexpected behavior, before proposing fix…
    /code-review                            3 free /ultrareview · Review the current diff or a PR
                                            for bugs
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /
────────────────────────────────────────────────────────────────────────────────────────────────────
```

Dòng chế độ dưới composer (Shift+Tab xoay vòng): `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`,
`⏵⏵ bypass permissions on (shift+tab to cycle)`; chế độ `default` hiện `? for shortcuts` [K]. Dòng cảnh báo `⚠ …` (vàng) nằm giữa đường kẻ dưới và dòng chế độ.

## Khung Cosmew hiện tại (cùng PTY)

```
✻ COSMEW · idle
/private/tmp/…/scratchpad/de                      ← header cắt cụt, không có trong Claude Code
Quiet desk. Clear answers.                         ← tagline
grok-4.7 · xai

/help commands  @ files  $ skills  Shift+Enter new line  Shift+Tab permissions
╭────────────────────────────────────────────────╮ ← hộp bo 4 cạnh thay vì 2 đường kẻ
│ ›  Ask anything…                               │ ← `›` thay vì `❯`, placeholder khác
╰────────────────────────────────────────────────╯
Enter send  Shift+Enter new line  Ctrl+R search history  / @ $ commands · files · skills
grok-4.7  effort default  mode default  0 agents running          ← status line luôn hiện
context [----------] unknown · in ? / out ? · cost unreported
```

Trust của Cosmew là hộp bo viền, lựa chọn `Allow for this session` / `› Exit`, gợi ý `↑↓ Select · Enter Confirm · Esc Exit`.
`?` bị gõ vào ô nhập. Menu `/` có `›`, tên và mô tả cùng dòng, kèm phím tắt `[Ctrl+L]`. Shift+Tab chỉ đổi chữ `mode …` trong status.

## Bảng khác biệt và đích

| # | Bề mặt | Cosmew hiện tại | Đích (Claude Code) | Nguồn | Pha |
|---|---|---|---|---|---|
| 1 | Mô hình render | Alternate screen, viewport, PageUp/Down (ADR 0064) | Inline: mục đã xong vào `<Static>` (scrollback terminal), vùng sống ở đáy: spinner, todo, menu, composer, footer. Không alternate screen. Cuộn/chọn text bằng terminal | C | A |
| 2 | Header | `✻ COSMEW · idle` + cwd mỗi khung | Không có header. Chỉ banner welcome một lần ở đầu (vào Static) | C | A |
| 3 | Welcome | Tagline, `model · provider`, dòng gợi ý | Logo 3 dòng bên trái (glyph Cosmew riêng); phải: `Cosmew v<version>` đậm / `<model> with <effort> effort · <account label>` mờ / cwd rút gọn `/…/<đuôi>` (giữ phần cuối vừa chiều rộng) | C | A |
| 4 | Trust | Hộp bo, `Allow for this session`/`Exit` | Đường kẻ trên, ` Accessing workspace:` đậm, path, đoạn "Quick safety check…", `Cosmew will be able to read, edit, and execute files here.`, **giữ dòng của Cosmew** về request kiểm tra tài khoản (ADR 0014), `❯ No, exit` / `Yes, I trust this folder` (con trỏ mặc định ở No, exit như Claude Code), `Enter to confirm · Esc to cancel`. Consent được lưu một lần cho canonical workspace theo ADR 0075; quyền từng tool vẫn hỏi riêng | C | D |
| 5 | Composer | Hộp bo 4 cạnh, `›`, `Ask anything…` | Đường kẻ `─` full width trên và dưới, `❯ ` (dòng tiếp theo thụt 2), placeholder mờ `Try "<ví dụ>"` (danh sách ví dụ xoay vòng của Cosmew); `!` đổi prompt thành `!` màu bash-mode (hồng) và đường kẻ cùng màu; `#` memory mode tương tự [K] | C/K | C |
| 6 | Effort | `effort default` trong status | Dòng phải trên đường kẻ trên: `◐ <effort> · /effort` (ẩn nếu model không quảng bá effort); Shift+↑/↓ đổi effort | C | C |
| 7 | Footer | 2 dòng gợi ý + 2 dòng status | 1 dòng chế độ (mục dưới). Không status line mặc định. Thông báo tạm thay dòng chế độ: `Press Ctrl-C again to exit`, `Esc again to clear`, `Context left until auto-compact: N%` (phải, khi < 20%) [K] | C/K | C |
| 8 | Chế độ quyền | `mode accept edits` trong status | `? for shortcuts` (default), `⏵⏵ accept edits on (shift+tab to cycle)`, `⏸ plan mode on (shift+tab to cycle)`, `⏵⏵ bypass permissions on (shift+tab to cycle)` (đỏ). Thứ tự xoay: default → acceptEdits → plan → bypass (chỉ khi được phép) → default | C | C |
| 9 | `?` | Bị gõ vào ô nhập | Ô rỗng + `?` mở bảng phím tắt 3 cột thay dòng chế độ; phím bất kỳ đóng. Chỉ liệt kê phím Cosmew thực sự hỗ trợ (`$ for skills` thay `/btw` nếu chưa có `/btw`) | C | C |
| 10 | Menu `/` | `›`, một dòng, `[Ctrl+L]` | Trên đường kẻ, thụt 2, `❯` + mục chọn màu nhấn, cột tên rộng cố định, mô tả wrap ≤ 2 dòng + `…`, ~5 mục, Tab hoàn tất, Enter chạy. `@` file và `$` skill cùng kiểu | C | C |
| 11 | Tin nhắn user | `> prompt` | `> prompt` mờ, nền xám nhạt cả dòng [K] | K | B |
| 12 | Câu trả lời | `⏺ text` | `⏺ ` (trắng) + Markdown; đoạn sau thụt 2 | K | B |
| 13 | Tool call | `⏺ read(note.txt) · ok · Ctrl+O` / ` ⎿ output` | `⏺ Read(note.txt)` (chấm xanh khi xong, đỏ khi lỗi, mờ nhấp nháy khi chạy, không chữ `· ok`); dưới: `  ⎿  Read 42 lines (ctrl+o to expand)`. Tên hiển thị: read→`Read`, glob/grep→`Search(pattern: "…", path: "…")` + `Found N files`/`Found N lines`, edit/apply_patch→`Update(path)` + `Updated path with A additions and R removals` + diff, write→`Write(path)` + `Wrote N lines to path`, exec_command→`Bash(cmd)` + 3–5 dòng đầu + `… +N lines (ctrl+o to expand)`, write_stdin→`Bash(stdin)`, web_fetch→`Fetch(url)`, web_search→`Web Search("q")`, agent→`Task(<mô tả>)` / tên agent type, update_plan→`Update Todos`, lsp→`LSP(op)`, skill→`Skill(name)`. Lỗi: `⎿  Error: …` đỏ; từ chối: `⎿  User rejected <tool>` | K | B |
| 14 | Diff | Có +/−, số dòng | Số dòng cột trái, dòng thêm nền xanh, dòng xoá nền đỏ, thụt dưới `⎿` [K] | K | B |
| 15 | Thinking | `✻ Thinking…` | `✻ Thinking…` mờ nghiêng; Ctrl+O để xem | K | B |
| 16 | Spinner | Có động từ/thời gian | Glyph xoay `·✢✳✶✻✽` (ngược lại), động từ + `…` có hiệu ứng shimmer màu nhấn, `(12s · ↓ 1.2k tokens · esc to interrupt)`; nằm ngay trên composer, có dòng trống phía trên; danh sách động từ riêng của Cosmew | K | B |
| 17 | Todo | Plan ghim trên composer, `[----]` | Kết quả tool: `⏺ Update Todos` + `⎿  ☐ việc` / `☒ việc` (gạch, mờ) / việc đang chạy đậm. Khi đang chạy: todo dưới spinner `⎿  ☐ …`; Ctrl+T ẩn/hiện. Bỏ thanh `[----]` | K | B |
| 18 | Hộp quyền | Đã có lựa chọn đánh số | Đường kẻ trên (không hộp bo), tiêu đề màu nhấn (`Bash command` / `Edit file` / `Fetch` …), nội dung thụt (lệnh + mô tả mờ, hoặc diff), `Do you want to proceed?` / `Do you want to make this edit to <file>?`, `❯ 1. Yes`, `2. Yes, and don't ask again for <prefix> commands in <dir>` (hoặc `Yes, allow all edits during this session (shift+tab)`), `3. No, and tell Cosmew what to do differently (esc)`. Giữ ngữ nghĩa phạm vi hiện có của Cosmew (lần này/phiên/luôn cho project/không + lý do), cảnh báo `NO SANDBOX`, mạng | K | D |
| 19 | Picker (`/model`, `/resume`, `/agents`, `/memory`, `/permissions`, `/config`=`/settings`, `/theme`, `/help`) | ListPicker chung | Đường kẻ trên, tiêu đề đậm, mô tả mờ, mục đánh số `❯ 1. Name  mô tả` với `✔` cho mục hiện dùng, gợi ý cuối `Enter to confirm · Esc to exit`. `/help`, `/config`, `/permissions`, `/status` dạng tab ngang (`←/→` hoặc Tab) [K] | K | D |
| 20 | Phím | Ctrl+R, Shift+Enter, Ctrl+O | Thêm: Esc Esc xoá ô nhập (ô rỗng: mở chọn tin nhắn trước để sửa/rewind nếu SDK có, không thì "Not implemented"), Ctrl+_ undo, Ctrl+Z suspend, Ctrl+V dán ảnh (dùng `clipboard.ts`), Ctrl+T todo, Ctrl+G mở `$EDITOR`, Ctrl+S cất prompt, Opt+P chọn model, Ctrl+C hai lần để thoát, `\`+Enter xuống dòng | C | C |
| 21 | Thoát | Unmount | Không xoá màn hình; in dòng mờ `Resume this session with: fyn --resume <id>` nếu có phiên [K] | K | A |
| 22 | Non-TTY | Một khung `renderToString` | Giữ nguyên | — | — |

Không làm trong đợt này (không có backend tương ứng, phải in "Not implemented" nếu người dùng gọi): `/btw`, `/keybindings`, rewind hội thoại nếu SDK chưa có, status line tuỳ biến.

## Chia việc (Codex `gpt-6.1-sol`, reasoning medium)

| Pha | Agent | Vùng file | Nội dung |
|---|---|---|---|
| A | `v4-shell` (chạy trước, 1 agent) | `ink/{runtime,screen,integrated-shell,app}.tsx`, `ink/core/**`, `ink/hooks/**`, `ink/ui/**`, `ink/features/{header,welcome,status,context-meter}/**`, `ink/testing/fullscreen.test.tsx`, ADR 0065 | Mục 1, 2, 3, 21; bỏ alternate screen, quay lại Static + vùng sống; component nền `Rule` (đường kẻ full width), `Pointer` `❯`, token màu kiểu Claude Code trong theme hiện có |
| B | `v4-transcript` | `ink/features/{transcript,diff,plan,subagents,notices}/**`, spinner trong `ink/ui/spinner.tsx` | Mục 11–17 |
| C | `v4-composer` | `ink/features/{composer,autocomplete,history,paste,status}/**`, keymap `ink/hooks/keymap*` | Mục 5–10, 20 |
| D | `v4-dialogs` | `ink/features/{startup-gate,permissions,question,picker,connect,models,sessions,settings,themes,help,memory,agents,skills,usage}/**` | Mục 4, 18, 19 |
| E | `v4-integrate` | toàn `apps/tui`, golden, PTY, docs | Ghép, golden mới (80/36), PTY inline, chụp tham chiếu [K] bằng resume transcript tổng hợp, cập nhật parity/CLAUDE.md |

B, C, D chạy song song sau A. Mỗi agent chỉ sửa vùng của mình; cần đổi vùng khác thì ghi vào báo cáo. Không commit,
không thêm dependency, không đổi `packages/**`. Người điều phối chạy `bun run typecheck`, `bun run lint`, `bun test tests`
và test `apps/tui` sau mỗi pha và gửi lỗi lại cho agent.

## Tiêu chí xong

- Khung PTY 100×40 của Cosmew khớp các khung [C] ở trên theo từng dòng, chỉ khác tên sản phẩm/logo/model/đường dẫn.
- Mọi hàng PASS trong `docs/delivery/tui-v3/parity.md` vẫn PASS (luồng, quyền, câu hỏi, plan, subagent, skills, memory, compact).
- Khung [K] được chụp tham chiếu ở pha E; chỗ nào lệch thì sửa hoặc ghi rõ khác biệt còn lại.
- Không tuyên bố "Product MVP complete"; live provider vẫn Needs verification.

## Kết quả pha A–E

Ngày 2026-11-19. A–D đã ghép vào host ở pha E; không thêm dependency, không đổi
public contract hay `packages/**` trong pha E, không commit.

- **A:** inline theo ADR 0065: welcome/nhật ký hoàn tất vào một `Static`, vùng sống
  ở đáy, không alternate screen. Thoát giữ scrollback; CLI nhận cả `fyn resume <id>`
  và alias `fyn --resume <id>`, hint dùng alias mới.
- **B:** tool card tên Read/Search/Update/Write/Bash/Task, receipt/diff, markdown,
  thinking, spinner và checkbox todo. Host giữ đúng một spinner sau notices/subagents,
  rồi tới todo khi lượt đang chạy, composer và footer. Ctrl+T chỉ ẩn/hiện todo;
  không sửa plan bền vững. Sửa lỗi shell card `Bash()` do host truyền `command`
  thay vì trường canonical `cmd`.
- **C:** composer `❯`, hai đường kẻ, effort/menu/footer/phím theo bảng trên.
  Host dùng chiều rộng input `width - 3`; Ctrl+S cất prompt, bỏ shortcut /resume
  và /theme cũ; ready Ctrl+C cần hai lần, startup vẫn huỷ ngay. Esc/Shift+Tab/Ctrl+O
  đóng bảng shortcuts trước hành động toàn cục; overlay giữ quyền sở hữu input.
- **D:** trust mặc định từ chối, giữ consent theo phiên và thông báo request có thể
  tính phí. Panel/picker dùng Rule/Pointer, mô tả inline, dấu ✔ độc lập cursor,
  footer xác nhận; help/settings/permissions/status có tab. Quyền giữ nguyên
  once/session/always/deny, stale hash, diff đề xuất, subagent attribution,
  NO SANDBOX, revocation và lý do từ chối; chỉ đánh số những scope SDK thực sự cho.
  Question đổi cách trình bày, vẫn cần submit rõ ràng, giữ lựa chọn khi đổi tab.
- **E:** cập nhật helper/waits/assertions theo copy mới; sửa cách nhận diện composer
  sau startup để phiên resume ở mode plan/acceptEdits không bị chờ footer default.
  Không bỏ assertion về consent, scope, denial, redaction, thứ tự hay receipt.
  Snapshot nền được review; golden 80/36 cột được đọc candidate trước khi chạy
  `UPDATE_GOLDEN=1`: bỏ viền bo và progress bar, đổi pointer/tool title, checkbox,
  indentation và khoảng trống. Dòng Unicode vẫn wrap trong chiều rộng tương ứng.

Bằng chứng D được chuyển từ `features/picker/phase-d-report.md` (file đó đã xoá):
52 tests / 323 assertions của logic, dialogs, v4-dialogs, startup-gate từng PASS;
kiểm picker 80/36 cột, scope/key không được SDK cấp không resolve được request,
network always đúng settings target, tab không lọc nhầm, 80×12 vẫn thấy choices/
NO SANDBOX/denial field, default Enter không grant; unmount question settle waiter,
trust refusal không probe/không bật tools và unmount thu hồi consent.

Bằng chứng E: host integration kiểm một spinner → todo → composer, toggle không
đổi plan, không toggle sau overlay, shortcuts không đổi mode/mở history, stash
không mở sessions, Ctrl+C đầu giữ tools và lần hai mới shutdown. Native PTY dùng
SDK ports tổng hợp, không HTTP/provider/tool process: replay một lần sau consent,
Read card, session permission, stream/todo, Ctrl+T, resize 80→36, draft, Esc cancel,
Ctrl+C hai lần, resume hint, exit 0 và không có alternate-screen enter/leave đều PASS.
Đây là bằng chứng terminal thật trên fixture; không chứng minh provider hay Seatbelt.

`bun run format`, `bun run typecheck`, `bun run lint` PASS. Lần cuối
`bun test tests apps`: **643 PASS / 7 SKIP / 298 FAIL**, 16.615 assertions,
6 snapshots; mọi test `apps` PASS. 298 ca còn lại thuộc bind port (244), native
sandbox/runtime (51), process observation (2), watcher (1). Stress transcript
1.100 dòng dùng budget 15 giây, giữ nguyên kiểm history/once-only; latency PTY
250 ms không đổi. Kết quả chi tiết và danh sách cần chạy lại ngoài sandbox ở
[phase-e-validation.md](phase-e-validation.md). Tham chiếu upstream [K], shimmer
trên terminal người dùng và provider đăng nhập thật vẫn **Needs verification**;
không coi frame fixture là xác minh hình ảnh upstream hay Product MVP complete.

## Pha F — màu terminal và dialog inline

Ngày 2026-11-19, theo phản hồi người dùng: UI gần như đen/trắng, cảnh báo/câu hỏi
trông như modal. Bằng chứng do coordinator cung cấp: PTY ready frame Cosmew có
213 ô `#525252`, chỉ 11 ô accent; frame tham chiếu có accent/logo cam `#d77757`,
chữ mờ `#6e7171` và màu chế độ riêng. Đây là census do coordinator báo cáo,
không phải capture upstream mới của pha F; revision upstream chưa được cung cấp.

Nguyên nhân: `auto` đọc `AppleInterfaceStyle` của macOS, nên OS Light chọn palette
Light trên terminal nền đen. Host còn đặt `display=none` cho toàn vùng sống khi mở
overlay. Đã sửa:

- TUI mặc định **Dark** nếu chưa lưu appearance. Lựa chọn Dark/Light/Auto đã lưu
  tiếp tục thắng; Auto chỉ đọc `COLORFGBG`, thiếu thông tin thì Dark, không gọi
  chương trình macOS hay suy luận từ giao diện OS. Không thêm OSC query nên không
  có đọc stdin, timeout hoặc truy vấn nền ngoài TTY.
- Palette Dark: accent/logo/spinner/menu/title `#D77757`; chữ phụ `#999999`,
  rule `#888888`; success `#4EBA65`, error/bypass `#FF6B80`, warning `#FFC107`,
  permission/info `#B1B9F9`; plan `#48968C`, accept edits `#AF87FF`, bash
  `#FD5DB1`; nền diff thêm/xoá `#225C2B`/`#7A2936`, prompt user `#373737`.
  Light giữ chữ phụ `#666666`, accent cam và các biến thể semantic đủ tương phản
  trên trắng. **Needs verification against Claude Code**: các mã màu mục tiêu
  được coordinator đưa từ trí nhớ, không phải mã nguồn/capture đã xác minh.
- Welcome/model/effort, tool dot/title/receipt, mode footer, shortcuts, menu,
  warning, permission title/rule, diff và spinner dùng token. NO_COLOR vẫn bỏ màu.
- Permission, request_user_input và mọi picker thay composer/footer/spinner ngay
  trong flow. Transcript sống, subagents, notices và todo vẫn ở trên; không box
  bao, không làm mờ nền, không clear/replay scrollback. InputScope không đổi nghĩa.
  Terminal ngắn cấp chỗ cho choices trước, cắt đầu tail trước và giới hạn context
  nếu nội dung vượt quá chiều cao terminal.
- Test trust settings dùng đúng scope: request thực chỉ có session/always/deny,
  nên `2` là always, `3` là deny. Sửa e2e chọn `2`, giữ assertion rule thật được
  áp dụng và pending request được giải quyết. Không đổi security hoặc tự trust file.
- Sửa cảnh báo resize listeners: nhiều transcript row/rule từng tự gắn listener;
  nay các consumer chia sẻ một listener mỗi stdout và tháo khi unmount cuối cùng.

Bằng chứng fixture: regression bắt được default Auto sai và spawn macOS; test mới
kiểm saved Light/Auto, fallback/terminal background. Frame chạy trong process con
`FORCE_COLOR=3` kiểm ANSI RGB thực của welcome, spinner, tool success/error,
warning, mode, menu, title/rule permission và nền diff/user. Host 80×12 kiểm dòng
`⏺ Read(file)` nằm trên dialog, choices/denial luôn thấy, spinner/composer ẩn rồi
composer trở lại. Question/picker kiểm transcript vẫn hiện và draft phục hồi;
Static có test append-once qua rerender/reset. Test 16 consumer kiểm listener count,
resize 80→36 và cleanup về 0. Golden permission 80/36 được đọc candidate trước khi
chạy `UPDATE_GOLDEN=1`; golden transcript hiện có được ghi lại cùng lần.

Kết quả validation và danh sách cần chạy lại ngoài sandbox ở
[phase-f-validation.md](phase-f-validation.md). Độ khớp màu/shimmer với terminal
người dùng, upstream revision và live provider vẫn **Needs verification**.
