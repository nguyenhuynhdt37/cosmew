# ADR 0058 — Subagent: đồng bộ (S5a), nền + agent tuỳ chỉnh + /agents (S5b)

- Ngày: 2026-11-18
- Trạng thái: Accepted; S5a (chế độ chờ) và S5b (nền, `agent_message/wait/close`, agent tuỳ chỉnh, `/agents`), fixture verified, không claim live provider hay OS sandbox mới.
- Contract: 1.31 → **1.32** (S5a) → **1.33** (S5b: `SubagentType` thành string, schema tool điều khiển, `AgentTypeView`, `SubagentNotice`, `CustomAgentDefinition`, `SubagentEvent.background`); SQLite vẫn 8 (bảng `subagent_sessions` thêm bằng `CREATE TABLE IF NOT EXISTS`); không dependency mới.

## Quyết định

Tool `agent {agent_type, description, prompt, model?, reasoning_effort?, background?, fork_context?}` (capability `agent.spawn`, `parallel: true`) chạy một `Conversation` lồng và trả bản tóm tắt cuối. Nhiều lời gọi trong cùng một response chạy song song; `max_threads` mặc định 6 và `max_depth` mặc định 1 (Codex `DEFAULT_AGENT_MAX_THREADS/DEPTH`), cấu hình `[agents] max_threads/max_depth/enabled` và `[agents.<role>] model/reasoning_effort/description/developer_instructions` trong `~/.futryn/config.toml` (chỉ cấp user). Lời gọi vượt `max_threads` bị từ chối `AGENT_LIMIT_REACHED` như Codex (không xếp hàng); cap chung của gate song song được nới thành `max_threads + 1` để lời gọi đó tới được scheduler. Con ở độ sâu >= `max_depth` không được offer tool `agent`, và gọi `agent` trả `AGENT_DEPTH_LIMIT`.

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

## Để lại cho S5c

Xem cuối phần S5b.

## S5b (2026-11-18)

### Chạy nền (`background: true`)

`agent` trả ngay `{"id","status":"running"}`; cha tiếp tục. Chỉ session gốc được chạy nền (con ở độ sâu >= 1 nhận `UNSUPPORTED`, tránh thông báo cho một cha sẽ biến mất). Con nền KHÔNG bị abort khi lượt cha bị hủy (Esc); chỉ dừng khi: user `/agents` -> X, `agent_close`, hoặc đóng phiên (`Application.shutdownCommands()` -> `SubagentScheduler.shutdown()` abort tất cả và chờ vòng lặp kết thúc; trạng thái `cancelled`, không thông báo). Vòng lặp của con: chạy một lượt, ghi `completed` (= idle), phát `subagent.finished {background: true}` ngoài lượt (qua `onSubagentNotice`, không qua ProgressQueue vì tool call đã xong), rồi nếu có follow-up trong inbox thì chạy lượt tiếp trên cùng conversation. `max_threads` đếm con đang chạy: slot giữ trong lúc một lượt chạy, nhả khi idle; `agent_message` vào con idle phải đặt lại slot (`AGENT_LIMIT_REACHED` nếu đầy).

Thông báo cho cha (cơ chế steer/queued input có sẵn): `<subagent id="…" status="completed|failed|cancelled" type="…" description="…">` + nhãn "untrusted subagent output" + tóm tắt (<= 4000 ký tự, `& < >` bị escape nên con không thể đóng/giả envelope). Cha đang chạy lượt -> `Conversation.steer` (preempt như steering thường); không thì `enqueueNextTurn` bền (cha idle). TUI hiện notice và, khi phiên đang hiển thị là cha, tự gửi tin đã xếp hàng để cha xử lý kết quả (Codex đánh thức cha). Thông báo là input user-role (dữ liệu, không quyền): không đổi mode, grant hay approval, và không bao giờ vào `ModelRequest.instructions`. Nếu cha đang `agent_wait` đúng con đó thì kết quả đi bằng output của tool, không gửi thông báo trùng.

### Tool điều khiển (port Codex `send_input` / `wait` / `close_agent`; `resume_agent` gộp vào message)

Chỉ được offer khi phiên đã từng có con (`hasChildren`), nên mọi request không dùng subagent giữ nguyên byte như S5a (và không phình context test 8k). Cùng capability `agent.spawn`, parallel, authorize như `agent`; con không bao giờ nhận chúng (bị lọc như `agent`).
- `agent_message {id, message}`: con đang chạy -> `steer` (trả `delivery: steered`), steer không nhận -> inbox (`queued`), con idle/failed/cancelled/interrupted -> mở lại conversation của con và chạy lượt mới nền (`resumed`, kể cả sau restart vì dựng lại từ store); con `closed` -> `AGENT_CLOSED`. Plan/Review chỉ cho con read-only.
- `agent_wait {ids?, timeout_ms?}`: mặc định mọi con nền của cha; trả ngay khi BẤT KỲ con nào đã final (Codex), kèm `status` + `summary`; timeout mặc định 30 s, kẹp 10 s..1 h (hằng Codex `DEFAULT/MIN/MAX_WAIT_TIMEOUT`), `<= 0` bị từ chối, id lạ -> `not_found`, abort cha -> `CANCELLED`.
- `agent_close {id}`: abort + chờ vòng lặp, ghi `closed`, trả `{previous_status}` (Codex).

### Agent tuỳ chỉnh

`@futryn/workspace` `AgentDefinitionCatalog` (cùng khuôn `SkillCatalog`): project từ workspace lên gốc repo, gần trước xa sau, trong mỗi scope `.futryn/agents`, `.claude/agents`, `.agents/agents`; sau đó `~/.futryn/agents`, `~/.claude/agents`. `*.md` trực tiếp (không đệ quy), tối đa 32 KiB, UTF-8, không symlink, bỏ thư mục vendored/Git ignored, tối đa 256 file, deny/ask Read rule ẩn file. Frontmatter: `name` (như skill), `description` (<= 1024), `tools` (danh sách phẩy/`[..]`/`- ..`), `model`, `reasoning_effort`; mọi key khác (kể cả `permissionMode`, `hooks`) bị bỏ qua và không cấp gì. Trùng tên giữ cái đầu + `DUPLICATE_NAME`; trùng tên/alias built-in giữ built-in + `BUILTIN_NAME_CLASH`. Tên tool Claude Code (`Read`, `Bash`, `Edit`...) ánh xạ sang tool Futryn; tên lạ bị bỏ kèm cảnh báo `UNKNOWN_TOOL`; `Task/agent/memory/request_user_input` không bao giờ được cấp.

Bất biến tin cậy (mọi nguồn, project lẫn user): tên/mô tả/thân là dữ liệu không tin cậy. Catalog (JSON-escaped, ngân sách 6.000 ký tự, giảm mô tả rồi bỏ đuôi + warning như skills) đi qua kênh user/project-context (`ConversationOptions.contextNotes`), KHÔNG vào `ModelRequest.instructions` và KHÔNG vào mô tả tool `agent`. Thân agent chỉ vào context của con dưới nhãn "untrusted project data", còn instructions của con là đoạn host viết sẵn ("custom subagent <name>"). Lệch Claude Code (thân là system prompt) có chủ ý. `tools` chỉ THU HẸP: profile tuỳ chỉnh bắt đầu từ `general`, tập cuối = giao với tool cha offer; `readOnly` khi không có tool ghi/lệnh (khi đó sandbox tối đa read-only, và Plan/Review cho phép nó); Plan/Review vẫn loại tool ghi/lệnh khỏi mọi con; `model` chỉ là gợi ý (không resolve được -> dùng model của cha, ví dụ alias `sonnet`), `reasoning_effort` qua đường resolve thường. Mỗi lần spawn đọc lại và kiểm lại file (`load`), nên sửa/đổi file sau discovery bị phát hiện.

### `/agents` và SDK

`/agents` là lệnh canonical (`SLASH_COMMANDS`, overlay `agents`, module `apps/tui/src/features/agents`, ADR 0015): danh sách loại agent (nguồn, mô tả, tool, cảnh báo/lỗi discovery) và con của phiên (id, loại, mô tả, trạng thái, nền/trước, số tool, token, thời gian); Enter xem transcript (bước tool + tóm tắt), X dừng con đang chạy (con vẫn resume được bằng `agent_message`; cha nhận thông báo `cancelled`), R làm mới. SDK: `client.agentTypes()`, `client.subagents()`, `client.inspectSubagent(id)`, `client.stopSubagent(id)`, `client.onSubagentNotice(listener)`.

### Bất biến bảo mật S5b

Mọi lời gọi tool của con (kể cả resume) vẫn qua một `ToolDispatcher` mới cùng policy/audit/redact; con chỉ thừa kế grant `fs.read` của cha (`SessionGrants.createChild`); text repository (agent file, tóm tắt con) không bao giờ vào instructions; thông báo con -> cha không chứa quyền. Notification delivery lỗi không làm hỏng con.

### Khác upstream / giới hạn

- Codex: `wait` trả khi một con xong (cùng), nhưng không có mailbox đa-agent V2, `interrupt` của `send_input` (thay bằng steer/queue) và `resume_agent` riêng (resume nằm trong `agent_message`). `close` luôn giải phóng id.
- Claude Code: không có `permissionMode`/`hooks`/`color` frontmatter; không thư mục con; `~/.agents/agents` không quét (spec chỉ nêu hai root user); `model: sonnet|opus|haiku` không map.
- Con nền không sống sau restart tiến trình (phục hồi thành `interrupted`; `agent_message` mở lại được). Steer đã nhận nhưng chưa giao khi lượt con kết thúc vẫn nằm trong pendingInput của con và đi cùng lượt kế tiếp. `fyn exec` (headless) không có vòng nhận lại thông báo: lượt cha kết thúc thì con nền bị huỷ khi thoát; dùng `agent_wait` nếu cần kết quả.
- Fixture verified (`tests/end-to-end/subagents-background.test.ts`, `tests/contracts/subagent-definitions.test.ts`); không live provider, không Seatbelt mới.

## Để lại cho S5c

Agent role qua file TOML kiểu Codex, `resume` qua restart tự động của con nền, hook/`permissionMode` của agent tuỳ chỉnh, đệ quy thư mục agent, nhắn giữa các con (mailbox), UI sửa/tạo agent.
