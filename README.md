<div align="center">

<img src="docs/assets/cosmew-pixel-logo.png" width="128" height="128" alt="Cosmew — an orange pixel cat with coral, violet and cyan accents">

# Cosmew

**Your coding companion, right in the terminal.**

Explore a codebase. Plan a change. Edit, run, and review — with your choice of model.

![Status: Development preview](https://img.shields.io/badge/status-development_preview-d77757?style=flat-square)
![Runtime: Bun 1.4.4](https://img.shields.io/badge/runtime-Bun_1.4.4-81a2be?style=flat-square)
![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-8abeb7?style=flat-square)

[Get started](#get-started) · [Features](#features) · [Terminal workflow](#terminal-workflow) · [MCP](#mcp) · [Documentation](#documentation)

</div>

---

Cosmew is a coding agent built with TypeScript and Bun. It connects directly to model APIs and runs its own agent loop, tools, permissions, and subagents. A fullscreen terminal interface keeps conversation, tool activity, background work, and approvals in one place.

**Development preview.** The sections below describe the current source tree. Live provider coverage and interactive acceptance are still being expanded; see the [provider matrix](docs/compatibility/providers-auth-matrix.md) and [verification notes](#project-status).

## Get started

Requires **Bun 1.4.4** and Git. Bun runs the TypeScript source directly; no application build is needed.

### 1. Install from source

```sh
git clone https://github.com/nguyenhuynhdt37/cosmew.git
cd cosmew
bun install --frozen-lockfile --ignore-scripts
bun run link:cli
```

Bun registers `cosmew` in its global bin directory, normally `~/.bun/bin`. Add that directory to your `PATH` if the command is unavailable.

### 2. Open your project

```sh
cd /path/to/your-project
cosmew
```

On first launch, choose a theme, optionally sign in, and review folder trust. You can also start from this checkout with `bun run cosmew`.

### 3. Connect and start coding

```text
/login
/model
Explain how this project is structured, then suggest a small improvement.
```

Use `/login` to select a provider and a supported sign-in method. Choose a model with tool support for coding tasks. Account and model selection persist across restarts.

> Startup connectivity checks and `cosmew model doctor --generate` can make a small billable request. API access and generation entitlement depend on the provider; a consumer subscription does not automatically include API access.

## Features

| Area | What you can do |
| --- | --- |
| **Code & tools** | Read and search files, edit with patches, run shell commands, inspect diffs, and use sandboxed code intelligence and web tools. |
| **Models & accounts** | Connect supported providers or custom gateways, discover models, switch accounts, and choose advertised reasoning effort levels. |
| **Subagents & tasks** | Delegate work, inspect a child's full conversation, send instructions, and manage background shells and agents. |
| **Sessions & context** | Resume and fork conversations, compact context, inspect checkpoints, and reuse project instructions and memories. |
| **MCP & skills** | Manage user MCP servers, browse registry metadata, connect tools, and control skill visibility. |
| **Usage & diagnostics** | Inspect turn/session usage, provider attribution, reported quota, context limits, and connectivity diagnostics. Missing provider data stays explicit. |
| **Terminal UI** | Use a scrolling transcript, detailed tool views, searchable pickers, themes, reduced motion, and keyboard navigation. |

## Terminal workflow

Start with a request, review the proposed actions, and approve access when needed. Use `/plan` to explore a change with read-only tools, then `/chat` to return to implementation.

### Everyday commands

| Command | Purpose |
| --- | --- |
| `/login`, `/logout` | Connect or manage accounts. |
| `/model`, `/effort` | Choose a model and its supported reasoning effort. |
| `/plan`, `/chat`, `/review` | Plan, implement, or review changes. |
| `/diff` | Inspect working tree changes. |
| `/tasks`, `/agents` | Manage background work and inspect subagents. |
| `/resume`, `/fork`, `/compact` | Restore, branch, or compact a conversation. |
| `/memory`, `/skills` | Browse memories and manage skills. |
| `/mcp` | Open the MCP manager. |
| `/usage`, `/context` | Inspect usage and context capacity. |
| `/permissions`, `/sandbox` | Review access rules and sandbox settings. |
| `/config`, `/theme` | Adjust behavior and appearance. |
| `/status`, `/doctor`, `/help` | Check the active setup and available commands. |

### Keyboard essentials

| Key | Action |
| --- | --- |
| `Tab` | Complete the selected suggestion. |
| `Shift+Tab` | Cycle `default` → `acceptEdits` → `plan`. |
| `Ctrl+O` | Toggle the detailed transcript. |
| `Ctrl+Q` | Toggle native text selection: drag to select, then use your terminal’s copy shortcut. |
| `Ctrl+B` | Move a supported running command into the background. |
| `PgUp` / `PgDn` | Scroll the transcript. |
| `Esc` | Interrupt an active turn or close the current panel. |

Type `@` for file suggestions, `$` for skills, or `/` for commands. The footer shows shortcuts for the current view.

### Follow background work

Open `/tasks`, or use the footer's **↓ to manage** shortcut when shown. Select a shell to inspect output or an agent to open its full conversation. In the task view, `x` stops running work; `Esc` returns.

The agent inspector uses the main conversation renderer. `Ctrl+O` expands tool details, `←` / `→` switch sibling agents, and `i` opens an instruction draft. Sending an instruction follows normal permissions.

Finished task history remains inspectable after restart. Running tasks stop when Cosmew exits and are never restarted automatically.

## Models & providers

Use `/login` for the interactive flow. Cosmew supports API keys, environment references, and provider-specific browser or device sign-in where available. Custom providers live in the user configuration; see [authentication and setup](docs/subsystems/providers-and-auth.md) and [subscription support](docs/delivery/subscription-auth.md).

<details>
<summary><strong>Connect a custom gateway</strong></summary>

```sh
cosmew providers add my-gateway \
  --url https://your-gateway.example/v1 \
  --protocol responses \
  --catalog manual

cosmew auth login --provider my-gateway --alias gateway-main --model your-model-id
cosmew
```

Choose `chat` for Chat Completions, `responses` for Responses, `anthropic` for Messages, or `gemini` for native Gemini. Supply the API base URL, including its prefix, rather than an individual generation endpoint. Use a discovery catalog instead of `manual` when supported.

For automation, reference a secret-manager-injected variable by name:

```sh
cosmew auth login --provider openrouter --alias main --env OPENROUTER_API_KEY
cosmew models list
```

Keys are entered through masked input, stdin, or environment references. Keep key values out of command arguments and repository files.

</details>

## MCP

Open `/mcp` for a server list with connection status and tool counts. Select a server for tools and connection actions; use **Advanced settings** for credentials and configuration. Inspect tools and diagnostics, enable or disable a server, reconnect it, or manage supported authentication. Discovery uses the [official MCP Registry](https://registry.modelcontextprotocol.io/); adding or installing a server requires an explicit action.

```sh
cosmew mcp search context7
cosmew mcp add docs --url https://developers.openai.com/mcp
cosmew mcp doctor docs
cosmew mcp list --managed
```

User servers support stdio and HTTP. OAuth login is available for servers that support it; auth-free documentation servers need no login. Registry entries and recommendations are discovery metadata, not a compatibility guarantee.

Managed installation supports a restricted, pinned npm format. Automatic dependency resolution is limited to dependency-free packages; transitive dependencies require a complete verified lockfile. Lifecycle scripts are disabled. See the [MCP manager guide](docs/delivery/mcp-manager.md) for authentication, installation limits, and acceptance evidence.

## Permissions & data

Folder trust, tool permissions, and the OS sandbox are separate controls. All model tool calls pass through the same permission dispatcher.

| Mode | Behavior |
| --- | --- |
| `default` | Ask before file edits and shell commands without an applicable allow rule. |
| `acceptEdits` | Preapprove file edits within working directories; shell permissions still apply. |
| `plan` | Read-only policy; mutations, shell execution, and network actions are denied. |
| `bypassPermissions` | Skip routine approval prompts; explicit ask/deny rules and sandbox limits still apply. With trusted sandbox off, external command directories need no additional approval. Available only through an explicit startup flag. |

The sandbox is **off by default**. Use `/sandbox` to enable it. Turning it off does not grant permissions or leave an analysis mode. Access outside working directories follows the explicit approval flow. Repository settings that loosen access require approval of their exact contents before taking effect.

<details>
<summary><strong>Configuration and local storage</strong></summary>

| Location | Contents |
| --- | --- |
| `~/.cosmew/config.toml` | User-defined model providers and related configuration. |
| `~/.cosmew/settings.json` | User permissions, sandbox, appearance, and preferences. |
| `.cosmew/settings.json` | Shared project settings, subject to trust checks. |
| `.cosmew/settings.local.json` | Local project overrides, subject to trust checks. |
| `~/.cosmew/mcp.json` | User MCP server definitions. Repository MCP files are not launched. |
| `~/.cosmew/provider-auth.sqlite` | Local account metadata, conversation history, and durable state. |

Credentials use OS keyring entries or environment references, with no plaintext fallback. Conversation history is stored locally without database encryption. Stdio MCP servers configured by the user run outside the command sandbox.

`COSMEW_HOME` overrides the state directory. Existing legacy state roots and environment overrides remain readable in place; credentials and sessions are not moved or merged. The public command is `cosmew` — update older command invocations accordingly. See the [rename decision](docs/adr/0103-cosmew-only-cli-and-repository.md) and [permission specification](docs/adr/0061-claude-code-permissions-and-sandbox.md).

</details>

## Scripts & automation

Use `exec` for a single task with streamed JSONL output or a final-response file:

```sh
cosmew exec "Summarize this project's architecture without changing files." \
  --cd /path/to/project \
  --permission-mode plan \
  --json \
  --output-last-message summary.txt
```

Select an account and model first. `--cd` provides explicit folder consent. Without a TTY, actions that need approval are denied immediately; scope unattended work with permission modes and tool rules. `--output-last-message` is an explicit host-side file export.

Run `cosmew --help` or `cosmew exec --help` for flags and exit codes.

## Development

```sh
bun run typecheck
bun run lint
bun run test
```

The current source tree also provides `bun run quality` for the combined gate and separate `test:integration`, `test:e2e`, `test:native`, `test:pty`, and `test:live` scripts. Live checks require the appropriate opt-in and local prerequisites; inspect the [test strategy](docs/delivery/test-strategy.md) before enabling them.

The workspace separates the CLI composition root, terminal UI, agent loop, API adapters, tools, permissions, and persistence. See the [dependency rules](docs/architecture/dependency-rules.md) and [event contract](docs/contracts/agent-events.md) before changing package boundaries or public interfaces.

## Project status

Core coding workflows, local recovery, subagents, permissions, and the MCP manager have automated coverage in the current source tree. Native sandbox and terminal evidence is primarily from macOS; Linux bubblewrap behavior and broader platform acceptance still need verification. Authenticated live-provider coverage is documented per provider.

Plugins, remote/cloud agents, MCP deferred tool search and resource browsing, and managed package update/rollback remain future work. The full Product MVP has not completed acceptance.

## Documentation

- [Documentation index](docs/README.md) — subsystem guides, delivery reports, and decisions.
- [Provider compatibility](docs/compatibility/providers-auth-matrix.md) — authentication and verification coverage.
- [MCP manager](docs/delivery/mcp-manager.md) — discovery, installation, authentication, and diagnostics.
- [Permissions & sandbox](docs/adr/0061-claude-code-permissions-and-sandbox.md) — access rules and trust behavior.
- [Architecture decisions](docs/adr/) — the reasoning behind public contracts and implementation choices.
