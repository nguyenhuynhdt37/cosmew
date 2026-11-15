# Quy tắc phụ thuộc

> Current implementation scope: [Provider/Auth PA1](../delivery/provider-auth-plan.md) and [ADR 0005](../adr/0005-provider-auth-product.md). Remaining Phase 0 descriptions below are historical plans, not feature claims.

**PA1 graph inspected; other planned edges remain Not implemented.** Mọi package được phép phụ thuộc `contracts`; contracts không phụ thuộc package Hannes nào và không xuất foreign SDK types. Public entry là `src/index.ts` tương lai; file khác private trừ subpath đã được ADR công bố. Không import trực tiếp `src/` của package khác. Không circular dependencies, kể cả type-only imports và event command cycles.

| Consumer | Hannes dependencies được phép ngoài contracts | Lý do |
|---|---|---|
| core | Không | Gọi injected model/tool/policy/store/agent ports |
| models | Không | Chuyển provider wire format |
| workspace | Không | Filesystem/version/snapshot ownership |
| security | Không | Policies và audit qua ports, không gọi tool executor |
| persistence | Không | SQLite transaction ownership |
| code-intel | workspace | Đọc normalized snapshots, không ghi code |
| tools | workspace, security, code-intel | Dispatcher kiểm quyền trước executor |
| mcp | security | Map permissions, register tool descriptors qua port |
| extensions | security | Grants và mediated service ports |
| compat-opencode / compat-deepseek | extensions | Chuyển hooks/services; không import core internals |
| agents | Không | Scheduler gọi runtime ports; không import core |
| sdk | Không | Client protocol, không nhúng core |
| testkit | Không | Fakes hợp đồng, không production dependency |
| apps/cli, apps/server | Implementations cần composition | Chỉ composition root được nối graph |
| apps/tui | sdk | UI chỉ command/event protocol |
| apps/web, apps/desktop | Chưa có imports | Host tương lai cần review |

Dependencies của tools lên code-intel chỉ cho read/search; code-intel không biết tools. Extension/tool/MCP registration dùng injected registrars trong contracts, tránh extensions↔tools hoặc mcp↔tools. Agents nhận RunLauncher port do root cung cấp, tránh agents↔core. Store không import core; audit sink inject, tránh security↔persistence.

Permission invariant: validate → normalize target → evaluate policy → persist intent/approval evidence → revalidate lease/target → execute → record outcome. Mọi đường thực thi, kể cả plugin/MCP/sidecar, phải đi qua cổng này. Kiểm tra trước UI confirmation không đủ nếu target thay đổi sau đó.

DAG graph, public entry checks và side-effect enforcement sẽ thành checks ở phase triển khai. Phase 0 chỉ mô tả. ADR bắt buộc cho dependency edge mới, shared ownership, public type/version thay đổi, process boundary hay thay security model.

Task 01 ([ADR 0019](../adr/0019-project-context-loader.md)) adds no package edges: workspace discovery receives an authorized-reader port from contracts; tools implements it with the existing workspace/security dependencies; core receives only ProjectContextPort. CLI composes these; SDK/TUI consume content-free reports. Core never imports workspace/tools/security/SDK implementations.

Task 03A ([ADR 0022](../adr/0022-sandboxed-exec-command-foundation.md)): contracts own CommandRuntime; tools owns the candidate OS/process executor, security owns process.execute decisions, CLI composes the runtime and TUI only renders events. No new package edges or dependencies. Raw process launch helpers remain tools-private. Production execution stays disabled until the complete security gate passes.
