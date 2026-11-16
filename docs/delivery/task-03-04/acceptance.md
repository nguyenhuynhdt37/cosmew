# Task 03 + 04 — Acceptance

Ngày: 2026-11-17. Codex pin: `090be4df0724cdef5758e6a0934ba557af8b6bbe`. Futryn bắt đầu tại `d56e11fabb82f638d6602a6628ee5323e064119b` (dev). Ma trận nguồn đầy đủ: [parity-matrix.md](parity-matrix.md); quyết định: [ADR 0037](../../adr/0037-chat-configuration-command-parity.md).

Đây là bằng chứng fixture/PTY. Chưa có nghiệm thu trực quan bởi người dùng và chưa có live authenticated generation; không tuyên bố 100% parity với Codex CLI.

## Lệnh kiểm chứng (2026-11-17, Bun 1.4.4, macOS)

| Lệnh | Exit | Kết quả |
|---|---|---|
| `bun run typecheck` | 0 | |
| `bun run lint` (tsc unused + prettier + `git diff --check`) | 0 | |
| `bun test tests` | 1 | 610 pass, 33 skip, 1 fail — xem flaky bên dưới |
| `bun test tests/security/process-supervision.test.ts -t 'ordinary child and nested'` ×3 | 0 | pass 3/3 khi chạy riêng |
| `bun run test:integration` | 0 | 127 pass, 23 skip |
| `bun run test:e2e` | 0 | 243 pass, 10 skip (bao gồm PTY TUI) |

Repo không có bước build (Bun chạy TS trực tiếp). Skip là các test opt-in (keyring, Docker, live provider), không tính là pass.

Flaky: `process-supervision.test.ts` "ordinary child and nested shell/pipeline" (Task 02, file không bị sửa) vượt deadline ~9 s khi full suite chạy song song có tải; pass trong `test:integration` và khi chạy riêng. Golden overlay được ghi lại có review: khác biệt duy nhất là lệnh `/fork` mới trong command palette.

## Trạng thái tính năng

| Tính năng | Trạng thái | Bằng chứng |
|---|---|---|
| Streaming transcript, provisional/discard, call ID | PARTIAL | transcript-activity, agent-loop-codex; provider completion không có final text chuẩn |
| Parallel tool / exec output / patch outcome | IMPLEMENTED — NOT LIVE VERIFIED | transcript-activity, chat-presentation, native-agent, diff-presentation |
| Composer: grapheme editing, multiline, draft | IMPLEMENTED — NOT LIVE VERIFIED | composer-input, tui (PTY) |
| Bracketed paste nguyên khối, giới hạn 1 MiB, masked secret | PARTIAL | composer-input, provider-connect; thiếu paste-burst heuristic và placeholder thu gọn |
| Steering / queue next-turn theo session | IMPLEMENTED — NOT LIVE VERIFIED | queued-input, agent-loop-codex |
| Command registry (alias, shortcut, busy flag, help/autocomplete) | IMPLEMENTED — NOT LIVE VERIFIED | commands-module, usage-context |
| `/diff`: staged/unstaged/untracked, rename/delete/binary/gitlink, helper bị tắt, cache không chạy Git khi render | IMPLEMENTED — NOT LIVE VERIFIED | workspace-git-diff (repo Git thật, marker helper độc hại không bao giờ được tạo), diff-presentation |
| `/config` 6 nhóm, budget/appearance lưu SQLite, provenance | IMPLEMENTED — NOT LIVE VERIFIED | configuration, theme-engine (restart SQLite) |
| `/plan`, `/review` (read/search-only, chặn tool ẩn) | IMPLEMENTED — NOT LIVE VERIFIED | tui-modes; review dùng diff thật của workspace |
| `/fork`, mode theo session, thu hồi grant/delegation khi đổi session | IMPLEMENTED — NOT LIVE VERIFIED | configuration, tui-modes |
| `!command` shell: cùng dispatcher/sandbox, journal, guard `sending` | IMPLEMENTED — NOT LIVE VERIFIED | user-shell-history, native-agent |
| `/status`, `/usage`, `/context` (shell receipt không tính usage) | IMPLEMENTED — NOT LIVE VERIFIED | usage-context, configuration |
| Resume theo cwd đã lưu | BLOCKED BY BACKEND | session contract chưa có trường workspace |
| Manual `/compact` | BLOCKED BY BACKEND | chỉ có auto compaction trong turn |
| MCP / plugins / skills / subagents | NOT IMPLEMENTED | ngoài phạm vi |

## Lỗi review đã sửa trong lần chạy

- `/review` cũ chạy vào session mới sau khi chờ Git → guard command/session/model/mode.
- `status()` vỡ khi probe terminal runtime ném lỗi → bắt lỗi, báo limitation.
- `--ignore-submodules=all` giấu staged gitlink → bỏ, có test Git thật.
- Đổi delegation/mode/session/resume/fork/clear khi turn hoặc shell đang chạy → `POLICY`.
- Queue next-turn dùng chung toàn client → lưu durable theo session id, claim theo session.
- (Security review sau commit) `/review` gửi diff của file secret (ví dụ `.env`) cho model mà không qua `evaluateRead` → chỉ gửi nội dung khi policy là `allow`, còn lại gửi path/status kèm `contentWithheld`; test `tui-modes` "review withholds diff content…" fail trên code cũ, pass sau khi sửa.

## Khác biệt còn lại so với Codex

Plan artifact riêng, notice approval/retry được giữ lại, status line cấu hình được, prompt history tìm kiếm lưu bền, draft theo từng thread, paste-burst khi terminal không hỗ trợ bracketed paste.
