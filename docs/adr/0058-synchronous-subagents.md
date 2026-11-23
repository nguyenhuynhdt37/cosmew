# ADR 0058 — Subagent: đồng bộ (S5a), nền + agent tuỳ chỉnh + /agents (S5b)

- Ngày: 2026-11-18
- Trạng thái: Accepted; S5a (chế độ chờ) và S5b (nền, `agent_message/wait/close`, agent tuỳ chỉnh, `/agents`), fixture verified, không claim live provider hay OS sandbox mới.
- Contract: 1.31 → **1.32** (S5a) → **1.33** (S5b: `SubagentType` thành string, schema tool điều khiển, `AgentTypeView`, `SubagentNotice`, `CustomAgentDefinition`, `SubagentEvent.background`); → **1.34** (S5c: `agent.isolation`, `HostAgentsConfig.maxChild*`, `SubagentParentLimits/ChildLimits`, `SubagentWorktreePort`, `SubagentSessionRecord.isolation`); SQLite vẫn 8 (bảng `subagent_sessions` thêm bằng `CREATE TABLE IF NOT EXISTS`, cột `isolation` thêm bằng `ALTER TABLE` có kiểm tra `PRAGMA table_info`); không dependency mới.

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

## Để lại cho S5c (đã xử lý một phần: xem phần S5c)

Agent role qua file TOML kiểu Codex, `resume` qua restart tự động của con nền, hook/`permissionMode` của agent tuỳ chỉnh, đệ quy thư mục agent, nhắn giữa các con (mailbox), UI sửa/tạo agent.

## S5c (2026-11-18)

### Cap của lượt cha áp cho con (sửa lỗi bảo mật bắt buộc)

Trước S5c, `childConv.send(...)` không nhận cap nào của lượt cha: một con có thể tiêu vượt `maxOutputTokens`/`maxEstimatedCostUSD` của lượt gọi và ngân sách người dùng (`TurnBudget`). Nay `Conversation.turnLimits()` (snapshot của lượt đang chạy: cap `send`, `TurnBudget`, usage gồm cả con đã xong, thời gian đã trôi) đi vào `getParentState().limits`; `inheritChildLimits` (`packages/agents/src/budgets.ts`) tính phần còn lại sau usage của cha và các con anh em ĐANG chạy (chưa được cộng vào receipt của cha):
- `maxOutputTokens` của con = cap cha trừ output đã dùng (và không vượt token budget còn lại); `maxEstimatedCostUSD` = cap cha trừ chi phí đã dùng; `TurnBudget.maxTokens/maxCostUSD/maxDurationMs` co lại bằng phần còn lại; `maxSteps/maxToolCalls` giữ nguyên cho lượt của con.
- Bất kỳ cap nào của cha đã hết (kể cả `maxOutputTokens`, coi là trần output cộng dồn của cả cây con) thì lời gọi `agent` (và `agent_message` mở lại con) bị từ chối `AGENT_BUDGET_EXHAUSTED`, không tạo conversation/worktree/slot. Con nền chạy các lượt sau của nó với snapshot lúc spawn/resume.
- Đặt trước ngân sách (sửa review bảo mật S5c): mỗi con đang chạy GIỮ CHỖ phần giới hạn đã cấp cho nó (`ActiveSubagentTask.reservation`; tối đa giữa giới hạn đã cấp và usage đã báo), và con kế tiếp chỉ nhận phần còn lại sau usage cha + phần đã đặt (`reserveForChildren`, `inheritChildLimits`). Hai con song song vì vậy không thể cùng nhận trọn phần còn lại: tổng giới hạn đã cấp không vượt cap của cha (token, cost, output); con đầu có thể nhận hết, con sau bị `AGENT_BUDGET_EXHAUSTED` đến khi con đầu xong. Khi lượt con kết thúc, usage thật được cộng vào cha và phần đặt trước chưa dùng được nhả. Nếu sau khi cộng, tổng vượt cap của cha (`parentCapsExceeded`), các con anh em đang chạy bị abort. `maxDurationMs` vẫn là soft (kiểm trước mỗi vòng model, ADR 0030) và dùng chung đồng hồ nên không đặt trước.

Ngân sách tuỳ chọn mỗi con: `~/.futryn/config.toml` `[agents] max_child_tokens`, `max_child_duration_ms` (>= 1000), `max_child_cost_usd` (chỉ cấp user); áp thêm lên phần còn lại (lấy giá trị nhỏ hơn).

### Model/effort theo con

Đã có từ S5a (`model`, `reasoning_effort` của tool và `[agents.<role>] model/reasoning_effort`); S5c bổ sung test (role mặc định cho `explore`, tham số tường minh thắng, model lạ bị từ chối). Thứ tự: tham số tool > `[agents.<type>]` > `[agents]` mặc định > model của cha.

### `isolation: "worktree"`

`agent {isolation: "worktree"}` (chỉ từ session gốc; Plan/Review và sandbox `read-only` từ chối; không phải repo Git hoặc chưa có commit -> lỗi `UNSUPPORTED` rõ ràng, con không chạy). `@futryn/workspace` `GitWorktrees` chạy `git` với cấu hình an toàn của ADR 0037 (không fsmonitor, hooks, bare ngầm, bỏ `GIT_*`, vô hiệu driver `filter.*.clean/process` khi kiểm tra thay đổi) để `git worktree add -b futryn/agent-<id8> <path> HEAD`. Worktree nằm ngoài repo và ngoài thư mục state: `<tmpdir>/futryn-worktrees/<sha256(repo)[:12]>/<agentId>`. Workspace, command runtime, writable root và `projectDir` của con là worktree; sandbox của con chỉ ghi được worktree (không ghi repo chính, không ghi `.git`; `.git` của worktree là file và bị Seatbelt/bwrap chặn ghi như mọi `.git`). Thư mục Git chung của repo chính được mở chỉ-đọc cho lệnh của con (`git status` chạy được; commit thì không, nên thay đổi nằm ở working tree của worktree). LSP bị tắt cho con cách ly. `.git` chỉ bị `git worktree add/remove` của host ghi, qua `GitWorktrees`.

Khi con xong: không đổi gì (status sạch và HEAD = commit gốc) thì worktree + nhánh bị xoá; có thay đổi (hoặc không kiểm tra được) thì giữ lại và kết quả tool/thông báo nền nói rõ `Worktree kept with changes: <path> (branch <branch>)`. Con nền chỉ kết thúc worktree khi hết vòng lặp (idle); `agent_message` mở lại con cách ly mở lại worktree còn đó hoặc tạo mới (cột `subagent_sessions.isolation`). Sau restart, worktree giữ lại vẫn mở được (`GitWorktrees.open`), không tự xoá.

### Sửa phụ từ review

`agent_message` mở lại con idle bằng vòng lặp nền nay bị từ chối `UNSUPPORTED` khi quản lý ở độ sâu >= 1, như `run()` (trước đó con độ sâu 1 có thể khởi động vòng lặp nền).

### `fyn exec`

Sau lượt đầu, `fyn exec` chờ các con nền đang chạy; mỗi thông báo `<subagent>` trong hàng đợi trở thành lượt kế tiếp của cha (như TUI đánh thức cha) tới khi không còn con chạy/tin xếp hàng; câu trả lời cuối là của lượt cuối. Hủy (SIGINT) dừng cả hai. `--json` phát đủ event của các lượt thêm.

### F12 — lệnh không sandbox dùng môi trường thật

`NativeCommandRuntime.env(tty, unsandboxed)`: lệnh `require_escalated` (đã được duyệt) và Full Access / `danger-full-access` chạy với HOME thật, không còn HOME/TMPDIR/XDG_*/cache của scratch. Môi trường là môi trường host theo mặc định `shell_environment_policy` của Codex (kế thừa toàn bộ, loại tên chứa `KEY`/`SECRET`/`TOKEN`) cộng overlay unified-exec (NO_COLOR, TERM, PAGER=cat...), bỏ marker `FUTRYN_SANDBOX`, bỏ mọi biến `FUTRYN_*`/`HANNES_*` (state/config của Futryn) và dùng PATH đã chuẩn hoá của runtime. Lệnh trong sandbox giữ nguyên môi trường scratch (ADR 0035). Test: `tests/security/native-host-env.test.ts`.

### Khác upstream / giới hạn

- Claude Code `isolation: "worktree"` còn dọn khi không đổi gì; port đó. Codex không có worktree cho subagent.
- Con cách ly không thể `git commit` (không ghi được thư mục Git chung). Handoff hiện tại theo [ADR 0097](0097-worktree-review-handoff.md): xem cả committed/uncommitted, dùng guarded `apply_patch` qua quyền thường của cha; merge branch đơn thuần không mang về file chưa commit. Giữ worktree tới khi đã kiểm tra tích hợp đủ.
- Worktree để trong thư mục tạm của OS; hệ điều hành có thể dọn nó (nhánh vẫn còn trong repo).
- bubblewrap (Linux) chưa kiểm chứng thật cho worktree; Windows chưa hỗ trợ (như ADR 0035).
- UI TUI cho nhiều con song song: `/agents` (S5b) là danh sách gọn có chọn xem; không thay đổi TUI trong S5c (TUI được viết lại riêng).
- Chạy agent từ xa/cloud và agent teams hoãn: `docs/delivery/wave-2/deferred.md`.
- Fixture verified: `tests/contracts/subagents-s5c.test.ts`, `tests/security/subagent-worktree.test.ts` (Git thật, Seatbelt thật trên macOS), `tests/end-to-end/subagents.test.ts` (S5c). Không live provider.

### Hardening worktree (sửa review bảo mật S5c)

- `git worktree add` cũng checkout file nên có thể chạy filter driver do repository cấu hình: mọi `filter.<d>` có `clean|smudge|process` đều bị vô hiệu bằng `-c filter.<d>.{clean,smudge,process}=` và `required=false` cho lệnh tạo worktree (cùng cơ chế với `status`); `SAFE_GIT_ARGS` (không fsmonitor/hooks) giữ nguyên. Test: filter smudge/process ghi marker không chạy.
- Thư mục gốc của worktree không còn là `os.tmpdir()/futryn-worktrees` dùng chung. CLI truyền `baseDirectory` = `<state>-worktrees` cạnh thư mục state (`~/.futryn-worktrees`), không nằm TRONG `~/.futryn` vì chính sách đọc/patch từ chối thư mục state đối với con. Mặc định của thư viện là `tmpdir()/futryn-worktrees-<uid>`. Trước khi dùng, `lstat` từng thành phần: phải là thư mục thật (không symlink), thuộc user hiện tại, mode 0700 (không có bit group/other); thiếu thì tạo 0700; sai thì `create-failed`. POSIX; Windows bỏ qua kiểm owner/mode. Test: symlink, mode 0755 và symlink ở thư mục theo repo đều bị từ chối.
