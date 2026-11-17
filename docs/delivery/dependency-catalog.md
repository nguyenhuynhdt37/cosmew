# Danh mục dependency (Phase 0)

**Ngày tra cứu:** 2026-11-13  
Các version là `latest` quan sát được trên npm registry vào ngày tra cứu, không phải phiên bản được chọn hay pin. `Needs verification` đánh dấu compatibility, release status hoặc product fit chưa xác minh. Catalog ghi evidence/candidate, không quyết định kiến trúc.

## Candidate dependencies

| Thành phần | Library đề xuất | Vai trò | Alternative | Rủi ro | Trạng thái |
|---|---|---|---|---|---|
| Runtime / package manager | `bun` | Runtime JS/TS, package manager, toolchain | Node.js + pnpm/npm | Native modules, deploy/CI target cần xác nhận | Needs verification — registry 1.4.4, không phải pin |
| TypeScript | `typescript` | Type checking và contracts | Bun transpiler; tsgo | Transpilation không phải type-check | Needs verification — registry 7.0.2; compiler version/target chưa chọn |
| Terminal UI | `@opentui/core` | TUI, Zig native core | Ink; OpenTUI Solid/React | Native binaries, OS/đóng gói, release cadence | Needs verification — registry 0.8.4 |
| AI SDK | `ai` | Generation, streaming, tools, provider registry | Provider API trực tiếp | API major tiến nhanh; cần đối chiếu model/feature | Needs verification — registry 7.0.172 |
| OpenAI-compatible adapter | `@ai-sdk/openai-compatible` | Custom provider qua baseURL/API key | `@ai-sdk/openai`; HTTP riêng | “Compatible” không bảo đảm tool/reasoning/stream parity | Needs verification — registry 3.0.92 |
| MCP TS SDK v2 | `@modelcontextprotocol/server`; `@modelcontextprotocol/client`; `@modelcontextprotocol/core` (chọn riêng theo nhu cầu) | MCP server, client và protocol primitives | v1 `@modelcontextprotocol/sdk` | v2 đổi package names/API; transport/adapters cần lựa chọn | v2 stable upstream; tag v2.4.0 và npm latest 2.4.0 được xác minh riêng |
| OpenCode plugin | `@opencode/plugin` | Plugin API/runtime OpenCode V2 | Plugin cục bộ hoặc API V1 | Chỉ dùng nếu cần OpenCode V2; version ghép với host | Needs verification — registry 2.3.0; upstream snapshot 2.2.0 |
| DeepSeek Cordis | `@deepseek-ai/cordis` | Context/service/plugin framework | Upstream `cordis` | Fork khác API/cadence; product fit chưa rõ | Needs verification — registry 4.1.0 |
| Cordis upstream | `cordis` | Core upstream Cordis | `@deepseek-ai/cordis` | Latest là prerelease 4.0.0-rc.13 | Needs verification — prerelease |
| HTTP | `hono` | HTTP API/router đa runtime | `Bun.serve`; Elysia | Middleware/auth/MCP adapter có thể chồng lớp | Needs verification — registry 4.13.18 |
| Schema | `zod` | Runtime validation, schema/type inference | Valibot; TypeBox; JSON Schema | Cần khớp major với SDK, tránh nhiều bản Zod | Needs verification — registry 4.6.7 |
| SQLite | Built-in `bun:sqlite` | SQLite driver đồng bộ tích hợp Bun | `better-sqlite3`; `node:sqlite` | Bun-specific; extensions/build/migration cần xác minh | Bun docs xác nhận module tích hợp; không cần npm package nếu dùng |
| Search | Binary upstream `rg` (optional, system PATH) | Backend của tool grep (ADR 0038); chỉ dùng path tuyệt đối ngoài workspace, `--no-config`, env rỗng | `@vscode/ripgrep`; Worker JS có sẵn | Không bundle binary; thiếu `rg` thì fallback Worker (không có context/type) | In use 2026-11-17 — không thêm package; macOS đã kiểm chứng, Linux/Windows chưa |
| Parsing | `web-tree-sitter` hoặc binding phù hợp | Incremental parsing/syntax tree | Native Tree-sitter bindings | WASM/native, grammar ABI và Bun path cần xác minh | Needs verification — web binding registry 0.27.2; chưa chọn binding |
| LSP client | `vscode-jsonrpc` + `vscode-languageserver-protocol` | JSON-RPC framing và LSP protocol types/client messages | Tự triển khai phần protocol tối thiểu | Hannes cần client; `vscode-languageserver` là server library, không đề xuất cho client; Bun streams/types cần kiểm tra | Needs verification — registry versions 10.0.0 / 3.18.5 |
| LSP server (nếu cần) | `vscode-languageserver` | Xây dựng Language Server Protocol server | Tự triển khai nhỏ | Không thay cho LSP client candidate ở dòng trên; Bun support chưa kiểm tra | Needs verification — registry 11.0.0 |
| Browser automation | `playwright` | Browser automation, e2e/control | WebDriver/BiDi | Upstream v1.65.0 nói CI test runner trên Bun 1.4.3; dùng `--bun`, một số hành vi khác Node | Bun runner được ghi nhận upstream; feature set Hannes cần xác minh |
| Telemetry API | `@opentelemetry/api` | Instrumentation API | Vendor API | Cần SDK/exporter riêng; Bun support chưa xác minh | Needs verification — registry 1.10.0 |
| Unit test | Bun built-in `bun:test` | Test runner tích hợp | Vitest | Cần kiểm tra coverage/report/integration cần thiết | API có trong Bun docs; nhu cầu tính năng cần xác minh |
| Unit test alternative | `vitest` | Test runner/Vite ecosystem | `bun:test` | Có thể dùng Bun, không bảo đảm mọi feature; coverage có giới hạn | Needs verification — registry 5.1.0; docs có Bun |
| Property testing | `fast-check` | Sinh input, kiểm tra invariant | Test thủ công; jsverify | Runner integration và seed reproducibility | Needs verification — registry 4.10.2 |
| “9Router” identity | Chưa đề xuất package | Có thể là project/router/gateway | Yêu cầu URL/repository chính xác | npm `9router`, GitHub org `9router`, repo `decolua/9router` không mặc định là một | Needs verification — npm 0.5.119; danh tính chưa rõ |

## Phiên bản registry quan sát

Tra trực tiếp npm registry `dist-tags.latest` ngày 2026-11-13, ngoại trừ các package MCP v2 và LSP protocol được xác minh thêm ngày 2026-11-14. Link package mở metadata registry trực tiếp; version quan sát không phải pin.

| Package | Latest quan sát | Ghi chú |
|---|---:|---|
| [`bun`](https://registry.npmjs.org/bun) | 1.4.4 | npm |
| [`@opentui/core`](https://registry.npmjs.org/%40opentui%2fcore) | 0.8.4 | npm |
| [`ai`](https://registry.npmjs.org/ai) | 7.0.172 | npm |
| [`@ai-sdk/openai-compatible`](https://registry.npmjs.org/%40ai-sdk%2fopenai-compatible) | 3.0.92 | npm |
| [`@modelcontextprotocol/sdk`](https://registry.npmjs.org/%40modelcontextprotocol%2fsdk) | 1.32.2 | v1; v2 dùng package names mới |
| [`@modelcontextprotocol/server`](https://registry.npmjs.org/%40modelcontextprotocol%2fserver) | 2.4.0 | npm latest checked 2026-11-14; upstream tag v2.4.0 |
| [`@modelcontextprotocol/client`](https://registry.npmjs.org/%40modelcontextprotocol%2fclient) | 2.4.0 | npm latest checked 2026-11-14; upstream tag v2.4.0 |
| [`@modelcontextprotocol/core`](https://registry.npmjs.org/%40modelcontextprotocol%2fcore) | 2.4.0 | npm latest checked 2026-11-14; upstream tag v2.4.0 |
| [`@opencode/plugin`](https://registry.npmjs.org/%40opencode%2fplugin) | 2.3.0 | npm; upstream metadata snapshot 2.2.0, version drift |
| [`@deepseek-ai/cordis`](https://registry.npmjs.org/%40deepseek-ai%2fcordis) | 4.1.0 | npm |
| [`cordis`](https://registry.npmjs.org/cordis) | 4.0.0-rc.13 | prerelease |
| [`hono`](https://registry.npmjs.org/hono) | 4.13.18 | npm |
| [`zod`](https://registry.npmjs.org/zod) | 4.6.7 | npm |
| [`better-sqlite3`](https://registry.npmjs.org/better-sqlite3) | 13.1.1 | alternative |
| [`@vscode/ripgrep`](https://registry.npmjs.org/%40vscode%2fripgrep) | 1.18.0 | wrapper alternative |
| [`web-tree-sitter`](https://registry.npmjs.org/web-tree-sitter) | 0.27.2 | candidate |
| [`vscode-languageserver`](https://registry.npmjs.org/vscode-languageserver) | 11.0.0 | server package |
| [`vscode-jsonrpc`](https://registry.npmjs.org/vscode-jsonrpc) | 10.0.0 | LSP client framing |
| [`vscode-languageserver-protocol`](https://registry.npmjs.org/vscode-languageserver-protocol) | 3.18.5 | LSP protocol/client types |
| [`playwright`](https://registry.npmjs.org/playwright) | 1.65.0 | npm |
| [`@opentelemetry/api`](https://registry.npmjs.org/%40opentelemetry%2fapi) | 1.10.0 | API only |
| [`vitest`](https://registry.npmjs.org/vitest) | 5.1.0 | npm |
| [`fast-check`](https://registry.npmjs.org/fast-check) | 4.10.2 | npm |
| [`9router`](https://registry.npmjs.org/9router) | 0.5.119 | danh tính chưa xác định |
| [`typescript`](https://registry.npmjs.org/typescript) | 7.0.2 | thêm registry check 2026-11-14 |

## Nguồn chính

| Chủ đề | Nguồn |
|---|---|
| Bun, SQLite, test | [Bun runtime](https://bun.sh/docs/runtime), [SQLite](https://bun.sh/docs/runtime/sqlite), [bun:test](https://bun.sh/docs/test), [npm bun](https://www.npmjs.com/package/bun) |
| OpenTUI | [Upstream](https://github.com/anomalyco/opentui), [npm package](https://www.npmjs.com/package/@opentui/core) |
| Vercel AI SDK | [Provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management), [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers), [SDK source docs](https://github.com/vercel/ai/blob/main/content/providers/04-openai-compatible-providers/index.mdx) |
| MCP SDK v2 | [Official repo](https://github.com/modelcontextprotocol/typescript-sdk), [v2 server](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server), [v2.4.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) |
| OpenCode | [Plugin build docs](https://opencode.ai/docs/build/plugins/), [upstream plugin package](https://github.com/anomalyco/opencode/tree/dev/packages/plugin) |
| Cordis | [DeepSeek package](https://www.npmjs.com/package/@deepseek-ai/cordis), [DeepSeek harness note](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md), [Upstream Cordis](https://github.com/cordiverse/cordis) |
| Hono / Zod | [Hono](https://hono.dev/docs/), [Zod](https://zod.dev/) |
| SQLite | [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| ripgrep | [Upstream](https://github.com/BurntSushi/ripgrep), [npm wrapper](https://www.npmjs.com/package/@vscode/ripgrep) |
| Tree-sitter | [Official docs](https://tree-sitter.github.io/tree-sitter/), [web binding](https://www.npmjs.com/package/web-tree-sitter) |
| LSP client / JSON-RPC | [vscode-jsonrpc](https://github.com/microsoft/vscode-languageserver-node/tree/main/jsonrpc), [vscode-languageserver-protocol](https://github.com/microsoft/vscode-languageserver-node/tree/main/protocol), [upstream repository](https://github.com/microsoft/vscode-languageserver-node) |
| Playwright / Bun | [v1.65.0 release](https://github.com/microsoft/playwright/releases/tag/v1.65.0), [Bun discussion](https://github.com/microsoft/playwright/issues/38095) |
| OpenTelemetry | [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js), [API npm](https://www.npmjs.com/package/@opentelemetry/api) |
| Vitest / fast-check | [Vitest guide](https://vitest.dev/guide/), [coverage](https://vitest.dev/guide/coverage), [fast-check](https://fast-check.dev/docs/introduction/) |
| 9Router | [npm](https://www.npmjs.com/package/9router), [GitHub org](https://github.com/9router), [decolua/9router](https://github.com/decolua/9router) |

**Cần xác minh tiếp:** OS/đóng gói; Bun support riêng cho LSP/JSON-RPC, exporters, parser và TUI; MCP transport/auth; nhu cầu OpenCode plugin; Cordis fork; ý nghĩa “9Router”; compiler/test toolchain. Không có dependency nào được pin ở đây.

## PA1 evaluated selection (2026-11-14)

Registry evidence is read directly from https://registry.npmjs.org; exact versions below are selected before installation. Bun runtime 1.4.4 is installed in a temporary tools prefix, not globally. SDK packages require Node >=22 APIs; Bun interoperability must pass this slice tests, not assumed from imports. No install scripts for workspace dependencies.

| Package | Version | License | Provenance | Threat/compatibility review |
|---|---|---|---|---|
| `bun` | 1.4.4 | MIT | git+https://github.com/oven-sh/bun.git; registry integrity recorded in lock; no registry attestation advertised | Dev/runtime toolchain; runs local code; platform binaries require trusted registry integrity |
| `typescript` | 7.0.2 | Apache-2.0 | git+https://github.com/microsoft/TypeScript.git; registry integrity recorded in lock; no registry attestation advertised | Dev/runtime toolchain; runs local code; platform binaries require trusted registry integrity |
| `@types/bun` | 1.4.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped.git; registry integrity recorded in lock; no registry attestation advertised | Dev/runtime toolchain; runs local code; platform binaries require trusted registry integrity |
| `ai` | 7.0.173 | Apache-2.0 | https://github.com/vercel/ai; registry integrity recorded in lock; SLSA attestation advertised | HTTP generation parser accesses prompts/keys; disable retries/telemetry and gate target; test Bun fetch/streams/cancel |
| `@ai-sdk/openai` | 4.0.118 | Apache-2.0 | https://github.com/vercel/ai; registry integrity recorded in lock; SLSA attestation advertised | HTTP generation parser accesses prompts/keys; disable retries/telemetry and gate target; test Bun fetch/streams/cancel |
| `@ai-sdk/anthropic` | 4.0.105 | Apache-2.0 | https://github.com/vercel/ai; registry integrity recorded in lock; SLSA attestation advertised | HTTP generation parser accesses prompts/keys; disable retries/telemetry and gate target; test Bun fetch/streams/cancel |
| `@ai-sdk/google` | 4.0.121 | Apache-2.0 | https://github.com/vercel/ai; registry integrity recorded in lock; SLSA attestation advertised | HTTP generation parser accesses prompts/keys; disable retries/telemetry and gate target; test Bun fetch/streams/cancel |
| `@ai-sdk/openai-compatible` | 3.0.92 | Apache-2.0 | https://github.com/vercel/ai; registry integrity recorded in lock; SLSA attestation advertised | HTTP generation parser accesses prompts/keys; disable retries/telemetry and gate target; test Bun fetch/streams/cancel |
| `zod` | 4.6.7 | MIT | git+https://github.com/colinhacks/zod.git; registry integrity recorded in lock; SLSA attestation advertised | Pure JS/TS schemas; no credential/network access on import |
| `@napi-rs/keyring` | 2.1.2 | MIT | git+https://github.com/Brooooooklyn/keyring-node.git; registry integrity recorded in lock; SLSA attestation advertised | Native N-API binary accesses OS credential store; supported OS backends differ, no plaintext fallback; verify macOS locally |

`@opencode/ai` 2.3.0 (MIT, SLSA advertised) evaluated but not installed: Effect 4.1.0, @opencode/schema, AWS credential providers, Google auth and media protocols broaden dependency/security surface. Vercel package licenses are Apache-2.0 in the selected npm artifacts (root repo license detection is not sufficient). @napi-rs/keyring includes platform optional binary packages; Bun supports N-API but OS credential backend availability is not guaranteed. Env-reference mode is the explicit portable alternative; no secret values in settings. Transitive lock inventory and audit are reviewed after resolution.

### Tool schema validation correction

Selected `ajv` 8.20.0, MIT, https://github.com/ajv-validator/ajv.git, registry inspected 2026-11-14. A negative fixture demonstrated that passing bare JSON Schema to AI SDK jsonSchema does not itself guarantee tool input validation. Ajv performs explicit synchronous draft-07 validation at the adapter boundary. Disable mutation/coercion/default insertion, disallow async validation, no compileAsync/loadSchema or external reference loading. Compilation can execute generated code and expensive hostile schemas remain a resource risk; descriptors are bounded and only supplied by trusted application ports in this slice (no plugins/tools enabled). Pure JS, Bun verified by tests; no install hooks or native ABI. Transitives: fast-deep-equal, fast-uri, json-schema-traverse, require-from-string; lock/inventory reviewed. No provenance attestation advertised for Ajv.

## SUB1: external official provider runtimes (2026-11-14)

No new npm dependency/install or lockfile change. Provider transport integration uses Node/Bun built-ins and user-installed official CLIs. This inventory evaluates executable prerequisites; presence is not subscription access.

| Runtime | Version/source inspected | License/provenance | Bun/OS and threat surface |
|---|---|---|---|
| ~~OpenAI Codex CLI~~ (removed, ADR 0049) | Was installed 0.167.0; official app-server schemas | Official OpenAI distribution; open-source core Apache-2.0, [source](https://github.com/openai/codex) | External process, not a Bun module. Native macOS arm64 initialization observed; OAuth file/profile, callbacks, network and builtin tools require explicit controls. |
| GitHub Copilot CLI | Installed 1.0.107, RPC protocol 3; current SDK source | Official GitHub CLI distribution governed by GitHub terms; SDK source MIT does not relicense the CLI. [SDK](https://github.com/github/copilot-sdk) | External process. Native macOS initialization observed. Fixed argv, no updates, private home/keytar disabled, empty tools/config discovery disabled. |
| Google Gemini CLI | Official source commit 4ed06ed0ddc523a6d356a4ad35ddfea331041888; source version 0.70.0-nightly.20261110.g1603e9bab | Google official repository, Apache-2.0 | External Node >=20 CLI; not installed here. Needs installed-version/OS acceptance. Browser auth, credential files and tools must remain isolated/denied. |
| Qwen Code CLI | Official source commit dab5253c628be736c8fdd43c9d9e36e8d1e9ff00; source version 0.27.2 | Official QwenLM repository, Apache-2.0 source headers | External Node >=22 CLI; not installed here. Needs installed-version/OS acceptance, including OAuth advertisement inconsistency and exact deny semantics. |

Never automatically fetch arbitrary executables or forward workspace access just because these are separate processes. See [ADR 0008](../adr/0008-subscription-runtime-auth.md) and [security/evidence](subscription-auth.md).

## apply_patch system filesystem binding (ADR 0025)

No npm/native helper installed. Selected existing Bun 1.4.4 `bun:ffi` (Bun MIT, official oven-sh runtime) dynamically binds OS openat/mkdirat/linkat/renameat/unlinkat and thread-local errno. macOS uses `/usr/lib/libSystem.B.dylib` (system-provided Apple/BSD components); Linux glibc uses fixed system libc paths (system LGPL runtime, no redistribution). No library path from models, workspace, PATH or LD_LIBRARY_PATH is accepted. Explicit close-on-exec flags: Darwin 0x1000000, Linux 0x80000. Threat surface is narrow native syscall ABI/pointer marshalling; NUL-terminated buffers remain live for each synchronous call, directory/file handles are closed, errors fail closed. macOS 15.8.1/Bun 1.4.4 verified by real OS fixtures; Linux glibc needs CI, other hosts unavailable. [Bun FFI documentation](https://bun.sh/docs/runtime/ffi), accessed 2026-11-15; rolling docs, deployment ABI must be reverified on upgrade.

## Execution container candidate — 2026-11-16

The execution milestone authorizes evaluation of the official `oven/bun:1.4.4` Linux image (Bun MIT; Debian base packages retain their respective licenses). Provenance: https://bun.com/guides/ecosystem/docker and https://hub.docker.com/r/oven/bun. The same Bun version is already pinned in this repository. Runtime code must pin the resolved sha256 digest, not a mutable tag; no command may pull images. Host setup may pull this version for acceptance. No npm dependency is added. Docker Engine is an external trusted host capability; require local Linux containers, default seccomp, private namespaces, no network/capability escalation and no daemon socket in the command. macOS native Seatbelt and unverified hosts remain closed. Supply-chain/kernel/daemon trust is a limitation; passing fixture tests alone is not approval to enable the backend. Final digest/host acceptance is recorded in ADR0032.

Resolved and tested 2026-11-16: `oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`, linux/arm64, Debian 13, Bun 1.4.4. Docker Engine 29.8.2 on OrbStack Linux 7.2.12/cgroup2/seccomp, Darwin 24.6.0 arm64 host. A transient registry 502 was retried once during authorized setup; the runtime never pulls. Existing cached Piston/Redis images were inspected during research but are not runtime dependencies or permitted execution images. No npm dependency/license change.

### Optional git-enabled command image (ADR 0034, evaluated 2026-11-16)

- **Name/version:** Debian `git` `1:2.47.3-0+deb13u1` (trixie main; package SHA256 `8c6b1e96b226211260d7814472215a8a1ed38ee37400c421d454391c1807cb5a`, depends on perl, libcurl3t64-gnutls, libexpat1, libpcre2-8-0, zlib1g, liberror-perl, git-man), installed on top of the pinned `oven/bun@sha256:1d22548f…548f1d` base.
- **License:** git GPL-2.0-only; dependencies under their Debian licenses. Used only as an executable inside the sandbox image; nothing is linked into Futryn.
- **Provenance:** deb.debian.org via the base image's apt sources (snapshot `20261020T213255Z`), verified by apt's Debian archive signatures at build time.
- **Build:** explicit host setup only: `bun scripts/build-exec-image.ts` (needs network). Tag `futryn-exec:git-<recipe hash prefix>`; the runtime never builds or pulls.
- **Runtime verification:** accepted only when its layer chain equals the pinned base chain plus exactly one layer and the label `futryn.exec.recipe` equals the recipe hash; the container is then created from the image **ID**, not the tag. Otherwise the base image (no git) is used and `git` is not advertised.
- **Bun/OS compatibility:** built and tested linux/arm64 on Docker Engine 29.8.2 (OrbStack, Darwin 24.6.0 arm64). amd64 and standalone Linux hosts: Needs verification.
- **Threat surface:** git can read `.git` (mounted read-only) including `.git/config`; it cannot write it. Network stays off unless a command's network escalation is approved. No npm dependency or lockfile change.

### Formatter: Prettier (evaluated 2026-11-16)

- **Name/version:** `prettier` **3.9.10**, pinned exactly (published 2026-10-10; 3.10.x was under two weeks old and is not used). Dev dependency only; never imported by product code or shipped in a runtime path.
- **License:** MIT. **Provenance:** npm `prettier`, source https://github.com/prettier/prettier, integrity `sha512-skGHTH1Yb9QvaTC4hWnRTzEYtCpApF0UMBPz+t/0ZPzP8ihefo/btKd+QA7pUE0fEwA1SbS/NmhyEcstdXOIdA==`.
- **Dependencies / install scripts:** none / none (installed with `--ignore-scripts` anyway).
- **Bun/OS compatibility:** pure JavaScript; runs under Bun 1.4.4 on macOS/Linux/Windows. Verified on Darwin arm64.
- **Threat surface:** runs locally on source files when a developer or `bun run lint` invokes it; no network access. Layout-only changes; behavior is verified by the full test suites after formatting.
- **Purpose:** consistent, readable formatting of all TypeScript/JavaScript (`bun run format`); `bun run lint` checks it so unformatted code cannot return.

## Wave 1 (plan D1, user-approved 2026-11-17)

### Shell parsing: web-tree-sitter + tree-sitter-bash (ADR 0040, added 2026-11-17)

- **Name/version:** `web-tree-sitter` **0.27.1** (published 2026-10-08; 0.27.2 of 2026-11-07 was under two weeks old and is not used), `tree-sitter-bash` **0.25.1** (published 2025), both pinned exactly in `packages/tools/package.json`.
- **License:** MIT (both). **Provenance:** npm; sources https://github.com/tree-sitter/tree-sitter (lib/binding_web) and https://github.com/tree-sitter/tree-sitter-bash. Integrity: `web-tree-sitter` `sha512-qtx0VyUyNRHtL3ze7+v0hCKB/sLcAmY7ZAVp/ZK/bCj0yED8ptvNrr7Vd7DwDyKDWN9baqcUx4uaD2r2ql+6IA==`, `tree-sitter-bash` `sha512-7hMytuYIMoXOq24yRulgIxthE9YmggZIOHCyPTTuJcu6EU54tYD+4G39cUb28kxC6jMf/AbPfWGLQtgPTdh3xw==`.
- **Dependencies / install scripts:** `web-tree-sitter` none. `tree-sitter-bash` depends on `node-addon-api` 8.9.2 (MIT) and `node-gyp-build` 4.8.4 (MIT) for its optional native binding and declares an install script; Futryn installs with `--ignore-scripts`, never builds or loads the native binding, and uses only the prebuilt `tree-sitter-bash.wasm` shipped in the package. The optional peer `tree-sitter` (native) is not installed.
- **Bun/OS compatibility:** WASM, loaded with `Parser.init()` + `Language.load()`; verified under Bun 1.4.4 on Darwin arm64 (parser load ≈ 25 ms once per process). Linux/Windows: Needs verification (pure WASM, no native code).
- **Threat surface:** parses command text the model proposed; no I/O beyond reading the two WASM files from this package's `node_modules`. A load failure makes every command "unverified" (asks), never "safe".
- **Purpose:** split compound shell commands and find dangerous sub-commands, as Codex does with tree-sitter-bash.

### MCP HTTP SDK and HTML conversion (ADR 0044, added 2026-11-17)

- **Direct pins / licenses:** `@modelcontextprotocol/sdk` **1.32.2** (MIT),
  `turndown` **7.2.5** (MIT), dev-only `@types/turndown` **5.0.6** (MIT).
  Registry manifests/license fields checked at https://registry.npmjs.org on
  2026-11-17; exact tarball integrity and transitive resolution are in `bun.lock`.
- **Sources:** https://github.com/modelcontextprotocol/typescript-sdk,
  https://github.com/mixmark-io/turndown,
  https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/turndown.
- **Install:** `bun install --ignore-scripts`; no dependency lifecycle code is run.
  SDK server/auth dependencies are installed as upstream declares them but Futryn
  imports only client/Streamable HTTP entrypoints. No stdio/OAuth or sampling/root
  services are exposed. Transitive packages retain their own licenses in installed
  manifests; the lock records their identities, not a new authorization to execute.
- **Threat surface:** SDK parses untrusted JSON-RPC/SSE and holds search credentials;
  response streams are bounded, cancelled, redacted and disallow redirects/cookies.
  Turndown parses HTML using its inert DOM dependency (`@mixmark-io/domino`);
  it never evaluates scripts or fetches subresources. Markdown/text conversion
  removes scripts, styles, embedded frames/objects and templates.
- **Compatibility evidence:** real local HTTP SDK and pinned Node/Bun HTTP transport
  fixtures under Bun 1.4.4 on Darwin arm64. Other OS runtimes and live provider
  endpoints remain **Needs verification**; passing fixtures are not live evidence.
