# ADR 0056 — Skills: discovery, metadata và đọc qua dispatcher

- Ngày: 2026-11-18
- Trạng thái: Implemented — fixture verified; OS/live verification có giới hạn bên dưới
- Phạm vi: chỉ wave 2 S3 / W11. Contract 1.27 → **1.28**, SQLite giữ schema 8; không dependency mới.

## Quyết định

1. `workspace` sở hữu `SkillCatalog`, parser frontmatter và discovery snapshot, không quyết định quyền. Quét từ workspace lên repository gần nhất (dấu `.git`, không chạy chương trình từ Git config), gần trước xa sau; trong mỗi scope: `.futryn/skills`, `.agents/skills`, `.claude/skills`. Sau project là ba root cùng tên dưới home, cuối cùng là `packages/workspace/skills/skill-creator/SKILL.md` do Futryn viết. Bỏ scope/root/con cháu vendored hoặc Git ignored bằng cùng cơ chế hardened Git của nested AGENTS. Không có repo thì chỉ workspace. Root được canonical hóa; không đi qua symlink trong cây skill. Scan giới hạn độ sâu 6 và 10.000 directories; warning khi vượt. Tên trùng giữ entry đầu, ghi `DUPLICATE_NAME`. Không quét toàn bộ repo để tìm skill ở scope con chưa mở.
2. File UTF-8, tối đa **65.536 byte**, frontmatter `---`; `name` bắt buộc, 1–64 ASCII letters/digits/underscore/hyphen, bắt đầu bằng letter/digit; `description` string không rỗng ≤1.024 ký tự. `disable-model-invocation` boolean, `argument-hint` string là tùy chọn. Không có YAML dependency trong repo: parser tối giản hỗ trợ scalar plain/quoted, boolean, `|`/`>` block, comment trên dòng riêng và comment scalar plain. Không triển khai YAML anchors/tags, flow structures cho các key được hỗ trợ, quoted/multiline keys hay scalar repair của Codex. Thiếu/sai/quá lớn/binary/UTF-8 lỗi → bỏ skill, trả diagnostic, không hỏng phiên. Các field khác, đặc biệt **`allowed-tools`, bị bỏ qua; không cấp quyền**.
3. Catalog model chỉ có name/description/short path, JSON escaped và có nhãn metadata không tin cậy. Ngân sách **8.000 ký tự** tính cả header/cảnh báo; giảm mô tả đồng đều, tới rỗng nếu cần, sau đó bỏ phần đuôi, có warning. `disable-model-invocation: true` không xuất hiện trong catalog model; vẫn có trong SDK và `/skills`, vẫn gọi trực tiếp hoặc qua tool theo tên được. Danh sách qua `ModelRequest.instructions` (adapter hiện có chuyển sang system/developer tùy provider), với nhãn dữ liệu không có quyền; **không nạp thân skill vào authority/system instructions**. Core tính token metadata trong context estimate. Trần tổng instructions tăng 8.000 → 32.768 để chứa host guidance + catalog; budget riêng catalog giữ 8.000.
4. `skill {name}` là builtin `fs.read`, parallel. `ToolDispatcher`/orchestrator vẫn validate → resolve → read policy → approval → revalidate → execute → audit/redact. Registry lookup theo tên, không nhận path. Resolver riêng chỉ nhận đúng `SKILL.md` của entry đã phát hiện; revalidate cả đường logical và canonical. `WorkspaceRoot.readBytes` mở `O_NOFOLLOW`, kiểm realpath, file type và inode/device sau open, đọc bounded rồi parse lại. Symlink root/file hay swap lúc approval đều thất bại. Snapshot quyết định đọc chặn cả race allow → ask giữa authorization và execution (fixture tái hiện fail trước khi sửa). Policy Read của project vẫn thắng. Kết quả có `content` và optional `ToolResult.skillDirectory` (thông tin, không grant); core đưa directory vào tool message. Riêng skill dùng trần output 65.536 byte sau redact để không cắt file hợp lệ; redact làm vượt trần thì đánh dấu truncated.
5. Core nhận injected `SkillsPort`, không import workspace/tools/security. Chỉ sau folder consent, CLI composition root nạp explicit `/name [args]` và `$name` bằng chính `ToolPort`/dispatcher. Thân được gắn nhãn dữ liệu dưới user/host rules, đưa vào user context **của lượt đó**, không lưu thân vào durable conversation. `$ARGUMENTS` thay trong body bằng callback để giữ literal `$&` và các replacement metacharacters. Mention trùng trong cùng prompt chỉ nạp một lần; unknown mention không đổi prompt. Steering/carry cũng được kiểm tra. Đọc lỗi/denied/truncated trả note cho model, không tự mở quyền. Tool call do model vẫn qua turn journal như mọi tool khác. Canonical `SLASH_COMMANDS`, aliases và legacy routes được giữ trước skill; `/skills` là command canonical, liệt kê source/path/errors/warnings trong transcript bounded. Catalog là snapshot theo client sau consent; mở client mới để discover file mới, body revalidate mỗi lần gọi.
6. Script không tự chạy: model dùng `exec_command`, qua policy/approval/sandbox thường. Native macOS runtime nhận **chỉ các directory skill đã phát hiện**, thêm read/ancestor-metadata rules; resource user luôn read-only kể cả khi home là workspace; resource khác ngoài workspace cũng read-only kể cả dưới `/private/tmp`, không expose cả home/root skills. Project `.futryn/skills` cần read exception sau deny `.futryn` chung để script đọc được; protected state/secret/exact-file denies vẫn áp dụng sau đó. Không cấp exception này cho LSP helper services.
7. Ngoại lệ state hẹp vì default state là `~/.futryn`: discovery được xét `~/.futryn/skills/.../SKILL.md`; dispatcher chỉ bỏ state-directory gate cho **đúng file user đã đăng ký** dưới `<state>/skills/`. Read deny rule vẫn chặn được, `read` thường không hưởng ngoại lệ. Seatbelt chỉ loại directory tài nguyên skill đã phát hiện dưới `<state>/skills/` khỏi state **read** deny; state **write** deny luôn nguyên vẹn. Database/credential/log và phần còn lại của state vẫn không đọc/ghi được. Không có reader path tùy ý ngoài workspace.

## SDK, consumers và tương thích

### Sửa hồi quy S3 (2026-11-18)

- Chỉ offer descriptor `skill` và metadata catalog khi có ít nhất một skill project/user với `disableModelInvocation: false`. Catalog rỗng, chỉ có system creator, hoặc chỉ có skill disabled đều không thêm tool/instructions vào model request. Khi có skill phù hợp, catalog vẫn bao gồm system creator. SDK `/skills`, slash/mention và dispatcher read/policy/audit vẫn hoạt động cho system/disabled skills. Đây là sửa điều kiện exposure trong contract 1.28, không đổi public shape/version. Chọn cách này để bundled creator không thay đổi mọi request của project chưa dùng skills; không mở rộng expected tool lists của các test cũ.
- Các fixture e2e read-tools, progressive-exploration và project-context dùng `skillsHome` tạm riêng, tránh metadata từ home thật làm lệch exact tool lists. Composer fixture bổ sung `isSkillCommand` của SDK; lỗi draft là thiếu method trong test double, không phải lỗi giữ draft của controller.
- Cargo test chạy hai runtime probes và 32 lệnh Seatbelt riêng, nên tăng timeout tổng từ mặc định 5 giây lên 30 giây, giữ nguyên timeout từng lệnh và mọi assertion bảo mật. Log gốc timeout rồi `UNSUPPORTED` phù hợp với cleanup đóng runtime khi body chưa xong; chưa xác minh thời gian chạy ngoài sandbox. Không đổi profile/runtime để chữa timeout: không có skill directories thì các nhánh profile S3 không phát sinh rule mới; thêm assertion profile với arrays rỗng giống hệt options không có skills.
- Kiểm tra lại: `bun run typecheck`, `bun run lint`; unit/composer/skills/profile: **32 pass, 1 skip, 0 fail**. E2e bằng preload `tests/support/in-process-loopback.ts`, bốn file progressive-exploration/project-context/read-tools/skills, lọc `actual PTY:`: **37 pass, 1 filtered out, 0 fail**. Preload chỉ kiểm tra logic với handler fixture hiện có, không chứng minh socket/OS/live provider.
- Chạy trực tiếp ba file e2e nói trên và native-path-hardening: **40 fail** do môi trường (`Bun.serve` bind localhost: `EADDRINUSE`; native availability self-test false). Primitive Seatbelt trả `sandbox_apply: Operation not permitted`; real skills Seatbelt test skip. Actual PTY project-context cũng không qua khi preload vì process con cần server socket thật. Cần người điều phối chạy lại bốn file nguyên bản ngoài sandbox, đặc biệt cargo test với budget mới; chưa claim OS pass.

- Contract 1.28 thêm `SkillMetadata`, `SkillDiagnostic`, `SkillsReport`, `SkillsPort`, optional `ToolResult.skillDirectory`; tăng trần tổng `ModelRequest.instructions` như trên. `client.skills()` trả `{skills, errors, warnings}` cloned, không có body; trước consent trả rỗng. Root redact/sanitize metadata trước SDK/model/UI. SDK backend thiếu port trả catalog rỗng.
- Core, CLI composition, SDK, TUI slash router và headless JSONL consumers dùng version 1.28. SDK/adapter wrappers đọc strict `ToolResult` cần schema mới khi dùng tool skill; field directory không phải authorization. Không migration persistence hay dependency edge mới.
- `.agents/skills` theo yêu cầu S3 thay compatibility `.codex/skills` trong plan W11 cũ; không thêm `.codex/skills`. Không có skill admin, tải URL/cache/index, installer, MCP dependencies, plugin/cloud skills, icons/interface assets (`agents/openai.yaml`) hoặc hot reload/watch. Giữ toàn bộ deferred.md cho S6.
- Khác Codex pinned: name bắt buộc (không fallback basename), safe-character validation và giới hạn description 1.024 theo yêu cầu S3, parser YAML nhỏ hơn và từ chối symlink kể cả symlink trong cùng cây. Chỉ hỗ trợ mention tên; không URI/path/structured mention hay implicit script invocation tracking. Budget dùng giảm mô tả rồi bỏ entry, không mang toàn bộ allocator/token configuration của Codex.
- Khác OpenCode pinned: tool dùng `name`, không `id`; chỉ `SKILL.md`, không loose root Markdown, không plugin state/watch/index tải về, không follow symlink. Claude Code: chỉ port hành vi frontmatter, slash và argument substitution theo yêu cầu; không claim parity/live verification cho runtime Claude Code hoặc quyền `allowed-tools`.
- Native Linux bubblewrap/Docker chưa bổ sung mount thư mục skill user trong S3; đọc body qua dispatcher vẫn hoạt động. Việc chạy script user ở các backend đó **Needs verification**; yêu cầu Seatbelt được triển khai riêng ở bước này.

## Nguồn chỉ đọc và provenance

Đối chiếu checkout local ngày **2026-11-18**, port hành vi, không chép nguyên văn. Không truy cập provider thật.

| Nguồn                                                                                                                      | Revision và path đã đọc                                                                                                                         | Hành vi đối chiếu                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Codex skills](https://github.com/openai/codex/tree/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/skills/src)          | `090be4df0724cdef5758e6a0934ba557af8b6bbe`, `codex-rs/skills/src/{parser,interface,loading,selection,mentions,invocation}.rs`                   | frontmatter/metadata, error isolation, selection/dedupe, `$name`, phân biệt implicit invocation/interface assets khỏi phạm vi S3 |
| [Codex host skills](https://github.com/openai/codex/tree/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/ext/skills/src) | cùng revision, `codex-rs/ext/skills/src/{host_roots,render,catalog_prompt}.rs`                                                                  | repo/user/system roots, catalog prompt, `DEFAULT_SKILL_METADATA_CHAR_BUDGET = 8_000`, rút mô tả/bỏ entry                         |
| [OpenCode skill](https://github.com/sst/opencode/blob/852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252/packages/core/src/skill.ts) | `852d5ed0b30ca84ed0a2cb0c9f68c9e99aeb4252`, `packages/core/src/skill.ts`, `tool/plugin/skill.ts`, `config/plugin/{skill-scan,compatibility}.ts` | mediated tool + directory/content, độ sâu scan 6, `.agents`/`.claude` compatibility                                              |

## Kiểm chứng và giới hạn

Fixture mới: `tests/contracts/skills.test.ts`, `tests/end-to-end/skills.test.ts` (provider wire qua fetch in-process), `tests/security/skills-seatbelt.test.ts`. Bao phủ parse, size inclusive 64 KiB, precedence/dedupe/system, ignored/vendor roots, metadata budget, disabled explicit invocation, traversal/symlink/swap, deny/cancel, default-state exception, no `allowed-tools` grant, body turn-local, SDK clone/consent, model tool journal, TUI reserved routes và headless `$name`.

Profile Seatbelt được assert cụ thể cho read-only skill resource và state deny. Test OS thật có sẵn và chỉ chạy nếu primitive sandbox-exec hoạt động. Môi trường phiên này từ chối ngay `/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` với `sandbox_apply: Operation not permitted` (exit 71), nên test OS được **skip**, không tính là pass. Mở socket localhost cũng bị từ chối (`Bun.serve` port 0: `EADDRINUSE`); fixture mới dùng fetch seam đã có, không dùng mock success để claim OS/live. Live provider, native script execution và Linux/Docker parity vẫn **Needs verification**. Không chạy toàn bộ suite theo phạm vi user.

### Kết quả kiểm tra phiên S3

- `bun run typecheck`: exit 0.
- `bun run lint`: exit 0.
- `bun test tests/contracts/skills.test.ts tests/contracts/commands-module.test.ts tests/contracts/headless-run.test.ts tests/contracts/model-compaction.test.ts tests/security/skills-seatbelt.test.ts tests/security/read-tools.test.ts tests/security/project-context.test.ts tests/security/tool-architecture.test.ts tests/end-to-end/skills.test.ts`: **68 pass / 1 skip / 0 fail** (9 files). Skip duy nhất là Seatbelt thật bị host từ chối.
- `bun test tests/end-to-end/headless-exec.test.ts tests/contracts/tui-golden.test.ts`: **1 pass / 8 fail**, các fail ở `fixtureServer` khi bind localhost (`EADDRINUSE`, port 0). Không coi là kiểm chứng headless socket/OS.
- Snapshot command palette/composer được cập nhật cho `/skills` (6 frames thay đổi, các frame khác giữ nguyên). `bun test --preload ./tests/support/in-process-loopback.ts tests/contracts/tui-golden.test.ts`: kiểm tra render bằng **chính handler fixture hiện có**, chuyển transport sang in-process; 2 pass / 0 fail. Preload chỉ bật bằng cờ riêng, không sửa behavior mặc định của tests hay runtime; không phải bằng chứng mạng/OS thật.
- Không chạy full suite, integration suite hoặc e2e suite; không commit/push.

### Tệp của S3

Tạo mới (10):

- `packages/contracts/src/skills.ts`
- `packages/workspace/src/skill-parser.ts`, `packages/workspace/src/skills.ts`
- `packages/workspace/skills/skill-creator/SKILL.md`
- `packages/tools/src/handlers/skill.ts`
- `tests/contracts/skills.test.ts`, `tests/end-to-end/skills.test.ts`, `tests/security/skills-seatbelt.test.ts`
- `tests/support/in-process-loopback.ts`
- `docs/adr/0056-skills-discovery-and-mediated-invocation.md`

Sửa (27):

- Contracts: `packages/contracts/src/{index,models,tools}.ts`.
- Workspace: `packages/workspace/src/index.ts`.
- Tools: `packages/tools/src/{context,orchestrator}.ts`, `packages/tools/src/handlers/{index,types}.ts`, `packages/tools/src/exec/{native,runtime,seatbelt-profile}.ts`.
- Core: `packages/core/src/agent/{turn,turn-types,turn-tools}.ts`.
- SDK: `packages/sdk/src/{client,commands}.ts`.
- CLI/TUI: `apps/cli/src/bootstrap/{commands,startup}.ts`, `apps/tui/src/features/{chat,commands}/controller.ts`.
- Consumers/tests: `tests/contracts/headless-run.test.ts`, `tests/end-to-end/headless-exec.test.ts`, `tests/contracts/__golden__/tui-overlays.json`.
- Docs: `CLAUDE.md`, `docs/README.md`, `docs/contracts/agent-events.md`, `docs/delivery/wave-2/plan.md`.

Bảo mật cần review trước bước kế: resolver/reader trong workspace và handler skill, state exception trong tools/context + CLI startup, và Seatbelt profile/native wiring. Không sửa các đường dẫn working tree user đã loại trừ; không stash/revert/commit/push.
