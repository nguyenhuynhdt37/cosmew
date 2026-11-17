# Nghiệm thu đợt 1 (W0–W7)

Kế hoạch: [plan.md](plan.md). Mỗi workstream ghi lệnh đã chạy, exit code và số pass/skip/fail. Skip không phải pass.

## W0 — Baseline (2026-11-17, HEAD `30f2d8a`)

Bun 1.4.4, macOS (Darwin 24.6.0), `FUTRYN_COMMAND_BACKEND=none` qua `tests/preload.ts`.

| Lệnh | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| `bun install --frozen-lockfile --ignore-scripts` | 0 | — | — | — |
| `bun run typecheck` | 0 | — | — | — |
| `bun run lint` | 0 | — | — | — |
| `bun test tests` | 0 | 653 | 33 | 0 |
| `bun run test:integration` | 0 | 151 | 23 | 0 |
| `bun run test:e2e` | 0 | 248 | 10 | 0 |

Nguồn tham chiếu (chỉ đọc, không chạy code):

- Codex `openai/codex` @ `090be4df0724cdef5758e6a0934ba557af8b6bbe` (đã checkout sẵn, xác nhận `git rev-parse HEAD`).
- OpenCode `sst/opencode` main @ `0ac0d7ee7260c3e711a481ceb4580bb60f4d9dd4` và tag `v1.19.5`.

## W1 — Quyền chuẩn Codex (ADR 0040)

| Lệnh | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| `bun run typecheck && bun run lint` | 0 | — | — | — |
| `bun test tests/security/approval-policy.test.ts` | 0 | 18 | 0 | 0 |
| `bun test tests/end-to-end/approval-policy.test.ts` (Seatbelt thật trên macOS) | 0 | 2 | 0 | 0 |
| `bun test tests` | 0 | 673 | 33 | 0 |

Ghi chú: các bộ test fixture viết cho hộp thoại duyệt chạy ở `untrusted` (`tests/preload.ts`); mặc định `on-request` được kiểm riêng.

### W1 — các lần review bảo mật (2026-11-17)

- `ca58b3f`, `5b99f6f`: stdin luôn cần duyệt (`never` từ chối); bộ phân tích lệnh trung gian được thay.
- `983b913`: port nguyên thiết kế Codex (allowlist `try_parse_word_only_commands_sequence`, lệnh không parse được là một lệnh mờ, heuristic `is_dangerous_command.rs` chỉ là chốt phụ, ranh giới là sandbox).
- `86449f2`: chỉ mở `-c` cho shell trần hoặc shell hệ thống (chặn `./bash` cài trong repo).
- `bun test tests/security/approval-policy.test.ts`: 29 pass, 0 fail.

## W1.5 — read đầy đủ (ADR 0041)

| Lệnh | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| `bun run typecheck && bun run lint` | 0 | — | — | — |
| `bun test tests/security/read-extended.test.ts` | 0 | 6 | 0 | 0 |
| `bun test tests/end-to-end/read-media.test.ts` | 0 | 3 | 0 | 0 |
| `bun test tests` | 0 | 693 | 33 | 0 |

### W1.5 — review bảo mật (`2c718e6`)

AGENTS.md lồng nhau không nạp từ thư mục vendored/bị git ignore; media phải đúng cấu trúc, bị từ chối nếu chứa secret đã đăng ký. `bun test tests/security/read-extended.test.ts tests/end-to-end/read-media.test.ts`: 11 pass, 0 fail.

## W2 — `update_plan` (ADR 0042)

| Lệnh | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| `bun run typecheck && bun run lint` | 0 | — | — | — |
| `bun test tests/end-to-end/plan.test.ts` | 0 | 3 | 0 | 0 |
| `bun test tests` | 0 | 698 | 33 | 0 |

## W3 — `request_user_input` (ADR 0042)

| Lệnh | Exit | Pass | Skip | Fail |
|---|---:|---:|---:|---:|
| `bun run typecheck && bun run lint` | 0 | — | — | — |
| `bun test tests/end-to-end/question.test.ts` | 0 | 5 | 0 | 0 |
| `bun test tests` (trước khi sửa danh sách tool trong `read-tools.test.ts`: 702 pass, 1 fail) | 1 | 702 | 33 | 1 |
| `bun test tests/end-to-end/read-tools.test.ts` (sau khi sửa) | 0 | 6 | 0 | 0 |

## Tiếp quản Claude / W4–W7 — 2026-11-17

Lịch sử review/failure và role split: [continuation](continuation.md).
Bằng chứng web: [web](web.md); thiết kế/giới hạn LSP: [ADR 0043](../../adr/0043-sandboxed-code-intelligence.md).
W5 commit `3628a34`, W6 commit `b1d0192`; W4/W7 và shared fixes/manifests
tích hợp tại `5aca162`. Toàn bộ final gate bên dưới đã xanh.

### Ma trận nghiệm thu theo khả năng thật

| Workstream | Trạng thái | Bằng chứng / phần chưa nghiệm thu |
|---|---|---|
| W0 baseline | VERIFIED LOCAL | Baseline W0 ở trên; không phải live provider evidence |
| W1 quyền Codex | VERIFIED LOCAL, OS-SCOPED | Ma trận policy/regressions; macOS native execution thật. Complex-shell dangerous detection là heuristic, sandbox là ranh giới; Linux chưa xác minh, Windows unavailable |
| W1.5 đọc đầy đủ | IMPLEMENTED, FIXTURE VERIFIED | Text/directory/tail/media/notebook/nested/recovery và wire format; structural media checks không phải full decoder, vision unknown thử gửi là deviation đã ghi ADR |
| W2 plan | IMPLEMENTED, FIXTURE VERIFIED | Schema/invariants, durable restart, checklist/activeForm; nội dung redact trước state callback |
| W3 question | IMPLEMENTED, FIXTURE VERIFIED | Single/multiple/free text/dismiss/cancel/noninteractive/recovery; pending text sanitized, answers không cấp quyền; interrupted dialogs không replay như live request |
| W4 LSP | IMPLEMENTED; TS REAL LOCAL VERIFIED | 9 thao tác fixture; TS7 initialize/definition/rename thật trong Seatbelt; helper permissions/secret/descendant tests thật. Python/Go/Rust và OS khác chưa live verified; error delta chỉ so message/source/code |
| W5 MCP HTTP/search | IMPLEMENTED — NOT LIVE VERIFIED | SDK JSON/SSE, bounded/error/timeout/cancel/retry và 4 provider request shapes bằng local HTTP; không có bằng chứng quota/auth/result-quality provider thật |
| W6 public fetch | IMPLEMENTED — NOT INTERNET/TLS VERIFIED | DNS/IP/redirect-policy fixtures, real pinned HTTP socket/Host, abort/oversize; binary/compression/browser rendering unsupported. Không dùng Internet/TLS fixture để giả bằng chứng live |
| W7 tích hợp | IMPLEMENTED, LOCAL GATE VERIFIED | Guidance theo offered tools, bridge list, contract 1.19, docs/catalog; final typecheck/lint/full/integration/e2e xanh. Benchmark token/quality chưa chạy |

Các trạng thái này không tương đương tuyên bố “PARITY VERIFIED” toàn bộ sản phẩm.
`diagnostics.reported` và general `mcp.server.status` chưa có: diagnostics ở
write receipt/transcript, còn W5 chỉ là search adapter cố định. W8–W13 chưa triển khai.

### Evidence cục bộ đã có trước final gate

| Lệnh / nhóm | Kết quả | Phạm vi chứng minh |
|---|---|---|
| `bun test tests/end-to-end/web-search.test.ts` sau retry fix | exit 0, 8 pass, 33 expects | Local MCP/REST transport fixture; không live provider |
| `bun test tests/security/web-fetch.test.ts` | exit 0, 7 pass, 53 expects | Chính sách/DNS/redirect + actual local HTTP sockets; không live Internet TLS |
| Parent targeted RPC/LSP/redaction/question/read-policy/transcript group | exit 0, 62 pass / 1 skip / 0 fail | Regression/security & local protocol/UI integration |
| `FUTRYN_TEST_REAL_LSP=1 bun test tests/end-to-end/lsp.test.ts -t 'real installed TypeScript LSP'` | exit 0, 1 pass, 6 expects, ~4.3 s | TypeScript 7 thật; native Seatbelt, definition + actual rename receipt/file change |
| Native helper natural-exit descendants | RED → GREEN | Same-PGID descendants được kill trước leader PID release; setsid vẫn unconfirmed |
| Native helper TERM-ignoring descendant | exit 0 | Kill request không để lại child cố tình bỏ qua TERM trong fixture cùng PGID |
| `bun run typecheck`, `bun run lint` sau sửa import/unused/format | exit 0 | Static typing, unused checks, format và diff whitespace |
| Parent grep/read-policy focused gate | exit 0, 15 pass / 0 fail | Builtin worker/ripgrep output filtering; giữ secret-skipped note mà không đọc file bị worker chặn |

Một full run trước final pending-prompt/observer fixes trả 745 pass / 34 skip /
2 fail / 1 unhandled error (781 tests, 80 files, exit 1); không tính pass: một
regression chủ động RED và một baseline independent-ps observer timeout đã tái
hiện isolated rồi sửa test-only đúng-PID, giữ identity/failure checks.

Failure history và baseline independent-ps observer issue được giữ ở
[continuation](continuation.md), không bị viết lại thành pass. Final gate sau
fixes được ghi riêng dưới đây.

### Final gate — exact runs after runtime/test freeze

| Lệnh | Exit | Pass | Skip | Fail | Evidence |
|---|---:|---:|---:|---:|---|
| `bun run typecheck` | 0 | — | — | — | Fresh final pipeline, trước full suite |
| `bun run lint` | 0 | — | — | — | Fresh final pipeline: unused/type/format/diff checks |
| `bun test tests` | 0 | 749 | 34 | 0 | 783 tests / 81 files / 86 365 expects / 187.77 s; không unhandled async error |
| `bun run test:integration` | 0 | 198 | 23 | 0 | 221 tests / 24 files / 1 253 expects / 33.30 s |
| `bun run test:e2e` | 0 | 286 | 11 | 0 | 297 tests / 22 files / 3 053 expects / 131.98 s |
| `bun install --frozen-lockfile --ignore-scripts` | 0 | — | — | — | Checked 144 installs / 163 packages, không đổi lock/source, 35 ms |

Các skip không được tính pass. Trong đó TS LSP thật là test opt-in nên skip ở
hermetic full suite; command opt-in riêng đã pass như bảng phía trên. Cả pipeline
cuối `typecheck → lint → full → integration → e2e` trả exit 0; không thay
runtime/tests sau frozen snapshot. Frozen-lock install xác nhận lock tái dùng được.

Implementation range: **`30f2d8a..5aca162`** (preparation bắt đầu `5f229c7`).
Docs receipt là **this commit**, ngay sau integration `5aca162`. Các commit
W5/W6 dùng source snapshot đang tích hợp; manifest/lock chung được chốt trong
integration, không claim từng commit trung gian tự chạy độc lập. Không push/cleanup;
primary sở hữu việc kiểm tra root rồi fast-forward local `dev`, giữ worktree và
các file HTML của user.
