# Hannes CLI

Hannes is a TypeScript/Bun coding-agent harness under development. The **Provider & Authentication slice is implemented and fixture-tested**: persistent providers/accounts, OS keyring or environment-reference authentication, dynamic/manual catalogs, model selection, streamed multi-turn chat and diagnostics. **The full Product MVP is not accepted yet**: commercial generation has not been live-verified, and subscription/delegated-agent integrations remain Not implemented.

Requires Bun **1.4.4**. No application build is required; Bun runs the TypeScript workspace.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run hannes
```

Trong Hannes, gõ **`/login`** rồi chọn provider hoặc gateway 9Router. Wizard hỏi URL/protocol nếu cần, nhập key ẩn, kiểm tra kết nối và chọn model ngay tại chỗ. Gõ **`/logout`** để đăng xuất và tiếp tục ở trong CLI; **`/login <account>`** để đăng nhập lại tài khoản đã lưu. Chưa có tài khoản vẫn mở được Hannes và dùng `/login`. Các menu nhận số thứ tự, ID hoặc từ khóa lọc models. `/cancel` hủy wizard; Ctrl-C thoát.

```text
hannes> /login
... chọn provider, nhập URL/model/key theo hướng dẫn ...
hannes> Xin chào
hannes> /logout
```

Các lệnh dài bên dưới vẫn có cho scripts; không cần dùng chúng để thiết lập tương tác. `bun run hannes --help` hiển thị toàn bộ lệnh.

Login prompts for an API key without echo and validates discovery against the provider. A successful model list establishes catalog access, not generation entitlement. `bun run hannes model doctor --generate` makes a small billable generation check with the selected/default model. Supply valid API credentials; ChatGPT/Claude/Gemini consumer plans do not automatically grant API access.

For a gateway such as your 9Router configuration, enter its URL, protocol and model ID:

```sh
bun run hannes providers add my-9router --url https://your-gateway.example/v1 --protocol responses --catalog manual
bun run hannes auth login --provider my-9router --alias gateway-main --model your-model-id
bun run hannes
```

Choose `chat` for Chat Completions, `responses` for Responses, `anthropic` for Messages, or `gemini` for native Gemini. Base URL includes the protocol prefix (usually `/v1`; Gemini `/v1beta`), not `/chat/completions`, `/responses` or `/messages`. For gateways with discovery, use `--catalog openai`/`anthropic`/`gemini`. No fixed 9Router service identity is assumed.

Headless users can reference a secret-manager-injected environment variable by **name**:

```sh
bun run hannes auth login --provider openrouter --alias main --env OPENROUTER_API_KEY
bun run hannes models list
bun run hannes models select <model-id-from-list>
printf 'Explain dependency injection.\n' | bun run hannes run --json
```

Never put key values in command arguments or repository settings. Default state is `~/.hannes/provider-auth.sqlite`; credentials are separate OS keyring entries, or environment references only. No plaintext credential fallback. Conversation content is stored locally without database encryption; protect the state directory and disk. Account/provider switching starts fresh context. There is no automatic fallback or shell/filesystem tool execution.

```sh
bun run typecheck
bun test tests
# Optional OS keyring probes (create and remove disposable test entries):
HANNES_VERIFY_KEYRING=1 bun scripts/verify-keyring.ts
HANNES_TEST_KEYRING=1 bun test tests/end-to-end/provider-cli.test.ts
# Explicit public network checks; no authenticated generation:
HANNES_LIVE_PUBLIC=1 bun scripts/smoke-public-catalogs.ts
```

See [CLI/auth setup and troubleshooting](docs/subsystems/providers-and-auth.md), [provider/auth matrix](docs/compatibility/providers-auth-matrix.md), [architecture audit and plan](docs/delivery/provider-auth-plan.md), [upstream comparison](docs/delivery/provider-auth-research.md), [ADR 0005](docs/adr/0005-provider-auth-product.md), [security review](docs/delivery/provider-auth-security-review.md), and [acceptance evidence](docs/delivery/provider-auth-acceptance.md).

The [original architecture](docs/architecture/system-overview.md), [dependency rules](docs/architecture/dependency-rules.md), [repository map](docs/architecture/repository-map.md) and [roadmap](docs/delivery/implementation-roadmap.md) remain the baseline for future phases. Unrelated packages, general tool execution, MCP/plugins, TUI/server, recovery and GUI compatibility are **Not implemented**. Empty source placeholders are not feature evidence.
