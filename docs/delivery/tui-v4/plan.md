# TUI v4 — kế hoạch giống 100% Claude Code (bản sửa 2026-11-19 tối)

## Sửa sai

Đặc tả `claude-code-parity.md` và ADR 0065 (inline, bỏ fullscreen) dựa trên một bản chụp **sai môi trường**: Claude Code được
chạy với biến `CLAUDE_CODE_*` thừa hưởng từ phiên con nên rơi về chế độ inline. Chụp lại khi đã bỏ các biến đó (PTY 100×30)
thì Claude Code 2.1.328 **toàn màn hình** (alternate screen): banner ở hàng 1, ô nhập/footer dính đáy (hàng 24–29), transcript
cuộn ở giữa. Ảnh chụp phiên thật của user (2026-11-19 22:49, Orca) cũng thế. Từ giờ **chỉ khung chụp thật mới là nguồn**;
mọi mục "theo hiểu biết" phải được chụp lại trước khi code.

## Nguyên tắc

1. **Tham chiếu trước, code sau.** Mỗi bề mặt có một khung tham chiếu thật (text + màu) trong `docs/delivery/tui-v4/reference/`
   (đã bỏ dữ liệu riêng tư: tên org, path, nội dung phiên). Không có khung thật → không được đánh dấu xong.
2. **So bằng máy.** Một harness chụp Cosmew và Claude Code cùng kích thước, chuẩn hoá phần được phép khác (tên sản phẩm, logo,
   model, path, số liệu thời gian/token) rồi so từng dòng + bảng màu. Mỗi bề mặt = một test chấp nhận.
3. Thương hiệu: không dùng tên/logo Claude trong UI; mọi thứ khác (bố cục, ký hiệu, câu chữ, màu, phím, nhịp) giống.
4. Ranh giới kiến trúc giữ nguyên (`apps/tui` chỉ dùng SDK). Thứ gì cần backend mới (ví dụ rewind, `/btw`) → ghi vào mục
   "cần backend", không giả lập thành công.

## Danh mục bề mặt (không bỏ sót)

Cột "Chụp": I = chụp được khi rảnh (không tốn tiền), R = chụp bằng resume một phiên có sẵn (không gọi model),
L = cần một lượt model thật (tốn chút usage), ? = chưa biết là của Claude Code hay của Orca.

| # | Nhóm | Bề mặt | Chụp |
|---|---|---|---|
| 1 | Khung | Fullscreen alternate screen, banner trong luồng transcript, viewport cuộn giữa, ô nhập + footer dính đáy; resize; màn thấp/hẹp; thoát trả lại màn hình + dòng resume | I |
| 2 | Khung | Cuộn: wheel chuột, PgUp/PgDn, opt+↑/↓, chỉ báo `↓ N more below`, tự bám đáy khi stream, nhảy về đáy | I/R |
| 3 | Khung | Chọn text + copy trong fullscreen (chuột), tiêu đề cửa sổ terminal, chuông/thông báo khi xong | I/L |
| 4 | Khởi động | Trust folder, onboarding theme lần đầu, cảnh báo (`⚠ …`), thông báo hook SessionStart `⎿ … says:` | I |
| 5 | Ô nhập | Placeholder xoay vòng, nhiều dòng, `\`+Enter, dán dài thành chip, ảnh, `@` file menu, `/` menu, history ↑/↓, Ctrl+R search, stash Ctrl+S, undo, Ctrl+G editor, bash mode `!`, chỉ báo effort `◐ … · /effort` | I |
| 6 | Ô nhập | Tin nhắn xếp hàng khi đang chạy (queued), steer, Esc ngắt, Esc Esc | L |
| 7 | Footer | Dòng chế độ 4 trạng thái + màu, `? for shortcuts`, bảng `?`, tác vụ nền `· 1 shell · ← 1 agent · ↓ to manage`, thông báo tạm (Ctrl-C again, Esc again), context left / auto-compact | I/L |
| 8 | Transcript | Tin nhắn user, câu trả lời `●` + Markdown (heading, list, bảng, code tô màu, link) | R |
| 9 | Transcript | Tool **gộp** thành dòng tóm tắt (`Ran N shell commands · 1 failed`, `Made N edits +x, read N files`, `Searched …`), Ctrl+O mở rộng; tool đơn lẻ; lỗi; bị từ chối | R |
| 10 | Transcript | Thinking, dòng hook `⎿ Stop says:`, dòng kết thúc lượt `✻ Cooked for 2m 13s · done 10:48 PM · 1 shell still running`, interrupted, lỗi API, compaction | R |
| 11 | Transcript | Diff trong Edit/Write (số dòng, nền màu), todo/tasks (Ctrl+T), subagent (Task) đang chạy/xong, shell nền | R |
| 12 | Đang chạy | Spinner (glyph, động từ shimmer, thời gian, token, `esc to interrupt`), tip dưới spinner | L |
| 13 | Hộp thoại | Quyền: Bash, Edit (diff), Write, Fetch/domain, MCP, sandbox/không sandbox; vị trí trong layout (thay ô nhập, không modal) | L |
| 14 | Hộp thoại | Câu hỏi (AskUserQuestion: tab, chọn nhiều, preview bên cạnh), duyệt plan (thoát plan mode) | L |
| 15 | Lệnh | `/model`, `/config`(=`/settings`), `/status`, `/help`, `/resume`, `/agents`, `/memory`, `/permissions`, `/theme`, `/context`, `/cost`/`/usage`, `/doctor`, `/mcp`, `/hooks`, `/compact`, `/clear`, `/login`/`/logout`, `/export`, `/rewind` | I |
| 16 | Panel | Transcript mode (Ctrl+O toàn màn), quản lý tác vụ nền (`↓ to manage`), khung diff bên phải (`226 files changed … source: Current`, `opt+↓ to scroll`) | I/? |
| 17 | Màu | Theme dark/light (+ các biến thể nếu có), từng token: brand cam, dim, rule, success, error, warning, permission, plan, accept-edits, bash, diff nền, nền tin nhắn user | I |
| 18 | Khác | Non-TTY một khung (giữ của Cosmew), màn 36 cột, Unicode/CJK, không màu (`NO_COLOR`) | I |

## Các pha

| Pha | Ai | Việc | Xong khi |
|---|---|---|---|
| G0 | điều phối (tôi) | Harness chụp: PTY + `pyte`, lưu text **và** màu; chụp mọi bề mặt I; resume một phiên cũ để chụp R; xác minh mục 16 (Claude Code hay Orca). Lượt L: **cần user đồng ý** chạy 2–3 prompt rẻ trong thư mục demo (permission Bash/Edit, câu hỏi, spinner, queued) | Mọi dòng bảng có khung tham chiếu hoặc ghi rõ lý do không chụp được |
| G1 | điều phối | Viết lại `claude-code-parity.md` từ khung thật: mỗi bề mặt = khung tham chiếu + khung Cosmew hiện tại + khác biệt; huỷ các dòng [K] sai (ví dụ `⏺` → `●`, tool gộp) | User xem và đồng ý |
| G2 | Codex `v4-fullscreen` | ADR 0066 thay 0065: quay lại fullscreen (dùng lại code ADR 0064 trong git), layout đúng khung thật, cuộn (wheel/PgUp/opt+↑↓, `↓ N more below`), thoát + resume | Test so khung mục 1–2 |
| G3 | Codex `v4-transcript` | Mục 8–11: `●`, tool gộp + mở rộng, dòng kết thúc lượt, hook, diff, todo, subagent | Test so khung mục 8–11 |
| G3 | Codex `v4-input` | Mục 5–7: ô nhập, footer, tác vụ nền | Test so khung mục 5–7 |
| G3 | Codex `v4-dialogs` | Mục 13–15: hộp quyền/câu hỏi/plan đúng vị trí, mọi lệnh slash | Test so khung mục 13–15 |
| G4 | Codex `v4-panels` | Mục 12, 16, 3: spinner, transcript mode, panel tác vụ nền, (khung diff nếu là của Claude Code), chọn text/copy | Test so khung |
| G5 | Codex `v4-integrate` + điều phối | Ghép, harness so khung chạy trong CI (`tests/end-to-end/tui-reference.test.ts` so với khung tham chiếu đã chuẩn hoá), golden, docs, CLAUDE.md | Toàn bộ suite xanh ngoài sandbox; bảng danh mục 100% có test |

G3 chạy song song (vùng file tách rời); mọi pha khác tuần tự. Sau mỗi pha điều phối chạy typecheck, lint, toàn bộ suite ngoài
sandbox, chụp PTY và gửi khác biệt lại cho Codex.

## Trạng thái

- G0: 109 khung thật trong `reference/` (51 rảnh 100×30, 58 có model 120×36). Còn thiếu: xem `spec.md` §10 (G0b).
- G1: [spec.md](spec.md) viết xong, chờ user xem.
- Codex hết hạn mức tới 2026-11-20 02:08; G2+ dùng agy `gemini-4-argon-high` nếu cần chạy trước giờ đó.

## Pha F (dừng giữa chừng do Codex hết hạn mức)

Pha F đã làm: hộp thoại không che transcript, accent `#d77757`. Sai: mặc định `dark` (terminal của user nền trắng) — G2 sửa theo spec §9. Phần "inline/scrollback"
trong ADR 0065 sẽ bị ADR 0066 thay ở G2.

## G2 (2026-11-19)

ADR 0066 viết xong và thay ADR 0065: alternate screen, đáy cố định (hàng 24-29 ở 100×30), banner trong transcript, PgUp/PgDn + chip `Jump to bottom`, panel `▔` / hộp thoại `─` ở đáy, theme `auto` theo OSC 11 (≤150 ms) rồi `COLORFGBG`, màu đo từ khung thật. Bản chụp Cosmew: `cosmew-g2/`. Còn thiếu: cuộn bằng chuột (Ink 8 không có sự kiện chuột), tab trong panel, menu `/` 2 cột, chữ footer `⏸ manual mode on`, glyph transcript (G3).
