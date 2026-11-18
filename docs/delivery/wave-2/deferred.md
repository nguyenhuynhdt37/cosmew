# Đợt 2 — việc hoãn lại (làm cùng bước MCP/plugin S6)

Ghi ngày 2026-11-18. Mỗi mục ghi nguồn tham chiếu để phiên sau đọc lại.

## Skills (từ S3)

| Mục                                                       | Nguồn                                                                           | Ghi chú                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Tải skill từ index qua URL (cache + phiên bản)            | OpenCode `packages/core/src/skill/discovery.ts` @ `852d5ed`                     | Làm cùng `mcp_install`: một lần xác nhận, ghim phiên bản, lưu ở cấp user |
| Skill admin `/etc/futryn/skills`                          | Codex `codex-rs/ext/skills/src/host_roots.rs` (`SkillScope::Admin`) @ `090be4d` | Cần quyết định chính sách quản trị                                       |
| `skill-installer` / tự cài skill theo yêu cầu             | Codex skill mẫu `codex-rs/skills/src/assets/samples/skill-installer`            | Gộp với tự cài MCP (Registry)                                            |
| Phụ thuộc MCP khai báo trong skill (`dependencies.tools`) | Codex `codex-rs/skills/src/metadata.rs`                                         | Cần MCP stdio/HTTP tổng quát trước                                       |
| Skill trong plugin                                        | Claude Code (plugin `skills/`), Codex `core-plugins`                            | Làm khi có hệ plugin                                                     |
| Skill trên cloud / gói executor                           | Codex `ext/skills/src/cloud_skill.rs`                                           | Không ưu tiên                                                            |

## Đã biết từ UAT, giữ nguyên theo quyết định user

- Session terminal có giới hạn cứng 300 s (`create-next-app` vượt, cài vẫn xong).
- Dev server không tải được Google Fonts khi sandbox không có mạng (bật `network_access = true` nếu cần).

## Memories — phần tự trích còn hoãn (S4 bổ sung)

Ngày 2026-11-18, đối chiếu local Codex `090be4df0724cdef5758e6a0934ba557af8b6bbe`. Citations, `usage_count`/`last_usage`, ưu tiên mục lục và đánh dấu 30 ngày đã làm trong [ADR 0057](../../adr/0057-user-scoped-project-memories.md); không còn deferred. Không tự xoá ký ức. Phần còn lại là job nền/trích xuất và agent tổng hợp, chưa chạy kể cả khi ghi `auto_extract = true` (host config có diagnostic rõ).

### Phạm vi phiên kế: auto extraction opt-in, mặc định tắt

- Chỉ bật bằng `[memories] auto_extract = true` trong host config user; `FUTRYN_MEMORY=0` / `enabled=false` thắng. Không đọc bật cờ từ repo. Hook lúc mở session chính mới hoặc kết thúc session chính, enqueue một lượt có giới hạn rồi trả UI ngay. Không chạy cho subagent, ephemeral, phiên chưa consent, phiên hiện tại còn hoạt động hay backend chat-only; không tạo tiến trình agent ngoài Futryn. Cần định nghĩa rõ việc thoát CLI có chờ một job hay chỉ hẹn cho lần startup kế, không để một process nền mồ côi.
- Eligibility theo Codex defaults (`config/src/types.rs`): tối đa **2** phiên/lượt, tuổi ≤**10 ngày**, idle ≥**6 giờ**. Scan tối đa **5.000** candidates, loại active/current/in-flight và đã xử lý đúng source revision. Dùng session snapshot watermark/hash để session có thêm lượt mới vẫn đủ điều kiện được xử lý lại. Root/project đúng workspace canonical; không lấy lịch sử workspace khác. Những khoảng tuổi/idle là lịch sử activity, không dựa riêng vào mtime file.
- Thêm migration SQLite (version kế sau 8 khi triển khai) và persistence port cho `memory_extraction_jobs`: project/session/source revision, pending/leased/succeeded/succeeded_no_output/failed, owner, heartbeat, lease expiry, retry_at và bounded error code. Claim transaction/CAS giữa các process; lease **3.600 s**, retry backoff **3.600 s** theo Codex `memories/write/src/lib.rs`. Codex cap concurrency 8 nhưng Futryn chỉ chọn 2/lượt, concurrency ban đầu ≤2. Cancel/shutdown trả lease an toàn; không ảnh hưởng outcome phiên chat; không hot-loop retry.
- Một request provider API trích JSON ứng viên `{name, description, type, content}` từ snapshot transcript đã redact, có ngân sách token/cost và input truncation rõ. Transcript/tool/web/repo text là dữ liệu không tin cậy; system prompt extraction là host-owned. Không tool/network hay runtime agent bên ngoài cho extractor; không lấy bí mật hoặc fact đã có trong repo. JSON lỗi/nothing useful trở thành failed hoặc succeeded_no_output, không ghi nửa ứng viên.
- Mọi candidate ghi bằng **cùng dispatcher `memory write`** với consent/feature gate, secret detector/redactor, tên/path/schema/16 KiB/1 MiB/256-entry checks, quota sidecar và audit thường. Chỉ đánh dấu processed sau khi các kết quả ghi được xác nhận; lưu receipt/idempotency cho partial batch để restart không nhân đôi hoặc đè user edits. Không bỏ qua logic tool bằng cách ghi thẳng file. Job failure/audit failure cần fail closed với storage, không fail phiên người dùng.
- Usage extraction lưu ledger riêng theo job/provider/model: tokens input/output/cache, cost coverage, thời gian, trạng thái. Không cộng nhầm vào turn chat hay `usage_count` (chỉ memory read). SDK cung cấp report đã redact; `/memory` có hàng usage extraction và lỗi/retry bounded. Chưa thêm usage row giả khi chưa có runner.
- Test bắt buộc: default off và off thắng true; config repo không kích hoạt; selection đúng age/idle/source revision/project; job claim cạnh tranh/restart/lease expiry/retry; shutdown/cancel; structured output malformed/no output/partial failure; secret/quota refusal qua dispatcher; idempotency bảo vệ user edit; lỗi job không làm fail chat; usage ledger tách khỏi chat và read count. Fixture model API chỉ chứng minh logic; live extraction/cost còn Needs verification.

### Consolidation agent để sau extractor

Agent tổng hợp riêng như Codex phase 2 là một bước sau nữa: lock project, bounded candidate set, sandbox chỉ state memory, không network/recursive delegation, mọi write qua dispatcher, snapshot/receipt và rollback strategy cần ADR. Không port memory-root Git repository hay tự prune files trong S4. Không tự xoá lâu không dùng khi chưa có yêu cầu/config riêng.

### Nguồn đã đọc

- `codex-rs/memories/README.md` (pipeline, eligibility, selection).
- `codex-rs/memories/write/src/{phase1,lib,start,runtime}.rs` là vị trí thực tế của orchestration tại revision pinned; đường `codex-rs/core/src/memories/` user/README nhắc tới **không tồn tại** trong checkout này. `phase1.rs` và `lib.rs` đã đọc để xác minh limits; các file runner còn lại cần đọc chi tiết khi triển khai.
- `codex-rs/config/src/types.rs` (defaults/clamps); `codex-rs/state/src/runtime/memories.rs` (phase-2 selection SQL).
- `codex-rs/memories/read/src/{citations,usage}.rs`, `codex-rs/ext/memories/templates/memories/read_path.md` cho phần đã triển khai. Usage upstream phân loại shell reads; Futryn chỉ đếm explicit dispatcher memory reads, không shell telemetry.
