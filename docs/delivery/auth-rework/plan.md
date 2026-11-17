# Làm lại đăng nhập + provider bất kỳ — kế hoạch

Ngày lập: 2026-11-17. Trạng thái: **đã duyệt 2026-11-17** — user đồng ý Q1–Q4 theo đề xuất và yêu cầu provider tuỳ chỉnh add được các gateway kiểu 9Router. Vai: Opus lên brief và duyệt bảo mật; Sonnet viết code; Haiku chạy test (effort `medium`).

## 0. Mục tiêu

Mọi model Futryn dùng đều chạy **agent loop của Futryn** (backend `hannes`: tool, sandbox, quyền, LSP của Futryn). Không còn chế độ chat-only vô dụng hay `delegated`. Người dùng nối được **provider bất kỳ** bằng cấu hình host (URL, giao thức, header, khoá), như `model_providers` của Codex.

## 1. Hiện trạng và bằng chứng

- 5 runtime subscription (`packages/contracts/src/models.ts:18`, `executionBackendFor` dòng 500): chỉ `codex` có tool Futryn (`codex-bridge`); `copilot`, `gemini-cli`, `qwen-code`, `grok-build` là `chat-only` trừ khi `/backend delegated` (tool riêng của runtime, ngoài sandbox Futryn).
- UAT 2026-11-17 với `grok-subscription`: 5 lượt, 0 tool call; status báo `toolsEnabled: true` + 15 tool trong khi backend `chat-only` (lỗi hiển thị).
- Provider tuỳ chỉnh hiện có: `providerSchema` = `{protocol: chat|responses|anthropic|gemini, baseURL, auth: api-key|none, catalog, timeoutMs, streamIdleTimeoutMs, streamUsage}`; thêm bằng `fyn providers add`. Không có header, query param, env header, retry riêng, lệnh lấy token, file cấu hình.
- Codex `model-provider-info/src/lib.rs` (pin `090be4d`): `name, base_url, env_key, env_key_instructions, wire_api, query_params, http_headers, env_http_headers, request_max_retries, stream_max_retries, stream_idle_timeout_ms, auth (lệnh lấy token), model_catalog_url, requires_openai_auth`.
- OpenCode main `0ac0d7e` `packages/core/src/plugin/provider/`:
  - `chatgpt.ts`: "Sign in with ChatGPT" — OAuth `https://auth.openai.com`, client đăng ký động (`dynamic_agent_client`), scope `chatgpt.tokens.use.direct`, gọi `https://api.openai.com/v1`.
  - `github-copilot.ts`: device code GitHub → `api.githubcopilot.com` (OpenAI-compatible).
  - `xai.ts`: "SuperGrok Subscription" — `https://auth.x.ai/oauth2`, device/browser, scope `grok-cli:access api:access` → `api.x.ai/v1`; dùng client ID của OpenCode.
- DeepSeek: OpenCode `packages/ai/src/protocols/openai-chat.ts` luôn gửi lại `reasoning_content` trên tin nhắn assistant cho DeepSeek (dòng 663-668, 569-579), dùng `max_tokens`, cache ở `prompt_cache_hit_tokens`; `schema/options.ts` timeout chunk 15 phút theo yêu cầu DeepSeek. DeepSeek Harness (`39163dd`): API key (`x-api-key`) hoặc đăng nhập tài khoản Platform qua `harness.deepseek.com` (client riêng của DSH; trừ ví Platform, không phải subscription).

## 2. Quyết định cần user chốt

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q1 | Gỡ runtime Gemini CLI, Qwen Code, Copilot CLI, Grok Build? Tài khoản đang có thì sao? | Gỡ. Lần khởi động sau: thông báo, đăng xuất và xoá credentials/profile của các tài khoản đó; tài khoản mặc định chuyển sang tài khoản còn dùng được |
| Q2 | ChatGPT: thay `codex-bridge` bằng API thuần hay giữ cả hai? | Thêm API thuần làm mặc định; giữ `codex-bridge` như lựa chọn dự phòng tới khi API thuần được thử thật, rồi gỡ |
| Q3 | Định dạng cấu hình host | `~/.futryn/config.toml`, bảng `[model_providers.<id>]` dùng đúng tên trường Codex (Bun đọc TOML sẵn, không thêm dependency) |
| Q4 | Copilot, SuperGrok | Làm bước xác minh trước (A5); chỉ code khi có client ID hợp lệ của Futryn hoặc người dùng tự cung cấp client ID của họ |

## 3. Workstreams

### A1 — Gỡ `delegated` (S)
Gỡ backend `delegated`, `/backend delegated`, `setDelegatedAgent`, ADR 0027 permission routing cho runtime, nhánh trong `executionBackendFor`, TUI, docs; test cũ của delegated chuyển thành test "không thể bật". Ghi ADR thay thế ADR 0029 phần delegated.

### A2 — Gỡ runtime chat-only + migration (M)
Gỡ provider `github-copilot` (runtime CLI), `google-subscription`, `qwen-subscription`, `grok-subscription` và code runtime tương ứng (`apps/cli/src/subscriptions/*` phần ACP/Copilot, `packages/models/src/subscription.ts`, `packages/security/src/subscription-policy.ts` phần liên quan). Migration persistence: tài khoản có `providerId` bị gỡ → xoá credential vault + profile runtime, xoá account, ghi thông báo một lần; nếu là tài khoản active → chọn tài khoản hợp lệ khác hoặc mở `/login`. Test: migration trên DB có các tài khoản đó; credentials thật sự bị xoá; tài khoản khác không đổi.

### A3 — Cấu hình host cho provider bất kỳ (M–L)
- File `~/.futryn/config.toml` (theo `FUTRYN_HOME`), **chỉ cấp người dùng**; config trong repo không được khai báo provider (tránh repo lạ chuyển prompt tới host của kẻ tấn công hoặc chạy lệnh lấy token).
- `[model_providers.<id>]`: `name`, `base_url` (https; http chỉ cho loopback), `wire_api` = `chat|responses|anthropic|gemini`, `env_key`, `env_key_instructions`, `query_params`, `http_headers` (không chứa secret — từ chối giá trị trông như token), `env_http_headers`, `request_max_retries`, `stream_max_retries`, `stream_idle_timeout_ms`, `models` (danh sách tay) hoặc `model_catalog_url`, `[model_providers.<id>.auth] command/args/timeout_ms` (lệnh lấy bearer token, chạy trực tiếp không qua shell, ngoài sandbox vì là cấu hình của chính người dùng; output không log; cache theo thời hạn).
- Không cho token dạng chữ trong file (luật "không plaintext credential"); khoá API dùng `env_key` hoặc keyring (`fyn auth login --provider <id>`).
- Nạp lúc khởi động vào registry với nguồn `config`; lỗi cấu hình hiện trong `/doctor` và `fyn providers list`, không chặn khởi động; giới hạn retry/timeout theo Codex.
- Adapter: áp `query_params`, `http_headers`, `env_http_headers` cho mọi request (cả catalog); redact header trong log.
- TUI `/login` thêm "Provider tuỳ chỉnh": form base URL, giao thức, cách xác thực (API key → keyring / env / none), nút thử kết nối, ghi vào `config.toml`. `fyn providers add` ghi cùng chỗ.
- **Gateway/router (9Router, OpenRouter-like, LiteLLM, one-api…)**: phải add được chỉ bằng cấu hình: base URL có path prefix (vd. `https://host/v1` hoặc `https://host/api/openai`), header tuỳ chỉnh, liệt kê model động qua `GET {base_url}/models` của gateway (hoặc `models` tay), tên model có tiền tố/slash (`provider/model`). Preset `router9` hiện có (`packages/models/src/providers/router9.ts` đang rỗng) chuyển sang dạng cấu hình host thay vì code riêng.
- Test: parse/validate (field lạ, URL http không loopback, header có token), merge với preset, header/query đến đúng request (fixture server), một gateway giả kiểu 9Router (path prefix + header + `/models` + tên model `vendor/model`) chạy được một lượt agent có tool, lệnh token chạy không qua shell và timeout, config trong repo bị bỏ qua, `/doctor` báo lỗi.

### A4 — ChatGPT API thuần (M)
- Đăng nhập "Sign in with ChatGPT": OAuth `auth.openai.com` + PKCE, đăng ký client động của Futryn (không dùng client của OpenCode/Codex), scope `chatgpt.tokens.use.direct`, refresh token trong keyring; gọi `https://api.openai.com/v1` (Responses) như API key → backend `hannes`.
- Chi tiết endpoint đăng ký/token lấy từ `chatgpt.ts` của OpenCode → **Needs verification** bằng một lần đăng nhập thật; nếu đăng ký động không chấp nhận client mới → dừng, báo user.
- Giữ `codex-bridge` theo Q2.
- Test: luồng OAuth với server giả (PKCE, callback, hủy giữa chừng xoá credential), refresh, 401 → yêu cầu đăng nhập lại.

### A5 — Copilot / SuperGrok: xác minh rồi mới làm (S nghiên cứu, M nếu làm)
- Nghiên cứu điều khoản và cách cấp client: GitHub (client bên thứ ba dùng Copilot API, OAuth App), xAI (`auth.x.ai` có cho đăng ký client không). Ghi kết quả vào ADR với nguồn.
- Nếu có đường hợp lệ: provider OAuth device/browser → API thuần như A4. Nếu chỉ dùng được với client ID do người dùng tự đăng ký: cho nhập client ID trong `config.toml` (`[model_providers.x.oauth] client_id=...`). Không dùng client ID của OpenCode.

### A6 — DeepSeek (S–M)
- Preset `deepseek`: `https://api.deepseek.com`, giao thức `chat`, API key, `stream_idle_timeout_ms = 900000`.
- Contract: lưu phần suy nghĩ của assistant theo tin nhắn (`reasoning` tuỳ chọn, redact, không hiển thị lại) để adapter gửi lại `reasoning_content` cho provider yêu cầu (DeepSeek; cờ `replayReasoning` theo provider/preset hoặc `config.toml`).
- Usage: đọc `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.
- Test: fixture server kiểm tra `reasoning_content` có trong request lượt sau khi có tool call; usage cache; timeout. Live (nếu user có key) sau `FUTRYN_LIVE_DEEPSEEK=1`.

### A7 — Status/UX và dọn dẹp (S)
- Sửa lỗi UAT: status chỉ liệt kê tool khi backend thật sự dùng tool Futryn; `toolsEnabled` phản ánh backend.
- `/login` sắp xếp: API key (OpenAI, Anthropic, Gemini, OpenRouter, xAI, DeepSeek, Ollama), subscription (ChatGPT; Copilot/SuperGrok nếu A5 đạt), Provider tuỳ chỉnh.
- Docs: `CLAUDE.md`, `AGENTS.md`, `docs/delivery/subscription-auth.md`, ADR mới (0045: gỡ delegated + runtime chat-only; 0046: cấu hình host; 0047: ChatGPT/Copilot/SuperGrok API thuần; 0048: DeepSeek reasoning replay).

### A8 — Nghiệm thu (Haiku)
`typecheck`, `lint`, `bun test tests`, `test:integration`, `test:e2e`; RED check cho test bảo mật; UAT thật: chạy lại kịch bản Next.js (`scratchpad/uat/nextjs-prompts.txt`) bằng một tài khoản backend `hannes` (xAI API key hoặc ChatGPT API thuần sau A4).

## 4. Thứ tự

A1 → A2 → A7 (status) → A3 → A6 → A4 → A5 → A7 (UX, docs) → A8. Mỗi bước một commit, không push.

## 5. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Xoá nhầm credentials | migration chỉ chạm providerId bị gỡ; test trên DB thật dạng fixture; thông báo rõ |
| Config host bị lạm dụng (repo độc hại) | chỉ cấp người dùng; không plaintext token; lệnh token không qua shell |
| Đăng ký client OpenAI/GitHub/xAI không như OpenCode | bước xác minh, dừng và báo nếu không hợp lệ; không mạo danh client khác |
| DeepSeek đổi yêu cầu replay | cờ theo provider, test fixture; live test riêng |
