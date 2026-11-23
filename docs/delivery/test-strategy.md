# Chiến lược kiểm thử

Các bảng Phase 0 bên dưới là kế hoạch lịch sử. Gate thực thi hiện tại nằm ở phần tiếp theo; suite thật nằm ở `tests/`, `apps/` và `packages/`. `packages/testkit` (placeholder 0 byte) đã xoá 2026-11-18.

| Lớp | Owner/location | Invariants | Bằng chứng exit |
|---|---|---|---|
| Contracts | tests/contracts, packages/testkit | Schema roundtrip, version negotiation, IDs/order, unknown fields | Fixture revisions và generated cases có seed |
| Core/models | Package-level tests được bổ sung sau | State transitions, budget, fragment assembly, retries/cancel | Fake model scripts + selected live provider fixture opt-in |
| Storage/recovery | Persistence/core | Atomic event/state, fencing, no blind replay | Fault injection tại từng intent/effect/result boundary |
| Security | tests/security | Permission mandatory, path/symlink, revoke/approval races | Negative cases fail closed trên supported OS |
| MCP | tests/compatibility | Initialize/capability, transports, OAuth, malformed output | Official SDK fixture servers; protocol/package pins |
| OpenCode | tests/compatibility | V1/V2/host/hook/SDK/RPC semantics | Differential traces upstream/Hannes theo capability |
| Cordis | tests/compatibility | DI/fiber/effects/event modes/profiles/reload | Vendored/fork/upstream baselines, leak detection |
| Interfaces | tests/end-to-end | CLI exit/cancel, TUI reconnect/approval, auth | User-visible flows trên thật host/runtime |
| Subagents/sandbox | tests/security, tests/end-to-end | Budget reserve, child scopes, process isolation | Adversarial platform matrix và crash scenarios |

Fakes testkit mô tả model stream fragments, clock/deadlines, storage fault points và tool receipts; không được fake permission success làm bằng chứng sandbox. Contract fakes không import production internals. Property tests dùng fast-check candidate cho paths, event ordering, replay/idempotency và permission scope intersections. Không viết tests chỉ mirror implementation hoặc snapshot toàn file output dễ biến động.

Conformance fixture metadata: ecosystem, host version, package/API commit, OS/runtime, config hash, supported capability, input, expected ordered events/results/cleanup, license/provenance, known deviations. Chạy upstream baseline và Hannes với cùng fixture trong môi trường được phép; compare semantic fields, normalize volatile IDs/timestamps. Plugin import thành công, typecheck pass hay screenshot không đủ chứng minh behavior parity. GUI requires desktop host/window/main fixtures riêng; server pass không cover GUI.

Failure matrix bắt buộc: provider drop trước/sau tool fragments; store disk-full trước approval/intent/result; crash sau side effect trước receipt; client disconnect trong approval; revoke giữa evaluate/execute; plugin fail giữa registrations; MCP crash/timeout với outcome unknown; LSP stale generation; two resume writers; Unicode/symlink/case-insensitive paths.

Determinism: seeded generators, fake clocks cho retries, event cursors và writer epochs. Integration tests dùng temporary workspaces và disposable identities, never production secrets. Live provider tests opt-in/capped budget và redacted recordings; fixture captures không chứa auth headers hoặc private repository content.

Runner hiện tại là Bun Test 1.4.4; Bun native/parser/TUI và SDK/OAuth phải có interoperability probes trước pin. Playwright chỉ cho web/desktop-renderer surfaces phù hợp, không thay native terminal/OS sandbox tests. Coverage percent không là exit gate; bắt buộc mapped invariants, negative tests và unresolved-risk report. Các gate từng phase ở [roadmap](implementation-roadmap.md); feature status chỉ cập nhật sau implementation và evidence review.


## Executable PA1 evidence

Provider/auth tests now run with Bun 1.4.4 (`bun run test`); the unified gate is `bun run quality` (typecheck, lint, then tests). Contract tests cover strict schemas, registry, account selection/rotation, metadata, actual deterministic HTTP adapters and routing. Security tests cover failure/secret/redirect/partial-stream cases. End-to-end tests launch the actual CLI as subprocesses, including streaming before terminal completion, SIGINT exit 130, multiple native protocols and account isolation. Optional `HANNES_TEST_KEYRING=1` runs the real OS credential backend; ordinary CI does not pretend an in-memory test vault proves keychain compatibility. Production never imports the test memory vault.

The opt-in public catalog script contacts OpenRouter and Models.dev only; it is not generation/auth evidence. Live paid API smoke tests use `model doctor --generate` with user-supplied real API credentials and record provider/model/date/runtime without prompts/keys. [Acceptance evidence](provider-auth-acceptance.md) gives exact counts and blocked live checks. No tests for other planned subsystems are claimed implemented.

Interactive authentication follow-up: executable subprocess tests cover fresh signed-out startup, guided URL/provider/model setup, `/login`, `/logout`, stable-ID relogin, saved credentials, model search, cancellation/failed auth and no cross-login context transfer. A POSIX PTY test cancels at the hidden key prompt and asserts exit 130 without credential creation/network traffic. The opt-in native-keyring PTY test checks masked key entry and terminal-history isolation, then actual chat and logout within one process. These are terminal/backend tests against deterministic provider HTTP fixtures, not commercial live-model evidence.


## Gate thực thi hiện tại (2026-11-22)

`bun run quality` chạy tuần tự typecheck, lint (unused checks, Prettier và
`git diff --check`), rồi `bun run test`. Test mặc định chạy `bun test tests apps
packages`, bao gồm CLI bootstrap và TUI/editor tests trong apps, cùng mọi test
package được thêm sau này. Gate dừng với exit code khác 0 nếu bất kỳ bước nào
thất bại; không chuyển failure thành acceptance. Không có dependency mới.

| Entry point | Phạm vi và điều kiện |
| --- | --- |
| `bun run test` | Tất cả product roots; native/PTY chạy khi host hỗ trợ, live generation và keyring bỏ qua |
| `bun run test:native` | Security suite và native-agent/exec/headless/LSP; gồm sandbox bật/tắt, cancellation, restart và fail-closed; test riêng báo skip khi host thiếu capability |
| `bun run test:pty` | CLI Ink PTY và synthetic native PTY; resize, alternate screen, consent, permission, cancellation/exit; POSIX host |
| `bun run test:integration` / `bun run test:e2e` | Rerun có mục tiêu; không thay thế quality gate |
| `bun run test:live` | Chỉ subagent provider acceptance, cần đồng thời `COSMEW_LIVE_SUBAGENTS=1` và `COSMEW_LIVE_SUBAGENTS_STATE`; có thể tính phí |

Runner xoá opt-in live kể cả khi shell cha đã đặt nó cho mọi tier thường; live
không chạy trong quality hay CI. Fixture live phải là thư mục state dùng một lần
trong OS temp (test kiểm tra realpath), được chuẩn bị chủ động với account/model
và budget. Không dùng state hay credentials của phiên người dùng. Kiểm tra OS
keyring vẫn là lệnh manual riêng được mô tả trong acceptance PA1; runner thường
xoá `HANNES_TEST_KEYRING`. `FUTRYN_TEST_REAL_LSP=1` là probe cài đặt LSP opt-in,
không phải bằng chứng generation.

`tests/preload.ts` giữ HOME/state tạm và backend mặc định `none`; từng test native
chủ động tạo runtime thật. Child CLI phải override `COSMEW_HOME` cùng các alias
legacy khi cần state fixture riêng (regression MCP đã sửa). Guard hash/metadata
state thật trước/sau test luôn giữ nguyên: failure phải điều tra nguồn ghi, không
restore DB, tắt guard hay coi mọi thay đổi là từ tiến trình ngoài. Kiểm tra grep
child env/default-state và focused MCP run không tìm thêm đường ghi real-state;
điều đó không chứng minh toàn bộ suite không còn leak.

`.github/workflows/quality.yml` định nghĩa cùng quality gate trên macOS và Linux,
locked install Bun 1.4.4, và ghi revision/runtime/OS. Đây là cấu hình CI, chưa phải
bằng chứng workflow đã chạy. Seatbelt tests chạy thật trên macOS có sandbox-exec;
nhiều native tests hiện chỉ hỗ trợ macOS và skip trên Linux. Linux bubblewrap
live containment còn **Needs verification**; matrix xanh với skip không chứng
minh capability này. PTY không thay thế nghiệm thu terminal vật lý.

Release/UAT phải ghi commit, trạng thái dirty, đường dẫn executable đang chạy,
SHA-256 của artifact/source bundle và runtime; đối chiếu với source đã test trước
khi nghiệm thu, nhất là external-cwd consent. CI source checks không chứng minh
binary đã cài được cập nhật. Chưa có installed-binary hash/release hoặc commercial
live-provider acceptance trong thay đổi gate này; không tuyên bố Product MVP complete.
