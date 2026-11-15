# Quy tắc cho coding agents

Repository đang ở **Provider & Authentication (PA1)** và **FUTRYN Terminal UI & Advanced Theme Engine (TUI1)** implementation slice, được người dùng cho phép ngày 2026-11-14. Cho phép implementation, manifests, dependencies đã đánh giá, tooling và executable tests trong `contracts`, `models`, `security`, `persistence`, `core`, `packages/sdk`, `apps/tui`, `apps/cli` và tests/docs liên quan. Các subsystem khác (tool shell, tool ghi file, MCP, plugin host, subagent ngoài) vẫn mang trạng thái `Not implemented`; giữ placeholders rỗng và không thêm package ngoài phạm vi này.

**TOOLS1** (người dùng cho phép ngày 2026-11-15, [ADR 0017](docs/adr/0017-read-only-tools-and-permission-engine.md)): cho phép triển khai ba công cụ **chỉ đọc** `read`, `glob`, `grep` trong workspace đã được đồng ý, permission engine trong `security`, kích hoạt `packages/tools` và `packages/workspace`, vòng lặp tool có giới hạn trong `core`, cùng contracts/tests/docs liên quan. Vẫn cấm: ghi/sửa file, shell/process, network tool, đọc ngoài workspace, luật quyền do người dùng cấu hình và mọi ngoại lệ bypass permission engine.

**TOOLS1-Codex** (người dùng cho phép bổ sung ngày 2026-11-15, [ADR 0018](docs/adr/0018-codex-read-tool-bridge.md)): riêng ChatGPT/Codex được gọi `read`/`glob`/`grep` của Hannes qua core và permission engine. Runtime builtin tools, shell, write, MCP và đọc ngoài workspace vẫn bị từ chối.

**Task 01 — Project Context Loader** (người dùng cho phép ngày 2026-11-15, [ADR 0019](docs/adr/0019-project-context-loader.md)): tự khám phá AGENTS.md/AGENTS.override.md trong workspace đã đồng ý, đọc có giới hạn qua permission engine, truyền user/project context vào core qua injected port. Không RAG/LSP/MCP/memory/shell/write tools, không mở rộng task khác.

**Task 02 — Progressive Code Exploration** (người dùng cho phép ngày 2026-11-15, [ADR 0020](docs/adr/0020-progressive-code-exploration.md)): hướng dẫn khám phá dùng chung cho direct provider và Codex, ngân sách vòng lặp có giới hạn (16 vòng, 32 lần gọi mỗi lượt), báo đọc lại nội dung không đổi. Không thêm tool mới, shell, write, MCP, RAG, memory hay Live Activity TUI.

Đọc [ADR 0005](docs/adr/0005-provider-auth-product.md), [ADR 0006](docs/adr/0006-futryn-tui-and-theme-engine.md), [PA1 plan](docs/delivery/provider-auth-plan.md) và [TUI1 research](docs/delivery/futryn-tui-upstream-research.md) trước khi mở rộng slice. Có thể install/typecheck/test/run CLI và TUI (`hannes tui`, `hannes themes`). Không triển khai shell, tool ghi file, plugins hay delegated agents trong slice này (công cụ đọc chỉ theo TOOLS1). Ngoại lệ SUB1 theo yêu cầu bổ sung của người dùng: provider transports chính thức cho subscription trong [ADR 0008](docs/adr/0008-subscription-runtime-auth.md), với profile riêng, credential vault, từ chối runtime builtin tools/permission và không phải delegated task scheduler; ngoại lệ đọc do Hannes kiểm soát chỉ theo ADR 0018. Không tuyên bố Product MVP complete trước acceptance evidence trên môi trường tương tác thật.
Trước mọi phase triển khai, đọc [docs](docs/README.md), toàn bộ [contracts](docs/contracts/agent-events.md), [dependency rules](docs/architecture/dependency-rules.md), [module ownership](docs/architecture/repository-map.md) và [roadmap](docs/delivery/implementation-roadmap.md). Chỉ triển khai phạm vi phase được giao; nguồn rỗng không phải bằng chứng tính năng hoạt động.

- Public contracts chỉ được thay đổi cùng ADR, migration/versioning và cập nhật consumers. Không deep-import private files giữa packages.
- Không thêm dependency chưa đánh giá tên package, phiên bản, giấy phép, provenance, Bun/OS compatibility và threat surface; cập nhật catalog trước khi cài trong phase được phép.
- Không bypass permission engine, kể cả builtin tools, plugin hooks, MCP, SDK, subagents và recovery. Process riêng không đồng nghĩa sandbox.
- Plugin chỉ nhận capability được cấp; không truyền database handle, raw shell, secrets hoặc toàn quyền workspace qua context.
- Tôn trọng ownership: core điều phối; security quyết định quyền; workspace kiểm soát filesystem; persistence sở hữu durable writes; adapters chỉ chuyển đổi.
- Trong phase triển khai, viết tests có ý nghĩa cho invariants, conformance, cancellation và failure modes; cập nhật docs cùng thay đổi. Không dùng mock success để chứng minh compatibility.
- Không tự chuyển ngôn ngữ/framework hoặc mở rộng package tree. Thay đổi ranh giới cần ADR và phạm vi được giao.
- Không commit credentials, raw prompts chứa bí mật hoặc output nhạy cảm. Log phải redacted.
- Nghiên cứu upstream phải lưu URL/path, ngày truy cập, revision và giới hạn bằng chứng. `Needs verification` tốt hơn suy đoán.
- Tất cả tính năng chưa triển khai mang trạng thái `Not implemented`. GUI compatibility cần GUI host riêng và acceptance tests riêng.

Các vùng còn ở Phase 0 được xác minh bằng filesystem/content/link inspection. PA1 dùng executable checks và fixture tests; live verification phải được ghi riêng.
