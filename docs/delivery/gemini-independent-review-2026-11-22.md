> Review do AGY Gemini 4 Neon (High) thực hiện trên working tree đang thay đổi. Các finding là nhận xét từ mã nguồn, chưa được reviewer chạy test; phần sửa và nghiệm thu sau đó được theo dõi riêng trong product-stability-fixes-2026-11-22.md. Mốc thời gian/ước lượng trong review là ý kiến reviewer.

# Báo cáo Review Độc Lập — Cosmew (`/Users/huynh/codes/hannes`)

- **Ngày review:** 2026-11-22
- **Chế độ:** Chỉ đọc (READ-ONLY) — không chỉnh sửa file repository, không stage/commit/reset/stash, không mở/ghi user state DB (`/Users/huynh/.futryn/provider-auth.sqlite`), không chạy live provider generation hay cài đặt package.
- **Tài liệu nền đã đối chiếu:** [AGENTS.md](/Users/huynh/codes/hannes/AGENTS.md), [docs/README.md](/Users/huynh/codes/hannes/docs/README.md), [docs/contracts/agent-events.md](/Users/huynh/codes/hannes/docs/contracts/agent-events.md), [docs/architecture/dependency-rules.md](/Users/huynh/codes/hannes/docs/architecture/dependency-rules.md), [docs/delivery/product-audit-2026-11-22.md](/Users/huynh/codes/hannes/docs/delivery/product-audit-2026-11-22.md).
- **Trạng thái cây mã nguồn:** Dirty tree dùng chung — các agent khác đang chủ động triển khai mục 1, 2, 4, 5, 6 của product-audit (mục 3 MCP là backlog riêng). Trong lúc review, các thay đổi của **mục 5 (worktree handoff)** và **mục 6 (unified quality gate)** vẫn đang tiếp tục được cập nhật trực tiếp nên được gắn nhãn **`MOVING TARGET`**.

---

## 1. Phạm vi, Giới hạn & Bằng chứng kiểm tra

| Khía cạnh | Trạng thái trong lượt review này |
|---|---|
| Đọc mã nguồn & diff hiện hành | Hoàn tất trên các gói lõi: `core`, `persistence`, `tools`, `security`, `mcp`, `agents`, `workspace`, `models`, `sdk`, `code-intel`, `contracts`, `apps/cli`, `apps/tui`, `scripts/test.ts`, `.github/workflows/quality.yml`. |
| Chạy test suite | **Không chạy full suite hay targeted test** (tuân thủ giới hạn đọc-chỉ và tránh xung đột với các agent khác đang sửa dirty tree + user-state guard trên `/Users/huynh/.futryn/provider-auth.sqlite`). **Không tuyên bố green full gate.** |
| Live provider / OS parity | Không chạy sinh token thật, không xác minh runtime Linux bubblewrap, Windows sandbox hay live OAuth/quota ngoài mã nguồn. Mọi so sánh runtime upstream đều gắn nhãn `Needs verification`. |
| Tôn trọng kiến trúc & bảo mật | Mọi đề xuất giữ nguyên mô hình quyền Claude Code (ADR 0061), cổng `ToolDispatcher` duy nhất, bất biến fail-closed của sandbox, untrusted repo settings, và cấm gọi tiến trình agent bên ngoài (ADR 0045–0049). |

---

## 2. Đánh giá các hạng mục đang sửa trong dirty tree (Items 1, 2, 4, 5, 6)

| Hạng mục | Trạng thái | Tóm tắt đánh giá kỹ thuật |
|---|---|---|
| **Item 1 — Workspace-scoped session safety** | Đã có bản sửa một phần | Đã chặn `listSessions`, `getSession`, `openStoredConversation` (`resumeSession`), `forkSession`. **Còn sót nhiều cửa hậu cross-workspace** ở `deleteSession`, `runShellCommand`, `savePlanProposal`/`getPlan*`, `subagents*`, `queuedInput`/`enqueueNextTurn`/`retractQueued*`, `promptHistory(scope:'session')`, và lệch canonical path ở `checkpointStore` (chi tiết mục 3.1). |
| **Item 2 — Failed/cancelled compaction usage & budgets** | Đã sửa phần lõi, còn 3 khe hở | `summarizeWithModel` (`onUsage` trong `finally`), `compact.ts`, `turn.ts:555-560`, `turn.ts:493`, `turn.ts:1136-1137`, và `accountModelUsage` xử lý tốt kịch bản gốc. **Còn 3 lỗi sót thật:** mất 100% usage khi `addUsage` chạy trên session mới fork/rewind chưa có `turn_receipts`; race cancellation trong `TurnRun.handleEvent`; và `agents/src/budgets.ts` bỏ qua `breakdown` nên có thể bypass `maxCostUSD` ở subagent (chi tiết mục 3.2, 3.3, 3.7). |
| **Item 4 — Kernel-lock memory crash recovery / journal** | Đã thay `mkdir` bằng `flock` + `.pending.json` | Bước tiến đúng hướng cho phục hồi sau `SIGKILL` không dựa PID/timeout. **Còn lỗi thực tế:** `flock(LOCK_EX \| LOCK_NB)` không retry trên cả đường chỉ đọc (`list`/`read`/`context`) gây lỗi `STORAGE` khi 2 tiến trình truy cập đồng thời; ngưỡng `names() > 264` chặn trước khi `recover()` dọn `.tmp`; `.pending.json` hỏng ném raw `SyntaxError`/`ZodError` (chi tiết mục 3.4). |
| **Item 5 — Worktree handoff guarded approved apply** | **`MOVING TARGET`** (đang sửa dở) | Bản nháp hiện tại ở [worktrees.ts](/Users/huynh/codes/hannes/packages/workspace/src/worktrees.ts#L219-L285) và [apply-patch.ts](/Users/huynh/codes/hannes/packages/tools/src/handlers/apply-patch.ts#L17-L79) đi đúng hướng (chỉ tạo patch untrusted kèm `expected_files` SHA-256 preimage guard qua `apply_patch`). Tuy nhiên **các điểm chưa hoàn thiện trên bản nháp** cần xử lý trước khi chốt: budget patch chỉ 1800 ký tự nhưng dump toàn bộ dòng cũ/mới thay vì contextual hunk; chặn cứng `(mode & 0o777) !== 0o644` (loại bỏ mọi file `0755` và mọi file tạo mới trên Linux umask `0002` có mode `0664`); từ chối file không có trailing newline / CRLF. *Không đánh giá đây là hành vi chấp nhận cuối cùng.* |
| **Item 6 — Unified quality gate + apps/TUI** | **`MOVING TARGET`** (đang sửa dở) | Bản nháp đã thêm [scripts/test.ts](/Users/huynh/codes/hannes/scripts/test.ts#L1-L46) (`all: ['tests', 'apps', 'packages']`, tách tier `native`/`pty`/`live`), [.github/workflows/quality.yml](/Users/huynh/codes/hannes/.github/workflows/quality.yml#L1-L30) (Ubuntu + macOS), script `quality` trong [package.json](/Users/huynh/codes/hannes/package.json#L35), và sửa env `COSMEW_HOME` trong [tests/mcp/user-servers.test.ts](/Users/huynh/codes/hannes/tests/mcp/user-servers.test.ts#L178-L180). Rủi ro còn lại ở `user-state-guard` (xem mục 4.1). *Không đánh giá đây là hành vi cuối cùng và chưa xác minh chạy xanh trên CI.* |

---

## 3. Lỗi Code Quan Sát Được (Observed Code Bugs) — Ưu tiên theo tác động

### 3.1. [P1 — Security / Data Integrity] Rò rỉ thao tác chéo workspace trên các API session chưa gọi `assertSessionWorkspace`
- **Vị trí:**
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1765-L1768) (`deleteSession`)
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1525-L1539) (`runShellCommand`)
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1569-L1578) (`savePlanProposal`, `getPlanProposal`, `getPlan`, `subagents`, `inspectSubagent`, `stopSubagent`)
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1923-L1948) (`queueSteeringForNextTurn`, `retractQueuedInput`, `retractQueuedEntries`, `enqueueNextTurn`, `listNextTurn`, `queuedInput`)
  - [packages/persistence/src/session-store.ts](/Users/huynh/codes/hannes/packages/persistence/src/session-store.ts#L774-L794) (`promptHistory` với `scope: 'session'`)
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1805-L1840) (`checkpointStore.begin/list/rewindCheckpoint` dùng `workspaceRoot` thô thay vì `canonicalWorkspace`)
- **Bằng chứng:** Item 1 chỉ gắn `assertSessionWorkspace(id, canonicalWorkspace)` cho `getSession`, `openStoredConversation` và `forkSession`. Trong khi đó `deleteSession` gọi thẳng `conversations.delete(id)` — một client ở workspace B vẫn xóa được session thuộc workspace A; `runShellCommand` mở thẳng `conversations.get(context.sessionId)` và ghi receipt shell từ workspace B vào session của A; các API queue/plan/subagent/promptHistory(`scope: 'session'`) cũng không kiểm tra `workspace` của `sessionId`. Riêng `checkpointStore` lưu/so khớp `workspaceRoot` chưa canonicalize, nên mở cùng thư mục qua symlink hoặc relative path khác làm `target.workspace !== workspaceRoot` trả `NOT_FOUND`.
- **Khắc phục đề xuất:** Gom kiểm tra `assertSessionWorkspace(sessionId, canonicalWorkspace)` vào toàn bộ entry point nhận `sessionId` (và kiểm tra `parentConversationId` cho `inspectSubagent`/`stopSubagent`), đồng thời chuẩn hóa `checkpointStore` theo `canonicalWorkspace`.

### 3.2. [P1 — Billing / Telemetry] `SqliteConversations.addUsage()` làm mất 100% usage khi `/compact` hoặc `/rewind --summarize` chạy trên session vừa fork/rewind
- **Vị trí:**
  - [packages/persistence/src/session-store.ts](/Users/huynh/codes/hannes/packages/persistence/src/session-store.ts#L693-L708) (`addUsage`)
  - [packages/persistence/src/session-store.ts](/Users/huynh/codes/hannes/packages/persistence/src/session-store.ts#L580-L600) (`fork`)
  - [apps/cli/src/bootstrap/startup.ts](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1852-L1883) (`rewindCheckpoint` `scope === 'summarize'`)
  - [packages/core/src/agent/compact.ts](/Users/huynh/codes/hannes/packages/core/src/agent/compact.ts#L54-L57)
- **Bằng chứng:** `fork()` và `rewindCheckpoint()` sao chép lịch sử bằng `appendContext()` (không tạo bản ghi trong bảng `turn_receipts`). Khi người dùng gọi `/compact` hoặc `/rewind --summarize` trên session vừa fork/rewind (hoặc session chỉ mới có `user-shell` receipt), `addUsage()` truy vấn `SELECT revision, data FROM turn_receipts WHERE conversation=? ORDER BY revision DESC`, gặp mảng rỗng `[]` (hoặc toàn `user-shell`) và **im lặng return**, làm toàn bộ token và chi phí USD đã tiêu thụ biến mất khỏi receipt/telemetry.
- **Khắc phục đề xuất:** Nếu chưa có agent `turn_receipts`, `addUsage()` phải tạo một receipt hệ thống/compaction riêng (ví dụ `kind: 'compaction'` hoặc gắn vào revision hiện hành trong `turn_receipts`) trong transaction để usage không bao giờ rơi vào hư không.

### 3.3. [P1 — Budget Enforcement] Subagent budget bỏ qua `usage.breakdown`, gây bypass `maxCostUSD` / `maxEstimatedCostUSD` khi pha trộn model không rõ giá
- **Vị trí:**
  - [packages/agents/src/budgets.ts](/Users/huynh/codes/hannes/packages/agents/src/budgets.ts#L179-L185) (`reserveForChildren`)
  - [packages/agents/src/budgets.ts](/Users/huynh/codes/hannes/packages/agents/src/budgets.ts#L190-L200) (`parentCapsExceeded`)
  - [packages/agents/src/budgets.ts](/Users/huynh/codes/hannes/packages/agents/src/budgets.ts#L220-L221) (`inheritChildLimits`)
  - Đối chiếu bản đã sửa đúng ở [packages/core/src/agent/turn.ts](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts#L1136-L1137)
- **Bằng chứng:** Theo ADR 0094, khi `combineUsage` gộp một request có `costUSD` với một request không có giá (`costUSD: null`), tổng `usage.costUSD` trở thành `null` nhưng phần chi phí đã biết vẫn nằm trong `usage.breakdown`. `TurnRun.workExhausted()` đã xử lý đúng bằng `usage.costUSD ?? usage.breakdown.reduce(...)`, nhưng cả 3 hàm trong `packages/agents/src/budgets.ts` vẫn viết `cost = used?.costUSD ?? 0`. Hệ quả: chỉ cần 1 subagent/request không có pricing là `parent.usage.costUSD` thành `null`, khiến `parentCapsExceeded` trả `false` (không dừng siblings) và `inheritChildLimits` tính `spentCost = 0` (cho phép spawn thêm subagent vượt trần chi phí).
- **Khắc phục đề xuất:** Dùng chung một helper `knownCostUSD(usage)` trong `@cosmew/contracts` cho cả `turn.ts` và `packages/agents/src/budgets.ts`.

### 3.4. [P1 — Persistence / Concurrency] Memory `flock(LOCK_EX | LOCK_NB)` gây lỗi `STORAGE` tức thì khi đọc/ghi đồng thời; lỗi dọn `.tmp` & corrupt `.pending.json`
- **Vị trí:**
  - [packages/persistence/src/memory-directory.ts](/Users/huynh/codes/hannes/packages/persistence/src/memory-directory.ts#L165) và [L194](/Users/huynh/codes/hannes/packages/persistence/src/memory-directory.ts#L194)
  - [packages/persistence/src/memories.ts](/Users/huynh/codes/hannes/packages/persistence/src/memories.ts#L59-L69) và [L105-L124](/Users/huynh/codes/hannes/packages/persistence/src/memories.ts#L105-L124)
- **Bằng chứng:**
  1. `withDirectory()` gọi `directory.lock()` cho mọi thao tác kể cả chỉ đọc (`list()`, `context()`, `read()`), và `lock()` gọi `flock(fd, 2 | 4)` (`LOCK_EX | LOCK_NB`) **không có retry/backoff**. Nếu 2 terminal/phiên Cosmew mở cùng workspace đọc `context()` đồng thời, một bên lập tức nhận `EWOULDBLOCK` và ném `FutrynError('STORAGE')`.
  2. `MemoryDirectory.names()` chặn cứng `names.length > 264` (256 memory + `.lock` + `.pending.json` + `.usage.json` + `MEMORY.md` = 260; chỉ cần 5 file `.tmp` sót lại sau nhiều lần crash là `names()` throw `STORAGE` **trước khi `recover()` kịp dọn `.tmp`**).
  3. Trong `recover()` (`memories.ts:112-122`), nếu `.pending.json` hỏng định dạng JSON hoặc sai schema, `JSON.parse` / Zod ném `SyntaxError` / `ZodError` thô thay vì `FutrynError('STORAGE')`.
- **Khắc phục đề xuất:** Bổ sung bounded retry/backoff (hoặc `LOCK_SH` cho `list`/`context` thuần đọc khi không cần recover) cho `flock`; tách riêng bước quét/dọn `.tmp` không bị giới hạn 264 trước `entries()`; bọc `recover()` để chuyển mọi parse failure sang `FutrynError('STORAGE')`.

### 3.5. [P1 — MCP Reliability] `JSON.parse(redact(JSON.stringify(structuredContent)))` có thể làm hỏng JSON hợp lệ và gây crash `TRANSPORT`
- **Vị trí:**
  - [packages/mcp/src/client.ts](/Users/huynh/codes/hannes/packages/mcp/src/client.ts#L143-L145)
  - Tương tự nguy cơ hỏng JSONL ở [apps/cli/src/exec.ts](/Users/huynh/codes/hannes/apps/cli/src/exec.ts#L143-L145)
- **Bằng chứng:** `McpClient.call()` thực hiện `JSON.parse(this.options.redact(JSON.stringify(result.structuredContent)))`. Nếu giá trị bí mật trong `structuredContent` (ví dụ cặp `"token":"..."` hoặc chuỗi chứa ký tự bị redact làm lệch dấu `"`) bị `redact()` thay thế trên chuỗi JSON đã serialize, `JSON.parse` ném `SyntaxError` và khối `catch` ở dòng 153 biến kết quả tool thành công thành lỗi `FutrynError('TRANSPORT')`. Ở `exec.ts:144`, chạy `app.redactor.text(JSON.stringify(...))` trên dòng JSONL cũng mang nguy cơ phá cấu trúc JSON của consumer.
- **Khắc phục đề xuất:** Viết đệ quy `redactJsonValue(value, redact)` redact từng chuỗi/key trước khi `JSON.stringify`, tuyệt đối không redact trực tiếp lên raw JSON wire text.

### 3.6. [P1 — MCP Lifecycle] `connectStdio` gắn vòng đời server vào `signal` của bước `connect()` + không thể reconnect server `failed` + 1 tool lỗi đánh sập cả server
- **Vị trí:**
  - [packages/mcp/src/servers.ts](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L198-L200) & [L232-L236](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L232-L236) (`connectStdio` lifetime leak)
  - [packages/mcp/src/servers.ts](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L80-L91) & [L115-L128](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L115-L128) (sticky failed snapshot & partial batch loss)
  - [packages/mcp/src/servers.ts](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L254-L270), [L283-L289](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L283-L289), [L321-L329](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts#L321-L329) và [packages/mcp/src/client.ts](/Users/huynh/codes/hannes/packages/mcp/src/client.ts#L134-L138), [L178-L196](/Users/huynh/codes/hannes/packages/mcp/src/client.ts#L178-L196)
- **Bằng chứng:**
  1. `connectStdio` đăng ký `signal?.addEventListener('abort', () => lifetime.abort())` và chỉ gỡ trong `close()`, không gỡ sau khi connect xong. Nếu caller truyền một startup-timeout signal hoặc command signal cho `connect(signal)` rồi abort signal đó sau khi connect thành công, toàn bộ stdio server đang chạy bị giết ngay lập tức.
  2. `McpHub.connect()` kiểm tra `if (this.servers.length || this.snapshotValue.servers.length) return this.snapshot()` — một server khởi động lỗi sẽ giữ trạng thái `failed` suốt vòng đời app, không có reconnect per-server. Nếu bị cancel giữa các batch 4 server, các server ở batch sau biến mất khỏi snapshot.
  3. `schemaOf()` ném `FutrynError('PROTOCOL')` cho toàn bộ server chỉ vì **1 tool duy nhất** có schema > 8 KiB hoặc không có `type: 'object'` (như root `anyOf`/`oneOf` hợp lệ theo JSON Schema).
  4. Cắt im lặng ở 4 trang / 64 tool và lọc chỉ giữ `block.type === 'text'`, biến kết quả `image`/`resource`-only thành success rỗng `""`.
- **Khắc phục đề xuất:** Gỡ listener `signal` ngay sau khi `connectStdio` hoàn tất handshake; triển khai reconnect từng server với bounded backoff; cách ly lỗi schema theo từng tool (báo warning thay vì fail toàn server); báo rõ truncation và trả lỗi/attachment rõ cho non-text content.

### 3.7. [P2 — Core Cancellation / Usage] `TurnRun.handleEvent()` kiểm tra `signal.aborted` trước khi ghi nhận `usage` của chunk cuối cùng
- **Vị trí:** [packages/core/src/agent/turn.ts](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts#L828) so với [L849-L855](/Users/huynh/codes/hannes/packages/core/src/agent/turn.ts#L849-L855)
- **Bằng chứng:** Khác với `summarizeWithModel` vừa sửa ([model-compaction.ts:106-107](/Users/huynh/codes/hannes/packages/core/src/context/model-compaction.ts#L106-L107) ghi `usage` TRƯỚC `signal?.throwIfAborted()`), `TurnRun.handleEvent()` ở dòng 828 ném `CANCELLED` ngay đầu hàm trước khi nhánh `event.type === 'usage' || event.type === 'completed'` ở dòng 849 chạy. Nếu tín hiệu hủy đua với event `usage`/`completed` cuối stream đã được provider phát ra, billing của lượt bị hủy không được ghi vào `this.modelUsage` / `receipt.usage`.
- **Khắc phục đề xuất:** Ghi nhận `usage` (và `observeTurn`) trước khi ném `CANCELLED` giống mẫu đã dùng trong `model-compaction.ts`.

### 3.8. [P2 — Moving Target Defect Watch (Item 5)] Các giới hạn quá chặt trong bản nháp `GitWorktrees.handoff()`
- **Vị trí (`MOVING TARGET`):** [packages/workspace/src/worktrees.ts](/Users/huynh/codes/hannes/packages/workspace/src/worktrees.ts#L256-L270)
- **Bằng chứng:**
  1. Dòng 265 tạo `*** Update File` bằng cách xuất toàn bộ `-lines(before)` và `+lines(after)` thay vì minimal contextual hunk, trong khi dòng 266 giới hạn tổng patch 1800 ký tự — khiến gần như mọi sửa đổi trên file >40 dòng đều rơi vào `patch review budget exceeded`.
  2. Dòng 256 từ chối mọi file có `(mode & 0o777) !== 0o644` — chặn cả file script `0755` lẫn mọi file mới tạo trên Linux mặc định `umask 0002` (`0664`).
  3. Dòng 257 từ chối file không có trailing newline hoặc CRLF.
- **Lưu ý:** Vì Item 5 đang được chỉnh sửa tích cực, nên xử lý các điểm này trước khi chốt nghiệm thu chứ không coi bản nháp là hoàn tất.

---

## 4. Rủi ro Chưa Xác Minh (Unverified Risks)

1. **`user-state-guard` và đột biến `/Users/huynh/.futryn/provider-auth.sqlite` trong lúc chạy test (`MOVING TARGET` Item 6):**
   - [tests/preload.ts](/Users/huynh/codes/hannes/tests/preload.ts#L11) gọi `watchUserState(userInfo().homedir)` theo dõi trực tiếp các file trong `~/.cosmew`, `~/.futryn`, `~/.hannes` thật của người dùng bằng `size:mtimeNs` và SHA-256.
   - **Rủi ro chưa xác minh nguyên nhân đơn lẻ:** Việc guard báo `/Users/huynh/.futryn/provider-auth.sqlite` thay đổi có thể xuất phát từ (a) một tiến trình Cosmew/`fyn` khác đang chạy đồng thời trên máy host chạm vào DB (WAL/mtime), hoặc (b) một test/child process còn sót chưa cô lập hoàn toàn `HOME`/`COSMEW_HOME` hoặc gọi trực tiếp `homedir()`/`userInfo().homedir` rơi vào `defaultStateDirectory`. Cần điều tra bằng audit trace (như `fs_usage` hoặc log process PID trong môi trường test tách biệt), tuyệt đối không tắt guard hay phục hồi DB.
2. **FFI `readdir` trên macOS Intel (`x86_64`) (`packages/persistence/src/memory-directory.ts:163`):**
   - Máy hiện tại là `arm64`, nơi symbol `readdir` trong `libSystem.B.dylib` mặc định dùng `struct dirent` 64-bit (`d_name` ở offset `21`). Tuy nhiên trên **macOS `x86_64`**, symbol `readdir` không có hậu tố `$INODE64` trả về struct 32-bit cũ với `d_name` ở offset `8`, khiến `new CString(Number(entry) + 21)` đọc sai vùng nhớ. **Trạng thái: Needs verification trên macOS x86_64** (và cần kiểm tra tương đương ở `SecureFiles` nếu dùng chung mẫu FFI).
3. **Linux bubblewrap & network proxy bridge:**
   - Như [startup.ts:1627-1630](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1627-L1630) và `AGENTS.md` đã ghi nhận: Linux bubblewrap chưa được nghiệm thu live trên máy Linux thật và hiện không có bridge tới loopback proxy cho lệnh trong sandbox (mạng bị cắt hoàn toàn khi bật sandbox trên Linux).
4. **Live provider / OAuth / Quota parity:**
   - [apps/cli/src/bootstrap/startup.ts:1734-1744](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1734-L1744) chỉ có live API credits cho OpenRouter (`GET /api/v1/key`); các provider khác (OpenAI/Anthropic/ChatGPT Codex headers trong [packages/models/src/limits.ts](/Users/huynh/codes/hannes/packages/models/src/limits.ts#L67-L139)) chỉ parse response headers của lượt gần nhất (`last-turn`) và đều cần xác minh live (`Needs verification`).
5. **Windows platform:** Chưa có sandbox và `MemoryDirectory` FFI (`memory-directory.ts:18`) trả `null` trên `win32` (fail-closed `STORAGE`).

---

## 5. Năng lực Đã Hiện Hữu (Existing Capabilities — KHÔNG đề xuất viết lại)

Để tránh lặp công việc và tôn trọng đúng codebase hiện tại, các năng lực sau **đã có implementation thực tế**:
- **Công cụ file & tìm kiếm:** `read` (kèm media/image attachments), `edit`, `write`, `apply_patch` (Codex format + stale-file/SHA-256 revalidation), `glob`, `grep`, và external file/cwd scoped approval (ADR 0092).
- **Shell / PTY / Background tasks:** Unified exec terminal, PTY streaming (`toolOutputDelta`), tác vụ nền `/tasks` + durable `<task-notification>` inbox, OS Seatbelt sandbox tùy chọn + HTTP/CONNECT proxy kiểm soát domain (ADR 0061, 0081).
- **Code Intelligence (LSP):** 9 thao tác LSP + rename chạy trong command sandbox, auto-restart backoff, file watcher, post-edit new diagnostics ([packages/code-intel/src/lsp.ts](/Users/huynh/codes/hannes/packages/code-intel/src/lsp.ts)).
- **Context, Compaction & Checkpoints:** Auto/manual model compaction + excerpt fallback, bounded `tool_output` evidence archive (ADR 0063), checkpoints + `/rewind` (code/conversation/summarize), `/fork`, prompt history & queue/steer/selective retract (ADR 0033, 0074).
- **Subagents hoàn chỉnh:** Built-in & custom agent definitions, fork context, background subagents, `agent_message` / `agent_wait` / `agent_close`, `/agents` overlay, per-child & inherited budgets, optional Git worktree isolation (ADR 0058, 0089).
- **Skills & Memories:** Skill catalog/invocation (ADR 0056), user-scoped project memories CRUD + usage ranking + citation parser (ADR 0057).
- **Usage Attribution & TUI:** Source-attributed usage breakdown (ADR 0094), fullscreen Ink TUI, Vim prompt editor (ADR 0091), custom themes, keybindings, onboarding, `fyn exec --json`.

---

## 6. 7 Cải tiến & Tính năng Mới Giá Trị Cao (Đối chiếu Claude Code, Codex CLI, OpenCode)

> Ghi chú tham chiếu upstream: Tài liệu chính thức được kiểm tra ngày **2026-11-22**. Mọi so sánh chỉ dựa trên tài liệu công khai, không chạy runtime đối thủ và không dò private endpoints; parity hành vi runtime thực tế đều thuộc diện **`Needs verification`**.

### Đề xuất 1 — Hoàn thiện MCP Lifecycle, Tool Search / Deferred Schemas, Resources & User-Scoped OAuth
- **Hiện trạng trong Cosmew:** Có stdio/HTTP cơ bản ([packages/mcp/src/servers.ts](/Users/huynh/codes/hannes/packages/mcp/src/servers.ts)); chưa có reconnect per-server, OAuth, resources, tool search/deferred schema (`/mcp` đang là `unavailable` cho subcommands, `McpServersSnapshot.supported` đều `false`).
- **Giá trị người dùng:** Kết nối ổn định với các MCP server thực tế (GitHub, Linear, Sentry, DB nội bộ) có 50–200+ tool mà không làm phình context window, không phải restart TUI khi mạng chập chờn hoặc server crash, và đọc được ảnh/resource trả về từ tool.
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Per-server reconnect + `/mcp reconnect|status` (chỉ đọc `~/.cosmew/mcp.json`, tiếp tục bỏ qua repo MCP files).
  2. Công cụ `mcp_tool_search` (hoặc deferred schema loading): chỉ gửi danh mục tên/mô tả ngắn vào context, nạp full `inputSchema` khi model gọi tìm kiếm; gỡ bỏ cứng 64-tool silent truncation và cô lập tool schema lỗi.
  3. Hỗ trợ `image` attachment (dùng lại hạ tầng `ToolResult.attachments` sẵn có) và `resources/list` + `resources/read` qua `ToolDispatcher`.
  4. User-scoped OAuth (`fyn mcp login <server>` / revoke) lưu token vào `CredentialVault` hiện có, tuân thủ SSRF + redaction.
- **Nguồn tham khảo upstream (2026-11-22):**
  - Claude Code MCP: `https://code.claude.com/docs/en/mcp` (tool search, reconnection, OAuth — runtime parity: `Needs verification`).
  - OpenAI Codex CLI MCP: `https://github.com/openai/codex` / `https://learn.chatgpt.com/docs/developer-commands` (`codex mcp login`, per-server tool filtering — runtime parity: `Needs verification`).
  - OpenCode MCP: `https://opencode.ai/docs/mcp-servers` (`Needs verification`).
- **Tiêu chí nghiệm thu:** Server khởi động lỗi → bật lại → `/mcp reconnect` phục hồi không cần restart app; server 120 tools tìm và gọi được tool thứ 100 mà tổng schema ban đầu nằm trong budget; kết quả `image`-only trả attachment hợp lệ thay vì chuỗi rỗng; mọi tool call từ deferred discovery vẫn đi qua `ToolDispatcher` + permission + redaction; repo `.mcp.json` vẫn không bao giờ tự chạy.

### Đề xuất 2 — Deterministic Lifecycle Hooks Executor (`PreToolUse`, `PostToolUse`, `Stop`)
- **Hiện trạng trong Cosmew:** Mới chỉ có contract giữ chỗ ([packages/contracts/src/hooks.ts](/Users/huynh/codes/hannes/packages/contracts/src/hooks.ts#L1-L11)) với `HooksSnapshot.supported: false` và `/hooks` báo chưa hỗ trợ.
- **Giá trị người dùng:** Biến các nguyên tắc mềm trong `AGENTS.md` thành ràng buộc tất định mà model không thể lờ đi: tự chạy formatter/typecheck sau `Edit`/`Write` (`PostToolUse`), chặn lệnh/pattern nguy hiểm đặc thù đội nhóm (`PreToolUse`), hoặc ép chạy test trước khi chốt lượt (`Stop`).
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Hỗ trợ 3 sự kiện: `PreToolUse`, `PostToolUse`, `Stop` với handler `command` (stdin JSON redacted, stdout JSON decision, timeout cứng + cancellation theo `AbortSignal`).
  2. Nguồn cấu hình: `~/.cosmew/settings.json` (user-trusted) và `<project>/.cosmew/settings.json` **chỉ chạy sau khi người dùng đã duyệt SHA-256 trust** (theo đúng quy tắc untrusted repo settings trong `AGENTS.md`).
  3. Bất biến bảo mật: Hook **chỉ có thể siết/chặn hoặc thêm feedback**, tuyệt đối không cấp quyền vượt `ToolDispatcher` hay ghi đè `deny` rule; sau `PreToolUse` phải revalidate target trước khi execute.
- **Nguồn tham khảo upstream (2026-11-22):**
  - Claude Code Hooks: `https://code.claude.com/docs/en/hooks` (`PreToolUse`/`PostToolUse`/`Stop`, deterministic control — runtime parity: `Needs verification`).
  - OpenAI Codex CLI Hooks: `https://github.com/openai/codex` (command hooks yêu cầu review/trust — runtime parity: `Needs verification`).
- **Tiêu chí nghiệm thu:** `PreToolUse` exit block chặn tool trước khi chạy; `PostToolUse` chạy linter và đính kèm feedback đã redact vào kết quả tool; `Stop` chặn tối đa N vòng lặp (chống infinite loop); repo hook chưa duyệt bị bỏ qua kèm Notice; hủy lượt (`Ctrl+C`) giết sạch tiến trình hook con.

### Đề xuất 3 — Session Management Workflow Hoàn Chỉnh (Rename bền, Last-Activity Sort, All-Projects Scope, Export Redacted)
- **Hiện trạng trong Cosmew:** [session-store.ts:795-830](/Users/huynh/codes/hannes/packages/persistence/src/session-store.ts#L795-L830) sắp xếp theo `rowid DESC LIMIT 200` (không theo last activity), không có cột tên tùy chỉnh, `/rename` và `/export` đang nằm trong `CLAUDE_UNAVAILABLE_COMMANDS` ([commands.ts:112, 140](/Users/huynh/codes/hannes/packages/sdk/src/commands.ts#L112)), TUI [sessions/index.tsx](/Users/huynh/codes/hannes/apps/tui/src/ink/features/sessions/index.tsx#L34-L108) chưa có chuyển đổi "Current project / All projects" và phân trang.
- **Giá trị người dùng:** Dễ tìm lại các phiên làm việc dài ngày, đặt tên rõ ràng theo ticket/PR, xuất biên bản làm việc sạch bí mật để dán vào PR/issue, và xem phiên ở dự án khác an toàn (mở đúng cảnh báo/hướng dẫn chuyển thư mục thay vì lặng lẽ resume sai root).
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. SQLite migration additive (v11 → v12): thêm cột `title` (nullable) và `updated_at` trên `conversations` (cập nhật khi có turn/message/rename) + index `(workspace, updated_at DESC)`.
  2. Triển khai `/rename <title>` và `/export [path] [--format md|json]` (luôn chạy qua `redactor`, ghi bằng `O_NOFOLLOW`, không giải mã raw base64/credentials).
  3. Nâng cấp `/resume`: mặc định lọc theo `canonicalWorkspace`, thêm tab/toggle `All projects` hiển thị đường dẫn workspace gốc và hỗ trợ phân trang (>200 sessions), giữ nguyên quy tắc từ chối resume trực tiếp chéo workspace.
- **Nguồn tham khảo upstream (2026-11-22):**
  - OpenAI Codex developer commands: `https://learn.chatgpt.com/docs/developer-commands` (session rename/export/management — `Needs verification`).
  - Claude Code CLI session commands (`/rename`, `/export`, `/resume`): `https://code.claude.com/docs/en/interactive-mode` (`Needs verification`).
- **Tiêu chí nghiệm thu:** Rename tồn tại qua restart; session vừa hoạt động nhảy lên đầu danh sách; danh sách >200 session phân trang đầy đủ; `/export` không bao giờ chứa secret đã đăng ký trong redactor hoặc theo symlink; test chéo workspace A/B và legacy `NULL` workspace đạt 100%.

### Đề xuất 4 — IDE / Editor Bridge chuẩn ACP (Agent Client Protocol) tối giản
- **Hiện trạng trong Cosmew:** Đã có LSP phục vụ *agent đọc code*, nhưng chưa có kênh giao tiếp với IDE/Editor (`/ide` đang `unavailable`) để nhận ngữ cảnh đang mở (active file, selection, editor diagnostics) hoặc điều khiển session/approval từ IDE.
- **Giá trị người dùng:** Đưa Cosmew vào luồng làm việc trực tiếp của VS Code / Cursor / Zed / Neovim / JetBrains mà không phải viết extension riêng cho từng IDE ngay từ đầu.
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Triển khai một subcommand `fyn acp` (stdio JSON-RPC 2.0 theo chuẩn ACP) bọc trên `FutrynClient` (`@cosmew/sdk`) — **không tạo agent loop mới**, không bypass `ToolDispatcher`.
  2. Vòng đầu chỉ hỗ trợ: khởi tạo session gắn workspace đã consent, nhận active file / selection làm untrusted user context, stream `ModelEvent` + `InteractionEvent` (permission approval/question) ra client IDE, và hỗ trợ cancellation.
- **Nguồn tham khảo upstream (2026-11-22):**
  - OpenCode ACP: `https://opencode.ai/docs/cli/acp` (Agent Client Protocol kết nối Zed/Neovim/JetBrains — `Needs verification`).
  - Claude Code IDE integrations: `https://code.claude.com/docs/en/vs-code` & `https://code.claude.com/docs/en/jetbrains` (`Needs verification`).
- **Tiêu chí nghiệm thu:** Một client ACP mẫu (hoặc integration test stdio) tạo phiên, gửi prompt kèm selection, nhận prompt duyệt quyền và từ chối/chấp nhận qua ACP, hủy giữa chừng dừng tool sạch sẽ; mọi thao tác file/shell vẫn bị ràng buộc bởi permission mode và sandbox hiện có.

### Đề xuất 5 — Auto-Memory Opt-In có Kiểm soát (Bounded, Idempotent, Reviewable)
- **Hiện trạng trong Cosmew:** Memory CRUD + ranking + citation đã ổn định (ADR 0057), nhưng `auto_extract = true` trong `~/.cosmew/config.toml` đang chỉ phát diagnostic `not implemented` ([apps/cli/src/bootstrap/host-config.ts:131-132](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/host-config.ts#L131-L132)).
- **Giá trị người dùng:** Tự động rút trích các sửa sai/quy ước quan trọng từ phiên làm việc (ví dụ lệnh build đặc thù, quy ước đặt tên, quyết định kiến trúc) mà không bắt người dùng nhớ gõ nhắc lưu memory thủ công.
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Bật opt-in qua `[memories] auto_extract = true` (mặc định `false`), chỉ chạy sau khi lượt kết thúc ở trạng thái idle (hoặc khi `/compact` / kết thúc session), có token/cost cap riêng và **hạch toán usage đầy đủ** vào session.
  2. Xuất kết quả thành danh sách **candidate memories** (dedupe theo nội dung/slug, lọc secret bằng `redactor` trước khi lưu, không ghi đè user edits).
  3. Cung cấp chế độ review trong `/memory` (chấp nhận / bỏ qua candidate) trước khi đưa vào `MEMORY.md` — giữ nguyên nhãn `untrusted project context`, tuyệt đối không trở thành system prompt hay permission grant.
- **Nguồn tham khảo upstream (2026-11-22):**
  - Claude Code Auto Memory: `https://code.claude.com/docs/en/memory` (project-scoped `~/.claude/projects/<project>/memory/`, `/memory` audit — `Needs verification`).
- **Tiêu chí nghiệm thu:** Chạy lặp lại trên cùng lịch sử không nhân bản memory (idempotent); candidate chứa chuỗi giống secret bị loại bỏ; usage của pass extract được cộng vào telemetry; `plan` mode / `COSMEW_MEMORY=0` không chạy extract; hủy khi thoát app không để lại file memory hỏng.

### Đề xuất 6 — Shared Task Graph cho Multi-Agent (Dependency, Owner & Conflict Visibility)
- **Hiện trạng trong Cosmew:** Đã có `update_plan` (tối đa 50 bước tuyến tính, 1 `in_progress`) và subagent messaging/worktrees, nhưng chưa có cấu trúc task chung có ID, dependency (`blockedBy`), chủ sở hữu (`owner`) và phát hiện xung đột file giữa các subagent song song.
- **Giá trị người dùng:** Khi chia một thay đổi lớn cho 2–4 subagent chạy song song (ví dụ backend + frontend + tests), người dùng và parent agent thấy rõ task nào đang chạy, task nào bị chặn bởi task nào, và cảnh báo sớm nếu 2 worker cùng chạm vào 1 file trước khi tích hợp worktree.
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Mở rộng tầng persistence (SQLite) & tools nội bộ (`task_create`, `task_update`, `task_list`) gắn với `sessionId`: mỗi task có `{id, title, status, blockedBy[], ownerAgentId?, worktreeBranch?, touchedFiles[]}`.
  2. Chặn circular dependency khi cập nhật `blockedBy`; tự động đánh dấu cảnh báo nếu 2 task đang chạy cùng khai báo/sửa 1 đường dẫn file; hiển thị gọn trong `/agents` hoặc `/tasks`.
  3. Giữ nguyên kiến trúc 100% agent loop của Cosmew (không sinh tiến trình agent bên ngoài).
- **Nguồn tham khảo upstream (2026-11-22):**
  - Claude Code Sub-agents & task coordination: `https://code.claude.com/docs/en/sub-agents` (`Needs verification`).
  - OpenAI Codex parallel worktrees & agent threads: `https://github.com/openai/codex` (`Needs verification`).
- **Tiêu chí nghiệm thu:** Tạo đồ thị 3 task `A -> B, C` không cho `B` chuyển `in_progress` khi `A` chưa `completed` (hoặc cảnh báo tường minh); phát hiện cycle và từ chối; hủy parent session hoặc dừng subagent cập nhật trạng thái task về `cancelled`/`blocked` nhất quán qua restart.

### Đề xuất 7 — Hoàn thiện Linux Sandbox Network Bridge & Đóng gói Phân phối Sạch (`fyn` Release Pipeline)
- **Hiện trạng trong Cosmew:**
  - Trên Linux, bubblewrap sandbox cắt hoàn toàn mạng (không nối qua loopback HTTP/CONNECT proxy như macOS Seatbelt — [startup.ts:1627-1630](/Users/huynh/codes/hannes/apps/cli/src/bootstrap/startup.ts#L1627-L1630)), khiến mọi tác vụ cần `allowedDomains` (như `npm`/`bun`/`git fetch`) đều thất bại khi bật sandbox trên Linux.
  - [apps/cli/package.json](/Users/huynh/codes/hannes/apps/cli/package.json#L4-L11) đang `"private": true`, `bin` trỏ thẳng file TypeScript `./src/index.ts` cùng các `workspace:*` dependencies, chưa có bundle/release smoke test trên máy sạch không có repo nguồn.
- **Giá trị người dùng:** Cosmew chạy mượt và an toàn ngang nhau trên cả macOS và Linux (CI/dev container/remote SSH), đồng thời cài đặt/nâng cấp được như một CLI độc lập thực sự thay vì chỉ `bun link` từ repo dev.
- **Phạm vi nhỏ nhất hữu ích (MVP):**
  1. Cầu nối Unix-domain socket (ví dụ `socat`/helper loopback hoặc proxy bind socket gắn vào bwrap namespace) để lệnh trong bubblewrap Linux đi qua đúng `SandboxProxy` + `allowedDomains` mà vẫn không có truy cập mạng trực tiếp/private IP.
  2. Build target đóng gói CLI (hoặc `bun build` bundle kèm kiểm tra hash cài đặt + smoke test trên thư mục sạch) tích hợp vào workflow release CI trên `ubuntu-latest` và `macos-latest`.
- **Nguồn tham khảo upstream (2026-11-22):**
  - Claude Code sandboxing (macOS Seatbelt + Linux bubblewrap + proxy): `https://code.claude.com/docs/en/sandboxing` (`Needs verification`).
  - OpenAI Codex CLI distribution & sandbox: `https://github.com/openai/codex` (`Needs verification`).
- **Tiêu chí nghiệm thu:** Trên Linux CI thật (`ubuntu-latest`), lệnh trong sandbox chỉ truy cập được domain nằm trong `sandbox.network.allowedDomains` và bị chặn với domain ngoài / IP private; artifact đóng gói chạy `fyn --help`, `fyn status --json`, `fyn exec` sạch ở máy không có `node_modules` của repo nguồn.

---

## 7. Thứ tự triển khai đề xuất

1. **Giai đoạn A — Chốt sạch các lỗi P1 còn sót trong sóng sửa hiện tại (1–2 ngày):**
   - Bịt kín toàn bộ cửa hậu cross-workspace trong `startup.ts` & `session-store.ts` (**Lỗi 3.1**) và chuẩn hóa `canonicalWorkspace` cho `checkpointStore`.
   - Sửa mất usage ở `SqliteConversations.addUsage` cho session fork/rewind (**Lỗi 3.2**), sửa `knownCostUSD` trong `packages/agents/src/budgets.ts` (**Lỗi 3.3**) và thứ tự capture billing trong `TurnRun.handleEvent` (**Lỗi 3.7**).
   - Sửa concurrency `flock` + ngưỡng `names()` + error wrapping trong `FileMemories` (**Lỗi 3.4**).
   - Hoàn tất và chốt nghiệm thu **Item 5** (sửa contextual hunk + bỏ chặn cứng mode `0644` ở `worktrees.ts`, **Lỗi 3.8**) và **Item 6** (điều tra dứt điểm nguyên nhân `user-state-guard` chạm `provider-auth.sqlite`, xác minh CI macOS/Linux).
2. **Giai đoạn B — Ổn định tầng tích hợp cốt lõi (1 tuần):**
   - Sửa lỗi JSON redaction ở `McpClient.call` + `exec.ts` (**Lỗi 3.5**) và lifetime/reconnect/schema-isolation của `McpHub` (**Lỗi 3.6**), sau đó mở rộng lên **Đề xuất 1** (MCP reconnect, deferred tool search, resources/images, user OAuth).
3. **Giai đoạn C — Nhân hệ số năng suất hàng ngày (1–2 tuần):**
   - **Đề xuất 2** (Deterministic Hooks `PreToolUse`/`PostToolUse`/`Stop` với repo-trust SHA-256).
   - **Đề xuất 3** (Session rename/last-activity/all-projects/redacted export).
4. **Giai đoạn D — Mở rộng hệ sinh thái & phân phối (2+ tuần):**
   - **Đề xuất 4** (ACP IDE bridge tối giản).
   - **Đề xuất 5** (Auto-memory opt-in có review) và **Đề xuất 6** (Shared task graph đa agent).
   - **Đề xuất 7** (Linux bubblewrap proxy bridge & release packaging pipeline).
