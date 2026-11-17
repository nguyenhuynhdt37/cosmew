# ADR 0049 — Bỏ hẳn Codex app-server runtime: Futryn chỉ gọi API

Date: 2026-11-17. Status: implemented (contract 1.21, SQLite schema v8). Thay thế [ADR 0018](0018-codex-read-tool-bridge.md)
và phần "Codex runtime làm fallback" của [ADR 0045](0045-remove-delegated-and-chat-only-runtimes.md) /
[ADR 0047](0047-chatgpt-direct-api-and-copilot-supergrok-research.md).

## Bối cảnh

Yêu cầu người dùng (2026-11-17): cấm mọi xử lý bên ngoài; Futryn chỉ gọi API và nhận response, và mọi
backend đều phải như vậy.

Trước thay đổi, mọi provider đều chạy backend `hannes` (Futryn giữ vòng lặp và mọi tool), trừ provider
`chatgpt` (`runtime: 'codex'`). Provider này khởi chạy tiến trình `codex app-server`; Codex tự giữ vòng
lặp model, prompt hệ thống và context, Futryn chỉ trả lời các dynamic tool call (`codex-bridge`).

UAT 2026-11-17 cho thấy bridge này còn để Codex tự xử lý: trên codex-cli 0.167.0, Codex bỏ dynamic tool
tên `exec_command` (tên dành riêng) và dùng `apply_patch`/`request_user_input` gốc của nó thay cho bản
Futryn trùng tên (`codex-rs/core/src/tools/registry.rs` `register_external_with_exposure`, openai/codex
@59ac39a; kiểm bằng provider giả ở localhost bắt request `/responses`). `apply_patch` gốc lại không tắt
được bằng config vì do metadata model quyết định.

## Quyết định

Bỏ hẳn Codex runtime. ChatGPT chỉ còn đăng nhập qua API trực tiếp (`chatgpt-api`, OAuth + PKCE,
ADR 0047), chạy backend `hannes` như mọi provider khác.

- Xóa: `apps/cli/src/subscriptions/{host,rpc,runtime-turn,codex-usage,project-context}.ts`,
  `packages/models/src/subscription.ts` (`SubscriptionAdapter`),
  `packages/security/src/subscription-policy.ts`,
  `packages/persistence/src/{runtime-profile,runtime-leases}.ts`, preset `chatgpt`, các phương thức
  đăng nhập `subscription-browser`/`subscription-device`, cùng fixture `tests/subscription-fixtures/`
  và các test của bridge.
- Contract 1.21: bỏ `Provider.runtime`, `SubscriptionRuntime`, `CredentialRef` kind `runtime`,
  `CredentialVault.setRuntime/getRuntime`, `ModelPort.inlineTools` và tham số `executeTool`,
  `InlineToolExecutor`, sự kiện `activity`/`RuntimeActivity`, backend `codex-bridge`, và
  `ContextReport.runtimeHiddenContext`. `executionBackendFor({toolsEnabled})` chỉ còn trả `hannes` hoặc
  `chat-only`; với cả hai, `loopOwner` luôn là `hannes`.
- Core: bỏ đường inline-tool. Một provider stream không bao giờ được báo `toolResult`, nếu có là
  `PROTOCOL`. Mọi lượt đều nhận steering. Bỏ hai giới hạn an toàn `bridgeCallsPerTurn`/`bridgeRefusalGrace`.
- Migration v8 (`migrateRemovedCodexRuntime`): xóa provider `chatgpt` cùng mọi tài khoản có
  `runtime: 'codex'`, kèm catalog, project selection và reasoning preference của chúng; chọn lại tài khoản
  còn dùng được; đưa credential vào `credential_cleanup` để xóa khỏi keyring (lỗi thì thử lại ở lần khởi
  động sau); xóa bảng `runtime_leases`; để lại một thông báo khởi động một lần, hướng dẫn đăng nhập lại
  bằng "ChatGPT subscription · API".
- Khởi động: xóa `<state>/runtime-tmp`, nơi profile Codex bị crash có thể còn để lại `auth.json`. Nếu là
  symlink thì chỉ unlink, không đi theo link.

## Hệ quả

- Không còn tiến trình agent bên ngoài nào. Mọi provider đều là adapter định dạng wire
  (`packages/models/src/providers`); vòng lặp, tool, quyền, sandbox và audit đều thuộc Futryn.
- ChatGPT phụ thuộc hoàn toàn vào đường API trực tiếp, vốn **chưa được kiểm live**. Nếu đường này lỗi với
  một tài khoản thì không còn fallback.
- Cơ sở dữ liệu schema v8 không mở được bằng bản Futryn cũ (bản cũ fail closed với `version > 7`).
