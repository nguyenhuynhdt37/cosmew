# Quy tắc cho coding agents

## Phạm vi đã cho phép

- **Tool architecture migration (2026-11-15):** refactor `read`, `glob`, `grep`, `exec_command` theo registry → router → handler → orchestrator → runtime; giữ `ToolPort` làm boundary của core. Cho phép sửa `packages/tools`, consumers cần thiết, tests và docs liên quan; không thêm tool, dependency hay package mới. [ADR 0024](docs/adr/0024-tool-execution-architecture.md).
- **PA1/TUI1:** provider/auth, official subscription transports, CLI/TUI và theme engine trong contracts, models, security, persistence, core, SDK và apps. [ADR 0005](docs/adr/0005-provider-auth-product.md), [ADR 0006](docs/adr/0006-futryn-tui-and-theme-engine.md), [ADR 0008](docs/adr/0008-subscription-runtime-auth.md).
- **TOOLS1:** workspace `read`/`glob`/`grep`, permission engine, bounded core tool loop; Codex chỉ gọi các tool Hannes kiểm soát qua core/permission engine. [ADR 0017](docs/adr/0017-read-only-tools-and-permission-engine.md), [ADR 0018](docs/adr/0018-codex-read-tool-bridge.md).
- **Context/exploration/activity:** bounded AGENTS loading qua injected authorized reader; 16 vòng/32 calls mỗi lượt và unchanged-read notices; ordered TUI transcript/Explored/thinking/status. [ADR 0019](docs/adr/0019-project-context-loader.md), [ADR 0020](docs/adr/0020-progressive-code-exploration.md), [ADR 0021](docs/adr/0021-codex-style-activity-presentation.md).
- **Task 03A/03B:** one-shot read-only/no-network process foundation, supervision, bounded output, truthful lifecycle reporting và adversarial OS tests. **Production exec_command vẫn CLOSED** cho đến khi chứng minh kernel/container lifetime containment, kể cả detached/reparented descendants và supervisor crash. killpg, enumeration hay process riêng không phải containment. Không signal process ngoài run sở hữu. [ADR 0022](docs/adr/0022-sandboxed-exec-command-foundation.md), [ADR 0023](docs/adr/0023-process-supervision.md).

Migration không mở PTY, write_stdin, write/edit/apply_patch tools, network tools, MCP, plugins, code-intel, RAG, memory hay delegated agents. Các subsystem này vẫn **Not implemented**; giữ source placeholders ngoài scope rỗng. Official subscription transports không phải delegated-task scheduler.

## Security và ownership bắt buộc

- Exposure/registration không cấp execution authority. Mọi invocation phải qua validation, workspace normalization, security policy, approval khi cần, revalidation, audit và sandbox khi applicable. Không bypass qua native Codex/runtime tools, SDK, plugins, MCP, recovery hoặc đường gọi khác. Không fallback unsandboxed khi sandbox lỗi.
- Deny thắng grants; approval bind đúng capability/target/command/cwd/sandbox policy, có cancellation/expiry/revoke. Không đọc ngoài approved workspace hoặc tự thêm user-configured permission bypass.
- Core điều phối qua ports; security quyết định quyền; workspace kiểm soát filesystem; persistence sở hữu durable writes; adapters chỉ chuyển đổi. Plugin tương lai chỉ nhận granted capabilities, không raw shell/database/secrets/full workspace context.
- Giữ Agent Loop, provider adapters, subscription isolation, session grants, usage và persisted tool-call/result pairing. Không replay execution qua history hoặc coi exposure là chứng minh tool an toàn.
- Không commit credentials, raw prompts chứa bí mật hay output nhạy cảm. Log và kết quả phải redacted/bounded.

## Quy trình và kiểm chứng

- Trước implementation đọc phần liên quan của [docs](docs/README.md), [events contract](docs/contracts/agent-events.md), [dependency rules](docs/architecture/dependency-rules.md), [module ownership](docs/architecture/repository-map.md), [roadmap](docs/delivery/implementation-roadmap.md). Chỉ mở rộng slice được giao; nguồn rỗng không chứng minh tính năng hoạt động.
- Public contract changes cần ADR, migration/versioning và cập nhật consumers. Không deep-import private files giữa packages, đổi framework/ngôn ngữ hay mở rộng package tree ngoài scope.
- Dependency mới phải được đánh giá tên/version/license/provenance/Bun/OS compatibility/threat surface và cập nhật catalog trước install. Có thể install dependencies đã duyệt, typecheck/test/run CLI/TUI (`hannes tui`, `hannes themes`).
- Viết tests có ý nghĩa cho invariants, permissions, conformance, cancellation và failure modes; cập nhật docs ngắn gọn cùng thay đổi. Không dùng mock success chứng minh OS/live compatibility.
- Upstream evidence ghi URL/path, ngày, revision và giới hạn; chưa xác minh thì ghi Needs verification. Không tuyên bố Product MVP complete trước interactive acceptance thật; GUI compatibility cần host và acceptance riêng.
- Phase 0 còn lại chỉ filesystem/content/link inspection; executable fixtures chỉ chứng minh scoped behavior. Native vault, authenticated providers và live verification được ghi riêng.
