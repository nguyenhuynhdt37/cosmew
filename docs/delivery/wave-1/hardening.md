# Hardening W0–W7 — 2026-11-17

Baseline: `42595b7`. User đã duyệt toàn bộ findings P0–P2. Một coding worker
thay code/tests/docs trong worktree Claude hiện tại; primary điều tra/review và
chạy mọi test/probe. Không đọc/mutate user DB, không chạm `uat-futryn/`, HTML của
user hay root dev; không Docker/bypass security, không push. Public contract giữ
1.19 nếu chỉ sửa hành vi mà không đổi schema/interface.

| Priority | Finding | Nguyên nhân / files / test |
|---|---|---|
| P0 DONE | TS7 pull diagnostics + JSON-RPC shutdown | Server chỉ pull (`diagnosticProvider`) không bao giờ publish nên chờ push hết hạn; `shutdown` gửi `params: null`. Client khai `textDocument.diagnostic`, gọi `textDocument/diagnostic` theo đúng version đã sync, bỏ kết quả cũ, `workspace/diagnostic/refresh`, shutdown không params. Files: `packages/code-intel/src/{client,lsp}.ts`. Tests: `tests/contracts/lsp-pull-diagnostics.test.ts` (cold/warm, stale result, shutdown) |
| P0 DONE | Fetch fallback IPv6 → IPv4 | Chỉ thử `addresses[0]`; IPv6 không route được làm fetch hỏng. Giờ kiểm tra toàn bộ answer (public, đúng family) rồi thử lần lượt trong cùng DNS pin, chỉ khi lỗi kết nối trước response headers; deadline chia đều; huỷ dừng thử tiếp; không resolve lại. Files: `packages/tools/src/runtimes/web-fetch.ts`. Tests: `tests/security/web-fetch.test.ts` (public IPv6 failure falls back..., address fallback never tries a private later answer..., black-holed first connection..., cancellation while trying..., fallback connections remain pinned...) |
| P0 DONE | Dangerous command fail closed | Script không parse/ambiguous (wrapper option lạ, `bash -ec`, `eval`, `xargs`...) chạy không hỏi dưới `on-request`/`never`. Giờ `unverified-command` (kind dangerous: hỏi / bị từ chối dưới `never`); wrapper grammar allowlist dùng chung. Files: `packages/security/src/{approvals,tool-policy}.ts`, ADR 0040. Tests: `tests/security/approval-policy.test.ts` (wrapper options..., on-request: unparsed/ambiguous..., opaque, malformed and uninspected interpreter...) |
| P0 DONE | Cargo credentials/config trong sandbox | `toolchainDirectories` mở cả cha của `~/.cargo/bin` (= `~/.cargo`, gồm `credentials*`, `config*`). Giờ chỉ mở `~/.rustup/toolchains`, `settings.toml`, `~/.cargo/bin`, `~/.cargo/registry` (read-only); `CARGO_HOME` là thư mục scratch của runtime chỉ symlink `bin`, `registry`; `credentials`, `credentials.toml`, `config`, `config.toml` bị deny literal bất kể `FUTRYN_SANDBOX_HIDE_SECRETS`, kể cả cargo root tuỳ biến trên PATH; `~/.rustup` chỉ cho stat. Policy id `v2`. Files: `packages/tools/src/exec/{native,seatbelt-profile}.ts`. Tests: `tests/security/native-path-hardening.test.ts` (cargo credentials and config are unreadable...; a PATH-exposed cargo root...). Giới hạn: registry read-only nên cargo ghi cache sẽ lỗi; Linux bwrap không đổi (không kiểm chứng) |
| P1 DONE | Canonical workspace/state roots | Symlink alias của workspace/state được resolve một lần, cấp quyền theo đường thật; retarget alias sau khởi tạo đóng admission. Files: `packages/tools/src/exec/native.ts`. Tests: `native-path-hardening.test.ts` (canonicalizes a symlink workspace; symlink state directory; retargeting) |
| P1 DONE | rust-analyzer / rustup shim trong Seatbelt | Xem mục cargo: shim chạy với `RUSTUP_HOME` + scratch `CARGO_HOME` mà không mở HOME. Test thật: `rustup toolchain shims run inside Seatbelt...` (cần rustup cài sẵn, skip nếu không) |
| P2 DONE | Directory listing symlink containment | Symlink trỏ tới `.git`, state hoặc ngoài workspace bị ẩn khỏi listing. Files: `packages/tools/src/builtin/read.ts`. Test: `tests/security/read-extended.test.ts` (directory listing omits symlinks...) |
| P2 DONE | Nested-instruction UTF-8 byte budget | `slice` tính UTF-16 unit nên vượt 60 KB byte và có thể cắt giữa code point. `fitUtf8Prefix`. Files: `apps/cli/src/bootstrap/{utf8,startup}.ts`. Tests: `tests/security/hardening-regressions.test.ts` (nested instruction budget...), `tests/end-to-end/read-media.test.ts` (nested UTF-8 instructions near the 60 KB cap) |
| P2 DONE | Approval reason strings + dependency catalog | `unverified-command`, `project-read-rule`, `web-fetch` hiện mã thô. Test duyệt mọi reason của policy. Catalog Wave 1 trong `docs/delivery/provider-auth-dependencies.md`. Test: `hardening-regressions.test.ts` (every ask reason...) |

Mỗi mục ghi nguyên nhân, files, RED → GREEN và giới hạn khi có bằng chứng.
Skip không phải pass; fixture không chứng minh live/OS compatibility. Existing
agent loop, terminal, policy/containment, MCP/LSP contracts, TUI và persistence
được giữ; chỉ sửa findings đã duyệt. Source/runtime freeze trước final gate.
