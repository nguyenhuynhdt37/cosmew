# Subscription authentication and simplified login

2026-11-14. [ADR 0008](../adr/0008-subscription-runtime-auth.md) extends the authorized provider slice for official subscription transports. Implementation and deterministic verification are distinct from live subscription acceptance.

## Login UX

`bun run futryn` → `/login` → **vendor** → **sign-in method** → model → chat.

OpenAI appears once and contains **Sign in with ChatGPT**, **API key**, and **More options…** (device code and environment reference). Google similarly groups subscription and API access. GitHub Copilot and Qwen have their own vendor rows. Internal runtime/provider IDs are not separate login choices. Selecting subscription starts the official browser/device flow immediately; approved auth links open via a fixed OS opener with no shell interpolation. Selecting API key asks only for the hidden key. Account names are generated automatically (`openai`, `openai-2`, `chatgpt`, etc.); rename is optional in account management. No alias or environment-variable prompt interrupts the ordinary sign-in path. Advanced custom endpoints remain explicit because URL/protocol/model data is necessary for a custom server.

The dialog uses a fully covering modal background, bounded width and content-based height: the wider chat composer's border/sidebar cannot leak around it. Errors remain in the credential step where possible. Subscription sign-in polls automatically; the user does not paste tokens, client IDs, refresh tokens or runtime paths. Device codes are intentionally visible; keys, OAuth one-time codes and token material are not. Missing runtime prerequisites are reported before starting sign-in. Existing API keys, accounts, catalogs and theme/session data continue to load.

The line-mode wizard follows the same vendor grouping and automatic account naming. An explicit `/login <saved-account>` reuses valid saved credentials without a redundant yes/no prompt. Reauthentication of a logged-out identity preserves its stable ID. Administrative `auth login --alias` remains available for scripts.

## Implemented paths and exact prerequisites

| Vendor | Path | Required local runtime | Verification |
|---|---|---|---|
| ChatGPT | Codex App Server managed browser/device login, account refresh, model listing and turns | Official `codex` on PATH | Protocol subprocess fixtures and actual unauthenticated handshake with `codex-cli 0.167.0`; paid model/browser login not attempted |
| GitHub Copilot | Official CLI device sign-in, CLI RPC auth status/model/session APIs | Official `copilot` on PATH | Protocol subprocess fixtures and actual unauthenticated handshake with Copilot CLI `1.0.107`, RPC protocol 3; subscription requests not attempted |
| Google AI subscription | Official Gemini CLI ACP Google OAuth, models and prompt streaming | Official `gemini` on PATH | Deterministic ACP subprocess fixtures; CLI not installed on this host, live compatibility Needs verification |
| Qwen | Official Qwen Code ACP `qwen-oauth`, model discovery and streaming | Official `qwen` exposing the documented ACP/OAuth path | Deterministic ACP subprocess fixtures; CLI not installed on this host. Current source accepts `qwen-oauth` but advertises only API auth in its auth-method list, so installed-version/browser compatibility explicitly Needs verification |
| Claude | Anthropic API key | Existing native API adapter | Existing HTTP fixtures; subscription login in a third-party product requires Anthropic approval and is not offered as working |
| OpenRouter | Official PKCE code-to-API-key flow | None beyond FUTRYN | Existing HTTP/OS-keyring tests; uses OpenRouter credits, not another subscription |

No runtime is silently downloaded, updated or authenticated using other apps' credentials. Missing runtime is a real prerequisite, not successful integration evidence. In particular, Gemini/Qwen fixture success is not a claim that their installed/vendor flows were observed here. Model access and quota depend on the actual account. Subscription usage/cost stays unknown unless reported; no invented zero-cost or entitlement guarantee.

## Security and persistence

Each account stores a versioned allowlisted credential snapshot in the OS keyring. API-key `get` cannot return a runtime snapshot as a bearer key. Runtime execution materializes credentials only into a private 0700 per-operation profile with an empty working directory and removes it on normal completion/cancellation. Snapshot restores reject traversal/unexpected files; capture rejects symlinks/oversized/non-JSON files and excludes runtime logs/transcripts. Runtime credentials may transiently exist on disk while the official CLI uses them. Forced host termination/power loss can leave private temporary files; full encrypted filesystem/crash recovery is not claimed.

Child environments omit inherited provider tokens, `NODE_OPTIONS`, shell auto-approval and user proxy/config injection. Provider-specific home overrides isolate official auth caches. Process execution uses fixed argv, no shell, and no project cwd. OAuth browser opening accepts only recognized provider HTTPS authorization hosts. Native runtimes may also use their own documented browser flow.

Codex runs with read-only policy and disabled shell/web/agents/MCP/apps/plugins; approval requests are declined. Copilot uses `availableTools: []`, excluded tool sources, no config discovery/plugins/skills and denied permission requests. Gemini uses `tools.core: []`. Qwen deliberately uses a **nonempty impossible core allowlist**, `permissions.deny: ['*']` and disabled tool search; its empty core list would enable defaults. ACP client filesystem/terminal capabilities are absent, and client-side requests are denied. Tool-start events fail the turn rather than becoming a committed success. These are runtime controls, not a claim of a separate OS sandbox; general FUTRYN tool execution remains Not implemented.

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
| [Claude policy](https://code.claude.com/docs/en/legal-and-compliance) | Official current authentication/credential-use policy | Third-party subscription sign-in needs approval; API access remains the supported path. |

## Remaining live acceptance

The user previously chose to configure subscription/API credentials locally later. Browser consent, paid model requests, entitlement/quota behavior and hostile-tool probes against each authenticated native runtime remain pending. No full Product MVP/vendor compatibility acceptance is claimed from deterministic fixtures or handshake checks alone.


Inspected dynamic source SHA-256 snapshots:

- Codex app-server markdown: `b9e75507755ba0be2ebc615ca1f4399a54a386125f3935f615405ea93efe77f2`.
- Copilot client.ts: `ccca591e6f3430c64e8709f9a6d533cb23a9d3ddcedf94a885139c7d5920dc45`.
- Copilot session.ts: `0ece64143e23756f5d71cf8c0f659409bf8dd73ffb269fc756ccbcb8060fb9e7`.
- Copilot types.ts: `2828179fed4beae3746a7e95d0efa175b6bdf43553b1edd815c19edcd325d3ec`.
