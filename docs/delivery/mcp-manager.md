# MCP manager — implementation and acceptance

Date2026-11-22. Contract1.54; SQLite13 unchanged. Implements the MVP selected in [comparison](mcp-manager-comparison-2026-11-22.md); [ADR0102](../adr/0102-mcp-manager.md). Preserve concurrent work in the shared dirty tree, including project/session commands and skill manager. No commits/staging/installed binary replacement performed by this task.

## Usage

Open `/mcp`: a Claude-style server list with connection glyphs and tool counts. Select a server for tools/connect/enablement, or Advanced settings for authentication/configuration/removal. Registry and recommendations are explicit list actions. Add server → Remote server asks for URL first and suggests an unused local name; validation keeps drafts and Tab/Shift+Tab revisits fields. See [ADR 0104](../adr/0104-mcp-dialog-and-json-schema-2020.md). Select an entry for independent installation/auth/connection status, tool inspection, diagnostics, enable/disable, reconnect, edit, login/logout, credential clear/set or removal. Discovery is metadata only; adding/installing requires a concrete human action. Credential input is masked and confirmation defaults to Cancel. Esc cancels an active operation and drains it before another starts. Unsupported formats/errors remain explicit; recommendations all initially tested:false.

CLI examples (run from this source checkout or a CLI linked to it):

```sh
cosmew mcp recommended
cosmew mcp search context7
cosmew mcp add docs --url https://developers.openai.com/mcp
cosmew mcp list --managed
cosmew mcp get docs
cosmew mcp doctor docs
cosmew mcp disable docs
cosmew mcp enable docs
cosmew mcp login docs
cosmew mcp logout docs
cosmew mcp remove docs
```

`login` is for a server that supports OAuth, not a requirement for auth-free docs. `credentials NAME --bearer-stdin` or masked terminal input stores endpoint-bound bearer credentials in the vault; `--clear` clears them. Secrets must not be passed in command arguments. `add|edit NAME -- EXE ARG...` preserves local argv rather than shell expansion. `install NAME --package PACKAGE --version EXACT [--integrity SHA512] [--lockfile FILE] [--bin NAME]` uses the supported managed format. Legacy `cosmew mcp list` still connects and prints its original report shape; `--managed` adds separate dimensions without forcing connection.

User configuration lives in the effective state directory's mcp.json, normally ~/.cosmew/mcp.json (COSMEW_HOME and existing legacy-root selection apply). Repository MCP configurations still never start programs. Disabling persists without deleting an entry. Invalid entries remain visible for repair/removal. Remote entries have no invented package version. Managed readiness checks owned manifests and executable existence. Removing one alias of a shared endpoint retains credentials needed by other aliases; logout suspends all aliases of that endpoint and clears shared local authentication. Logout reports whether remote revocation was confirmed, unsupported, failed or unnecessary; no remote service records are deleted.

## Safety and reliability

All model MCP calls still pass ToolDispatcher, schema and existing permission modes. Host management is not registered as a model tool. MCP descriptors carry per-entry UUID plus generation to prevent identical-name/schema replacement from inheriting pending/session approval. Config change/connect detects identity changes and clears client grants. Config mutations use private descriptor-relative atomic replacement, bounded reads, kernel lock and revision CAS. Unknown config fields survive.

Protocol supports explicit reconnect, disable, replacement and generation-fenced shutdown; invalid tool schemas are isolated, pagination64tools/4pages is visible, unsupported image/resource-only results return an explicit error. No mutating tool call is replayed to reconnect. OAuth includes PKCE/state/issuer/resource checks; configured headers are scoped to MCP origin, discovered network targets are checked before requests and production OAuth DNS answers are pinned to the validated public address with TLS hostname retained. Loopback is permitted only for explicitly loopback-rooted development flows. Credentials remain vault-bound, never in public snapshots. Durable epoch/revision tombstones and immutable vaultrefs fence cross-process refresh after logout; kernel locks release after SIGKILL.

## Supported installation scope

[Managed installation details](mcp-managed-install.md): pinned npm packages with SHA512; automatic metadata resolution supports dependency-free packages. Transitive dependencies require an explicit complete verified npm lockv3. Lifecycle scripts are disabled, binaries are checked to be owned regular JS files, package paths and registries are constrained, cancellation/failure removes only owned installation directories. Missing node/npm or packages requiring install scripts/native builds are not silently supported. Remote endpoints need configuration, not a package download. Arbitrary executable plugins, tool search/resources, package update/rollback and enterprise catalogues are expansion work.

## Evidence

- Registry live read-only smoke: actual official Registry query `context7` returned3 entries including io.github.upstash/context7, each untested, remote recipe; no package was installed and no service account used.
- Live auth-free OpenAI Docs MCP handshake/listTools: connected,5tools,no problems, then closed; no account or generation used. This verifies that endpoint only, not OAuth or universal server compatibility.
- Real local HTTP/stdin/stdout fixtures verify add→connect→call→disable→enable→reconnect→remove, managed install registration/launch/cleanup, safe credentials and auth-free remote status.
- Real loopback OAuth fixtures verify PKCE callback, refresh through actual SDK HTTP transport, logout, revoked/stale flows, malformed callbacks, cross-origin credential isolation, unsafe IP/DNS denial, pinned wire options, two-store logout fencing and process-kill lock recovery. No real provider OAuth/OS-keyring/remote revocation certification is claimed.
- Dedicated CLI subprocess tests run with no account/model and disposable state. TUI tests cover explicit action routing, masked credentials, default-Cancel, edits, validation, pagination and cancellation drain.
- Independent read-only review identified and rechecked credential propagation, discovery SSRF, stale identity approvals, auth logout race, malformed configs and HTTP compatibility. Actual hub replacement and dispatcher session/pending approval regressions pass; reviewer found no additional concrete P1 after fixes (not a security certification).
- Focused settled group:96pass/0fail/562assertions before final added real-hub identity regression; final root manager suite8pass/0fail/52assertions. Counts overlap.
- Latest fully settled focused MCP/CLI/TUI/status group: **98pass /0fail /576assertions** in10files; typecheck/lint/format/diff checks passed.
- Aggregate interim run:1959pass/13skip/1fail in1973tests; the sole failure was unrelated background-history retention volume test exceeding its5s deadline under overlapping suites. Its complete6-test file passed separately in3.87s. **Final sequential `bun run quality` exited0**: typecheck, lint/format/diff checks and **1961pass /13skip /0fail**,1974tests across219files,8snapshots,52182assertions,387.61s. Guard stayed enabled. Native/current macOS source-tree evidence only; no remote CI or installed-binary acceptance implied.

Earlier runs saw the test guard detect changes to real legacy provider-auth.sqlite while other user processes were active. The guard was never disabled and the real database was never restored. Concurrent activity is not evidence that these isolated tests caused the writes. Both fixture-local successes and aggregate guard failures are reported honestly.
