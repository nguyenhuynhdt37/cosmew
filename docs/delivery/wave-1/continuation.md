# Tiếp quản Claude — 2026-11-17

Nguồn: phiên Claude `0706b4c0-5ce7-4d3a-8f07-20a51392fd6a`, worker
`a431e2dc16b98f4a5` dừng 03:52 UTC vì giới hạn 5 giờ. User yêu cầu tiếp tục kỹ như
phiên trước. Giữ nguyên worktree `.claude/worktrees/agent-a431e2dc16b98f4a5`;
không ghi đè `dev`, không đụng hai file HTML chưa track ở root, không push.

## Phạm vi, vai trò và quyết định

- W0–W3 có commit đến `41fb45d`; W4 có code dang dở chưa commit khi tiếp quản.
  Tiếp tục kế hoạch W0–W7 đã duyệt, không xin lại D1–D6.
- Theo chỉ dẫn mới của user: **đúng một coding worker** (`review_wave1`) viết code,
  tests, docs và commit; primary chỉ phân tích, điều phối, review và chạy tests.
  Ban đầu worker rà W1–W3 rồi làm W5/W6, sau đó tiếp quản toàn bộ W4–W7.
- Giữ code W4 dang dở để kiểm chứng/hoàn thiện, không xoá công việc Claude để làm lại.
- W5 dùng Tavily REST như source OpenCode đã xác minh; không dựng endpoint MCP
  giả theo nhận định sai trong bảng kế hoạch. Exa/Firecrawl/Parallel dùng MCP SDK.
- Không thêm decoder ảnh/PDF ngoài dependency đã duyệt; ghi rõ mức kiểm cấu trúc
  tối thiểu và giới hạn quét raw secret thay vì tuyên bố decode đầy đủ.
- Không có benchmark có phí token hay live search được chạy; bằng chứng fixture,
  OS thật và local TS thật được tách riêng. Không tuyên bố Product MVP complete.

## Findings đã review và regression

| Finding thực tế | Sửa | Regression / bằng chứng |
|---|---|---|
| Notebook attachment name và tool target chưa redact | Redact names/target tại dispatcher finish | `wave1-redaction.test.ts`, thấy RED rồi GREEN |
| Plan text lưu/hiển thị trước redact | Redact explanation/step/activeForm trước callback | `wave1-redaction.test.ts`, RED → GREEN |
| Raw Unicode secret trong media lọt vì chỉ latin1 | Quét cả UTF-8 và latin1 | `wave1-redaction.test.ts`, RED → GREEN |
| Pending question lộ secret/ký tự điều khiển | Sanitize mọi field hiển thị trước lưu SDK/UI; giữ ID | `question.test.ts` pending-question regression, RED → GREEN |
| Pending prompt cũ có thể được duyệt sau khi thêm deny | Đổi rule theo hướng hạn chế (thêm deny/ask, xoá allow) deny/settle unresolved prompts; thêm allow giữ prompt “don’t ask again”; giữ mode/delegation | `question.test.ts` pending command regression, RED (once thay vì deny) → GREEN (parent chạy lại hai pending/rule tests) |
| Grant session vượt qua deny mới | Sửa rule thu hồi cả hai cache grant | `question.test.ts` production client → dispatcher → MCP fixture, network call thứ hai bị chặn; RED → GREEN |
| Direct read/search/snippet không xét Read rule nếu builtin allow | Pure project read-policy port ở direct read, instruction, listing, glob, suggestion, grep và LSP; hard deny/secret vẫn thắng | `read-policy-overrides.test.ts` cả ripgrep/worker; LSP hidden-source assertion; RED → GREEN |
| LSP rename đọc source trước policy | Deferred source authorization/revalidate trước RPC | `lsp.test.ts` denied/secret source không start server, RED → GREEN |
| JSON-RPC header không terminator tăng vô hạn; null/duplicate lengths | Bound header/body, schema envelope, đóng/kill peer lỗi | `lsp-rpc.test.ts`, RED → GREEN |
| Diagnostics stale/malformed/unopened URI tăng state | Version/range/message validation, chỉ open documents, cap/close | `lsp-rpc.test.ts`, RED → GREEN |
| Shutdown bỏ sót server đang initialize | Lifetime abort + ownership starting peer + reject late completion | `lsp-rpc.test.ts`, RED → GREEN |
| Native helper đọc secret theo setting command thường | Helper sandbox riêng luôn mask secret | Seatbelt thật trong `lsp.test.ts`, RED → GREEN |
| Leader helper thoát để lại child cùng PGID | Supervisor giữ leader đến cleanup rồi kill group trước PID reuse | Seatbelt thật natural-exit test RED → GREEN; TERM-ignoring descendant test GREEN |
| Watcher còn thiếu | Coalesce, chỉ sync open authorized file, recheck rules, bỏ vendor/ignored folder, didClose | `lsp.test.ts` watcher regression RED → GREEN |
| Rename peer edit range/shape không hợp lệ | Validate WorkspaceEdit + source snapshot + ranges/surrogates + patch revalidation | `lsp.test.ts`; malformed trả INVALID_PATCH, resource operations UNSUPPORTED |
| Diagnostics có trong receipt nhưng UI bỏ mất | Render error rows dưới successful file edit | `transcript-activity.test.ts`, RED → GREEN |
| MCP init fail bị cache vĩnh viễn | Kết nối SDK mới lần gọi sau, shared init; đóng/abort attempt | `web-search.test.ts` transient500 then success RED → GREEN; close-during-init GREEN |
| Text HTML rule ưu tiên hơn script/style removal | Bỏ các element đó khỏi plain-text custom rule | `web-fetch.test.ts`, RED → GREEN |
| Guidance còn nói không có mạng/read-only/mọi lệnh hỏi | Guidance theo tools offered + sandbox/policy thực tế | `wave1-guidance.test.ts`, RED → GREEN |

## Lịch sử kiểm chứng tiếp quản

Các kết quả dưới đây là run tại thời điểm đó, không thay thế final gate trong
[acceptance](acceptance.md):

- Kiểm tra tiếp quản: typecheck exit 0; 48 tests quyền/read/plan/question pass.
- Full run đầu: 723 pass / 33 skip / 11 fail / 1 unhandled error, 767 tests,
  78 files, exit 1. Fail gồm tool-list expectations cũ, MCP retry regression
  chủ động RED, và timeout 40-round dưới tải khiến cleanup đóng DB trước turn.
  Isolated mặc định từng fail ~5 giây; rerun deadline chẩn đoán 20 giây pass
  ~2.66 giây với đầy đủ 42 views / 41 results. Không sửa runtime ceiling.
- Integration/e2e đầu dùng snapshot đang sửa còn thiếu import, expectations cũ
  và malformed rename code; đây là failure thật đã ghi lại, không tính pass.
- E2E tích hợp đầu sau đó: 282 pass / 11 skip / 3 fail, 296 tests, 22 files,
  141.29 giây, exit 1. Hai fail vì assertion rộng `not.toContain('at most')`
  khớp nhầm hướng dẫn plan “at most one in_progress”; sửa assertion kiểm numeric
  tool/request budget thực tế. Một fail vì malformed rename map sai UNSUPPORTED
  thay vì INVALID_PATCH; sửa typed parser result, không nới test.
- Full run kế tiếp trước pending-prompt fix: 745 pass / 34 skip / 2 fail /
  1 unhandled error, 781 tests, 80 files, 208.34 giây, exit 1. Một fail là
  pending-approval regression chủ động RED; một là process-supervision baseline
  `ordinary child and nested…` timeout 5 giây (~9.626 giây thực tế), independent
  `/bin/ps -A` observer timeout; không có code mới trong runtime đó. Final gate
  sẽ phân biệt isolated/rerun thay vì biến failure này thành pass.
- Full run trước policy-semantic adjustment: 747 pass / 34 skip / 2 fail,
  không còn observer error. Hai fail là UI “don’t ask again” và selected approval:
  add-allow từng bị coi là restriction nên huỷ prompt hợp lệ. Không nới UI test;
  sửa đúng semantics: thêm deny/ask hoặc xoá allow huỷ unresolved prompts, thêm
  allow giữ prompt hiện tại/unrelated prompts; mọi rule edit vẫn revoke caches.
  Parent fresh focused gate cả bốn cases (pending deny, cache deny, selected UI,
  “don’t ask again”) đều pass. Final pipeline chạy lại toàn bộ sau thay đổi này.
- Parent targeted gate sau read-policy/UI fixes: 62 pass / 1 skip / 0 fail,
  8 files, ~16 giây. Compile và lint đã xanh sau sửa import/unused param/format.
- Pending-prompt fix: parent fresh targeted gate hai tests xanh; typecheck/lint
  exit 0. Rule hạn chế settle deny mọi unresolved prompt, không reset mode/delegation;
  thay đổi theo hướng cho phép giữ các pending prompt hợp lệ.
- Baseline process-supervision timeout tái hiện cả isolated (~8.749 giây);
  nguyên nhân observer test dùng `ps -A` lặp lại cho từng PID. Sửa **test-only**
  `current(record)` dùng `ps -p` đúng positive PID, giữ identity lstart/command/state;
  global discovery `observe()` vẫn dùng `-A`. Lỗi/timeout/signal/stderr hoặc row
  không parse được fail closed, chỉ clean no-PID exit 1 mới là absent. Parent
  targeted ordinary-child case sau sửa pass ~714 ms; full process-supervision
  và observer-unit gate trước negative malformed-row mới: 12 pass / 0 fail,
  ~3.66 giây. Negative malformed-row đã thấy RED rồi sửa parser; final run ghi riêng.
- Parent grep/read-policy focused gate: 15 pass / 0 fail, exit 0; giữ count/note
  secret bị worker prefilter bỏ qua mà không đọc file bị chặn.
- **TS thật:** opt-in `FUTRYN_TEST_REAL_LSP=1` local installed TypeScript 7,
  native Seatbelt, initialize + definition + rename: pass ~4.3 giây, 6 assertions.
  Python/Go/Rust/Linux/Windows và live provider search chưa có bằng chứng thật.
- Hook security review tự động của commit W5 không hoàn tất vì HTTP 403;
  `/Users/huynh/.claude/security/log.txt` có chi tiết. Đây không phải pass review.
  Primary đã được thông báo để báo user; local review/regressions vẫn thực hiện.

## Giới hạn giữ nguyên, không giấu trong kết luận

- New diagnostics so multiset message/source/code, không dịch range theo diff;
  lỗi mới có cùng message với lỗi cũ vừa hết có thể bị bỏ sót.
- Diagnostics là receipt/transcript; `diagnostics.reported` và general
  `mcp.server.status` observer events chưa triển khai.
- Project Read rules kiểm returned source data; trusted ripgrep có thể scan file
  trước output filter. Worker prefilter trước đọc. Đây không phải sandbox per-file
  cho language server độc hại. Native sandbox không mạng/ẩn secret là lớp riêng.
- Media structural checks không decode đầy đủ; raw scan không phát hiện được mọi
  secret đã nén/encode hoặc chưa được đăng ký.
- macOS descendant `setsid` vẫn unconfirmed. Recursive watcher OS khác chưa xác minh.
- Benchmark 20–30 coding tasks và 30 search queries chưa chạy; không có số cải thiện
  token/quality hay tuyên bố ngang Codex/OpenCode từ suite fixture.
- W8–W13 (model compaction, subagents, memories, skills, general MCP, CodeMode)
  chưa triển khai trong đợt này.

## Final frozen-snapshot gate

Parent chạy tuần tự để tránh compile/test CPU cạnh tranh gây lỗi quan sát giả:
`typecheck → lint → full → integration → e2e`, dừng ngay nếu có lỗi.

Fresh `typecheck` / `lint`: exit 0. Fresh `bun test tests`: **exit 0, 749 pass,
34 skip, 0 fail**, 783 tests / 81 files / 86 365 expects, 187.77 giây, không còn
unhandled async error. Đây là run sau cả policy-semantic fix và test-only observer
fix; failure history phía trên giữ nguyên. Cùng pipeline, integration **exit 0,
198 pass / 23 skip / 0 fail**, 221 tests / 24 files / 1 253 expects, 33.30 giây.
Cùng pipeline, e2e **exit 0, 286 pass / 11 skip / 0 fail**, 297 tests / 22 files /
3 053 expects, 131.98 giây. Toàn pipeline exit 0. Parent cũng chạy
`bun install --frozen-lockfile --ignore-scripts`: exit 0, checked 144 installs /
163 packages, không đổi source/lock (35 ms). Không sửa runtime/tests sau snapshot.

Integration code/shared fixes/manifests/tests commit: `5aca162`. W5 `3628a34`,
W6 `b1d0192` có trước đó; docs evidence commit theo ngay sau integration. Không
rewrite lịch sử Claude, không push/cleanup. Primary kiểm root context rồi quyết
định fast-forward local dev; worker không thay root hay hai HTML của user.
