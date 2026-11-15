> Slash-command discovery and account continuation were updated by [ADR 0013](../adr/0013-canonical-slash-commands.md). Older command tables below are historical where they conflict.

# Provider Connect and command rebuild

Evidence date: **2026-11-14**. Scope: PA1/TUI1, [ADR 0007](../adr/0007-provider-connect-and-commands.md). **Implementation delivered; live-provider Product MVP acceptance remains pending.** The user chose to configure live credentials locally later. No credentials from other applications were accessed.

## Start and use

```sh
bun run futryn
# Equivalent: bun run hannes tui
```

The existing CLI package exports a `futryn` executable. With that package linked on PATH, `futryn` in a terminal also starts the TUI; no global install is performed by this change. `hannes chat` retains the line-oriented wizard; noninteractive administration remains available.

1. Enter `/login`. Type to filter registry providers, navigate with arrows and Enter. Each row shows connected state and available methods. `Ctrl+A` opens account management. Custom endpoint is always available at the end of the filtered list.
2. Choose the method and a unique account name. API keys and OAuth codes are masked and never added to composer history. Environment mode accepts a variable **name**, not its value. No-auth skips the secret prompt. Keyring failure offers an actionable environment-mode alternative, with no plaintext fallback.
3. OpenRouter additionally offers its official OAuth PKCE method. Open the displayed URL, authorize access to your OpenRouter API credits and paste the one-time code. On short terminals use PgUp/PgDn to view the wrapped URL. Esc cancels; expired/failed codes require a fresh authorization.
4. Successful connection opens `/model`. Choose a cached/discovered model, use `Ctrl+R` for discovery, `Ctrl+A` for a manual ID and Tab/Shift+Tab to switch the provider account. Enter selects. Send a message to invoke the actual configured adapter.
5. `/login` then Ctrl+A opens account management; `/logout` opens searchable accounts for sign-out. Enter opens Switch, Add, Rename, Reconnect, Logout and Remove. Logout/removal requires an explicit confirmation; Cancel is selected initially. A failed deletion leaves the account fenced and available for retry.
6. Restart retains settings/accounts/models. `/resume` opens saved sessions. Account/model changes start fresh contexts; prior sessions are preserved.

Custom endpoints collect ID, URL, protocol, auth requirement, discovery protocol or manual model ID. Root validates HTTPS/loopback policy and rejects URL credentials, query, fragment and remote cleartext HTTP before saving. Manual-only endpoints validate using an actual small generation request, which may incur provider charges. Discovery validates access to a catalog, not generation entitlement; OpenRouter separately checks authenticated `/key`.

## Command audit and migration

| Canonical | Preserved aliases | Actual behavior |
|---|---|---|
| `/login` | `/connect` | Registry provider/method connection dialog |
| `/logout` | — | Account manager, explicit sign-out/removal confirmation |
| `/model` | `/models` | Provider-account model picker; `/model <id>` selects a cached ID |
| `/status` | — | Model/account/session/capabilities and historical connectivity timestamp |
| `/config` | `/settings` | Interactive appearance settings |
| `/permissions` | `/perm` | Existing pending approval queue; tool-policy editing explicitly Not implemented |
| `/mcp` | — | Not implemented; separate MCP auth explained |
| `/plugin` | `/plugins` | Not implemented; no plugin host enabled |
| `/theme` | `/themes` compatibility | Theme picker; custom editing is unavailable. |
| `/resume` | `/sessions`, `/continue` | Session picker; `/resume <id>` resumes directly |
| `/clear` | — | Fresh conversation context; previous session preserved |
| `/compact` | — | Not implemented: no summarization/provenance backend; suggests clear/resume |
| `/help` | `/?` | Scrollable command and keyboard help |
| `/doctor` | — | Actual active-provider validation and runtime/settings diagnostics |
| `/exit` | `/quit` | Clean terminal exit |

Existing `/accounts` (`/account`), `/new`, `/diff`, `/theme edit` (`/editor`, `/customize`) remain supported FUTRYN additions. Administration families `providers`, `auth`, `accounts`, `models`, `themes`, `chat`, `run`, and `model doctor` remain compatible. Top-level `login`, `logout`, `model`, `config`, `permissions`, `resume`, `clear`, `status`, `doctor`, `exit` resolve to actual flows; top-level unsupported MCP/plugin/compact returns `UNSUPPORTED`. `auth methods` and both connection UIs consume the Integration Registry.

`/` autocomplete includes aliases and Tab completion; `@` retains bounded workspace path autocomplete. File mentions remain literal references: automatic file content attachment and general filesystem tools are Not implemented. `!` reports unsupported shell execution before sending anything to the model. Esc dismisses menus/dialogs or aborts streaming. Ctrl+C aborts a request, clears a nonempty draft, then exits on an empty prompt. Alt+Enter/Ctrl+J insert a newline. Shift+Tab retains existing view-mode cycling and explicitly reports that tool permission modes are unavailable; it never changes permissions.

Preserved FUTRYN shortcuts: Ctrl+P palette, Ctrl+T themes, Ctrl+S sessions, Ctrl+B sidebar, Ctrl+D diff. These are **not Claude Code keyboard parity claims**; current Claude Code assigns several differently. Model shortcut is now Ctrl+L: the old advertised Ctrl+M conflicts with Enter on ordinary terminals. Help and palette scroll with selection; provider/account lists keep selected rows visible. The existing ANSI renderer is preserved; exact OpenCode rendering fidelity and GUI-host parity are not claimed.

## Reproducible verification

```sh
bun run typecheck
bun run lint
bun test tests
bun run test:integration
bun run test:e2e
# Actual OS keyring, disposable fixture entries only:
HANNES_TEST_KEYRING=1 bun test tests
```

`lint` applies TypeScript unused-local/parameter checks and patch whitespace checks without adding dependencies. Local HTTP fixtures exercise real provider SDK translation; production adapters are not replaced with successful mocks. OAuth fixtures verify S256 against an actual local exchange server while asserting that the production driver requests only the pinned official URL. CI injects a private in-memory vault for that test; native-keyring tests are separate.

Coverage includes registry/provider filtering; API key, environment and no-auth login; official OAuth challenge/exchange/expiry/failure/cancellation/redaction; model/account switching and request-model verification; custom no-auth/manual endpoints; forbidden URLs; rollback and logout; persistence/restart; command aliases/autocomplete; navigation/confirmation; small frames; full-target permission scope isolation, forged scopes and expired grants; streaming and failure handling.

The terminal E2E spawns the actual CLI using `Bun.Terminal`, types `/login`, selects a provider, authenticates, selects a model, observes a streamed fixture reply, exits, restarts and logs out. Existing PTY tests also exercise secret echo suppression and terminal cleanup. Native OS-vault tests verify create/read/rotation/deletion with disposable synthetic secrets. These are real terminal/process/keyring checks, **not live vendor inference** or manual visual acceptance across terminal emulators.

Observed final checks on this host:

| Check | Result |
|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | Pass after synchronizing existing TUI/SDK workspace entries; external dependency versions unchanged |
| `bun test tests` | 85 pass, 3 native-keyring tests skipped without opt-in, 0 fail |
| `bun run typecheck` | Pass |
| `bun run lint` | Pass: compiler semantic lint and whitespace |
| `bun run test:integration` | 36 pass, 0 fail, 3 files |
| `HANNES_TEST_KEYRING=1 bun test tests` | 88 pass, 0 fail, 10 files, including actual OS-keyring and PTY tests |
| `HANNES_TEST_KEYRING=1 bun run test:e2e` | 33 pass, 0 fail, 3 files; actual PTY and native-vault tests included |
| Authenticated vendor generation / browser OAuth | Not run; user will configure live credentials locally later |

SIGTERM during an in-flight PTY login is covered: terminal modes restore, credential rollback drains before SQLite closes, and the process exits with cancellation status. Source/dependency inspection confirms no new dependencies, package graph changes or unrelated subsystem implementation.

## Upstream evidence

Accessed 2026-11-14; dynamic docs hashes identify the inspected snapshot and are not immutable upstream release guarantees.

| Source | Revision / SHA-256 | Evidence and limits |
|---|---|---|
| [OpenCode integration dialog](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/tui/src/component/dialog-integration.tsx) | commit `d759c548aab33a7a6f5171cbeab40a59e91d90aa`; file `8a396a6a31dbfe389e2da1b24a3d143c473d714b3d7a08cee71b5603ffff0c22` | Integration/method metadata, connected account summary, add/activate/rename/delete, key/OAuth/command branches and cancellation. FUTRYN exposes only implemented drivers; its account manager is separately reachable from the provider dialog. |
| [OpenCode selector source](https://github.com/anomalyco/opencode/blob/d759c548aab33a7a6f5171cbeab40a59e91d90aa/packages/tui/src/ui/dialog-select.tsx) | commit `d759c548aab33a7a6f5171cbeab40a59e91d90aa`; file `9f478e199f7899f8399a7243d15470e84f7ac15cfd7e9c82899641db84c54f1a` | Search/filter, selected-row scrolling, modal padding and keyboard interaction. Used as UX reference, not a byte-for-byte renderer copy. |
| [Claude interactive mode](https://code.claude.com/docs/en/interactive-mode.md) | `e624de2e0aef168711284cadc2a261723e1273a77a4aa1c1b8b22f2227769803` | Slash/@/shell conventions, Esc, Ctrl+C, Shift+Tab; unsupported tools explicitly diagnosed. |
| [Claude commands](https://code.claude.com/docs/en/commands.md) | `cfd3f6cf0d55272f07af7105713eb7215c0e6939eb8108cd9bec2e7792dfa3ba` | Canonical command names, config/model/theme dialogs, clear/resume semantics. FUTRYN offers its own backend support, not full Claude feature parity. |
| [OpenRouter OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth.md) | `7c6c0fcaf536e8359b3d80ded67cd526e816dadf7a4a3feb6c55831d3fd355d6` | Explicit headless PKCE, ten-minute single-use code, no callback, S256 and API-key exchange. This guide's code exchange needs no management API key; generated API-reference docs inconsistently mention one. Live authorization remains Needs verification. |
| [OpenRouter current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key.md) | `f996e5a7f914476020a01ac7ba0a14166c36889c9fd666c3eaf90134d79c6f5a` | Authenticated `GET https://openrouter.ai/api/v1/key`, distinct from public catalog discovery. |

## Outstanding acceptance

Authenticated live model generation and real browser OpenRouter authorization require the user's locally configured account and are **not verified**. Manual visual acceptance in iTerm/Kitty/Windows Terminal, Linux/Windows keyring behavior, device-code drivers, delegated CLIs, external auth plugins, MCP, shell/file tools, permission-policy editing and context compaction remain **Not implemented / Needs verification** as applicable. No claim of a fully accepted Product MVP is made.


SUB1 and login UX follow-up: [current behavior and evidence](subscription-auth.md), [ADR 0008](../adr/0008-subscription-runtime-auth.md). This supersedes the alias-entry step and separate subscription-provider rows: vendors are grouped, ordinary login does not ask for account names, and advanced environment/custom settings are secondary.

## Simplified logout (2026-11-15)

`/logout` no longer opens general account management. With one saved account it signs out immediately; with several, a focused searchable sign-out picker selects the active account initially and Enter signs out the selected account. Esc cancels without changing credentials. Other accounts stay connected. `/accounts` retains Switch/Add/Rename/Reconnect/Logout/Remove and its existing removal confirmation. Failed credential deletion is never reported as success and stays retryable from the sign-out picker, including identities fenced as logged-out. Environment references are detached locally; shell environment values and remote provider credentials are not revoked.

Verification: typecheck/lint pass; `HANNES_TEST_KEYRING=1 HANNES_TEST_COPILOT=1 bun test tests`: 130 pass, 0 fail. Coverage includes single-account direct logout, multi-account selection/cancellation, failed deletion/retry, and updated actual PTY API/custom-endpoint/subscription logout flows. No public contract or storage schema change.
