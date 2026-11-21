# Đợt 2 — Kế hoạch điều phối Codex (từng bước một)

Baseline: `dev` = `b087bd9` (2026-11-17). Đợt 1 và đổi đăng nhập đã xong (ADR 0040–0048, unit 761/33/0, integration 214/23/0, e2e 267/10/0).
Thiết kế chi tiết W8–W13 nằm ở [wave-1/plan.md §5](../wave-1/plan.md); file này chỉ quy định **thứ tự, phạm vi từng phiên Codex, tiêu chí xong và prompt giao việc**.

## 1. Cách điều phối

- **Mỗi bước = một phiên Codex mới** (context sạch, rẻ token). Không gộp bước.
- Người điều phối (user hoặc Claude) dán **prompt của bước** (mục 4) vào Codex. Codex làm xong → commit → in báo cáo theo mẫu mục 3 → **dừng**.
- Trước khi mở bước kế: người điều phối xem báo cáo + `git log -1 --stat`. Nếu bước có chạm quyền/sandbox/credential/MCP/process, cho Claude (Opus) review diff bảo mật trước. Lỗi review → mở một phiên Codex sửa ngay, với prompt "fix: <finding>" + đường dẫn file.
- Codex chạy với `approval: on-request`, `sandbox: workspace-write`. Bước nào cần mạng (UAT, clone tham chiếu) thì ghi rõ trong prompt.
- **Tiết kiệm token / thời gian test**: trong phiên chỉ chạy `bun run typecheck`, `bun run lint` và các file test liên quan. Bộ test đầy đủ (`bun test tests`, `test:integration`, `test:e2e`) chỉ chạy **một lần ở cuối bước**, ở chế độ gọn: `bun test tests 2>&1 | tail -5` (tương tự cho hai bộ còn lại). Không chạy lại cả bộ nhiều lần.

## 2. Quy tắc chung cho mọi phiên (dán kèm prompt)

```
Quy tắc:
- Đọc AGENTS.md, CLAUDE.md, docs/architecture/dependency-rules.md, và mục được chỉ định trong docs/delivery/wave-1/plan.md + docs/delivery/wave-2/plan.md.
- Working tree dùng chung: không stash/revert/format file người khác; git add từng file của mình; kiểm git status trước commit.
- Mọi tool mới đi qua ToolDispatcher (validate → path → policy → duyệt → revalidate → audit → chạy → redact). Không đường vòng.
- Đổi public contract: tăng version contract, cập nhật consumers, ghi ADR mới trong docs/adr/ (số tiếp theo).
- Dependency mới: dừng và hỏi trước; nếu được duyệt ghi vào docs/delivery/dependency-catalog.md.
- Port hành vi từ Codex/OpenCode/Claude Code, không chép nguyên văn; ghi URL + revision + ngày đọc trong ADR. Chưa xác minh thì ghi "Needs verification".
- Test có ý nghĩa (quyền, hủy, lỗi, recovery); không mock success để chứng minh live.
- Một commit `feat(...)`/`fix(...)` cho bước, kết thúc bằng dòng Co-Authored-By theo cấu hình. Không push.
- Dừng và hỏi khi: cần dependency mới; cần chạy ngoài sandbox; source thật khác plan; phá test bảo mật mà không rõ cách giữ bất biến.
- Cuối phiên in báo cáo theo mẫu mục 3 của wave-2/plan.md rồi dừng.
```

## 3. Mẫu báo cáo cuối bước

```
Bước: <S#> — <tên>
Commit: <sha> <subject>
Đã làm: <gạch đầu dòng ngắn>
Chưa làm / lệch plan: <...>
Test: typecheck=<exit> lint=<exit> | unit p/s/f | integration p/s/f | e2e p/s/f
Bảo mật cần review: <file + lý do, hoặc "không">
Trạng thái: PARITY VERIFIED | IMPLEMENTED — NOT LIVE VERIFIED | PARTIAL
```

## 4. Các bước theo thứ tự

| #   | Bước                                  | Cỡ  | Phụ thuộc                                 | Review bảo mật                   |
| --- | ------------------------------------- | --- | ----------------------------------------- | -------------------------------- |
| S0  | UAT thật Next.js                      | S   | tài khoản `xai` hoặc ChatGPT đã đăng nhập | không                            |
| S1  | `fyn exec` + sự kiện SDK cho headless | S–M | —                                         | có (duyệt/quyền headless)        |
| S2  | W8 Compaction bằng model + `/compact` | M   | —                                         | không                            |
| S3  | W11 Skills                            | S   | —                                         | có (đọc file ngoài workspace)    |
| S4  | W10 Memories                          | M   | —                                         | có (secret, ghi ngoài workspace) |
| S5  | W9 Subagent                           | L   | S1 (sự kiện), quyền theo agent            | có                               |
| S6  | W12 MCP đầy đủ + tự cài               | L   | S5 không bắt buộc                         | có (process bên thứ ba, OAuth)   |
| S7  | Hooks + slash command tuỳ chỉnh       | M   | S1                                        | có (chạy lệnh người dùng)        |
| S8  | W13 CodeMode                          | L   | S6                                        | có                               |

Mỗi lỗi do S0 tìm ra được sửa **trước** S1 (mỗi lỗi một phiên `fix`).

---

### S0 — UAT thật Next.js

**Mục tiêu**: chứng minh agent Cosmew làm trọn một project thật bằng model có tool. Không viết tính năng.

Prompt:

```
Bước S0 (wave-2/plan.md). Không sửa code sản phẩm.
1. bun run hannes account list — chọn tài khoản có backend `hannes` (xai API key hoặc chatgpt-api). Không có thì dừng, báo user.
2. Tạo thư mục trống /Users/huynh/codes/hannes/uat-cosmew/run-<yyyymmdd-hhmm>/ (không đụng file sẵn có trong uat-cosmew/).
3. Chạy: bun scripts/uat/agent-run.ts --workspace <thư mục đó> --prompts <file 5 lượt Next.js> --report <thư mục>/report.json --approve all --turn-timeout-ms 900000
   (file prompt: copy nội dung 5 lượt ở docs/delivery/wave-2/uat-nextjs-prompts.txt; cần mạng cho npm/create-next-app.)
4. Đọc report.json: mỗi lượt — số tool call, tool lỗi, quyền hỏi, kết quả build/test/curl thật.
5. Ghi docs/delivery/wave-2/uat-nextjs.md: bảng lượt, lỗi Cosmew tìm được (tool sai, quyền vô lý, treo, sai trạng thái), mỗi lỗi kèm bằng chứng (đoạn report đã redact). Commit chỉ file docs.
```

Xong khi: có `uat-nextjs.md` với danh sách lỗi (có thể rỗng) và kết luận dùng được/không.

### S1 — `fyn exec` + sự kiện SDK headless

**Lấy**: `codex exec` (non-interactive, `--json` JSONL sự kiện, exit code), `opencode run`, `claude -p --output-format stream-json`.
**Phạm vi**:

- Lệnh `hannes exec "<prompt>"` (và `-` đọc stdin), cờ: `--cd <dir>`, `--approval untrusted|on-request|never` (mặc định `never` khi không có TTY, như Codex exec), `--sandbox`, `--json` (JSONL sự kiện agent theo `docs/contracts/agent-events.md`), `--output-last-message <file>`, `--account/--model`. Bật tool (đồng ý thư mục bằng cờ `--cd` rõ ràng, không ngầm định). Exit: 0 xong, 1 lỗi turn, 2 không có tài khoản dùng tool, 64 sai tham số.
- SDK: thêm đăng ký sự kiện `permission.requested` / `question.asked` thay cho polling; `status()` trả `approvalPolicy`; `setUserInputAvailable(false)` mặc định ở exec.
- Chuyển `scripts/uat/agent-run.ts` sang dùng các API này (giữ CLI cũ).
- ADR mới + contract version.
  **Test**: e2e exec với provider giả: JSONL hợp lệ, exit code, `never` từ chối việc vượt sandbox và báo model, Ctrl-C hủy sạch, không TTY không treo chờ duyệt.

### S2 — W8 Compaction bằng model + `/compact`

Theo [wave-1/plan.md W8](../wave-1/plan.md). Đọc thêm Codex `core/src/compact.rs` và OpenCode `session/compaction.ts` ở revision đã ghim (mục 9 plan đợt 1). Kèm: `hannes exec` tự compact khi đầy.

**Trạng thái (2026-11-17): đã làm** — [ADR 0054](../../adr/0054-model-compaction.md), contract 1.26, `tests/contracts/model-compaction.test.ts`. Auto ở 90% cửa sổ (Codex), `/compact [hướng dẫn]`, `client.compact()`, fallback trích đoạn, usage được tính, sự kiện `context.compacted`. Chưa kiểm chứng live với provider thật; compaction giữa turn chỉ lưu trong bộ nhớ (xem ADR).

### S3 — W11 Skills

Theo W11. Bổ sung: đọc skill ở thư mục user đi qua reader có kiểm quyền riêng (không dùng sandbox workspace), giới hạn 64 KiB/skill; skill trong workspace là dữ liệu không tin cậy (chỉ nạp khi model gọi `skill`).

**Trạng thái (2026-11-18): S3 đã triển khai** — [ADR 0056](../../adr/0056-skills-discovery-and-mediated-invocation.md), contract 1.28. Project/user/system discovery, parser ≤64 KiB, metadata budget 8.000 ký tự, `skill` qua dispatcher, `/skills`, `/name args`, `$name` ở TUI/exec, SDK `client.skills()`, Seatbelt read-only resource rules. Fixture được kiểm tra; OS Seatbelt bị môi trường từ chối `sandbox_apply` nên test thật skip, chưa live verified. Các mục deferred.md giữ cho S6. Không commit/push theo yêu cầu phiên S3.

### S4 — W10 Memories

Theo W10. Bổ sung: `/memory` trong TUI; `hannes exec` vẫn nạp `MEMORY.md`; tắt bằng `COSMEW_MEMORY=0`.

**Trạng thái (2026-11-18): S4 đã triển khai** — [ADR 0057](../../adr/0057-user-scoped-project-memories.md), contract 1.30. Memories kiểu Claude Code ở cấp user, Markdown/index private, dispatcher `memory`, context dữ liệu không tin cậy, `/memory` Modal, SDK list/read/delete, headless và env/config disable. Fixture verified; không claim live provider/OS opener/Seatbelt. S5 phải bỏ memory context của subagent. Citations gọn, usage_count/last_usage, ranking khi overflow và stale hint 30 ngày đã triển khai; trích xuất nền/tổng hợp còn hoãn chi tiết trong deferred.md. Không commit/push.

### S5 — W9 Subagent

**Trạng thái (2026-11-18): S5a đã triển khai** — [ADR 0058](../../adr/0058-synchronous-subagents.md), contract 1.32: tool `agent` chế độ chờ, `explore/worker/general/plan`, song song 6 / độ sâu 1, quyền thu hẹp, journal + recovery, sự kiện + TUI + `exec --json`. **S5b đã triển khai** (contract 1.33): `background: true` + thông báo `<subagent>` bền cho cha, `agent_message/agent_wait/agent_close` (port Codex send_input/wait/close_agent), agent tuỳ chỉnh `.cosmew|.claude|.agents/agents/*.md` + `~/.cosmew|~/.claude/agents`, `/agents`, SDK `agentTypes()/stopSubagent()`; xem phần S5b của ADR 0058. **S5c đã triển khai** (contract 1.34): `isolation: "worktree"`, model/effort theo con + `[agents.<type>]`, ngân sách `max_child_*`, `fyn exec` chờ con nền, sửa lỗi bảo mật cap của cha áp cho con (`AGENT_BUDGET_EXHAUSTED`) và F12 (lệnh không sandbox dùng môi trường thật); **S5 hoàn tất**. Còn hoãn: agent role TOML kiểu Codex, mailbox giữa các con, remote/cloud agents, agent teams (deferred.md). Fixture verified, không claim live provider. Không commit/push.

Theo W9. Bổ sung: sự kiện `subagent.started/finished` (contract); subagent kế thừa approval policy nhưng **không** kế thừa grant phiên của cha trừ grant đọc; `explore` dùng model rẻ hơn nếu cấu hình `[agents.explore] model=...` trong `~/.cosmew/config.toml`.

### S6 — W12 MCP đầy đủ + tự cài

Theo W12; chia **hai phiên**: S6a (stdio transport, cấu hình, duyệt theo annotation, `/mcp`, `tool_search`, `mcp_resource`) và S6b (OAuth cho HTTP, `mcp_search` + `mcp_install` qua MCP Registry). Lấp `packages/mcp/src/transports/{stdio,http}.ts`; chuyển adapter `web_search` sang transport chung.

**Trạng thái (2026-11-20): S6a một phần** — [ADR 0068](../../adr/0068-user-mcp-connect.md), không tăng contract. Nối stdio và HTTP từ `mcp.json` cấp người dùng (`fyn mcp`, `/mcp`, gọi tool qua ToolDispatcher). Chưa có: S6b, cấu hình project, annotation auto|prompt|writes, `tool_search`, `mcp_resource`, OAuth. `web_search` giữ adapter HTTP riêng.

### S7 — Hooks + slash command tuỳ chỉnh

**Lấy**: Claude Code hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`; JSON stdin, exit 2 = chặn), custom commands dạng Markdown (`.claude/commands/*.md`, `$ARGUMENTS`); Codex `notify` / hooks và OpenCode plugin hooks — Needs verification ở revision ghim.
**Phạm vi**: hooks chỉ khai báo ở `~/.cosmew/config.toml` (cấp user, không từ workspace — tránh repo tự chạy lệnh); chạy trong sandbox như `exec_command`, timeout 60 s, output bounded + redact; hook chỉ có thể **siết** quyền (deny/ask), không nới. Slash command tuỳ chỉnh từ `.cosmew/commands/*.md` (project) và `~/.cosmew/commands/` (user): chỉ là template prompt, không chạy lệnh.
**Test**: hook chặn tool, hook timeout, hook không thể allow cái bị deny, command template với `$ARGUMENTS`, command project không ghi đè command built-in.

### S8 — W13 CodeMode

Theo W13. Trước khi code: phiên ngắn riêng chọn engine (D5) và dừng hỏi user nếu cần dependency mới.

## 5. Kết thúc đợt 2

Sau S8 (hoặc khi user dừng): một phiên chạy toàn bộ test + chạy lại UAT S0 bằng `hannes exec`, ghi `docs/delivery/wave-2/acceptance.md` theo mục 11 của plan đợt 1. Push chỉ khi user bảo.
