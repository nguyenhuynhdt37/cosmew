# ADR 0026 — xAI Grok API key và SuperGrok subscription qua Grok Build

Accepted 2026-11-15 theo yêu cầu của người dùng "cấu hình login bằng grok api + subscription". Phần chat-only/`deny = ["*"]` chỉ còn áp dụng khi chưa có folder consent; sau consent vẫn là chat-only, trừ khi người dùng opt-in delegated ([ADR 0029](0029-hannes-owned-agent-and-delegated-backends.md)). Mở rộng ADR 0005/0007 (preset API) và ADR 0008 (subscription runtime chính thức); không thay đổi ADR 0017/0018 (tool chỉ đi qua Hannes, runtime subscription không có tool).

## Quyết định

1. **API key** — preset `xai` (`https://api.x.ai/v1`, protocol `chat`, catalog `openai`, `streamUsage: true`). Dùng lại adapter OpenAI-compatible, keyring/env reference như mọi provider API key; không có fallback plaintext. xAI Chat Completions hỗ trợ `stream_options.include_usage` (chunk usage trước `[DONE]`). Responses API của xAI được khuyến nghị cho tích hợp mới nhưng chưa được chọn ở đây: chuyển protocol cần kiểm chứng live riêng.
2. **Subscription** — runtime `grok-build` (provider `grok-subscription`, baseURL định danh `https://api.x.ai`) giao cho CLI chính thức `grok` qua ACP: `grok agent --no-leader stdio`, auth method `grok.com` (OAuth trình duyệt của xAI tại `auth.x.ai`). Không tự cài OAuth client của xAI, không mượn client ID của bên thứ ba, không import `~/.grok/auth.json` có sẵn.
3. Cả hai cùng `family: 'xai'`, nên `/login` hiển thị một nhóm "xAI Grok" với các phương thức: Sign in with Grok, API key, Environment variable.

## Cô lập runtime

- Profile riêng mỗi thao tác: `GROK_HOME=<profile>` và `HOME=<profile>` (Grok quét `~/.claude`, `~/.cursor`, rules theo `$HOME`). Chỉ `auth.json` được lưu/khôi phục qua vault OS.
- `config.toml` cố định: `permission.deny = ["*"]` (rule `*` khớp mọi tool, kể cả read-only tool vốn được tự duyệt ở mọi mode), `disable_web_search`, `features.backend_tools/web_fetch = false`, subagents/memory/managed MCP/relay/campaigns/telemetry/trace upload/error reporting tắt, compat Claude/Codex/Cursor (hooks, MCP, rules, skills, agents) tắt.
- Env: `GROK_DISABLE_AUTOUPDATER=1`, `GROK_DISABLE_EXPERIMENTS=1`, `GROK_CAMPAIGNS=0`, `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`, `DISABLE_ERROR_REPORTING=1`; không truyền `XAI_API_KEY`.
- Client không quảng bá capability filesystem/terminal ACP; `session/request_permission` bị huỷ; mọi `tool_call` trong `session/update` làm lượt chat thất bại với `POLICY`; request `x.ai/*` từ agent bị từ chối như mọi request lạ.
- Contract 1.11: thêm giá trị `grok-build` vào `subscriptionRuntimeSchema` (additive). Reader cũ gặp runtime ref `grok-build` sẽ fail closed khi parse.

## Bằng chứng và giới hạn

- Nguồn: user guide đi kèm Grok Build 1.0.77 (`~/.grok/docs/user-guide/02-authentication.md`, `05-configuration.md`, `15-agent-mode.md`, `22-permissions-and-safety.md`, `26-config-reference.md`), truy cập 2026-11-15; `grok --help`, `grok agent --help`, `grok login --help` cùng phiên bản. Trang https://x.ai/cli trả 403 cho fetch tự động; https://docs.x.ai/developers/rest-api-reference/inference/chat-completions.md cho `include_usage`.
- Probe cục bộ (GROK_HOME tạm, chưa đăng nhập): `initialize` trả `protocolVersion: 1`, `authMethods: [{id: "grok.com"}]`, danh sách model trong `_meta.modelState.availableModels`; `session/new` khi chưa đăng nhập trả `-32000 Authentication required`; `grok inspect` xác nhận config profile được nạp, 1 permission rule, compat tắt, `config.toml` được giữ nguyên (CLI chỉ nối thêm khoá `[marketplace]`).
- **Needs verification**: shape model trong phản hồi `session/new` khi đã đăng nhập (host chấp nhận `models`, `_meta.models` và `_meta.modelState`); luồng `authenticate` có phát URL qua stderr/`authenticate/update` hay tự mở trình duyệt; chặn tool phía server (X search `toolOverrides`) với `backend_tools = false`; entitlement theo gói (nguồn thứ cấp báo SuperGrok/X Premium+ từ 2026-05-25, và OAuth API của xAI có allowlist riêng có thể trả 403). Fixture CI không chứng minh tương thích vendor; chưa có xác minh live có xác thực.
