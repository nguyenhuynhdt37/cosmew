# Audit tính năng Cosmew và hướng phát triển

Ngày: 2026-11-22. Baseline commit: `578f6f1`, cộng working tree đang có bản sửa
external-cwd consent và test isolation chưa commit. Đây là audit, không phải tuyên
bố nghiệm thu toàn dự án. Lượt này không sửa production code, không commit/push,
không gọi provider có phí hay chạy agent CLI bên ngoài.

## Những phần đã có

Structured Read/Edit/Write/apply_patch, Glob/Grep, shell/PTY và tác vụ nền, web
search/fetch, MCP stdio/HTTP, 9 thao tác LSP và rename, skills, memory CRUD/index/
citations, compaction/checkpoints/rewind, queue/steer, subagent hội thoại đầy đủ,
message/sibling navigation/stop/notification/history, optional worktree isolation,
Vim và theme đều đã có implementation. Không đưa lại các phần này vào backlog
"chưa làm" chỉ vì một alias slash command còn ghi unavailable.

ChatGPT không phải hoàn toàn chưa xác minh live: ADR 0050 ghi exchange/discovery/
keyring/streaming; delivery subagents-4 ghi real ChatGPT API/gpt-6.2-sol lifecycle,
continuation/cancellation/out-of-turn progress. Phạm vi đó chưa chứng minh mọi
provider/model, refresh/revocation, sibling concurrency, restart hay TUI/OS.
Usage source attribution ở ADR 0094 cũng đã có; quota khác OpenRouter chủ yếu là
snapshot response, không phải account refresh API đầy đủ.

## 1–6: Nên cải thiện trước

### 1. P1 — Resume chéo dự án không làm rõ workspace (đã tái hiện)

Client B liệt kê và resume được session lưu cho A, giữ lịch sử A nhưng
`status().workspace` vẫn B. Không có tool/file mutation trong phép thử; source
xác lập dispatcher của client B vẫn dùng tool root B. Đây là nguy cơ sửa nhầm dự
án do context/workspace lệch nhau, không phải chứng minh permission bypass.

Evidence: `packages/persistence/src/session-store.ts:792` lấy 200 session toàn
cục; `apps/cli/src/bootstrap/startup.ts:1729` không lọc; `:1446–1450` và
`:1750–1752` resume không kiểm tra workspace gốc; TUI
`apps/tui/src/ink/features/sessions/index.tsx:100–102` lại mô tả theo dự án hiện tại.
Repro tạm quan sát `listedInB=true`, `storedWorkspace=A`,
`currentWorkspace=B`, `resumedMessages=[AUDIT_PROJECT_A_ONLY_MARKER]`.

Nghiệm thu: mặc định lọc theo workspace; All projects hiển thị đường dẫn; resume
khác workspace phải chuyển root đúng hoặc tạo fork được ghi nhãn rõ. Test A/B,
legacy NULL workspace, same-name sessions và hơn 200 session.

### 2. P1 — Usage bị mất khi compaction thất bại (đã tái hiện)

`packages/core/src/context/model-compaction.ts:105–116` nhận usage rồi có thể
throw vì length/empty/protocol. `agent/compact.ts:46–68` và `agent/turn.ts:545–558`
chỉ ghi usage sau khi helper return thành công. `context/rewind-summary.ts:20`
có cùng mẫu cần rà soát. Request summary có usage đã báo nhưng thất bại có thể
biến mất khỏi receipt và budget.

Repro `/tmp/cosmew-failed-compaction-repro.ts`, public Conversation + SQLite tạm,
fixture model, không billing live: bốn lượt trước tổng input 40; một summary báo
1000 input/100 output/$0.123. Length-cut và empty fallback đều giữ tổng 40 và
usage:null; success control tăng lên 1040. Phép thử đã shutdown/xoá state tạm.

Nghiệm thu: ghi usage đúng một lần dù summary length/empty, stream lỗi sau usage
hoặc huỷ; không publish summary/checkpoint chưa hợp lệ. Kiểm tra reopen, source
attribution và budget. Existing failure tests chủ yếu lỗi trước khi có usage.

### 3. P1/P2 — MCP cần phục hồi và báo giới hạn đúng (source verified)

`packages/mcp/src/servers.ts:80–90` trả snapshot cũ khi đã có status, kể cả failed;
composition `startup.ts:1960` dùng lại hub này. HTTP client retry không thay thế
được hub rediscovery sau lần khởi tạo hỏng. Cần reconnect từng server, bounded
backoff, cập nhật trạng thái và cancellation/shutdown rõ.

Discovery tại `servers.ts:254` và `client.ts:184` dừng sau 4 trang/64 tool, chưa
báo truncation; schema đã expose được đưa upfront vào request. Non-text MCP
content bị lọc ở `servers.ts:283–289` / `client.ts:134–138`, nên image-only result
có thể trở thành success rỗng. Cần notice, deferred discovery/schema và chuyển
content hỗ trợ được hoặc trả lỗi unsupported rõ.

Nghiệm thu: init fail→server hồi phục→reconnect không restart app; 100+ tools vẫn
tìm được mà context bounded; image/resource-only không success rỗng; mọi deferred
call vẫn qua dispatcher/schema/permission/redaction.

### 4. P1 — Memory cần phục hồi sau crash (source verified; kill test còn thiếu)

`packages/persistence/src/memory-directory.ts:170–175` tạo `.lock` bằng mkdir và
không có owner/lease recovery. Reads cũng giữ lock để cập nhật usage
(`memories.ts:151`); process chết lúc giữ lock có thể chặn các lần đọc/ghi sau.
Mutation ghi memory/index/counters riêng tại `memories.ts:215–218`, nên cần cơ chế
reconcile nếu crash giữa các lần rename.

Nghiệm thu: real subprocess bị kill khi giữ lock/giữa các commit boundary; mở lại
phục hồi an toàn, không lấy lock của process còn sống, không mất user edits;
kiểm tra PID reuse/symlink/concurrent writers. Không kết luận đã chạy crash test.

### 5. P1/P2 — Worktree handoff thiếu bước tích hợp kết quả (source verified)

`packages/agents/src/subagents.ts:806` hướng dẫn merge branch hoặc copy; worktree
được tạo ở HEAD (`packages/workspace/src/worktrees.ts:173–181`) và sửa đổi thường
chưa commit, nhất là khi sandbox cấm ghi common .git. Merge branch khi đó có thể
không đem sửa đổi về checkout chính.

Nghiệm thu: phân biệt committed/uncommitted, có xem diff và apply/copy được duyệt,
xử lý conflict/untracked/binary; giữ worktree nếu chưa tích hợp thành công. Test
hiện có chứng minh giữ worktree, chưa chứng minh end-to-end tích hợp sửa đổi.

### 6. P1 — Một quality gate phải bao phủ đúng sản phẩm (đã kiểm tra)

`package.json:26` chạy `bun test tests`, bỏ test dưới apps, nơi có TUI/editor và
bootstrap. Không thấy .github workflow trong cây hiện tại. Test native/PTY/live
cần tách tầng nhưng cùng có entry point và báo skip, không chỉ một số tổng xanh.

Có regression test env cụ thể: preload set COSMEW_HOME, nhưng
`tests/mcp/user-servers.test.ts:176` chỉ ghi đè FUTRYN_HOME/HANNES_HOME khi spawn.
CLI đúng khi ưu tiên COSMEW_HOME nên fixture đọc nhầm temp state và thấy servers
rỗng. Run kiểm soát đặt cả ba biến về cùng temp home thì stdio discovery hoạt
động. Đây là lỗi test isolation, không phải bằng chứng MCP CLI bị hỏng.

Nghiệm thu: gate tests + apps + type/lint; toàn bộ child process trỏ state tạm;
CI macOS/Linux có sandbox on/off, cancellation/restart/terminal controls. Pending
external-cwd consent phải được commit và đối chiếu installation hash trước UAT;
không lẫn draft đã test với binary đang chạy. Không dừng/khôi phục DB của phiên
người dùng để làm guard xanh.

## 7–12: Tính năng mới đáng bổ sung

7. **Hooks trước/sau tool và trước khi kết thúc.** Hiện chỉ có contract/status,
   chưa có executor (`packages/contracts/src/hooks.ts`, SDK hookStatus supported
   false). Dùng để format/lint/test hoặc chặn completion khi kiểm tra bắt buộc
   chưa đạt. Bắt đầu nhỏ: PreToolUse/PostToolUse/Stop, trusted provenance,
   timeout/cancel và revalidation; không cho hook đi vòng dispatcher.
8. **MCP OAuth/resources + tool search/deferred schemas.** Stdio/HTTP đã có;
   tương tác OAuth, resource discovery/read và dynamic tool refresh chưa có.
   Thêm user-scoped login/refresh/revoke, SSRF/redaction/size limits. Không tự chạy
   repo MCP config. Không dò endpoint quota/auth riêng không được tài liệu hoá.
9. **Auto memory opt-in.** Memory hiện tại dùng được, nhưng `auto_extract=true`
   trả diagnostic unsupported (`apps/cli/src/bootstrap/host-config.ts:131–132`).
   Thêm job bounded/idempotent, review candidate, giữ user edits, tính usage và
   không biến nội dung chat/repository thành quyền hay instruction hệ thống.
10. **IDE/ACP bridge.** LSP trong agent đã có; editor bridge để gửi file đang mở,
    selection, diagnostics và điều khiển session/approval từ IDE chưa thấy. Làm
    protocol và một integration nhỏ trước full IDE extension/server UI.
11. **Shared task graph cho nhiều agent.** update_plan đã có tối đa 50 bước và
    một in_progress; chưa phải task có ID/dependency/owner. Thêm giao việc, trạng
    thái phụ thuộc, cancellation và theo dõi conflict; tiếp tục dùng agent loop
    Cosmew, không spawn CLI agent bên ngoài.
12. **Session product workflow và phân phối.** Rename bền, sort theo last activity,
    phân trang, workspace/time, export Markdown/JSON redacted chưa trọn vẹn;
    `/rename` và `/export` vẫn unavailable, dù fork/scrollback/editor transcript
    đã có. CLI hiện private, bin trỏ TS source + workspace packages; cần đường
    cài đặt/release/upgrade có smoke test trên máy sạch. Linux/live LSP/provider
    certification cần mở rộng; Windows sandbox vẫn chưa được triển khai.

## Tham khảo upstream

Đã mở tài liệu chính thức ngày 2026-11-22. Đây là reference capability theo tài
liệu hiện tại, không phải so sánh runtime đã chạy live hay bảo đảm tương thích
version cài trên máy.

- Claude Code: [hooks](https://code.claude.com/docs/en/hooks),
  [MCP tool search/reconnection/OAuth](https://code.claude.com/docs/en/mcp),
  [auto memory](https://code.claude.com/docs/en/memory). Học sự tách biệt giữa
  workflow gợi ý bằng prompt với bước kiểm tra bắt buộc và schema nạp khi cần.
- OpenAI Docs: [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands)
  ghi session rename/export, lifecycle hooks, worktree/server/session management.
  Học luồng hoàn chỉnh từ session tới worktree/review; không coi tên slash command
  là thước đo hoàn thành tính năng và không sao chép chế độ quyền Codex vào
  permission model Claude-style của Cosmew.
- OpenCode: [MCP](https://opencode.ai/docs/mcp-servers),
  [plugins](https://opencode.ai/docs/plugins),
  [ACP](https://opencode.ai/docs/cli/acp). Học mở rộng protocol/editor và lifecycle
  của tích hợp. Quy tắc trust của repository/settings vẫn theo Cosmew; không
  tự import/chạy plugin repository như cách một sản phẩm khác có thể cho phép.

## Phạm vi kiểm tra và thứ tự đề xuất

- Core: 62 pass / 0 fail / 323 assertions cho model-compaction, memories,
  runtime-recovery, durable-execution. Những test này không bao phủ usage failure
  vừa tái hiện hay stale lock do SIGKILL.
- MCP/web/LSP: 58 pass / 2 skip / 1 fail; fail là test env ở mục 6. Native
  Seatbelt helper tests qua; hai real-installed TypeScript LSP tests bị skip.
- Session A/B và failed compaction đã có repro riêng; source xác minh đường tool
  root B nhưng không thực thi mutation vào B. Không tuyên bố live billing proof.

Làm 1–2 trước để tránh sai dự án và sai usage; tiếp theo 3–6 để ổn định kết nối,
persistence và quality gate. Sau đó mở 7–8; 9–12 là backlog tăng năng lực sản
phẩm. Các feature đã có ở phần đầu không phải công việc cần viết lại.
