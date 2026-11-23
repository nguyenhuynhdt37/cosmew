# ADR 0057 — Ký ức project cấp user, kiểu Claude Code

- Ngày: 2026-11-18
- Trạng thái: Accepted; chỉ S4, fixture verified, không claim live provider/OS sandbox parity.
- Contract: 1.28 → 1.29 → 1.30 → **1.31**; SQLite giữ 8, không dependency mới.

## Quyết định

User đã chọn kiểu Claude Code: mỗi ký ức là Markdown trong `~/.futryn/projects/<id>/memory/`, frontmatter `name`, `description`, `type: user|feedback|project|reference`; `MEMORY.md` là mục lục một dòng mỗi entry. Identity project hiện có là đường dẫn canonical workspace; `<id>` là SHA-256 UTF-8 của chính đường dẫn đó, không phụ thuộc account/model/session hay alias symlink. Không đặt ký ức trong repository. Memory root luôn là `.futryn` dưới OS home (test inject home riêng), kể cả database dùng legacy `.hannes` hay `FUTRYN_HOME`. Config vẫn dùng host config user-level hiện có, không đọc config workspace.

Persistence sở hữu `FileMemories`; contracts xuất schema/metadata và `MemoriesPort`; tools nhận port inject, core chỉ nhận context port; CLI nối graph; SDK/TUI không import persistence. Không đổi dependency DAG. Không tái sử dụng workspace write tools để vượt state deny. Không mở quyền đọc/ghi ký ức cho shell/LSP.

`memory {action: list|read|write|delete, name?, description?, type?, content?}` đi qua ToolDispatcher như `update_plan`: validate → policy `agent.state` cho list/read, `agent.state.write` cho write/delete (không approval filesystem) → audit → revalidate route → execute → redact/bound output. Write cần đầy đủ metadata + content, là replace toàn bộ entry; read/delete chỉ nhận slug lowercase ASCII ≤64 ký tự, không nhận path; tên `memory` được dành riêng để tránh collision với `MEMORY.md` trên filesystem không phân biệt hoa thường. SDK `client.memories()` trả metadata clone (rỗng trước consent/disabled); `readMemory`/`deleteMemory` gọi dispatcher, không gọi store trực tiếp. Tên tool, requested/decided/completed được audit; không ghi body bí mật vào audit. Tool description dặn nhớ/quên theo yêu cầu user hoặc lưu điều bền vững không suy từ code; không lưu điều repo đã ghi.

## Lưu trữ và an toàn

- Directory 0700, file 0600. Open từng ancestor/final bằng `openat` + `O_NOFOLLOW`; regular file một hardlink, UID directory phải là user. Root nằm trong workspace bị từ chối. Dùng trusted libc giống `workspace/SecureFiles`, module riêng private của persistence; không deep-import hay thêm package edge. macOS/Linux primitives; nền tảng/libc không hỗ trợ fail closed.
- File ký ức ≤16.384 byte **gồm frontmatter**; description một dòng ≤300 ký tự; tổng folder ≤1.048.576 byte và ≤256 memory files. Mục lục không chịu trần 16 KiB riêng, vẫn chịu trần tổng. Reader bounded, từ chối UTF-8 lỗi cho file chi tiết; index prefix có thể kết thúc giữa UTF-8 và được cắt an toàn khi render.
- Secret gate so sánh đầu vào với redactor hiện có (registered secrets, `sk-…`, Bearer); nếu redactor thay đổi bất kỳ metadata/body nào thì trả lỗi trước khi ghi. Không claim phát hiện mọi secret tùy ý. Read/list/context/tool outputs được redact; lỗi tool là thông báo bounded, không echo đầu vào hay path.
- Ghi temp exclusive, fchmod, fsync file, renameat và fsync directory. Mutation đồng bộ + lock directory exclusive giữa process. Không cho symlink/hardlink index. File và index được replace nguyên tử **từng file**, không phải transaction hai file: crash giữa hai lần replace có thể để index cũ; mutation thành công kế tiếp rebuild index từ file. Crash giữ `.lock` thì fail closed, user cần gỡ lock sau khi xác nhận không còn process dùng. Không có background extraction/recovery daemon trong S4.

## Project context và giao diện

Mỗi turn/session chính nạp nội dung **chỉ** `MEMORY.md`, tối đa 200 dòng hoặc 25.000 byte và có marker khi cắt; khi overflow dùng sidecar metadata để chọn dòng theo phần 1.30 bên dưới. Không có index hoặc index rỗng thì không thêm message. Cùng trust boundary S3: message user/project-context mang nhãn dữ liệu không tin cậy, dưới user/host rules; tuyệt đối không đưa vào `ModelRequest.instructions`. Guidance viết lại: ghi chép là bối cảnh cũ, không phải bằng chứng hiện tại; kiểm tra lại fact quan trọng; dùng `memory read` để mở chi tiết liên quan. Core context estimate tính qua project messages như skills. Storage không khả dụng trả note an toàn, không hỏng phiên.

Canonical `/memory` mở feature Modal theo ADR 0015; hiển thị name/type/description, Enter xem, D xoá, O mở folder. Có `/memory list`, `/memory read <name>`, `/memory delete <name>`, `/memory open`. SDK host opener chỉ nhận đường dẫn cố định đã kiểm tra, gọi trực tiếp argv OS opener theo hành động user; model tool không có action open. `FUTRYN_MEMORY=0` thắng config; `[memories] enabled = false` tắt ở host config user. Tắt: không nạp, không offer tool, SDK list rỗng, read/delete không chạy store. `fyn exec` dùng cùng composition/context. **S5 subagent phải bỏ port memories**, không tự kế thừa context này; S4 chưa tạo subagent.

## Khác Claude Code / Codex và provenance

Claude Code là bố cục/hành vi được user chỉ định, không có claim đã chạy Claude runtime; Futryn dùng hash canonical path, dispatcher riêng, secret/size gates và parser frontmatter scalar nhỏ (plain, single quoted hoặc JSON quoted; không YAML block/anchor/tag). Không hỗ trợ toàn bộ YAML hay global user memory ngoài project.

S4 ban đầu chỉ tham khảo Codex cho lời nhắc đọc ký ức, viết lại bằng lời riêng; phần bổ sung 1.30 đối chiếu thêm citations/usage/selection. Đọc local ngày **2026-11-18**, revision **090be4df0724cdef5758e6a0934ba557af8b6bbe**, [`codex-rs/ext/memories/templates/memories/read_path.md`](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/ext/memories/templates/memories/read_path.md). Không port layout rollout summaries hay background extraction/consolidation. Bổ sung 1.30 bên dưới port citations và usage ranking; runner nền vẫn hoãn trong deferred.md. Không dùng nguyên câu prompt upstream và không claim tương thích memory protocol Codex.

## Kiểm chứng

`tests/contracts/memories.test.ts`: filesystem thật trong fixture tạm — CRUD/index replace, mode bits, schema/secret/byte/count bounds, symlink/hardlink/state containment, canonical aliases và workspace isolation, index truncation, audit/no approval. `tests/end-to-end/memories.test.ts`: provider wire qua fetch seam in-process — untrusted context không vào system/developer, chỉ nạp index, empty/disabled, SDK clone/read/delete, TUI Modal, host folder opener seam, `fyn exec` cùng contract 1.29. Không dùng seam để chứng minh mạng localhost, OS folder opener, Seatbelt hay provider thật.

### Kết quả phiên S4

- `bunx prettier --write` trên tất cả file sửa/tạo; `bun run typecheck`, `bun run lint`: exit 0.
- Bộ 11 file liên quan (memories contracts/e2e, skills contracts/e2e, commands-module, headless-run, model-compaction, tool-architecture, project-context, read-tools, skills-seatbelt): **85 pass / 1 skip / 0 fail**, 589 assertions. Skip là Seatbelt thật bị host từ chối.
- E2E progressive-exploration/read-tools/project-context với temporary preload `/tmp/futryn-s4-loopback.ts` (gọi chính fixture handlers in-process): **32 pass / 1 filtered out / 0 fail**, 271 assertions. Filter bỏ `actual PTY:` vì cần socket/process thật. Các fixture dùng home ký ức riêng và expected tool lists có memory.
- Golden với cùng preload: **2 pass / 0 fail**, 68 assertions; review diff chỉ 6 frame palette/composer thêm `/memory`. Preload là artifact tạm, không đổi transport production hay mặc định test.
- Chạy trực tiếp thêm headless-exec + tui-golden: **8 fail** tại `fixtureServer` bind localhost (`EADDRINUSE`, port 0), trước luồng cần test; gồm 2 golden tests và 6 exec scenarios (JSONL/stdin/output, output symlink, consent/approval, signals, provider failure, Full Access). Không tính in-process render hay runExec fixture là bằng chứng CLI subprocess/socket/Seatbelt/live.
- Không chạy full suite hoặc live provider; Linux libc/Windows, OS folder opener thật và real terminal còn Needs verification. Không commit/push; các đường dẫn user loại trừ giữ nguyên.

### Tệp S4

Tạo mới (12):

- `apps/tui/src/features/memory/controller.ts`
- `apps/tui/src/features/memory/index.ts`
- `apps/tui/src/features/memory/logic.ts`
- `apps/tui/src/features/memory/types.ts`
- `apps/tui/src/features/memory/view.ts`
- `docs/adr/0057-user-scoped-project-memories.md`
- `packages/contracts/src/memories.ts`
- `packages/persistence/src/memories.ts`
- `packages/persistence/src/memory-directory.ts`
- `packages/tools/src/handlers/memory.ts`
- `tests/contracts/memories.test.ts`
- `tests/end-to-end/memories.test.ts`

Sửa (27):

- `CLAUDE.md`
- `apps/cli/src/bootstrap/host-config.ts`
- `apps/cli/src/bootstrap/startup.ts`
- `apps/tui/src/app.tsx`
- `apps/tui/src/features/commands/controller.ts`
- `apps/tui/src/types.ts`
- `docs/README.md`
- `docs/contracts/agent-events.md`
- `docs/delivery/wave-2/deferred.md`
- `docs/delivery/wave-2/plan.md`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/models.ts`
- `packages/core/src/agent/turn-types.ts`
- `packages/core/src/agent/turn.ts`
- `packages/persistence/src/index.ts`
- `packages/sdk/src/client.ts`
- `packages/sdk/src/commands.ts`
- `packages/tools/src/context.ts`
- `packages/tools/src/handlers/index.ts`
- `tests/contracts/__golden__/tui-overlays.json`
- `tests/contracts/headless-run.test.ts`
- `tests/contracts/tui-golden.test.ts`
- `tests/end-to-end/headless-exec.test.ts`
- `tests/end-to-end/progressive-exploration.test.ts`
- `tests/end-to-end/project-context.test.ts`
- `tests/end-to-end/read-tools.test.ts`
- `tests/end-to-end/skills.test.ts`

## Bổ sung S4 — citations và usage (contract 1.30, 2026-11-18)

Phiên bổ sung làm mục 1–3; user cho phép hoãn phần 4 nếu quá lớn. Không có runner/job/model call nền, không dependency mới hay migration SQLite. `auto_extract=true` hiện trả host-config diagnostic unsupported; thiết kế job chi tiết nằm ở deferred.md.

### Trích dẫn

Host guidance tĩnh khi offer memory yêu cầu chỉ trích file chi tiết thật sự dùng; đúng một block cuối câu trả lời ngoài code fence:

```text
<oai-mem-citation>
<citation_entries>
preference.md:1-3|note=[used preference]
</citation_entries>
</oai-mem-citation>
```

Không trích `MEMORY.md`, không đưa nội dung/citation ký ức vào PR description hay commit message; ký ức là lịch sử, kiểm chứng fact quan trọng; write chỉ khi user yêu cầu hoặc học điều bền vững không suy từ code. Guidance này host-owned; metadata/body thực tế vẫn ở project-data/tool channel, không vào instructions.

`parseMemoryCitations` trong SDK là display-only: chỉ nhận file slug Markdown, dedupe, bỏ index/path traversal và range sai; giữ literal block trong fenced code (backtick/tilde). TUI áp dụng trên assistant text parts, render `Ký ức đã dùng: …`, ẩn raw block/partial prefix trong streaming, và dùng cùng parser khi replay transcript. Block thiếu đóng bị ẩn và không tạo citation; không tự khẳng định file đã đọc ngoài claim của model. Journal/SDK/headless wire giữ text gốc để consumers parse, không biến citation thành authority hoặc permission. Không port rollout UUID citations của Codex.

### Mức dùng và ưu tiên context

Sidecar `.usage.json` version 1, atomic 0600 dưới cùng directory descriptor/lock của S4: map tên → `{usage_count, last_usage, updated_at}`; schema strict, timestamp UTC, số safe integer, ≤64 KiB/256 records và nằm trong tổng quota 1 MiB. `last_usage` null trước lần đọc đầu. Legacy file thiếu record dùng mtime làm source updated time; không ghi file khi chỉ list/context. `MemoryInfo` thêm các field trên và `unused` cho SDK/list/TUI; input `memory write` không cho model tự sửa counters.

Mỗi successful `memory read` (model hay SDK/UI) tăng count và ghi thời điểm trước khi trả body; tracking write hỏng thì tool trả error, không trả read thành công mà thiếu usage. Counter và file body độc lập, không tăng từ citations/list/context. Update memory giữ count/last_usage, refresh updated_at; delete xoá record, recreate về 0. Sidecar chịu O_NOFOLLOW/hardlink refusal, quota, atomic rename/fsync như memory files. Vẫn nguyên giới hạn atomic từng file và stale `.lock` sau crash của S4 ban đầu.

Chỉ khi index vượt 200 dòng/25.000 byte, đọc full index bounded ≤1 MiB để không bỏ qua tail entry có giá trị; xếp fresh trước stale, `usage_count DESC`, `COALESCE(last_usage, updated_at) DESC`, `updated_at DESC`, tên DESC; dòng không map được đứng cuối theo thứ tự cũ. Đây là adaptation selection Codex: giữ stale ở cuối thay vì loại/xoá, và đưa thứ tự rank trực tiếp vào context thay vì sắp theo thread id sau selection. Redact toàn bộ index đã rank trước byte/line cutoff để không lộ secret-prefix vắt qua biên; byte/line bound áp sau sort/redact, không thay `MEMORY.md` trên đĩa. Index vừa budget giữ nguyên thứ tự.

`max_unused_days` mặc định **30**, user config `[memories] max_unused_days` clamp **0..365** như Codex; kiểu sai dùng default kèm diagnostic. `last_usage` cũ hơn cutoff (hoặc `updated_at` nếu chưa đọc) làm `unused=true`. `/memory` hiện số lần/thời điểm dùng, nhãn “lâu không dùng” và gợi ý “cân nhắc xoá (D)”; không tự xoá.

### Provenance bổ sung

Đọc checkout local ngày 2026-11-18, xác nhận HEAD `090be4df0724cdef5758e6a0934ba557af8b6bbe`. Nguồn: [citations.rs](https://github.com/openai/codex/blob/090be4df0724cdef5758e6a0934ba557af8b6bbe/codex-rs/memories/read/src/citations.rs), `memories/read/src/usage.rs` (shell telemetry classification, khác counter explicit read của Futryn), `memories/README.md`, `ext/memories/templates/memories/read_path.md`, `config/src/types.rs` (30 ngày, clamp và phase-1 defaults), `state/src/runtime/memories.rs` (selection SQL), `memories/write/src/{phase1,lib}.rs` (job limits). `core/src/memories/` không tồn tại tại revision này; runner nằm trong `memories/write/`. Không chép nguyên prompt upstream; không claim live parity.

### Kiểm chứng bổ sung 1.30

- `bunx prettier --write` trên file sửa/tạo; `bun run typecheck`, `bun run lint`: exit 0.
- 15 file liên quan (memories contracts/e2e, memory-citations, skills contracts/e2e, commands-module, headless-run, model-compaction, tool-architecture, project-context, read-tools, skills-seatbelt, host-config, wave1-guidance, transcript-virtualization): **111 pass / 1 skip / 0 fail**, 1.841 assertions. Skip là Seatbelt thật; không claim OS sandbox pass.
- Sáu file với temporary preload in-process `/tmp/futryn-s4-loopback.ts`: transcript-activity, quiet-transcript, tui-golden, progressive-exploration, read-tools, project-context — **58 pass / 1 filtered out / 0 fail**, 457 assertions. Filter bỏ `actual PTY:` cần process/socket thật. Golden hiện có giữ nguyên trong lượt bổ sung. Preload gọi chính handler fixture, không thay production transport và không chứng minh mạng localhost/PTY/OS/live provider.
- Test mới kiểm tra block an toàn/dedupe/no index/traversal, literal fenced code và mọi streaming prefix, persisted answer/replay render; successful model read đúng count/timestamp, list/context không tăng, update/delete/recreate, sidecar symlink/quota/failure, legacy mtime và tên trùng inherited object key, ngưỡng 30 ngày, user config 7 ngày/stale deletion hint, no extraction generation call, count/recency prioritization ở cả line/byte overflow và disk index giữ nguyên; redact trước cutoff để không lộ prefix secret vắt qua biên và marker khi redaction làm output vượt budget.
- Tạo thêm `packages/sdk/src/memory-citations.ts`, `tests/contracts/memory-citations.test.ts`. Sửa `packages/contracts/src/{memories,models}.ts`, `packages/persistence/src/{memories,memory-directory}.ts`, `packages/sdk/src/{client,index}.ts`, `packages/core/src/agent/guidance.ts`, `packages/tools/src/handlers/memory.ts`, `apps/cli/src/bootstrap/{host-config,startup}.ts`, `apps/tui/src/features/memory/{types,logic}.ts`, `apps/tui/src/features/transcript/view.ts`, fixtures/consumers headless và docs S4. Tệp trong inventory S4 ban đầu ở trên được giữ; không commit/push/dependency mới, không sửa đường dẫn user loại trừ.

## Security fix: memory edits (contract 1.31)

List/read giữ `agent.state`; write/delete dùng capability `agent.state.write` và prepared kind
`state-write`. Dispatcher từ chối mutation trong sandbox `read-only` (Read Only preset)
và Plan/Review (`analysisOnly`), kiểm tra lại sau approval; không ghi/xoá memory hay index.
Read vẫn giữ usage sidecar của contract 1.30, không đổi nội dung memory.
Approval adapter dùng kind `edit`, rule namespace `Tool`, target `memory write|delete <slug>`:
project deny thắng như các edits khác; `untrusted` hỏi, Auto/on-request/never không prompt
trừ project ask/deny. Không cache approval mutation trong dispatcher để bỏ qua policy mới.
Đây là quyết định user kiểu Claude Code, không mở quyền shell/LSP vào state.
Regression tests bao phủ Read Only, plan/analysisOnly, untrusted, Auto và project deny.

## Update (ADR 0061)

The permission model changed to Claude Code's: memory write/delete is refused in `plan` mode (and in Plan/Review agent mode and read-only subagents), is an `edit` otherwise (`default` asks, `acceptEdits`/`bypassPermissions` write) and project deny rules (`Tool(memory)`) still win. The Read Only/Auto/untrusted wording above is historical.

## Crash recovery update (2026-11-22, internal storage only)

This update supersedes the stale-lock/manual-rebuild limitation above. No public
contract, SQLite schema, package edge or dependency changes.

Memory operations now acquire a descriptor-relative regular `.lock` file with
kernel `flock`, supplied by the already trusted system libc. The file
is persistent and must never be removed during normal operation. Kernel ownership
ends on close/process death, including SIGKILL: no PID, PID start time, timeout or
stale lease can authorize stealing another process's lock. Independent-process
contention retries nonblocking acquisition for at most 250 ms in steps of at most
10 ms, then fails closed; callers can retry. A process-local inode ownership set
refuses same-process contention immediately, so a synchronous caller cannot block
its own owner. Symlinks, hardlinks, nonregular files, foreign owners,
and inode replacement detected after acquisition are rejected. List and context
also lock so they cannot observe an interrupted mutation before reconciliation.

**Legacy migration:** the previous empty `.lock` directory has no PID/owner record.
There is no safe way to distinguish a live old executable from a crashed one.
It is never removed automatically. Storage reports an actionable diagnostic: stop
all Cosmew processes using that memory directory, remove only its empty `.lock`
directory, and retry. Never delete a regular `.lock` file; doing so can split kernel
lock ownership. Do not run old and new executables against the same memory root.

Before changing a memory, an atomic/fsynced bounded `.pending.json` journal stores
its validated slug, before/after content hashes and intended usage state. Content,
index and usage still commit by individual atomic rename/fsync; deletes now fsync
the directory too. On every subsequent open, under the kernel lock, recovery
validates the journal and actual Markdown files, repairs the affected generated
index link from current frontmatter, filters usage records to existing files and
finishes/removes the journal durably. It never stores/replays a memory body, so
user changes or deletions made after a crash remain authoritative. If actual
content matches the intended commit, planned usage metadata is retained; otherwise
current usage plus actual file mtime is retained. Unrelated custom index lines,
including blank lines, are preserved; the generated link for the affected slug is
owned by reconciliation. Normal successful explicit mutations retain their existing
full-index rebuild behavior. A second crash during recovery can be reconciled again.
Exclusive UUID temporary files abandoned by a killed atomic write are removed
under the same lock, with the same no-symlink/no-hardlink checks. Cleanup streams
through abandoned temporary files before applying the 264-entry list bound. A
scan processes at most 4,096 directory entries; if that limit is reached it fails
closed after deleting the temporary files already visited, so subsequent retries
continue making progress through a larger finite backlog. Corrupt journal JSON
and schema diagnostics become the standard bounded `STORAGE` error.

Evidence: `tests/contracts/memory-recovery.test.ts`, real child processes running
production storage methods, paused after completed durable operations and killed
with SIGKILL. Covers live-holder exclusion and post-kill reopening, journal/content/
index/usage/delete boundaries, a second crash during recovery, body/index user edits,
stale/reused PID text ignored, malicious journal slugs and lock/journal symlinks.
No test-only crash hook was added to production. macOS arm64 / Bun 1.4.4 verified;
Linux libc/flock and power-loss certification remain **Needs verification**. These
are process-crash tests, not claims of hardware/filesystem power-loss behavior.

### Independent review follow-up (2026-11-22)

Verified section 3.4 of the local read-only review against the implementation.
Regression tests first reproduced immediate interprocess contention failure,
raw JSON/schema errors, and inability to reopen with 300 abandoned temporary files.
The fixes above are covered by actual child processes releasing locks after a short
hold, a child killed after leaving 300 exclusive-name temporary files, immediate
same-process contention refusal, and existing long-held live-owner/SIGKILL tests.
The temporary-file fixture uses the reserved atomic-write namespace with real
filesystem writes; this proves backlog cleanup and process-death exclusion, not
300 independently observed crashes or hardware power-loss behavior.

Focused validation after this follow-up: memory recovery, memory contract and
memory end-to-end tests **47 pass / 0 fail / 243 assertions**; typecheck, scoped
Prettier and diff checks passed on macOS arm64 / Bun 1.4.4. No guard bypass.
