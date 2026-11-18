# TUI v3 — làm lại toàn bộ giao diện bằng Ink (kiểu Claude Code CLI)

> **Trạng thái 2026-11-18: xong.** Pha 0–3 đã hoàn tất: Ink là TUI duy nhất, `FUTRYN_TUI` và renderer cũ đã bị xoá. Bằng chứng và mục chưa làm: [parity.md](parity.md), ADR 0059/0060.

Ngày 2026-11-18. Yêu cầu user: làm lại toàn bộ TUI cho production, dùng thư viện, UI/UX tham khảo Claude Code CLI; điều phối Codex `gpt-6.1-sol` (medium), chia nhiều agent con theo phần.

## Quyết định

- **Thư viện:** Ink (React cho terminal — chính là thứ Claude Code CLI dùng). Phiên bản ghim, đều ≥ 2 tuần tuổi tại 2026-11-18:
  - `ink@8.0.0` (2026-10-03), `react@19.3.1` (2026-10-14), `@types/react@19.3.0` (2026-09-09)
  - `ink-testing-library@4.0.0` (test render), `marked@18.1.2` (2026-10-26, parse Markdown), `cli-highlight@2.1.11` (tô màu code)
  - Ghi tên/version/license vào `docs/delivery/dependency-catalog.md` khi thêm.
- **Ranh giới giữ nguyên:** `apps/tui` chỉ phụ thuộc `@futryn/sdk` + `@futryn/contracts` (dependency rules). Mọi hành vi đi qua SDK (command/event protocol); không đổi core/security. Mọi slash command, quyền, hỏi user, plan, subagent, skills, memories, compaction… phải còn đủ.
- **Chuyển đổi an toàn:** TUI mới viết trong `apps/tui/src/ink/` song song TUI cũ, chọn bằng `FUTRYN_TUI=ink` trong lúc làm; khi đạt bảng parity (mục cuối) thì đổi mặc định sang Ink và xoá renderer cũ trong cùng đợt (pha 3).
- **Cấu trúc:** giữ tinh thần ADR 0015 (mỗi tính năng một thư mục), nhưng thành component React: `ink/features/<name>/{index.tsx, logic.ts, view.tsx, use-<name>.ts}`; logic thuần giữ test đơn vị được; state lấy từ SDK qua hooks (`useFutrynClient`, `useEvents`).

## UI/UX lấy từ Claude Code CLI

- Khung chính: transcript cuộn tự nhiên trong scrollback (không full-screen alternate buffer trừ overlay), ô nhập dưới cùng có viền bo, dòng gợi ý phím dưới ô nhập, status line (model, chế độ quyền, context %, chi phí).
- Transcript: `> prompt` của user; `✻ Thinking…` có thể thu/mở; `⏺ Tool(arg)` + `⎿ output` rút gọn (Ctrl+O mở rộng); diff có màu +/− và số dòng; câu trả lời render Markdown (heading, list, bảng, code block tô màu); spinner có động từ và thời gian/token khi đang chạy; Esc để ngắt.
- Ô nhập: nhiều dòng (Shift+Enter / `\`+Enter), lịch sử ↑/↓, Ctrl+R tìm lịch sử, `/` gợi ý lệnh, `@` gợi ý file, `$` gợi ý skill, dán ảnh/văn bản dài thu gọn `[Pasted text #1 +40 lines]`, `!` chạy lệnh shell, `#` ghi nhớ nhanh vào memory.
- Hộp quyền kiểu Claude Code: tiêu đề tool, lệnh/diff xem trước, lựa chọn đánh số (1 Lần này / 2 Cả phiên / 3 Luôn cho project + rule sẽ lưu / 4 Không, nói lý do), phím tắt.
- Overlay chọn danh sách (model, tài khoản, phiên, theme, agents, memory, skills, settings, permissions) dùng chung một component chọn có lọc gõ chữ.
- Plan/todo ghim phía trên ô nhập; subagent hiện dạng cây gọn với tiến độ; thông báo nền (subagent xong, compaction) dạng dòng mờ.

## Chia việc (agent con chạy song song, mỗi agent một vùng file)

| Pha | Agent                            | Vùng file                                                                                                         | Nội dung                                                                                                                                                                                                                                                         |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `tui-core` (1 agent, chạy trước) | `apps/tui/src/ink/{app,runtime,core,ui,theme,hooks}/**`, `apps/tui/package.json`                                  | Khung Ink: runtime, router overlay, hooks SDK, theme tokens (dùng lại theme engine hiện có), component nền (Box viền, ListPicker có lọc, Spinner, KeyHint, Markdown, CodeBlock, Diff), keymap, test harness `ink-testing-library`, cờ `FUTRYN_TUI=ink`. ADR mới. |
| 1   | `tui-transcript`                 | `ink/features/{transcript,diff,plan,subagents,notices}/**`                                                        | Toàn bộ hiển thị transcript, tool groups, thinking, diff, citations ký ức (dòng gọn), plan ghim, cây subagent.                                                                                                                                                   |
| 1   | `tui-composer`                   | `ink/features/{composer,autocomplete,history,paste}/**`                                                           | Ô nhập, lịch sử, gợi ý `/` `@` `$`, dán, `!`/`#`, phím tắt.                                                                                                                                                                                                      |
| 1   | `tui-dialogs`                    | `ink/features/{permissions,question,picker,connect,models,sessions,settings,themes,help,memory,agents,skills}/**` | Mọi hộp thoại/overlay.                                                                                                                                                                                                                                           |
| 1   | `tui-chrome`                     | `ink/features/{status,header,welcome,startup-gate,context-meter,usage}/**`                                        | Status line, header, welcome, cổng đồng ý thư mục + xác minh tài khoản, đồng hồ context/chi phí.                                                                                                                                                                 |
| 2   | `tui-integrate` (1 agent)        | `ink/app.tsx` + mọi nơi nối                                                                                       | Ghép các phần, chạy đủ luồng, golden mới, e2e PTY, so parity.                                                                                                                                                                                                    |
| 3   | `tui-switch` (1 agent)           | `apps/tui/src/**`, `apps/cli`                                                                                     | Đổi mặc định sang Ink, xoá renderer cũ, dọn test cũ, cập nhật docs/CLAUDE.md.                                                                                                                                                                                    |

Quy tắc chung cho mọi agent: chỉ sửa vùng file của mình (cần thay đổi vùng khác → ghi vào báo cáo, không tự sửa); không commit/push; không thêm dependency ngoài danh sách trên; chỉ chạy typecheck, lint và test của vùng mình (người điều phối chạy toàn bộ suite giữa các pha); không đụng `.claude/`, `giao-dien.html`, `hello.html`, `uat-*/`.

## Bảng parity (điều kiện để pha 3 đổi mặc định)

Đồng ý thư mục + xác minh tài khoản; đăng nhập/đổi tài khoản/model/effort; gửi, steer khi đang chạy, Esc ngắt; transcript đủ loại phần; quyền (once/session/always/deny, NO SANDBOX, mạng); request_user_input; plan; diff; subagent (chờ/nền, `/agents`); skills (`/skills`, `/tên`, `$tên`); memories (`/memory`, citations); `/compact`; `/permissions` + Shift+Tab preset + cảnh báo Full Access; mọi lệnh trong `SLASH_COMMANDS`; theme; sessions/resume; usage/context; cờ `--yolo/--full-auto/-s/-a`; non-TTY in một khung; hiệu năng (không giật khi stream dài, transcript > 1 000 dòng).
