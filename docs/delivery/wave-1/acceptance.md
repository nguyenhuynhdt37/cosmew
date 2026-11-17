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
