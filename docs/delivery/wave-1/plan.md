# Kế hoạch triển khai: lấy cái tốt nhất của Codex, OpenCode (và Claude Code) — bản 2

Ngày lập: 2026-11-17. Trạng thái: **đã duyệt 2026-11-17** (user chấp nhận kế hoạch và D1–D6 theo đề xuất), đang triển khai đợt 1. Khi đã được phép, session thực hiện đọc hết file này, xử lý mục 3 (quyết định cần chốt) trước, rồi chạy các workstream theo thứ tự ở mục 6, commit sau mỗi workstream.

## 0. Mục tiêu và tiêu chí "tốt nhất"

Mục tiêu: Cosmew đọc–hiểu–sửa dự án ngang hoặc hơn Codex/OpenCode/Claude Code, dùng không giới hạn (không phí cố định ngoài token model).

Khi hai bên khác nhau, chọn theo thứ tự: (1) an toàn không kém Codex; (2) ít lượt gọi/token hơn cho model; (3) chạy local, miễn phí; (4) đơn giản để bảo trì; (5) tên/schema quen với model (Codex cho GPT, Claude Code cho Claude) — khi cần, giữ tên gần bên được train nhiều nhất.

"Xong" một workstream = code + test có ý nghĩa + docs/ADR + `typecheck`/`lint`/test liên quan xanh + commit. Không có tính năng "hiện ra mà không chạy".

## 1. Hiện trạng Cosmew (baseline 2026-11-17, HEAD `93f26db`)

- Tools: `read` (chỉ text), `glob` (mtime), `grep` (ripgrep + fallback Worker), `edit`, `write`, `apply_patch` (cùng patch plan, ReadLedger), `exec_command`, `write_stdin` (sandbox native).
- Quyền: chế độ kiểu Claude Code `default | acceptEdits | auto | plan | bypassPermissions` (`packages/contracts/src/permissions.ts` `permissionModeDecision`) + project rules `Bash(...)`/`Read(...)` (deny > ask > allow) + sandbox `COSMEW_SANDBOX_MODE`, `COSMEW_SANDBOX_ESCALATION` (`apps/cli/src/bootstrap/commands.ts`). Mặc định hỏi mọi lệnh và mọi lần ghi.
- Context: `ProjectContextLoader` nạp `AGENTS.override.md`/`AGENTS.md` từ root tới cwd lúc bắt đầu; compaction trích đoạn (`packages/core/src/context/compaction.ts`, 91 dòng); `markUnchanged` cho lần đọc lặp.
- Contract: `CONTRACT_VERSION = '1.18'`; `Message.content` chỉ là chuỗi; `ToolResult.content` ≤ 64 KiB chuỗi; `ModelInfo.capabilities.vision` đã có (mặc định `unknown`).
- Persistence: SQLite `PRAGMA user_version = 5`.
- Placeholder rỗng sẵn có: `packages/code-intel`, `packages/mcp`, `packages/agents`.
- TUI: `apps/tui/src/features/*` (ADR 0015), TUI v2 virtualized transcript đã commit (`93f26db`, ADR 0039).

## 2. Sự thật đã xác minh trong source (dùng làm chuẩn)

Codex `openai/codex` @ `090be4df0724cdef5758e6a0934ba557af8b6bbe` (đọc 2026-11-17), đường dẫn tính từ `codex-rs/`:

| Chủ đề | Hành vi | Nguồn |
|---|---|---|
| Lệnh không có luật | `never`: chạy (dựa sandbox); `untrusted`: hỏi; `on-request` + sandbox giới hạn: **chạy không hỏi** nếu không xin vượt sandbox, hỏi nếu xin; full-access: chạy | `core/src/exec_policy.rs:868-950` |
| Lệnh nguy hiểm | khớp danh sách nguy hiểm → hỏi; ở `never` → cấm | `exec_policy.rs:897-905`, `shell-command/src/command_safety/is_dangerous_command.rs` (`rm` có force, xuyên `sudo`/`env`) |
| Luật exec-policy | luật tiền tố allow/prompt/forbid; khi duyệt có thể đề xuất lưu luật tiền tố (`proposed_execpolicy_amendment`) | `execpolicy/`, `core/src/exec_policy.rs:366-470`, `core/src/tools/sandboxing.rs` |
| Tách lệnh shell | `tree-sitter-bash` | `shell-command/src/bash.rs`, `Cargo.toml` (`tree-sitter 0.25`) |
| Ghi file | trong vùng ghi được → tự duyệt (trừ `untrusted`) | `core/src/safety.rs:67` `assess_patch_safety` |
| `request_permissions` | xin thêm quyền filesystem/mạng; áp cho các lệnh sau trong turn, hoặc cả session nếu user chọn | `core/src/tools/handlers/shell_spec.rs:173` |
| Duyệt tool MCP | mỗi server: `auto` (mặc định) / `prompt` / `writes` / `approve`; `auto`: `readOnlyHint=true` → không hỏi, ngược lại hỏi trừ khi `destructiveHint=false` **và** `openWorldHint=false` | `config/src/mcp_types.rs:29`, `core/src/mcp_tool_call.rs:2840-2866` |
| `update_plan` | `{explanation?, plan:[{step,status}]}`, `pending/in_progress/completed`, tối đa 1 `in_progress`, trả "Plan updated" | `core/src/tools/handlers/plan_spec.rs`, `plan.rs` |
| `request_user_input` | 1–3 câu, `header` ≤ 12 ký tự, options label+description, tự thêm "Other"; mặc định chỉ Plan mode (cờ `DefaultModeRequestUserInput` mở cho Default) | `request_user_input_spec.rs`, `tools/src/tool_config.rs:6` |
| Compaction | prompt "CONTEXT CHECKPOINT COMPACTION" (tiến độ, quyết định, việc còn lại, dữ liệu cần thiết); giữ tin nhắn user gần nhất tối đa 20 000 token; giữ một phần output tool | `prompts/templates/compact/prompt.md`, `core/src/compact.rs:69`, `compact_retained_tool_outputs.rs` |
| Agents | `spawn_agent`, `send_input`, `send_message`, `followup_task`, `resume_agent`, `wait_agent`, `list_agents`, `close_agent` | `core/src/tools/handlers/multi_agents_spec.rs` |
| Skills | `SKILL.md` frontmatter `name` (≤ 64), `description`, `metadata.short-description`; tên mặc định theo thư mục | `skills/src/parser.rs` |
| Memories | nền 2 pha: model rút ký ức từ session cũ → agent gộp thành file; bỏ sub-agent/ephemeral | `memories/README.md` |
| CodeMode | process riêng, V8 có sandbox | `code-mode-runtime/Cargo.toml` |
| LSP, WebFetch | không có | — |

OpenCode `sst/opencode` main @ `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4` và tag `v1.19.5` (đọc 2026-11-17):

| Chủ đề | Hành vi | Nguồn |
|---|---|---|
| Danh sách tool (main) | edit, glob, grep, image-generate, mcp-resource, patch, question, read, schedule, shell, skill, subagent, todo, webfetch, websearch, write, file-diff, artifact | `packages/core/src/tool/plugin/` |
| `read` | text 2000 dòng/50 KiB; **ảnh/PDF** theo magic bytes ≤ 20 MiB; **thư mục** có phân trang; **offset âm**; gợi ý khi không thấy file (cùng tên, sai gốc); **nạp AGENTS.md lồng nhau sau khi đọc** | `tool/plugin/read.ts`, `tool/read-filesystem.ts` |
| `todo` | status `pending/in_progress/completed/cancelled`; output tóm tắt số lượng | `tool/plugin/todo.ts` |
| `question` | `multiple`, luôn cho tự gõ, gợi ý "(Recommended)" đứng đầu; đóng hộp thoại → "The user dismissed this question" và tiếp tục; subagent bị cấm | `tool/plugin/question.ts`, `plugin/agent.ts` |
| `webfetch` | `text/markdown/html`, ≤ 5 MiB, timeout ≤ 120 s, redirect thủ công kiểm quyền lại từng URL; **không chặn IP nội bộ** | `tool/plugin/webfetch.ts`, `tool/html-markdown.ts` |
| `websearch` | nguồn exa (mặc định, không key), firecrawl, parallel, tavily, tinyfish — **đều là endpoint MCP** | `tool/plugin/websearch.ts`, `plugin/websearch/` |
| Quyền theo agent | `explore`: cấm tất cả trừ shell/grep/glob/webfetch/websearch/read; `.env` ask; không tạo subagent | `plugin/agent.ts:74-95` |
| `subagent` | `{agent, description (3–5 từ), prompt, model?, sessionID?}` | `tool/plugin/subagent.ts` |
| Compaction | agent ẩn `compaction`; agent `summary`, `title` | `plugin/agent.ts:96-118` |
| CodeMode | trình thông dịch riêng ~20 700 dòng, MIT, giới hạn tuỳ chọn `timeoutMs/maxToolCalls/maxOutputBytes` | `packages/codemode` |
| LSP | **main đã bỏ** (TODO trong `edit.ts`, `file-mutation.ts`); v1: diagnostics sau sửa chỉ ERROR, ≤ 20/file, debounce 150 ms; tool `lsp` 9 thao tác (không rename); `typescript-language-server --stdio` + `tsserver` của project; > 25 server, một số tự cài | v1 `packages/opencode/src/lsp/*`, `tool/lsp.ts`, `tool/edit.ts:180-210` |
| RAG/embedding | không có (chỉ là loại model của provider) | `packages/core/src/provider.ts` |

Claude Code: mô tả theo hành vi tool công khai (không có source): Read đọc ảnh/PDF/`.ipynb`; LSP tool; Agent/Explore; memory dạng file; `/compact`; Skills; WebFetch dùng model nhỏ lọc trang.

Chưa xác minh (ghi "Needs verification" khi dùng): hạn mức Exa không key; API MCP Registry; `@opencode/codemode` có phát hành trên npm không.

## 3. Quyết định cần user chốt trước khi code

| # | Câu hỏi | Đề xuất |
|---|---|---|
| D1 | Dependency mới | Đồng ý: `@modelcontextprotocol/sdk` (MIT), `web-tree-sitter` + grammar `tree-sitter-bash` WASM (MIT), `turndown` (MIT) cho HTML → Markdown. LSP server **không bundle**: dùng của máy/project. |
| D2 | `danger-full-access` | Không làm trong kế hoạch này. |
| D3 | Mặc định quyền | `workspace-write` + `on-request` như Codex (lệnh trong sandbox, ghi trong workspace không hỏi). |
| D4 | Memories | Kiểu Claude Code (agent tự ghi file, rẻ); pha nền của Codex để tuỳ chọn, tắt mặc định (tốn token). |
| D5 | CodeMode engine | Quyết định ở W13 sau khi đo: `@opencode/codemode` (nếu có trên npm) hoặc `quickjs-emscripten` (MIT, WASM). |
| D6 | Version contract | Tăng một lần mỗi đợt (1.19 cho đợt 1, 1.20 đợt 2, 1.21 đợt 3). |

## 4. Thiết kế chung (áp cho mọi workstream)

- **Capability mới** trong `packages/contracts/src/tools.ts`: `agent.state` (plan, memory), `user.input` (hỏi), `code.intel` (lsp đọc), `network.fetch`, `network.search`, `mcp.call`, `agent.spawn`, `code.exec` (CodeMode). Plan/Review mode cho phép: `fs.read`, `code.intel`, `agent.state`, `user.input`, `network.search`, `network.fetch` (đọc ngoài không đổi workspace). Sửa bộ lọc `analysisOnly` ở `packages/core/src/agent/turn.ts`.
- **Mọi tool mới** đăng ký qua `ToolRegistry` và đi qua `ToolOrchestrator` (validate → policy → duyệt → revalidate → audit → chạy → redact). Không có đường gọi vòng (kể cả MCP, subagent, CodeMode).
- **Chính sách quyền** gom về một hàm `decideApproval(policy, request)` trong `@cosmew/security` (W1), mọi tool dùng chung.
- **Sự kiện SDK mới**: `plan.updated`, `question.asked/answered`, `diagnostics.reported`, `mcp.server.status`, `subagent.started/finished`, `memory.updated`, `compaction.completed`.
- **Persistence schema 6** (một migration cho đợt 1, thêm cột/bảng cho đợt 2 ở schema 7): bảng `session_plan`, `session_instructions` (AGENTS lồng nhau đã nạp), `mcp_servers`, `memories` (chỉ mục; nội dung là file).
- **TUI**: mỗi tính năng một folder `features/<name>/` (types/logic/view/controller/index), đăng ký trong `CosmewTuiApp.registerFeatures`; transcript hiển thị kiểu Claude Code: `Plan`, `Ask`, `LSP(op)`, `Search(q)`, `Fetch(url)`, `Agent(desc)`, `Skill(name)`, `MCP(server.tool)`.

## 5. Workstreams chi tiết

Kích thước: S ≈ nửa ngày, M ≈ 1–2 ngày, L ≈ 3–5 ngày công agent.

### W0 — Chuẩn bị (S)
- `git status`/`log`; xác nhận không có session khác đang sửa; `bun install --frozen-lockfile --ignore-scripts`; chạy `typecheck`, `lint`, `bun test tests`, `test:integration`, `test:e2e`; ghi baseline vào `docs/delivery/wave-1/acceptance.md`.
- Clone tham chiếu (mục 9) vào thư mục tạm; không chạy code trong đó.

### W1 — Quyền chuẩn Codex (M)
- **Lấy**: quyết định lệnh theo `exec_policy.rs` (Codex) + bộ quyền theo agent (OpenCode) + project rules hiện có (Claude Code).
- **Thiết kế**: `ApprovalPolicy = 'untrusted' | 'on-request' | 'never'` (env `COSMEW_APPROVAL_POLICY`, `COSMEW_SANDBOX_ESCALATION=never` cũ → `never`); `decideApproval` trả `allow | ask | deny`:
  - lệnh: nguy hiểm → ask (`never` → deny); xin vượt sandbox (mạng) → ask (`never` → deny); còn lại `on-request`/`never` → allow, `untrusted` → ask trừ luật allow;
  - ghi file: trong vùng ghi được → allow (trừ `untrusted`), ngoài → deny như hiện tại;
  - stdin vào phiên đang chạy: allow trong cùng sandbox (Codex);
  - đọc secret: ask (giữ, như OpenCode); project rules thắng chế độ; deny luôn thắng.
- **Ánh xạ chế độ cũ** (ghi ADR): `default`→`untrusted`, `acceptEdits`→`untrusted` + ghi tự duyệt, `auto`→`on-request`, `plan`→chỉ đọc, `bypassPermissions`→`never` (vẫn trong sandbox). Mặc định mới: `auto`/`on-request`.
- **Tree-sitter**: `web-tree-sitter` + `tree-sitter-bash` tách lệnh ghép; mỗi lệnh con xét nguy hiểm/luật riêng; parse thất bại hoặc cấu trúc lạ (`$(...)`, heredoc phức tạp) → coi là cần hỏi. Port danh sách nguy hiểm của Codex.
- **Luật tiền tố**: khi duyệt lệnh, hộp thoại cho "luôn cho phép `<tiền tố>`" → lưu `Bash(<tiền tố>:*)` vào project rules (đã có cơ chế).
- **`request_permissions`**: `{permissions:{network?: boolean, writable_paths?: string[]}, reason}` → luôn hỏi; grant cho turn hoặc session; `never` → từ chối.
- **File**: `packages/security/src/approval.ts` (mới), `tool-policy.ts`, `packages/contracts/src/permissions.ts`, `packages/sdk/src/client.ts` (`requestPermission`), `packages/tools/src/orchestrator.ts`, `apps/cli/src/bootstrap/commands.ts`, `packages/tools/src/exec/shell-parse.ts` (mới), handler `request-permissions.ts` (mới), TUI `features/permissions` (hiện policy + nút lưu tiền tố).
- **Test**: ma trận 3 policy × {lệnh thường, lệnh nguy hiểm, `rm -rf` trong `&&`, lệnh cần mạng, ghi trong/ngoài, stdin, đọc secret}; `never` không bao giờ prompt; deny rule thắng mọi policy; parse lỗi → ask; lưu tiền tố hoạt động; e2e: `bun test` chạy không hỏi ở `on-request`.
- **Rủi ro**: ít hỏi hơn trước → sandbox phải đúng; chạy lại toàn bộ test sandbox (`tests/security/*exec*`, seatbelt).

### W1.5 — Đọc file đầy đủ (M)
- **Lấy**: `read` của OpenCode main + `.ipynb` của Claude Code + giữ phần tốt của Cosmew (ReadLedger, `markUnchanged`, chặn secret).
- **Thiết kế**:
  - AGENTS.md lồng nhau: sau khi `read` thành công một file ở thư mục con, tìm `AGENTS.override.md`/`AGENTS.md` từ thư mục đó lên root (bỏ các file đã nạp), đọc qua reader có kiểm quyền hiện có, lưu vào `session_instructions` (durable), đưa vào `ModelRequest.instructions` ở lượt sau; giới hạn byte theo `ProjectContextLoader`.
  - Gợi ý khi không thấy: cùng tên khác hoa/thường trong thư mục cha; đường dẫn tuyệt đối sai gốc → thử ghép phần đuôi vào root; chỉ gợi ý đúng 1 path đã kiểm `evaluateRead`.
  - Thư mục: liệt kê có phân trang offset/limit, bỏ mục deny, đánh dấu `/` cho thư mục.
  - Offset âm: N dòng cuối.
  - Ảnh/PDF: magic bytes png/jpeg/gif/webp/pdf, ≤ 20 MiB; contract: `ToolResult.attachments?: {mime, data(base64), name}[]` và `Message.attachments?` (giữ `content` chuỗi để tương thích); adapter Anthropic → block `image`/`document` trong `tool_result`; OpenAI-compatible → chèn một user message chứa `image_url` ngay sau tool message; model `vision !== 'supported'` → trả lỗi rõ "model không xem được ảnh". Không lưu base64 vào transcript hiển thị; persistence lưu blob riêng có giới hạn.
  - `.ipynb`: render cell (`[n] code|markdown`, nguồn, output text; output ảnh → attachments).
- **File**: `packages/tools/src/builtin/read.ts` (+ `read-media.ts`, `read-notebook.ts`), `packages/workspace/src/project-context.ts`, `packages/contracts/src/{models,tools}.ts`, adapter trong `packages/models/src/adapter.ts`/`http.ts`, `packages/persistence/src/session-store.ts`.
- **Test**: mỗi tính năng + secret không lộ qua gợi ý/listing; ảnh qua cả hai adapter (fixture server kiểm wire format); model không vision bị từ chối; AGENTS lồng nhau nạp đúng một lần, sống sau restart.

### W2 — Plan/todo `update_plan` (S)
- **Lấy**: schema Codex + `cancelled` (OpenCode) + `activeForm` (Claude Code) + output tóm tắt (OpenCode).
- **Thiết kế**: capability `agent.state`, `parallel: false`; validate ≤ 1 `in_progress`; lưu `session_plan` durable; sự kiện `plan.updated`; `progress.ts` dùng plan thật thay regex khi có.
- **UI**: `features/plan`: checklist ghim trên composer (✓ / ▸ / ○ / ✗), dòng `activeForm` cạnh spinner, thu gọn khi xong hết.
- **Test**: schema, recovery, Plan mode có tool, UI golden.

### W3 — Hỏi người dùng `request_user_input` (M)
- **Lấy**: schema Codex + `multiple` (OpenCode) + dismissal không lỗi (OpenCode) + "(Recommended)" (OpenCode/Claude Code).
- **Thiết kế**: capability `user.input`; cho dùng ở chat và plan; từ chối khi non-interactive (`fyn exec`/không có UI) và trong subagent; SDK `listPendingQuestions/answerQuestion/dismissQuestion`, hủy theo `AbortSignal`; câu trả lời là text, không cấp quyền; durable để recovery không hỏi lại câu đã trả lời.
- **UI**: `features/question` dùng `Modal`: tab theo câu (header), chọn số/phím mũi tên, Space cho multiple, ô "Khác" tự gõ, Esc = dismiss.
- **Test**: trả lời/multiple/tự gõ/dismiss/hủy turn/non-interactive/recovery.

### W4 — LSP (L)
- **Lấy**: OpenCode v1 (diagnostics sau sửa, 9 thao tác) + rename (Claude Code/LSP) + cải tiến của Cosmew (chỉ lỗi mới, sandbox, lọc path).
- **Thiết kế**:
  - `packages/code-intel`: `JsonRpcConnection` (khung `Content-Length`), `LspClient` (initialize, capabilities, didOpen/didChange/didClose, publishDiagnostics, cancel, shutdown), `LspManager` (root theo lockfile/`tsconfig`/`pyproject.toml`/`go.mod`/`Cargo.toml`, khởi động lười theo đuôi file, 1 server/ngôn ngữ/root, restart có backoff tối đa 3 lần, timeout 10 s/request).
  - Server: TS/JS (`typescript-language-server --stdio` từ `node_modules/.bin` của project hoặc PATH, với `tsserver` của project; TS ≥ 7 → `tsc --lsp --stdio` nếu có), Python (`basedpyright-langserver`/`pyright-langserver --stdio`), Go (`gopls`), Rust (`rust-analyzer`). Không có → tool báo rõ cách cài; không tự tải.
  - Chạy qua runtime sandbox native: read-only workspace, không mạng, ghi được thư mục cache riêng trong state Cosmew; Windows → không khả dụng.
  - Diagnostics sau `edit/write/apply_patch`: lấy diagnostics trước (nếu file đã mở) và sau (chờ push mới, debounce 150 ms, tối đa 3 s); báo **lỗi mới** (so theo message+range dịch chuyển), ERROR, ≤ 20/file, thêm vào kết quả tool; không có server → im lặng.
  - Tool `lsp` (capability `code.intel`, `parallel: true`): `goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls`; vào/ra 1-based; chuyển UTF-16 ↔ code point; kết quả có trích dòng code; path lọc `evaluateRead`, ngoài workspace (vd. `node_modules` types) chỉ hiện path + dòng, không nội dung nếu bị deny.
  - Tool `rename` (hoặc thao tác `rename` của `lsp` với capability `fs.write`): `WorkspaceEdit` → patch plan nhiều file (`ApplyPatchRuntime`) → duyệt theo W1.
  - Theo dõi file: `fs.watch` đệ quy trên root (macOS FSEvents) có coalesce; báo `didChange` cho file đang mở; bỏ thư mục ignore.
- **UI**: transcript `LSP(op file:line)`; diagnostics hiện dưới kết quả edit (màu error).
- **Test**: server LSP giả (fixture stdio) cho mọi thao tác, Unicode/emoji range, crash/restart, timeout, cancel, lỗi mới vs cũ, path ngoài/secret; test thật TS nếu có `typescript-language-server` (skip nếu không); rename qua duyệt.
- **Rủi ro**: server chậm khởi động (giới hạn chờ), bộ nhớ (tắt server rảnh > 10 phút), khác biệt giữa các server.

### W5 — MCP client HTTP + `web_search` (M)
- **Lấy**: OpenCode (websearch đa nguồn qua MCP) + quyền MCP của Codex.
- **Thiết kế**: `packages/mcp`: `McpClient` trên `@modelcontextprotocol/sdk` (Streamable HTTP), `initialize` một lần/endpoint, `tools/call` với timeout 30 s, kết quả ≤ 64 KiB, redact, dữ liệu không tin cậy. `web_search` (capability `network.search`, không hỏi, audit): `{query, numResults? (≤ 10)}`; chọn nguồn: có key (`EXA_API_KEY`/`TAVILY_API_KEY`/`FIRECRAWL_API_KEY`/`PARALLEL_API_KEY`) → nguồn đó; không → Exa không key; parse như OpenCode; lỗi/hạn mức → báo rõ, gợi ý đặt key.
- **UI**: `Search("query")` + danh sách tiêu đề/URL.
- **Test**: MCP server giả HTTP local; live sau `COSMEW_LIVE_WEB=1`.

### W6 — `web_fetch` (S–M)
- **Lấy**: OpenCode webfetch + chặn IP nội bộ (Cosmew).
- **Thiết kế**: capability `network.fetch`; `{url, format: markdown|text|html, timeout ≤ 120}`; chỉ http(s); resolve DNS → chặn loopback/private/link-local/metadata/IPv6 ULA (dùng `validateEndpoint` + kiểm IP), kiểm lại sau mỗi redirect (≤ 5); ≤ 5 MiB; HTML → Markdown bằng `turndown` (bỏ script/style); quyền theo W1 (mạng = vượt sandbox → `on-request` hỏi lần đầu mỗi domain, grant theo phiên; luật `WebFetch(domain:x)` đã có trong rule parser).
- **Test**: server local: redirect, 5 MiB, timeout, chặn 127.0.0.1/169.254.169.254/[::1]/DNS trỏ nội bộ, redirect sang nội bộ.

### W7 — Tích hợp đợt 1 (S)
- `guidance.ts`: hướng dẫn plan/ask/lsp/web chỉ khi tool được offer; nhắc "tìm bằng grep/lsp trước, đọc đúng đoạn".
- Codex bridge: `HANNES_BRIDGE_TOOLS` + mô tả.
- Contract 1.19, `docs/contracts/agent-events.md`, ADR 0040 (quyền), 0041 (read), 0042 (plan+ask), 0043 (LSP), 0044 (MCP+web); `CLAUDE.md`; catalog dependency; `acceptance.md`.

### W8 — Compaction bằng model + `/compact` (M) — đợt 2
- **Lấy**: prompt + giữ tin nhắn user 20 000 token + giữ output tool (Codex) + agent compaction riêng (OpenCode).
- **Thiết kế**: khi context gần đầy (ngưỡng hiện có) hoặc `/compact [hướng dẫn]` lúc rảnh: gọi model hiện tại với prompt checkpoint (port nội dung, không chép nguyên văn), tạo tin nhắn tóm tắt có tiền tố; giữ nguyên: tin nhắn user gần nhất ≤ 20 000 token, receipt ghi file, plan hiện tại, AGENTS đã nạp; lỗi model → fallback compaction trích đoạn hiện có. Durable như checkpoint (ADR 0030).
- **Test**: ngưỡng kích hoạt, nội dung giữ lại, fallback, recovery sau compaction, `/compact` khi đang chạy bị từ chối.

### W9 — Subagent (L) — đợt 2
- **Lấy**: tool `subagent` của OpenCode (đơn giản) + quyền theo agent (OpenCode) + `wait/close` của Codex khi chạy song song.
- **Thiết kế**: `packages/agents`: định nghĩa agent `explore` (chỉ đọc/tìm/lsp/web, không hỏi, không subagent) và `general` (đầy đủ trừ hỏi người dùng và subagent con); tool `agent` `{agent, description, prompt}` chạy `Conversation` lồng, context riêng, cùng `ToolDispatcher` với bộ quyền giới hạn; nhiều lời gọi trong cùng response chạy song song (giới hạn 4); trả bản tóm tắt cuối; usage cộng vào session cha; hủy theo turn cha; journal riêng.
- **UI**: `Agent(description)` với tiến độ thu gọn.
- **Test**: explore không ghi được, không hỏi được; song song; hủy; usage; recovery.

### W10 — Memories (M) — đợt 2
- **Lấy**: Claude Code (agent tự ghi file, chỉ mục) làm mặc định; pha nền Codex tuỳ chọn tắt.
- **Thiết kế**: thư mục `~/.cosmew/projects/<id>/memory/`; mỗi ký ức một file Markdown có frontmatter (name, description, type: user/feedback/project/reference); `MEMORY.md` chỉ mục được nạp vào instructions mỗi session (giới hạn byte); tool `memory` `{action: list|read|write|delete, name, content?}` (capability `agent.state`, không hỏi, chặn nội dung giống secret bằng redactor); `/memory` xem/sửa.
- **Test**: ghi/đọc/xoá, chỉ mục, secret bị chặn, nạp ở session mới.

### W11 — Skills (S) — đợt 2
- **Lấy**: định dạng `SKILL.md` của Codex (name ≤ 64, description) + tool `skill` của OpenCode.
- **Thiết kế**: quét `.cosmew/skills`, `~/.cosmew/skills`, và tương thích `.codex/skills`, `.claude/skills`; chỉ đưa danh sách tên + mô tả vào instructions; tool `skill` `{name}` nạp nội dung (đọc qua reader có kiểm quyền); `/skills` liệt kê.
- **Test**: parse frontmatter lỗi/thiếu, ưu tiên project > user, giới hạn kích thước.

### W12 — MCP đầy đủ + tự cài (L) — đợt 2
- **Lấy**: Codex (quyền theo annotation và theo server, tên `mcp__server__tool`) + OpenCode (`mcp-resource`) + Claude Code (`tool_search` khi nhiều tool).
- **Thiết kế**: stdio transport; cấu hình `.cosmew/mcp.json` (project) + `~/.cosmew/mcp.json` (user); server stdio chạy như process thường (như Codex), hiển thị rõ; duyệt theo chế độ server `auto|prompt|writes|approve`; `mcp_resource` đọc resource; khi tổng mô tả tool > ngưỡng → chỉ gửi tên, `tool_search` nạp schema khi cần; `/mcp` quản lý; tự cài: `mcp_search` (MCP Registry) + `mcp_install` (một lần xác nhận, ghim phiên bản, ưu tiên HTTP, token vào keyring, xác minh bằng `tools/list`).
- **Test**: server stdio giả, OAuth giả, annotation → quyết định duyệt, tool_search, cài/gỡ.

### W13 — CodeMode (L) — đợt 3
- **Lấy**: ý tưởng chung Codex/OpenCode; engine quyết định ở D5.
- **Thiết kế**: tool `code` `{source}`; trình thông dịch không có I/O ngoài các hàm tool được inject; **mỗi lời gọi tool bên trong vẫn qua `ToolDispatcher`** (quyền, audit); giới hạn thời gian 60 s, ≤ 50 lời gọi tool, output ≤ 64 KiB; trả giá trị cuối + log.
- **Test**: thoát sandbox (không truy cập `process`/fs/network), giới hạn, quyền của từng lời gọi bên trong, benchmark số lượt/token so với gọi tool thường.

## 6. Thứ tự và phụ thuộc

```
W0 → W1 → W1.5 → W2 → W3 → W4 → W5 → W6 → W7   (đợt 1, commit mỗi bước)
                                   ↓
          W8 → W9 (cần W1 quyền theo agent) → W10 → W11 → W12 (cần W5)   (đợt 2)
                                   ↓
                                  W13 (cần W1, W12 cho tool MCP)          (đợt 3)
```
W2/W3 độc lập với W4–W6 nếu cần làm song song bằng session khác (khác file: W2/W3 chạm `core`, `sdk`, `features/plan|question`; W4 chạm `code-intel`, `tools`).

## 7. Kiểm chứng và đo

- Sau mỗi workstream: `bun run typecheck && bun run lint`, test liên quan; cuối mỗi đợt: `bun test tests`, `bun run test:integration`, `bun run test:e2e`. Không ghi pass khi chưa chạy; skip không phải pass; flaky đã biết: `tests/security/process-supervision.test.ts` "ordinary child and nested…" dưới tải.
- **Benchmark cuối đợt 1** (`tests/benchmark/`, chạy tay, có phí token): 20–30 tác vụ đọc/sửa trên repo mẫu, cùng model/effort; so trước/sau: tỉ lệ đúng, số lượt tool, token, thời gian. Web search: 30 câu hỏi lập trình, top-5 đúng.
- Live (cần mạng/server thật) đặt sau biến môi trường, ghi riêng với fixture.

## 8. Rủi ro tổng

| Rủi ro | Giảm thiểu |
|---|---|
| Ít hỏi quyền hơn (W1) | test sandbox đầy đủ; deny rule luôn thắng; danh sách nguy hiểm + Tree-sitter |
| LSP/MCP stdio chạy code bên thứ ba | LSP trong sandbox; MCP stdio hiển thị rõ + xác nhận khi cài |
| Prompt injection từ web/MCP/AGENTS lồng nhau | kết quả là dữ liệu, không phải chỉ dẫn hệ thống; AGENTS chỉ từ trong workspace |
| Token tăng (ảnh, subagent, compaction) | giới hạn kích thước; subagent tóm tắt; benchmark |
| Contract/persistence migration | một migration mỗi đợt, test đọc session cũ |
| Bảo trì LSP nặng (OpenCode đã bỏ) | chỉ 4 ngôn ngữ, cấu hình dạng bảng, thêm ngôn ngữ = thêm một mục |

## 9. Nguồn tham chiếu (clone lại; chỉ đọc)

```sh
git clone https://github.com/openai/codex.git /tmp/ref-codex && git -C /tmp/ref-codex checkout 090be4df0724cdef5758e6a0934ba557af8b6bbe
git clone https://github.com/sst/opencode.git /tmp/ref-opencode && git -C /tmp/ref-opencode checkout 0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4
git clone --depth 1 --branch v1.19.5 https://github.com/sst/opencode.git /tmp/ref-opencode-v1
```
Port hành vi, không chép nguyên văn; mỗi ADR ghi URL, revision, ngày đọc.

## 10. Quy tắc làm việc

- Working tree có thể dùng chung: không stash/revert/format file người khác; `git add` từng file; kiểm `git status` trước commit.
- Mỗi workstream một commit (`feat(...)`), kết thúc bằng dòng `Co-Authored-By` theo cấu hình phiên. Không push khi user chưa bảo.
- Dừng và hỏi khi: cần dependency ngoài D1; cần chạy gì ngoài sandbox ngoài phạm vi đã nêu; source thật khác mục 2; một thay đổi phá test bảo mật mà không rõ cách giữ bất biến.

## 11. Báo cáo cuối mỗi đợt

Commit đầu/cuối; danh sách commit; bảng tính năng (PARITY VERIFIED / IMPLEMENTED — NOT LIVE VERIFIED / PARTIAL / NOT IMPLEMENTED); lệnh test + exit code; benchmark; khác biệt còn lại so với Codex/OpenCode/Claude Code.
