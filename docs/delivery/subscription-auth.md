# Subscription authentication and simplified login

2026-11-14. [ADR 0008](../adr/0008-subscription-runtime-auth.md) extends the authorized provider slice for official subscription transports. Implementation and deterministic verification are distinct from live subscription acceptance.

## Login UX

`bun run futryn` → `/login` → **vendor** → **sign-in method** → model → chat.

OpenAI appears once and contains **Sign in with ChatGPT**, **API key**, and **More options…** (device code and environment reference). Google similarly groups subscription and API access. GitHub Copilot and Qwen have their own vendor rows. xAI Grok groups **Sign in with Grok** (Grok Build subscription) with **API key** ([ADR 0026](../adr/0026-xai-grok-api-and-subscription.md)). Internal runtime/provider IDs are not separate login choices. Selecting subscription starts the official browser/device flow immediately; approved auth links open via a fixed OS opener with no shell interpolation. Selecting API key asks only for the hidden key. Account names are generated automatically (`openai`, `openai-2`, `chatgpt`, etc.); rename is optional in account management. No alias or environment-variable prompt interrupts the ordinary sign-in path. Advanced custom endpoints remain explicit because URL/protocol/model data is necessary for a custom server.

The dialog uses a fully covering modal background, bounded width and content-based height: the wider chat composer's border/sidebar cannot leak around it. Errors remain in the credential step where possible. Subscription sign-in polls automatically; the user does not paste tokens, client IDs, refresh tokens or runtime paths. Device codes are intentionally visible; keys, OAuth one-time codes and token material are not. Missing runtime prerequisites are reported before starting sign-in. Existing API keys, accounts, catalogs and theme/session data continue to load.

The line-mode wizard follows the same vendor grouping and automatic account naming. An explicit `/login <saved-account>` reuses valid saved credentials without a redundant yes/no prompt. Reauthentication of a logged-out identity preserves its stable ID. Administrative `auth login --alias` remains available for scripts.

## Implemented paths and exact prerequisites

| Vendor | Path | Required local runtime | Verification |
|---|---|---|---|
| ChatGPT | Codex App Server managed browser/device login, account refresh, model listing and turns | Official `codex` on PATH | Protocol subprocess fixtures and actual unauthenticated handshake with `codex-cli 0.167.0`; paid model/browser login not attempted |
| GitHub Copilot | Official CLI device sign-in, CLI RPC auth status/model/session APIs | Official `copilot` on PATH | Protocol subprocess fixtures and actual unauthenticated handshake with Copilot CLI `1.0.107`, RPC protocol 3; subscription requests not attempted |
| Google AI subscription | Official Gemini CLI ACP Google OAuth, models and prompt streaming | Official `gemini` on PATH | Deterministic ACP subprocess fixtures; CLI not installed on this host, live compatibility Needs verification |
| Qwen | Official Qwen Code ACP `qwen-oauth`, model discovery and streaming | Official `qwen` exposing the documented ACP/OAuth path | Deterministic ACP subprocess fixtures; CLI not installed on this host. Current source accepts `qwen-oauth` but advertises only API auth in its auth-method list, so installed-version/browser compatibility explicitly Needs verification |
| xAI Grok (SuperGrok) | Official Grok Build ACP (`grok agent --no-leader stdio`), auth method `grok.com`, model discovery and streaming; isolated `GROK_HOME`/`HOME` | Official `grok` on PATH (https://x.ai/cli) | Deterministic ACP subprocess fixtures; actual unauthenticated `initialize`/`session/new` and `grok inspect` with installed 1.0.77 on 2026-11-15. Browser login, authenticated model shape and plan entitlement Need verification |
| xAI Grok API | API key / env reference, `https://api.x.ai/v1` OpenAI-compatible chat with `include_usage` | None beyond FUTRYN | Existing OpenAI-compatible adapter fixtures; live xAI request not run |
| Claude | Anthropic API key | Existing native API adapter | Existing HTTP fixtures; subscription login in a third-party product requires Anthropic approval and is not offered as working |
| OpenRouter | Official PKCE code-to-API-key flow | None beyond FUTRYN | Existing HTTP/OS-keyring tests; uses OpenRouter credits, not another subscription |

No runtime is silently downloaded, updated or authenticated using other apps' credentials. Missing runtime is a real prerequisite, not successful integration evidence. In particular, Gemini/Qwen fixture success is not a claim that their installed/vendor flows were observed here. Model access and quota depend on the actual account. Subscription usage/cost stays unknown unless reported; no invented zero-cost or entitlement guarantee.

## Native runtime tools (ADR 0027, opt-in since ADR 0029)

Folder consent alone keeps subscriptions on `codex-bridge` (Codex loop, Hannes tools) or `chat-only`. Only after an explicit per-session `/backend delegated` does the runtime work in the real workspace with its own, unconfined tools; their permission requests become Hannes prompts answered by the session permission mode (Shift+Tab / `/permissions <mode>`). Live 2026-11-15: Grok 4.7 and Codex `gpt-6-luna` ran shell commands in `auto` and showed one `process.execute` prompt in `default` (denied → no file). Copilot/Gemini/Qwen native mode is fixture/design only. The rules below describe chat-only mode (no consent).

## Security and persistence

Each account stores a versioned allowlisted credential snapshot in the OS keyring. API-key `get` cannot return a runtime snapshot as a bearer key. Runtime execution materializes credentials only into a private 0700 per-operation profile with an empty working directory and removes it on normal completion/cancellation. Snapshot restores reject traversal/unexpected files; capture rejects symlinks/oversized/non-JSON files and excludes runtime logs/transcripts. Runtime credentials may transiently exist on disk while the official CLI uses them. Forced host termination/power loss can leave private temporary files; full encrypted filesystem/crash recovery is not claimed.

Child environments omit inherited provider tokens, `NODE_OPTIONS`, shell auto-approval and user proxy/config injection. Provider-specific home overrides isolate official auth caches. Process execution uses fixed argv, no shell, and no project cwd. OAuth browser opening accepts only recognized provider HTTPS authorization hosts. Native runtimes may also use their own documented browser flow.

Codex runs with read-only policy and disabled shell/web/agents/MCP/apps/plugins; approval requests are declined. Copilot uses `availableTools: []`, excluded tool sources, no config discovery/plugins/skills and denied permission requests. Gemini uses `tools.core: []`. Qwen deliberately uses a **nonempty impossible core allowlist**, `permissions.deny: ['*']` and disabled tool search; its empty core list would enable defaults. Grok Build uses `permission.deny = ["*"]` (its read-only tools are otherwise auto-approved in every mode), disabled web search/backend tools/subagents/memory/managed MCP/relay/telemetry and disabled Claude/Codex/Cursor compat discovery; `HOME` points into the profile. ACP client filesystem/terminal capabilities are absent, and client-side requests are denied. Tool-start events fail the turn rather than becoming a committed success. These are runtime controls, not a claim of a separate OS sandbox; general FUTRYN tool execution remains Not implemented.

Account generation/reference checks fence streams, model discovery and refresh persistence. Logout terminates owned active connections, deletes the vault entry, clears selection/catalog and cannot be undone by a late credential refresh. Separate accounts never share a profile/key. SQLite owner/PID leases serialize operations on the same account across processes, preventing competing token rotations; dead-process lease reclamation is transactional. Local logout deletes FUTRYN's credential material; remote revocation remains the provider's responsibility. API keys and runtime snapshot persistence never fall back to a durable plaintext credentials file.

## Tests and actual evidence

- Four subprocess wire fixtures exercise browser/device completion, separate accounts, model selection, requests, persistence/restart, failure/cancellation, tool-request denial, missing credential output and logout during a stream.
- The actual TUI is driven through `Bun.Terminal`: `/login` → OpenAI → ChatGPT → model → streamed fixture chat → logout. No account-name/key prompt appears on that subscription path.
- Grouping/keyboard tests verify one vendor row, advanced-method disclosure, immediate API-key input and a modal backdrop without leaked composer borders.
- Profile/vault tests cover environment stripping, fixed provider bindings, path/symlink/size checks, exclusion of prompts/logs and real native-keyring roundtrip/redaction/deletion.
- Native installed-runtime probes use fresh empty profiles and only initialization/ping. They do not read existing Codex/Copilot credentials or attempt a provider request.

Run `bun run typecheck`, `bun run lint`, `bun test tests`, and opt in to disposable native keyring checks with `HANNES_TEST_KEYRING=1 bun test tests`. Fixture executables are confined to `tests/subscription-fixtures`; production has no fixture mode or environment-variable executable injection.

Verified checks on this host:

| Check | Observed result |
|---|---|
| `bun run typecheck` | Pass |
| `bun run lint` | Pass |
| `HANNES_TEST_KEYRING=1 bun test tests` | 119 pass, 0 fail, 12 files; includes actual PTY and native-keyring checks |
| Actual Codex initialization | Pass, installed 0.167.0, isolated empty profile, no login/model request |
| Actual Copilot RPC ping | Pass, installed 1.0.107, protocol 3, isolated empty profile, no login/model request |
| Gemini/Qwen installed runtime / authenticated vendor requests | Not run; prerequisites/live consent not available |
| Actual Grok Build ACP initialize (2026-11-15) | Pass, installed 1.0.77, isolated empty profile, `protocolVersion: 1`, `authMethods: [grok.com]`; `session/new` without login returns `Authentication required`; no login/model request |


## Official-source research

All accessed 2026-11-14. Dynamic documentation is not an immutable upstream contract; source revision is recorded where available.

| Source | Revision / inspected paths | Evidence limits |
|---|---|---|
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Official current markdown; local `codex app-server generate-ts` schemas generated with 0.167.0 | Managed `account/login/start` browser/device, cancellation, logout, `account/read`, model list, thread/turn/events and sandbox/approvals. Native init observed; authenticated generation pending. |
| [Codex source](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools) | Current tree and `tools/spec_plan.rs`; dependency is the installed CLI, not copied Rust code | Shell feature gate, view-image and other tool controls reviewed; runtime tool controls are not an OS sandbox claim. |
| [Copilot SDK source](https://github.com/github/copilot-sdk/tree/main/nodejs/src) | `client.ts`, `session.ts`, `types.ts`; exact hashes below | RPC framing, fixed CLI flags, empty tool filter, private COPILOT_HOME, disabled keytar and session/model/event APIs. No npm SDK dependency added. |
| [Copilot auth](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) | Current official docs and installed `copilot login --help` | Official device/browser login and own runtime state; no borrowed OAuth client or auth import. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/tree/4ed06ed0ddc523a6d356a4ad35ddfea331041888) | `packages/cli/src/acp/acpRpcDispatcher.ts`, core config storage/utils paths; source package `0.70.0-nightly.20261110.g1603e9bab` | ACP Google OAuth and GEMINI_CLI_HOME/profile/tool controls; package not installed or live authenticated here. |
| [Qwen Code](https://github.com/QwenLM/qwen-code/tree/dab5253c628be736c8fdd43c9d9e36e8d1e9ff00) | `acp-integration/acpAgent.ts`, `authMethods.ts`, `config/settingsSchema.ts`, core config storage/oauth config; source package 0.27.2 | ACP auth/prompt/model shape, QWEN_HOME, empty-list pitfall and OAuth notifications; auth advertisement inconsistency noted above. No first-party client ID is copied. |
| Grok Build user guide (bundled with `grok` 1.0.77, `~/.grok/docs/user-guide/{02,05,15,22,26}-*.md`), accessed 2026-11-15 | Installed version 1.0.77 (50ca579fa996) | ACP stdio, `grok.com` OAuth, `GROK_HOME`, permission `*` rule, config keys. https://x.ai/cli returned 403 to automated fetch; no xAI client ID copied. |
| [Claude policy](https://code.claude.com/docs/en/legal-and-compliance) | Official current authentication/credential-use policy | Third-party subscription sign-in needs approval; API access remains the supported path. |

## Remaining live acceptance

The user previously chose to configure subscription/API credentials locally later. Browser consent, paid model requests, entitlement/quota behavior and hostile-tool probes against each authenticated native runtime remain pending. No full Product MVP/vendor compatibility acceptance is claimed from deterministic fixtures or handshake checks alone.


Inspected dynamic source SHA-256 snapshots:

- Codex app-server markdown: `b9e75507755ba0be2ebc615ca1f4399a54a386125f3935f615405ea93efe77f2`.
- Copilot client.ts: `ccca591e6f3430c64e8709f9a6d533cb23a9d3ddcedf94a885139c7d5920dc45`.
- Copilot session.ts: `0ece64143e23756f5d71cf8c0f659409bf8dd73ffb269fc756ccbcb8060fb9e7`.
- Copilot types.ts: `2828179fed4beae3746a7e95d0efa175b6bdf43553b1edd815c19edcd325d3ec`.


## Copilot saved-sign-in fix

The first live user report found `AUTH` after GitHub consent. The Copilot runtime recipe incorrectly passed `--no-auto-login`: official SDK documentation states this ignores saved CLI credentials (`useLoggedInUser: false`). FUTRYN restores its own credential snapshot into a private `COPILOT_HOME`, so that flag prevented the runtime from using the sign-in it had just saved. The flag is removed; inherited tokens remain excluded, keytar stays disabled, and `GH_CONFIG_DIR`/XDG paths point inside the same private profile to prevent unrelated `gh`/user-config fallback. No global Copilot credential cache is imported.

The subprocess fixture now honors `--no-auto-login` semantics, so the existing full Copilot login/model/chat/restart tests detect this regression. Subscription errors use the provider's sign-in context, not API-key instructions, and longer diagnostics wrap inside the dialog. An isolated native `copilot login --device-code` probe reached the authorization URL/code without a TTY or API key and was cancelled without consent; no real tokens were read or model request sent. Full post-consent vendor validation still needs the user's next sign-in.

Official source: [Copilot SDK authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md), “Disabling auto-login”, accessed 2026-11-14. Configuration follows the existing `useLoggedInUser` behavior; public contract/storage versions and provider scopes are unchanged.

## Follow-up: native Copilot credential document parsing

The user still observed `AUTH` after that change. A second fault was reproduced on installed Copilot CLI **1.0.107** (macOS arm64): the CLI writes `config.json` with these leading lines, followed by JSON:

```text
// User settings belong in settings.json.
// This file is managed automatically.
```

`RuntimeProfile.snapshot()` previously passed the entire file to `JSON.parse`, throwing before the credential could enter the vault. The old subprocess fixture used plain JSON and missed this failure. With the observed header added to that fixture, the Copilot login/model/chat test failed at snapshot capture (`Unrecognized token '/'`) before the fix.

Persistence now accepts that exact managed header (LF or CRLF) for allowlisted `config.json` and stores canonical strict JSON. Restore accepts both existing strict documents and the same managed format. This avoids general comment stripping inside tokens/URLs, preserves nested-token redaction, and leaves the snapshot schema at version 1. Unknown comment formats, malformed JSON, extra trailing content and existing file/path/size violations fail closed with a safe storage error.

Evidence recorded 2026-11-14:

- Installed native runtime: `/opt/homebrew/Caskroom/copilot-cli/1.0.107/copilot`. Its extracted `prebuilds/darwin-arm64/runtime.node` SHA-256 is `0eae290b7e80529f44935ddce0e87919a49c017353269fad5e239579bc3ade3a`; no vendor binary/source is added to the repository.
- A fresh isolated native runtime writes benign `appTipShown` state through `globalState.writeKey`; FUTRYN captures the resulting native document, restores it in a different private profile, and a second native process reads the saved value via `globalState.load`. Automated opt-in: `HANNES_TEST_COPILOT=1 bun test tests/end-to-end/subscriptions.test.ts`. No existing auth cache is imported, browser consent requested, token read or model request sent by this probe.
- Deterministic Copilot lifecycle tests now use the native header for authentication output. Actual PTY coverage includes GitHub Copilot → device-flow fixture → model → streamed fixture response → logout.
- A disposable native OS-vault test checks capture of a header-bearing synthetic token document, nested secret redaction, vault retrieval and deletion.
- Verification on a separate checkout of `4c412d3` plus this fix: typecheck/lint pass; `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests` reports **123 pass, 0 fail**, including unit/integration, PTY and native-state tests. The shared working tree reports 122 pass / 2 fail in Fyn rendering assertions affected by concurrent, uncommitted TUI edits; those edits are preserved and excluded from this auth fix.

These checks verify the parsing fault and native document persistence. Authenticated Copilot model/chat acceptance after browser consent remains **Needs verification**; the benign native-state test does not establish token entitlement or a successful vendor response.

### ChatGPT/Codex workspace reads

[ADR 0018](../adr/0018-codex-read-tool-bridge.md) enables only Hannes-owned read/glob/grep after TUI folder consent. Codex native execution stays disabled and its cwd stays isolated. `/status` reports whether reading is disabled, unavailable, or read-only. After updating, restart the TUI so the new adapter is loaded, approve the actual project folder, and ask it to read README or inspect the project. A file has only been read when a successful read card/result exists; an @path alone does not load content. Copilot/Gemini/Qwen subscription reading remains unavailable in this increment.

Verification 2026-11-15: installed official Codex 0.167.0 completed one real `read` of a temporary README through the active subscription and returned its randomly generated marker (not included in the prompt). Temporary conversation/workspace removed; no private project contents sent. Actual PTY fixture coverage passes folder consent → ChatGPT login → read → successful tool card. Read/glob/grep, redaction, denied secrets/outside paths, builtin shell denial, duplicate/foreign/over-limit requests, resume and cancellation regressions pass. `bun run lint` and `bun test tests`: **246 pass, 5 skip, 0 fail**, 251 tests across 23 files; skipped checks are opt-in native-environment suites. Experimental protocol support on other Codex versions remains Needs verification.

Project overview follow-up: Codex now receives the approved project root separately from its isolated process cwd, and tool responses identify their relative source. Investigation instructions ask for manifests, relevant entry points/call paths and representative tests, with explicit distinctions between implementation, stale documentation and uninspected areas. Existing conversations need a restarted TUI to load these changes. This improves grounding; it does not promise exhaustive review from a brief overview request. A live source-vs-README evaluation and its limits are recorded in ADR 0018.
