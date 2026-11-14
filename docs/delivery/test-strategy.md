# Chiến lược kiểm thử

**Not implemented.** Phase 0 chỉ filesystem/content/link inspection; mọi test suite dưới đây được viết/chạy ở phase triển khai được giao. tests và testkit hiện là placeholders rỗng.

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

Runner chưa chọn giữa Bun Test/Vitest; Bun native/parser/TUI và SDK/OAuth phải có interoperability probes trước pin. Playwright chỉ cho web/desktop-renderer surfaces phù hợp, không thay native terminal/OS sandbox tests. Coverage percent không là exit gate; bắt buộc mapped invariants, negative tests và unresolved-risk report. Các gate từng phase ở [roadmap](implementation-roadmap.md); feature status chỉ cập nhật sau implementation và evidence review.


## Executable PA1 evidence

Provider/auth tests now run with Bun 1.4.4 (`bun test tests`); typecheck is separate (`bun run typecheck`). Contract tests cover strict schemas, registry, account selection/rotation, metadata, actual deterministic HTTP adapters and routing. Security tests cover failure/secret/redirect/partial-stream cases. End-to-end tests launch the actual CLI as subprocesses, including streaming before terminal completion, SIGINT exit 130, multiple native protocols and account isolation. Optional `HANNES_TEST_KEYRING=1` runs the real OS credential backend; ordinary CI does not pretend an in-memory test vault proves keychain compatibility. Production never imports the test memory vault.

The opt-in public catalog script contacts OpenRouter and Models.dev only; it is not generation/auth evidence. Live paid API smoke tests use `model doctor --generate` with user-supplied real API credentials and record provider/model/date/runtime without prompts/keys. [Acceptance evidence](provider-auth-acceptance.md) gives exact counts and blocked live checks. No tests for other planned subsystems are claimed implemented.

Interactive authentication follow-up: executable subprocess tests cover fresh signed-out startup, guided URL/provider/model setup, `/login`, `/logout`, stable-ID relogin, saved credentials, model search, cancellation/failed auth and no cross-login context transfer. A POSIX PTY test cancels at the hidden key prompt and asserts exit 130 without credential creation/network traffic. The opt-in native-keyring PTY test checks masked key entry and terminal-history isolation, then actual chat and logout within one process. These are terminal/backend tests against deterministic provider HTTP fixtures, not commercial live-model evidence.
