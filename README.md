# Cosmew CLI

Cosmew is a TypeScript/Bun coding-agent harness under development. The **Provider & Authentication slice is implemented and fixture-tested**: persistent providers/accounts, OS keyring or environment-reference authentication, dynamic/manual catalogs, model selection, streamed multi-turn chat and diagnostics. **The full Product MVP is not accepted yet**: commercial generation has not been live-verified, and authenticated-provider/interactive acceptance remains limited. Subscription backend ownership and opt-in rules are described in [ADR 0029](docs/adr/0029-hannes-owned-agent-and-delegated-backends.md).

Repository: [nguyenhuynhdt37/cosmew](https://github.com/nguyenhuynhdt37/cosmew).

Requires Bun **1.4.4**. No application build is required; Bun runs the TypeScript workspace.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run link:cli
# Now available in any project directory:
cosmew
```

The package registers `cosmew` and compatibility aliases `fyn`, `futryn`, and `hannes` in Bun's global bin directory (normally `~/.bun/bin`, which must be on PATH). None changes your working directory: `cd /path/to/project` then run `cosmew`.

Start the full-screen Cosmew interface with `cosmew` in any project folder. From this checkout, use `bun run cosmew`. Approve the current folder for this session, then the app checks the selected account/model with a small request (which may incur cost); select another account or sign in if the check fails. Use `/theme` to select Auto, Dark, or Light; dark/light surfaces retain color for status and syntax. Enter **`/login`** for searchable providers and supported authentication methods, then choose a model and chat. OpenRouter additionally supports its official browser/headless **OAuth PKCE** flow. `/logout` opens account management with Add, Switch, Rename, Reconnect, Remove and sign-out. `/config`, `/theme`, `/model`, `/resume`, `/status`, `/doctor` and `/help` open the corresponding real flows; unsupported backend commands explain their limits. Existing command names remain aliases.

The account/model selection and custom endpoints persist across restart. API keys use the OS keyring or explicit environment references. Failed/cancelled new connections remove their stored credentials. Live authenticated provider acceptance is pending the user's local configuration; fixture, actual PTY and native-keyring evidence is in [Provider Connect acceptance](docs/delivery/provider-connect-acceptance.md), with the [contract/migration decision](docs/adr/0007-provider-connect-and-commands.md).

`bun run cosmew chat` retains the line-oriented wizard described below. Bare interactive `cosmew` opens the TUI; `fyn`, `futryn`, and `hannes` remain aliases.

Trong Cosmew, gõ **`/login`** rồi chọn provider hoặc gateway 9Router. Chọn hãng rồi chọn cách đăng nhập; tên tài khoản được tạo tự động. Subscription dùng browser/device, API key chỉ hỏi key ẩn. URL/protocol chỉ xuất hiện khi chủ động chọn custom endpoint. Gõ **`/logout`** để đăng xuất và tiếp tục ở trong CLI; **`/login <account>`** để đăng nhập lại tài khoản đã lưu. Chưa có tài khoản vẫn mở được Cosmew và dùng `/login`. Các menu nhận số thứ tự, ID hoặc từ khóa lọc models. `/cancel` hủy wizard; Ctrl-C thoát.

```text
cosmew> /login
... chọn provider, nhập URL/model/key theo hướng dẫn ...
cosmew> Xin chào
cosmew> /logout
```

Các lệnh dài bên dưới vẫn có cho scripts; không cần dùng chúng để thiết lập tương tác. `bun run cosmew --help` hiển thị toàn bộ lệnh.

Login prompts for an API key without echo and validates discovery against the provider. A successful model list establishes catalog access, not generation entitlement. `bun run cosmew model doctor --generate` makes a small billable generation check with the selected/default model. Supply valid API credentials; ChatGPT/Claude/Gemini consumer plans do not automatically grant API access.

Custom provider reasoning levels can be declared in the **user-only** `~/.cosmew/config.toml`:

```toml
[model_providers.my_xai]
name = "My xAI"
base_url = "https://api.x.ai/v1"
wire_api = "chat"
env_key = "XAI_API_KEY"

# Optional provider-wide levels:
# [model_providers.my_xai.reasoning]
# efforts = ["low", "high"]

[model_providers.my_xai.reasoning.models."grok-4.7"]
supported = true
efforts = ["low", "high"]
```

The optional `reasoning` table above sets provider-wide effort levels. Per-model declarations override provider defaults; user config overrides discovery. `supported = false` explicitly disables effort selection; absent metadata stays unknown. Lists must contain 1–20 unique strings of 1–40 characters, without whitespace; `default` is reserved. Workspace config is ignored. `/effort` Auto always resets to the provider default; Enter saves, `s` applies only to this session. Anthropic/Gemini have no effort wire mapping. **Needs verification:** whether grok-4.7 accepts the example levels. See [ADR 0078](docs/adr/0078-user-declared-reasoning-efforts.md).

For a gateway such as your 9Router configuration, enter its URL, protocol and model ID:

```sh
bun run cosmew providers add my-9router --url https://your-gateway.example/v1 --protocol responses --catalog manual
bun run cosmew auth login --provider my-9router --alias gateway-main --model your-model-id
bun run cosmew
```

Choose `chat` for Chat Completions, `responses` for Responses, `anthropic` for Messages, or `gemini` for native Gemini. Base URL includes the protocol prefix (usually `/v1`; Gemini `/v1beta`), not `/chat/completions`, `/responses` or `/messages`. For gateways with discovery, use `--catalog openai`/`anthropic`/`gemini`. No fixed 9Router service identity is assumed.

Headless users can reference a secret-manager-injected environment variable by **name**:

```sh
bun run cosmew auth login --provider openrouter --alias main --env OPENROUTER_API_KEY
bun run cosmew models list
bun run cosmew models select <model-id-from-list>
printf 'Explain dependency injection.\n' | bun run cosmew run --json
```

Never put key values in command arguments or repository settings. New installations store state in `~/.cosmew/provider-auth.sqlite`; existing `~/.hannes` state is reused in place. `COSMEW_HOME` overrides the directory (`FUTRYN_HOME` and `HANNES_HOME` remain supported). Credentials keep their legacy keyring identity; credentials are separate OS keyring entries, or environment references only. No plaintext credential fallback. Conversation content is stored locally without database encryption; protect the state directory and disk. Account/provider switching starts fresh context. There is no automatic provider fallback. Workspace reads and approved apply_patch writes are mediated by Cosmew. Shell commands run in the OS sandbox (macOS Seatbelt, Linux bubblewrap).

```sh
bun run typecheck
bun run lint
bun test tests
# Optional OS keyring probes (create and remove disposable test entries):
HANNES_VERIFY_KEYRING=1 bun scripts/verify-keyring.ts
HANNES_TEST_KEYRING=1 bun test tests/end-to-end/provider-cli.test.ts
# Explicit public network checks; no authenticated generation:
HANNES_LIVE_PUBLIC=1 bun scripts/smoke-public-catalogs.ts
```

See [CLI/auth setup and troubleshooting](docs/subsystems/providers-and-auth.md), [provider/auth matrix](docs/compatibility/providers-auth-matrix.md), [architecture audit and plan](docs/delivery/provider-auth-plan.md), [upstream comparison](docs/delivery/provider-auth-research.md), [ADR 0005](docs/adr/0005-provider-auth-product.md), [security review](docs/delivery/provider-auth-security-review.md), and [acceptance evidence](docs/delivery/provider-auth-acceptance.md).

The [original architecture](docs/architecture/system-overview.md), [dependency rules](docs/architecture/dependency-rules.md), [repository map](docs/architecture/repository-map.md) and [roadmap](docs/delivery/implementation-roadmap.md) remain the baseline for future phases. Unrelated packages, MCP/plugins, remote server, unconfined/general process execution and GUI compatibility remain **Not implemented**. The 0-byte placeholder sources were removed; those docs are the plan, not a feature claim.


Current login UX and official subscription transports: [subscription sign-in and verification](docs/delivery/subscription-auth.md). Vendors are grouped once; subscription opens browser/device sign-in, API key asks only for the hidden key, and account names are automatic.

## Continue an interrupted task

In a writable scratch project, choose a direct model backend (`fyn`), then ask: `Create helo.html, a beautiful standalone sales landing page.` Cancel after exploration, then send `tiếp` or `continue`. Cosmew preserves the accepted request and completed tool evidence, requests current write approval, and guides the model to create and read back the artifact. Use `/resume` after restart. Denied writes are not retried automatically; an uncertain write requires filesystem inspection before another mutation. Model capability and credentials still determine live success.

Durable history is retained separately from token-budgeted model context. Extractive checkpoints preserve user constraints, mutation receipts and recent turns; if critical context cannot fit safely, the turn reports a limit. No approval is restored by history, resume or fork. See [recovery architecture](docs/adr/0030-durable-conversation-recovery.md) and [fixture/process acceptance](docs/delivery/conversation-recovery.md).

Rename compatibility: private workspace imports now use `@cosmew/*`; `CosmewError` is the canonical exported error, with `HannesError` retained as the same constructor. Persisted backend IDs (including `hannes`), database schema and authorization rules are unchanged. Historical ADRs retain the old product name. See [ADR 0031](docs/adr/0031-cosmew-project-rename.md).

## Command sandbox

`exec_command` runs in the OS sandbox. `COSMEW_COMMAND_BACKEND=none` turns commands off. The old `docker` value does the same and reports that the container backend was removed ([ADR 0062](docs/adr/0062-remove-docker-command-backend.md)).
