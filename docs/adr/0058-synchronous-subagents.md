# ADR 0058 — Subagent đồng bộ (S5a)

- Ngày: 2026-11-18
- Trạng thái: Accepted; chỉ S5a (chế độ chờ), fixture verified, không claim live provider hay OS sandbox mới.
- Contract: 1.31 → **1.32**; SQLite vẫn 8 (bảng `subagent_sessions` thêm bằng `CREATE TABLE IF NOT EXISTS`); không dependency mới.

## Quyết định

Tool `agent {agent_type, description, prompt, model?, reasoning_effort?, background?, fork_context?}` (capability `agent.spawn`, `parallel: true`) chạy một `Conversation` lồng và trả bản tóm tắt cuối. `background: true` trả `UNSUPPORTED` (S5b). Nhiều lời gọi trong cùng một response chạy song song; `max_threads` mặc định 6 và `max_depth` mặc định 1 (Codex `DEFAULT_AGENT_MAX_THREADS/DEPTH`), cấu hình `[agents] max_threads/max_depth/enabled` và `[agents.<role>] model/reasoning_effort/description/developer_instructions` trong `~/.futryn/config.toml` (chỉ cấp user). Lời gọi vượt `max_threads` bị từ chối `AGENT_LIMIT_REACHED` như Codex (không xếp hàng); cap chung của gate song song được nới thành `max_threads + 1` để lời gọi đó tới được scheduler. Con ở độ sâu >= `max_depth` không được offer tool `agent`, và gọi `agent` trả `AGENT_DEPTH_LIMIT`.

Package `@futryn/agents` (workspace mới, chỉ phụ thuộc `contracts`) giữ profile, scheduler/registry, giải model/effort và `SubagentManager`. Nó chạy con qua port `runChildTurn` do `apps/cli` (composition root) cung cấp, nên không import core/tools/security. Cạnh mới duy nhất: `apps/cli` -> `agents`.

## Loại agent

`explore` (chỉ đọc: read/glob/grep/lsp/web_search/web_fetch/skill; `exec_command` chỉ sandbox `read-only`, không network, không escalation), `worker` (đủ tool trừ `request_user_input`, `memory`, `agent`; hướng dẫn quyền sở hữu file, không một mình trong codebase, không revert sửa của người khác), `general` (đa năng như OpenCode general, trừ hỏi user/agent), `plan` (chỉ đọc, không shell, trả kế hoạch có bước). Mô tả viết lại bằng lời riêng. Hướng dẫn riêng của loại đi qua `ModelRequest.instructions` (host-owned, không phải text repository). Plan/Review của cha chỉ cho `explore`/`plan`.

## Quyền (bất biến)

Con dùng cùng `ToolDispatcher` (một instance mới, cùng policy/audit/redact), kế thừa sandbox, approval policy và project rules (deny > ask > allow > mode) của cha. Sandbox hiệu lực = `min(cha, loại)`: loại chỉ có thể thu hẹp. `SessionGrants.createChild()` chỉ thừa kế grant `fs.read` của cha; grant khác không bao giờ; grant của con không rò lên cha. Scope hash prompt của con gồm agent id nên "session" của con không khớp grant cha. Prompt quyền mang `subagent {agentId, agentType, description}` (đã sanitize), TUI hiện "Subagent: <loại> (<mô tả>)". Con không nạp/ghi memories, không hỏi user (`canAskUser` false), không `update_plan` của cha. Bộ tool bị lọc hai lần (descriptor offer và `isToolAllowedForProfile` khi invoke).

## Vòng đời

Con có conversation riêng (journal SQLite) và bản ghi `subagent_sessions` (status running/completed/failed/cancelled/interrupted/closed); ẩn khỏi `list()`, xoá theo cha. Sau restart, turn dở của con được phục hồi thành `interrupted` (`PROCESS_EXIT`), không tự chạy lại. `fork_context` sao chép lịch sử cha đã hoàn tất (bỏ tool call chưa có kết quả) + nhãn dữ liệu kế thừa (Codex FullHistory). Usage con cộng vào receipt lượt cha và hiển thị riêng (`client.subagents()`). Abort lượt cha abort con (trạng thái `cancelled`). Lỗi con (provider, limit, v.v.) trả về cha là tool result `error` redacted; không hỏng phiên. Compaction con dùng cơ chế ADR 0054 của chính conversation con.

## Sự kiện và UI

`subagent.started/progress/finished` (contract 1.32) đi qua ProgressQueue (progress gộp theo `callId`, chỉ do Futryn phát; provider stream phát `subagent.*` là `PROTOCOL`), SDK notify (`ReactiveAgentEventKind`) và `fyn exec --json`. TUI: `⏺ Agent(mô tả)` + dòng thu gọn `[loại] Done · N tool · tokens`, Ctrl+O mở transcript con; phục hồi sau resume từ persistence.

## Tool ngoài bộ offer

Call tool không được offer cho con (ví dụ `write` của explore) vẫn bị adapter provider từ chối `PROTOCOL` (fail closed, ADR 0029/test tui-modes) và con kết thúc `failed`, lỗi trả về cha dạng tool error. `AGENT_DEPTH_LIMIT`/`DENIED` trong invoke là lớp phòng thủ thứ hai, test ở mức contract.

## Khác upstream

- Codex: cùng default 6/1 và từ chối khi đầy; chưa có `send_input/wait/close/resume` (S5b), agent role qua file TOML (S5c) và không có thread mở sau khi trả kết quả.
- OpenCode: `agent_type` thay `subagent`; không có task id resume ở S5a.
- Claude Code: tóm tắt cuối là kết quả duy nhất; con không có tool hỏi user hay lồng thêm agent.

Nguồn đọc ngày 2026-11-18: Codex @ `090be4d` `codex-rs/core/src/tools/handlers/multi_agents/*`, `core/src/agent/{role,control,registry}.rs`, `core/src/config/mod.rs`; OpenCode @ `852d5ed` `packages/core/src/tool/plugin/subagent.ts`, `session/subagent-depth.ts`. Hành vi port, không chép văn bản.

## Kiểm chứng

`tests/contracts/subagents.test.ts` (profile, sandbox/tool narrowing, grants, scheduler, config, fork, persistence/recovery, model resolution) và `tests/end-to-end/subagents.test.ts` (explore chỉ đọc, worker không được offer agent, song song 6 + từ chối thứ 7, fork_context, grant/deny rule/prompt TUI, hủy cha, usage + lỗi con + compaction, thứ tự sự kiện/TUI/resume/exec --json). Không có live provider; không verify Seatbelt thật (runtime lệnh là fake có ghi sandbox).

## Để lại cho S5b/S5c

`background`, `send_input`, `wait`, `close`, `resume`, ghi chú thread mở; agent tuỳ chỉnh từ file; `/agents` UI quản lý.
