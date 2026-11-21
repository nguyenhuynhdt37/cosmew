# ADR 0074 — P3: nguồn diff, duyệt plan, summarize và điều khiển phiên

Ngày: 2026-11-20. Trạng thái: Accepted. Contract 1.38 → **1.39**, SQLite 9 → **10**. Không dependency mới, không thay dependency DAG.

## Public API và consumers

SDK và CLI composition root cùng nâng lên 1.39; TUI chỉ gọi public `@futryn/sdk`. JSONL phát version mới; consumers bỏ qua field additive nhưng phải nhận version mới. Các API P1 không bị xoá. RewindScope thêm `summarize`; embedding host không có port mới trả UNSUPPORTED, không giả thành công.

- `getWorkspaceDiff({base})` / `refreshWorkspaceDiff({base})`: session (mặc định), uncommitted, branch; snapshot có effective base và capabilities/reason. Current / Uncommitted / Branch là nhãn UI. Session so snapshot workspace đã được read-policy duyệt khi mở phiên, gồm thay đổi từ shell; uncommitted so HEAD; branch so merge-base của HEAD với default branch rồi so working tree. Không fetch để tìm default branch. Không Git, detached HEAD hoặc thiếu default branch được báo rõ, không đoán một nhánh tùy ý. Ctrl+X B (`app:cycleDiffBase`) ở DiffPanel và ←/→ đổi nguồn, bỏ nguồn unavailable và hiển thị lý do. Completion cũ không ghi đè nguồn/phiên mới.
- `resolvePlanApproval({mode:'manual'|'acceptEdits', feedback})` lưu quyết định và feedback đã redact trước đổi quyền; tool nhận feedback cùng kết quả. `{feedback}` cũ vẫn yêu cầu sửa, giữ plan. `PlanProposal.plan/path/revision` đưa markdown và artifact durable cho UI; row cũ không có artifact vẫn đọc được. Persistence chọn đường dẫn riêng `plans/<proposal UUID>-<revision>.md` dưới session store, private 0600/0700; fsync trước publish path SQLite. `editPlanProposal(text, expected?)` chỉ sửa đề xuất đang chờ sau validate/revalidate session, revision và cancellation; không grant. Editor mở bản sao tạm 0600 qua suspendTerminal, không sửa artifact gốc; chỉ submit text đã đổi sau return. Shift+Tab ở feedback approve atomically; không thêm lựa chọn bypass.
- `rewind({checkpointId,scope:'summarize',instructions?})`: model đang được chọn viết handoff cho suffix từ checkpoint; giữ prefix trước checkpoint trong phiên mới và append summary. Dùng machinery ADR0054, focus có giới hạn và redact. Journal gốc giữ nguyên, receipt rewind append; cancellation trước commit không ghi gì. Model failure dùng extractive summary, kể cả suffix một lượt. Không restore code trong scope này. Usage được tính như compact vào phiên nguồn. UI có optional focus line.
- `retractQueuedEntries({includeShell:false})` là API selective tương đương yêu cầu `retractQueuedInput` overload; trả id/type/content đã redact. Store transaction IMMEDIATE tuyến tính với beginExecution; chỉ ghi receipt/remove inbox cho entry được chọn. `shellOnlyWhenAlone` kiểm tra trong transaction, không tin snapshot UI. Runtime chỉ bỏ đúng id đã rút. ↑ lấy text trước draft; shell giữ nguyên trong queue hỗn hợp hoặc draft có chữ; chỉ một shell và draft rỗng mới được lấy, giữ prefix `!` để chuyển shell mode. Legacy `retractQueuedInput()` vẫn trả chuỗi như P1.
- `selectModel(...,{scope:'session'})` không gọi router persist settings; nếu đang có hội thoại thì fork với selection mới qua port có sẵn để adapter pin đúng model và giữ lịch sử. Chưa có hội thoại thì selection RAM áp dụng lần tạo phiên đầu. `setReasoningEffort(value,{scope:'session'})` giữ override trong RAM theo phiên/account/model; sendTurn nhận giá trị này; phiên mới dùng preference bình thường. `s` ở ModelPicker/EffortSlider áp dụng session only; Enter vẫn lưu preference.
- `promptHistory({scope:'session'|'project'|'everywhere',limit?})`: tối đa 200 prompt, mỗi content tối đa 16.000 ký tự, mới nhất trước, timestamp, bỏ subagent sessions, redact trước output. Project so canonical workspace của từng submission ở composition root; session so id. Session resume qua workspace khác không gán prompt mới cho workspace cũ. Steering lấy từ journal acceptance, retracted steering bị loại. Bản sao context/fork và handoff không tạo prompt lịch sử mới. Projection giữ tối đa 5.000 submission, output tối đa 200. Everywhere chỉ database riêng của user hiện tại. Ctrl+R mặc định everywhere; Ctrl+S xoay session → project → everywhere; có cột thời gian. Embedding host thiếu history port chỉ dùng RAM với nhãn session, không gắn nhãn project/everywhere cho lịch sử RAM.

## SQLite migration

v10 thêm nullable `conversations.workspace` và `messages.created_at`, cùng bảng/index `prompt_history` bounded. Các actual user submission/steering ghi projection cùng transaction với message/journal; scoped store nhận canonical workspace từ host, không dùng trạng thái workspace global. New session được host gắn canonical workspace một lần; resume ở workspace khác không đổi nhãn cũ. New messages ghi ISO timestamp. Backfill workspace chỉ từ checkpoint đã lưu; timestamp chỉ từ startedAt của receipt cùng revision. Legacy prompt thiếu timestamp không xuất hiện trong history mới; session không rõ workspace không xuất hiện ở project, không đoán workspace hiện hành. Projection backfill chỉ dữ liệu có timestamp từ message/steering journal, giữ NULL workspace chưa biết. Copied context ghi metadata timestamp NULL, không sinh lịch sử submission; nhật ký gốc không thay đổi. Binary cũ từ chối version 10; binary mới tự migration trong transaction khi mở. Plan revision/path vẫn JSON additive, không cần bảng mới. Session-only preference không thêm durable user settings.

## Quyền và provider

Không đường mới gọi tool vòng ToolDispatcher. Workspace Git adapter nhận read-policy/redactor qua port; không cho Git hooks, external diff/textconv, fsmonitor, clean/process filters hoặc lazy-fetch partial clone chạy chương trình repository. Production explicit bases chỉ cho Git đọc metadata và blob OID; content working tree đọc descriptor-relative bằng SecureFiles (mọi ancestor nofollow, từ chối hardlink/FIFO và thay đổi khi đọc). Env allowlist cố định, không preload/secrets/global config, protocol.allow=never. Không network/fetch; default branch dò origin/HEAD local rồi convention main/master, không truy vấn remote. Empty HEAD dùng empty baseline. Mode-only changes giữ metadata. Text diff dùng prefix/suffix replacement có giới hạn, chưa minimal như Git ở nhiều vùng rời nhau. Baseline Current từ checkpoint cũ thiếu completeness marker hoặc đã pruning trả unavailable, không đoán trướcảnh. Không có fallback không-sandbox. Output/file/report có giới hạn, path được kiểm tra trong workspace và policy trước trả content; untracked cũng kiểm tra. Repository config là dữ liệu không tin cậy. Current, branch/default-branch metadata và mọi snapshot không phải grant. File restore vẫn qua dispatcher ADR0073. Plan approval không cấp riêng file/shell/network permission; edit plan không đổi mode.

Đã kiểm tra `packages/models/src/adapter.ts` (working tree ngày 2026-11-21), `catalog.ts`, `packages/contracts/src/models.ts`: contract hiện có `reasoningEffort` theo mức quảng bá. Adapter chuyển giá trị cho Responses qua `providerOptions.openai`, và cho OpenAI-compatible Chat qua provider key cấu hình (`<id>.chat` → `<id>`), nơi AI SDK 3.0.92 serializes thành `reasoning_effort`; cả hai đường chỉ chạy khi model metadata quảng bá đúng mức. Anthropic/Gemini chưa có wire mapping nên vẫn trả `UNSUPPORTED`. Không có request field service tier/fast mode hoặc thinking enabled boolean. `replayReasoning` của DeepSeek là replay dữ liệu, không phải toggle thinking. Vì vậy không thêm `fastMode/setFastMode` hay `thinking/setThinking` giả. Alt+O/Alt+T vẫn Not implemented; `/effort` dùng mức được model quảng bá. Mapping toggle sang provider wire, subscription/account eligibility và provider live: **Needs verification**. Không suy luận việc provider hỗ trợ từ dependency AI SDK có field tương tự.

## Nguồn và giới hạn

Reference: `docs/delivery/tui-v4/reference/live-120x36/L02-edit-done.txt`, `L12-plan-approval.txt`; capture Claude Code 2.1.328 ngày 2026-11-19, đặc tả `spec.md`, keys.md §6 và yêu cầu wave P3 ngày 2026-11-20. Quy tắc queue: https://code.claude.com/docs/en/interactive-mode#take-back-what-you-queued (nguồn P2 truy cập 2026-11-20, không revision bất biến). Không tuyên bố đã xác minh lại trang live ở P3. Model fixture không chứng minh provider có xác thực; OS clipboard, Linux/Windows và parity live còn **Needs verification**. Không tuyên bố Product MVP complete.

Bằng chứng test và kết quả toàn wave: [P3 trong p2-status.md](../delivery/tui-v4/p2-status.md).


## P3 fix round — default diff và review (2026-11-20)

Coordinator báo ngoài sandbox: 1187 pass, 12 skip, 6 fail; ba regression P3 được tái hiện độc lập bằng test không dùng port.
Root cause: Current chỉ lấy path/preimage từ patch checkpoints nên không thấy file do Bash tạo/sửa; `/review` vô tình dùng
Current của client chưa có phiên thay vì working tree so HEAD. Ngoài ra filter P3 bỏ luôn path cần ask, làm mất metadata
`contentWithheld` mà review từng trả.

Sửa implementation: workspace sở hữu inventory descriptor-relative (no symlinks), snapshot tối đa8MiB/20.000 entries,
≤1MiB/file, có read-policy/redactor và deadline. Host capture trước thực thi phiên, persist snapshot trong JSON của checkpoint
đầu tiên (không schema migration); resume dùng lại snapshot và Current hợp nhất inventory mới để phát hiện file shell-created.
Legacy không có full snapshot vẫn dùng patch preimages hiện có, không đoán pre-session bytes. Scope restore không đổi: đây là
**diff**, không phải quyền rollback thay đổi của shell/MCP. Snapshot lỗi/oversize/redacted fail closed.

`/review` gọi explicit Uncommitted, giữ kiểm tra session/selection/mode sau await trước chuyển mode và submit. Report display
vẫn bỏ ask/deny paths; cache private chỉ giữ metadata rỗng cho ask paths (không đọc current bytes hoặc blob của chúng).
Sau chuyển review, getter cùng base cho phép metadata ask; `reviewEvidence` áp dụng lại cả builtin lẫn project read rules
và đánh dấu contentWithheld. Deny/state/outside paths không được mở rộng. Không đổi contract1.39/SQLite10 hay dependency.

Regression tests: `tests/contracts/workspace-diff-regressions.test.ts`: shell thực qua /bin/sh không patch receipt, pre-existing
uncommitted content không bị coi là mới, persisted snapshot/resume, fresh-client review qua Git thật, ask-policy old/new content
không vào request, cancellation khi đổi session và secret rejection trước durable write. Các test này không tuyên bố Seatbelt/live
provider compatibility; hai file end-to-end gốc vẫn cần coordinator chạy ngoài sandbox do HTTP bind EADDRINUSE local.

Reasoning-effort reset and user-only capability declarations are corrected by
[ADR 0078](0078-user-declared-reasoning-efforts.md), folded into the uncommitted contract 1.40 rename.
