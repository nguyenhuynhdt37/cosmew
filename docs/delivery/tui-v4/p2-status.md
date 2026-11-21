# P2 — kiểm toán và nghiệm chứng TUI

Ngày: 2026-11-20. Phạm vi: `apps/tui/**`, tests, tài liệu TUI và hai slash entries trong SDK.
Không commit; không sửa các hunk của phiên khác trong turn.ts/profiles.ts/paths.ts.
`git status`/`git diff` có nhiều thay đổi từ các wave trước; không coi toàn bộ diff là thay đổi P2.

## Kiểm toán trước khi tiếp tục

| # | Trạng thái lúc kiểm toán | Code và bằng chứng đã có | Thiếu/cần xử lý |
|---|---|---|---|
| 1 | partial | backgroundTasks, Ctrl+B, task panel, completion theo session; background-tasks/background-tasks.test.tsx, composer/keys.test.tsx, testing/p2-integration.test.tsx | Footer chưa có `↓ to manage`, thứ tự shell/agent chưa khớp |
| 2 | partial | SDK queuedInput/retract/sendQueuedNow, prepend draft, race delivery; composer/keys.test.tsx | Chưa giới hạn lấy lại shell command khi nháp/queue hỗn hợp |
| 3 | partial | PlanApprovalDialog, resolvePlanApproval, feedback/Esc, 80×12, màu reference; plan-approval/plan-approval.test.tsx | SDK không có artifact/path, API sửa proposal hay resolution approve+feedback; Ctrl+G báo lý do |
| 4 | done | attachImage/chips/backspace/left/right, stale-session/denial/preparing; composer/keys.test.tsx, clipboard.test.ts | Clipboard macOS native Needs verification; không tuyên bố test parser là bằng chứng OS |
| 5 | partial | checkpoints + rewind code/conversation/both, conflict, 5 lựa chọn, registry; panels/panels.test.tsx | `summarize` không có trong RewindScope; disabled kèm lý do |
| 6 | done | mcpServers nhóm source/glyph/count, hooks supported:false, hook.ran detail; panels/panels.test.tsx, transcript/p2-events.test.tsx | Hook execution/management không được backend hỗ trợ; UI hiển thị thật |
| 7 | partial | Current side panel ≥110, auto-open receipt, focus/keys/scroll/colors; diff/panel.test.tsx, testing/p2-integration.test.tsx | Ctrl+X B/←→ chỉ báo thiếu SDK bases; không có cycleDiffBase thực |
| 8 | done | `[` native PTY alternate leave/enter; `v` editor executable + temp 0600; Settings `/`/Space | session-only model/effort, fast/thinking/history scopes giữ Not implemented theo điều kiện đề bài |

## Yêu cầu SDK chính xác

Không sửa SDK ngoài slash entries theo brief. Các mục sau bị chặn ở public API:

1. `getWorkspaceDiff({base: 'session' | 'uncommitted' | 'branch'})` và `refreshWorkspaceDiff({base})`, snapshot trả base thực/capabilities. Hiện hai method không nhận argument, chỉ có Current. Không thể dựng branch diff từ snapshot hiện tại.
2. `resolvePlanApproval` cần thêm resolution `{mode: 'manual' | 'acceptEdits', feedback: string}` để approve+feedback atomically. Hiện `{feedback}` chỉ yêu cầu sửa plan và giữ plan mode; UI không được gọi đó là approval. `PlanProposal` cần artifact `path` và `updatePlanProposal({id, expectedRevision, plan})` cập nhật proposal đang chờ, trả artifact metadata và revalidate session/cancellation để Ctrl+G sửa đúng artifact. Hiện chỉ có plan text trong proposal, không có đường dẫn.
3. `rewind({checkpointId, scope: 'summarize', instructions?})` và backend tạo conversation đã summarize. Hiện RewindScope chỉ có code/conversation/both.
4. `retractQueuedInput({includeShell: false})` hoặc atomic selective retraction trả entries có id/type/content: lấy text khỏi queue hỗn hợp nhưng để shell ở lại. Method hiện tại rút tất cả, trả một chuỗi; TUI phải giữ nguyên queue hỗn hợp thay vì vô tình rút shell.
5. Các nhánh tùy chọn ở mục 8: session-only overload cho selectModel/setReasoningEffort; trạng thái/API fast/thinking; history có scope. Hiện API persist setting và không có các capabilities đó.

## Kết quả chạy

Coordinator báo ngoài sandbox trước vòng này: typecheck/lint sạch, full suite 1138 pass / 4 fail. Đây là kết quả coordinator cung cấp, không phải lần chạy local.

## Trạng thái cuối sau sửa trong phạm vi cho phép

`done` dưới đây nghĩa là wiring/nhánh yêu cầu đã có invariant test, không phải tuyên bố nghiệm thu parity 100% hay OS/provider live.

| # | Trạng thái cuối | Kết quả và proof test |
|---|---|---|
| 1 | done | Footer từ backgroundTasks theo thứ tự shell/agent + `↓ to manage`; `footer:close` là action của x (giữ alias stop), Enter output, Esc list, stop refusal không đổi trạng thái. `composer/keys.test.tsx`: **Ctrl+B and its chord call the real SDK background API…** + **shell footer uses session-scoped SDK stop…**; `background-tasks/background-tasks.test.tsx`: **a backend refusal…**; `testing/p2-integration.test.tsx`: **durably delivered background completion prints once…** |
| 2 | partial — SDK blocked | Text retract trước nháp, snapshot đã claim không bị lấy lại; một shell entry chỉ lấy khi nháp rỗng. Queue hỗn hợp giữ nguyên vì SDK chỉ rút tất cả. `composer/keys.test.tsx`: **Up retracts authoritative queued input…**, **queued shell retraction requires…**, **send-now does not interrupt when SDK refuses…**; `testing/p2-integration.test.tsx`: **send-now chord uses SDK queue transfer and delivers the interrupted inbox exactly once** |
| 3 | partial — SDK blocked | Manual/acceptEdits/feedback, Markdown + rules và màu, Esc/late Enter không grant, choices ở 80×12. Thiếu artifact editor/path và atomic approve+feedback. `plan-approval/plan-approval.test.tsx`: **plan choices remain reachable…**, **feedback keeps plan mode…**, **late Enter after backend cancellation…**, **plan uses measured light and dark…**; `testing/p2-integration.test.tsx`: **pending plan approval replaces composer at 80x12…** |
| 4 | done (native clipboard Needs verification) | Ctrl+V → attachImage; chip metadata, nhiều chip Left/Right/backspace; ảnh chỉ gửi sau prepare thành công; clipboard về muộn không gắn sang session khác. `composer/keys.test.tsx`: **image clipboard uses SDK metadata chips…**, **Left/Right navigate multiple image chips…**, **denied image paste…**, **clipboard completion cannot attach…**; `clipboard.test.ts`: parser/bounds/timeout, không gọi đó là test OS live |
| 5 | partial — SDK blocked | Checkpoint rows + stats; both/conversation/code qua rewind, conflict hiển thị; đủ năm lựa chọn, code scope disabled khi không restorable. Summarize disabled có lý do; Never mind huỷ. `panels/panels.test.tsx`: **rewind uses durable checkpoints and requires a scope confirmation**; `testing/integration.test.tsx`: **slash commands leave their result…**; registry có /rewind và /hooks |
| 6 | done | MCP snapshot thật, glyph/count/group source; management unsupported có lý do; hooks không cấu hình và unsupported; hook.ran chỉ ở detail, count PostToolUse, preemption không xoá hook đã chạy. `panels/panels.test.tsx`: **MCP metadata is grouped…**, **/mcp says no servers…**; `transcript/p2-events.test.tsx`: **hook events preserve arrival order…**, **preemption discards provisional model text and retains observed hooks exactly once** |
| 7 | partial — SDK blocked | Pane Current ≥110, 52 cột body + separator/padding, numbered DiffView/backgrounds, auto-open sau receipt thành công, transcript thu hẹp; /diff toggle; navigation/expand/back/page; resize hint dưới 110. Ctrl+X B và ←/→ **không cycle base thật**: báo SDK thiếu base và giữ Current. `diff/panel.test.tsx`: responsive/numbered rows/keys/colour; `testing/p2-integration.test.tsx`: **/diff at 80/109 columns…**, **first successful change opens side diff…**, **/diff remains reachable…** |
| 8 | done theo các điều kiện của brief | `[` thật rời alternate screen/in scrollback/vào lại; `v` chạy executable editor thật qua suspendTerminal trên bản sao 0600, không đổi hội thoại. Settings slash/search và Space toggle. `testing/native-pty.test.ts`, `testing/fullscreen.test.tsx`: **fullscreen transcript [ suspends Ink…**, **transcript v runs a real VISUAL editor…**; `picker/v4-dialogs.test.tsx`: **Settings slash enters search…**. Model session-only, fast/thinking/history scopes vẫn Not implemented vì SDK không có capability; Ctrl+X Ctrl+S là fallback chat:sendNow khi không có kitty Ctrl+Enter |

## Khác biệt còn lại với reference

- Mục 2/3/5/7 bị giới hạn bởi các API liệt kê ở trên; không tự viết Git adapter/plan file hay gọi core từ TUI để lách giới hạn.
- Plan focus lựa chọn đầu như reference; editor footer/path không thể hiển thị thật khi proposal không có artifact.
- Nhóm MCP dùng source thực của backend, không bịa nhóm của tài khoản/reference; hooks execution và MCP management chưa có backend.
- Clipboard reader native chỉ có PNG macOS; các host khác báo lỗi rõ, payload parser/SDK đã kiểm tra nhưng OS clipboard thật chưa nghiệm chứng.
- Wheel/chọn chuột trong Ink và các nhánh tùy chọn ở mục 8 giữ giới hạn đã ghi trong keys-status.md.
- Không re-record golden trong vòng tiếp tục này. Các golden 80/36 được kiểm tra bằng composition-golden và full suite.

Nguồn cho quy tắc shell retract: [interactive-mode — Take back what you queued](https://code.claude.com/docs/en/interactive-mode#take-back-what-you-queued), truy cập 2026-11-20; trang live không có revision bất biến. Capture/version tham chiếu của dự án giữ ở reference (2.1.328); không tuyên bố trang live cùng revision.


## Nghiệm chứng local cuối vòng tiếp tục

- `bun run typecheck`: qua.
- `bun run format --ignore-path /tmp/cosmew-p2-format-ignore`: qua. Ignore bổ sung chỉ để formatter không ghi ngoài phạm vi được giao hoặc vào bốn test coordinator yêu cầu giữ nguyên; không sửa formatter config trong repo.
- `bun run lint`: qua (tsc noUnused + Prettier check toàn repo + git diff --check).
- `bun test apps tests/contracts` **một process**: **592 pass, 4 skip, 34 fail**, 630 tests/77 files, 6 snapshots, 15962 assertions. Không có lỗi TUI; không báo toàn suite xanh.
- `FORCE_COLOR=3 bun test apps/tui/src/ink/features/diff apps/tui/src/ink/features/plan-approval`: **20 pass, 0 fail**, 100 assertions. Light panel/add/remove lấy từ L02 `.colors.json`, dark add từ L10, plan dark selected/rule từ L12; màu còn lại được assert theo token/spec.
- Nhóm test bổ sung sau audit (Ctrl+B/chord/revoke, mixed shell retract, multi-image chips, queue transfer/delivery): 37 pass/0 fail ở lần focused; nằm trong full run cuối ở trên.
- SHA-256 trước/sau vòng chạy xác nhận không đổi: turn.ts, profiles.ts, paths.ts, native-agent.test.ts, security/apply-patch.test.ts, end-to-end/subagents.test.ts, end-to-end/project-context.test.ts.

34 lỗi local còn lại (để coordinator chạy ngoài sandbox):

| File | Số lỗi | Nguyên nhân |
|---|---:|---|
| tests/contracts/provider-limits.test.ts | 2 | bind Bun.serve port 0, EADDRINUSE |
| tests/contracts/usage-context.test.ts | 7 | fixture HTTP/bind port 0 |
| tests/contracts/user-shell-history.test.ts | 1 | fixture HTTP/bind port 0 |
| tests/contracts/configuration.test.ts | 2 | fixture HTTP/bind port 0 |
| tests/contracts/provider-adapters.test.ts | 21 | fixture HTTP/bind port 0 |
| tests/contracts/process-observer.test.ts | 1 | independent ps observation bị sandbox từ chối |

Ba lỗi không thuộc P2 coordinator nêu (apply-patch parser, subagent CONTEXT_LIMIT, project-context PTY) không được sửa. Kết quả ngoài sandbox 1138 pass/4 fail nêu đầu báo cáo là kết quả coordinator của lần trước, tách với phép đo local mới.

## P3 — SDK/backend và TUI cùng wave

Ngày: 2026-11-20. Contract **1.39**, SQLite **10**, [ADR0074](../../adr/0074-p3-review-and-session-controls.md).
Không dependency mới, không commit, không stash/reset/checkout; các hunk trước P3 được giữ nguyên.
Các trạng thái SDK-blocked trong P2 phía trên là lịch sử; bảng này là trạng thái P3.

| # | Trạng thái | Kết quả và proof test |
|---|---|---|
| 1 Diff bases | done | SDK base/capabilities, Current/Uncommitted/Branch, cycle/skip reason, stale session/base completion. `workspace-diff-bases.test.ts`: Git thật, merge-base, staged-then-undone, unborn HEAD, detached/nonGit, partial clone, secret/deny/untracked, index/HEAD unchanged, parent-symlink race, FIFO/hardlink refusal, mode-only. `diff/panel.test.tsx`, `p2-integration.test.tsx`: keys, reason, mode metadata, stale refresh. |
| 2 Plan approval | done | Atomic approve+feedback, artifact private revision bền, edit API không grant, Ctrl+G bản sao/suspendTerminal, footer editor/path. `plan-approval.test.ts` và TUI cùng tên: edited then approved, redaction, revision/session/cancel/failure; `testing/plan-editor.test.tsx`: chạy editor executable thật, copy0600, late/cancelled edit và exit failure giữ plan. Artifact symlink/mode/oversize bị từ chối. |
| 3 Summarize rewind | done | Current model summary suffix + giữ prefix trong fork, focus, extractive fallback, usage, transaction commit; journal gốc không sửa. `checkpoints.test.ts`: exact span, model failure, cancellation không đổi session/usage/journal; `panels.test.tsx`: chọn summarize, optional focus và Esc. |
| 4 Selective retract | done | `retractQueuedEntries` trả id/type/content, giữ shell + SDK-owned delivery reservation, runtime chỉ bỏ id được rút. `input-retraction.test.ts`: cả thứ tự delivery/retract, stale claim, failed transaction, selective shell, duplicate stale live snapshot, claim head/tail race. `composer/keys.test.tsx`: text trước draft; shell chỉ lấy khi ô rỗng và queue duy nhất, giữ `!`. |
| 5a Session settings | done | Model/effort session scope không gọi preference persist; model fork giữ context và Plan/Review trong RAM, account catalog đúng selection. `p3-history-settings.test.ts`: settings byte-equivalent, sendTurn effort, fresh session reset, failed fork, cross-account defaults, mode after resume. `picker/dialogs.test.tsx`, `testing/keys.test.tsx`: `s` qua SDK; Enter vẫn save. |
| 5b History | done | Actual prompt/steering projection bounded5000, output≤200×16000 ký tự, timestamp, canonical workspace per submission, redaction, không duplicate copied context/handoff, retracted steering bỏ khỏi view. `p3-history-settings.test.ts`: restart/schema9 migration, unknown legacy fail-closed, workspace alias/isolation, cross-workspace resume attribution, steering; `checkpoints.test.ts`: synthetic handoff không thành history. `composer/composer.test.tsx`: time column, title, Ctrl+S session→project→everywhere, Enter. |
| 5c Fast/thinking | done investigation; Not implemented toggles | Adapter có reasoningEffort (responses) và replayReasoning (chat/DeepSeek), không có service-tier/fast hoặc thinking enabled field. Không tạo API giả; Alt+O/T báo thật, `/effort` vẫn dùng advertised levels. `composer/keys.test.tsx`. Provider flag mapping/account eligibility/live: Needs verification trong ADR0074. |

### Khác biệt còn lại với reference

- Diff textual replacement dùng bounded prefix/suffix, chưa minimal ở nhiều vùng sửa rời nhau. Default branch dùng origin/HEAD local rồi convention main/master, không fetch. Session baseline không gồm shell/MCP hoặc sửa ở ngoài project root; legacy checkpoint thiếu completeness marker, snapshot đã redact hoặc pruning báo unavailable. Git explicit bases không đọc worktree content: SecureFiles descriptor traversal chống parent-symlink race, Git chỉ đọc metadata/blob OID.
- History legacy không có timestamp bị bỏ; chưa biết workspace thì không vào project. Context được copy khi fork/rewind không phải submission mới (composer ↑ vẫn dùng context trong RAM); session prompt history bắt đầu từ submission thực trong fork. Retention5000 recent submissions/user, output tối đa200.
- Fast/thinking boolean toggles, hooks execution/MCP management, Ink wheel/mouse selection và clipboard OS giữ giới hạn đã ghi. Provider có xác thực và Linux/Windows còn Needs verification; editor executable test không thay bằng chứng terminal/provider live.
- Không re-record golden. So bốn candidate integrated/permission ở **80 và 36 cột** với baseline bằng diff: không đổi.

### Nghiệm chứng P3

- `bun run format`: qua; `bun run typecheck`: qua; `bun run lint`: qua (noUnused + Prettier check toàn repo + diff check).
- `bun test apps tests/contracts`: **636 pass, 4 skip, 34 fail**, 674 tests/80 files, 6 snapshots, 16.231 assertions. Không có lỗi P3/TUI trong lần cuối này; không gọi toàn suite là xanh.
- Backend/security focused (p3-history-settings, input-retraction, workspace-diff-bases, checkpoints, plan-approval, model-compaction, terminal-injection): **74 pass, 0 fail**, 420 assertions.
- TUI focused (composer, history, picker/dialogs, panels, plan-editor, p2-integration, composition-golden, keys): **156 pass, 0 fail**, 738 assertions.
- `FORCE_COLOR=3` diff + plan-approval: **26 pass, 0 fail**, 121 assertions. Các lần chạy focused có overlap với full suite, không cộng thành tổng test độc lập.
- Bốn golden candidate integrated/permission tại 80/36 cột so baseline bằng `diff -u`: không đổi; không re-record.
- SHA-256 trước/sau xác nhận `packages/core/src/agent/turn.ts`, `packages/agents/src/profiles.ts`, `packages/workspace/src/paths.ts` không đổi.

34 lỗi môi trường để coordinator chạy ngoài sandbox (cùng nhóm đã ghi P2):

| File | Lỗi | Nguyên nhân |
|---|---:|---|
| tests/contracts/provider-limits.test.ts | 2 | Bun.serve bind port0 EADDRINUSE |
| tests/contracts/usage-context.test.ts | 7 | Bun.serve bind port0 EADDRINUSE |
| tests/contracts/user-shell-history.test.ts | 1 | Bun.serve bind port0 EADDRINUSE |
| tests/contracts/configuration.test.ts | 2 | Bun.serve bind port0 EADDRINUSE |
| tests/contracts/provider-adapters.test.ts | 21 | Bun.serve bind port0 EADDRINUSE |
| tests/contracts/process-observer.test.ts | 1 | Independent ps observation failed |

Các fail không được skip hay thay bằng mock success. Fixtures model chỉ chứng minh invariant/cancellation/failure handling;
Git/SecureFiles/editor dùng executable/filesystem thật ở host này, không suy rộng thành authenticated provider hoặc OS matrix.

- Sau audit action id: Ctrl+X B công bố đúng `app:cycleDiffBase` trong DiffPanel; `diff:changeBase` cũ là alias không có default key. `keymap/keymap.test.ts` assert public id và alias; focused keymap + diff + goldens: **35 pass, 2 skip, 0 fail**, 482 assertions. Hai skip là color checks không có FORCE_COLOR, đã chạy riêng ở trên.


## P3 fix round — hồi quy default diff / review

Coordinator ngoài sandbox: 1187 pass / 12 skip / 6 fail; ba lỗi P3 được xử lý ở code, không đổi expectation của hai file
end-to-end. Current trước đây chỉ duyệt patch preimages; nay dùng bounded workspace snapshot lúc mở phiên và inventory mới,
phát hiện shell writes dù không receipt. Snapshot được persistence giữ trong checkpoint JSON đầu tiên để resume.
`/review` explicit Uncommitted thay Current của phiên chưa tồn tại; cache giữ metadata ask không content, chỉ chiếu vào review,
`reviewEvidence` lọc lại builtin/project rules. Stale refresh giữ nguyên mode và không submit sang session mới.

Thêm `tests/contracts/workspace-diff-regressions.test.ts` với sáu test không port: shell-created/modified + baseline, persisted
snapshot/resume, review fresh Git, ask old/new bytes withheld, stale-session review, snapshot secret rejection.
Đặc tả diff shell ở phần này thay giới hạn “session baseline không gồm shell/MCP” của báo cáo P3 phía trên;
không đổi giới hạn **restore** code qua checkpoint. Contract1.39 / SQLite10 giữ nguyên, không dependency hay commit.


Nghiệm chứng local fix round: `bun run format`, `bun run typecheck`, `bun run lint` qua.
Focused regression + workspace bases + checkpoints + terminal-injection + TUI diff + p2-integration:
**48 pass, 2 skip, 0 fail**, 320 assertions/7 files. Sáu test mới đã tái hiện ba lỗi trước sửa (3 fail),
sau đó qua không dùng HTTP fixture hay fake success của OS sandbox. Hai skip là color checks không FORCE_COLOR.
Chạy đủ `tests/end-to-end/native-agent.test.ts` và `tests/end-to-end/tui-modes.test.ts`: **1 pass, 11 fail**,
11 lỗi HTTP fixture `Bun.serve` bind port0 `EADDRINUSE` trước assertion (10 tui-modes + native Task02F).
Coordinator cần chạy hai file này ngoài sandbox; không gọi chúng đã qua local.
SHA-256 xác nhận không đổi turn.ts/profiles.ts/paths.ts và ba test excluded apply-patch/subagents/project-context.
Không sửa hai file end-to-end gốc, không commit, không stash/reset/checkout.
