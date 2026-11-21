# Pha 1 — tui-dialogs

Chỉ thêm file trong các feature được giao. Không đổi SDK/core/security, app slots,
UI nền, dependency hay renderer mặc định. Không commit/push.

Mỗi thư mục export qua `index.tsx`. Component cần client/theme/overlay providers.
`IntegratedShell` mở dialog qua overlay, không tạo listener stdin riêng. Common props:
`width?: number`, `visibleRows?: number`; resize theo stdout, text được sanitize,
màu qua theme, không có timer animation của feature. `usePicker` cung cấp
`open(id, ReactNode)` và `close()` cho host composition.

| Feature     | Component                                                                                                           | Props bổ sung                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| permissions | `PermissionsDialog`, `PermissionRequestDialog`, `PermissionRulesDialog` / `usePermissions`                          | `approvalId?`, `toolName?`, `onDenied?(reason, request)`; request component cần `request`; rules có `confirmFullAccessOnOpen?` |
| question    | `QuestionDialog`, `QuestionRequestDialog`                                                                           | `questionId?`; request component cần `request`                                                                                 |
| models      | `ModelsDialog`, `EffortDialog`                                                                                      | `accountId?`, `isStreaming?`, `onChanged?`                                                                                     |
| connect     | `ConnectDialog`                                                                                                     | `initialStep?: provider\|accounts`, `accountId?`, `action?: switch\|logout`, `initialQuery?`, `isStreaming?`, `onChanged?`     |
| sessions    | `SessionsDialog`                                                                                                    | `onChanged?`                                                                                                                   |
| settings    | `SettingsDialog`                                                                                                    | `onNavigate(action)` bắt buộc; `isStreaming?`, `initialSection?`                                                               |
| themes      | `ThemesDialog`                                                                                                      | common props                                                                                                                   |
| help        | `HelpDialog`                                                                                                        | `onCommand?(command)`                                                                                                          |
| memory      | `MemoryDialog`                                                                                                      | common props                                                                                                                   |
| agents      | `AgentsDialog`                                                                                                      | common props                                                                                                                   |
| skills      | `SkillsDialog`                                                                                                      | `onInvoke?(command)`; thiếu callback thì invocation disabled                                                                   |
| picker      | `Dialog`, `PickerDialog`, `TextEntry`, `Detail` / `usePicker`, `useDialogTask`, `useDialogRefresh`, `useDialogSize` | explicit interfaces trong `index.tsx`; `Detail.onBack?` cho Enter quay lại                                                     |

`IntegratedShell` mở các dialog trên. `usePermissions` là hook còn lại của nhóm này:
nó đọc pending/rules/mode và `cycleMode()` xoay `default → acceptEdits → plan` qua SDK
(`bypassPermissions` chỉ khi khởi động bằng nó). Hook subscriptions được cleanup khi unmount.

## Hành vi

- Permission: chỉ các quyết định SDK cung cấp; phím 1–N theo thứ tự lựa chọn hiện trên màn hình
  (once / session / always khi có rule, cuối cùng deny + lý do). Enter mặc định đi vào deny. Giữ scope hash,
  persist rule qua SDK trước approval, proposed diff không ghi là đã apply,
  escalation hiện NO SANDBOX, Ctrl+X revoke grants. Unmount dismiss đúng request.
  `/permissions`: chế độ quyền, Allow/Ask/Deny thêm/xoá theo từng file settings (user/project/local)
  và duyệt settings repository đang chờ. Các quyết định không được cung cấp không thể gọi bằng phím số.
- Question: từng tab, options có mô tả, multiple toggle, nhập tự do, explicit
  Submit all answers; kiểm đủ câu trả lời, unmount dismiss.
- Models: lọc ID/tên, cached catalog, Ctrl+R discovery có AbortSignal,
  Ctrl+A manual, Tab đổi catalog account (chưa gửi history), chọn model rồi effort;
  xác nhận account switch qua SDK. Effort chỉ advertised + provider default.
- Connect: providers, advanced methods, env reference, key input ẩn, ChatGPT
  browser/device OAuth + progress, OpenRouter OAuth code, custom user-config
  provider wizard (protocol/auth/catalog/manual/headers), accounts switch/rename/
  reconnect/add/logout/remove. Có confirm gửi history hoặc xoá credential. Đóng
  abort sign-in/switch, cancel challenge kể cả challenge đến muộn; lỗi không echo
  secret/provider response. Logout active thử chuyển sang account còn lại.
- Sessions: search/resume/delete confirmation, Ctrl+N new; giữ lỗi SDK thật.
- Settings: mọi section/control cũ, budget user, appearance global/project,
  scope Ctrl+G, tabs, lý do control unavailable; help từ KEYMAP/SLASH_COMMANDS.
  Manual compaction hiện hướng dẫn `/compact` theo SDK hiện tại.
- Themes: chọn để preview, Apply commit; Back/đóng rollback preview.
- Memory: list counters/last usage/stale hint, read/scroll/back/delete có confirm,
  mở folder qua SDK; không tự prune và không giả delete thành công khi denied.
- Agents: types + diagnostics, children/usage/status, transcript/back/stop/refresh.
  Skills: catalog/source/path/explicit-only/diagnostics và callback explicit invoke.

## Nối pha 2 / đề xuất pha 0

1. Mount hooks trong providers; dispatch slash canonical của SDK vào `open…`.
   Subscribe interaction trước khi chạy turn, mở permission/question theo ID.
   Host vẫn sở hữu consent, `setUserInputAvailable`, bật tools và lifecycle turn.
   `onChanged` đồng bộ transcript sau model/account/session changes; callback của
   settings route `models/accounts/effort/permissions/sessions/context/status`.
2. `resolvePermission` chưa có field denial reason: `onDenied` chỉ là callback UI
   sau SDK deny; pha 2 phải chuyển text thành user feedback/steering nếu có text.
   Không ghi reason thành rule/grant và không báo model đã nhận khi chưa nối.
3. Shell đóng Esc; các picker embedded không truyền `onCancel`. Question/permission
   và auth tự cleanup nghiệp vụ khi bị thay overlay, không chỉ khi bấm Esc.
4. Phase 0 Shell đang thêm Panel bên ngoài dialog Panel: feature chừa 4 cell để
   fit terminal. Đề xuất Shell render thẳng `active.content` ở pha 2, rồi bỏ
   phần chừa 4 cell. Không thay app.tsx trong pha 1.
5. ListPicker 0.1 chỉ có query nội bộ, cursor nội bộ, số thứ tự tương đối và hint
   cố định. Permission cần phím số cố định theo decision nên dùng picker read-only
   - handler số/arrow/Enter riêng; dấu chọn nằm trong label. Đề xuất pha 0 thêm
     controlled cursor hoặc numbered-choice mode và custom hint/ẩn số thứ tự để
     bỏ hai bộ số/dấu chọn. Không mở rộng API nền trái contract trong pha này.
6. Theme preview bắt đầu khi Enter chọn theme, sau đó Apply hoặc Back. Nếu cần
   preview ngay khi di chuyển cursor như TUI cũ, ListPicker cần `onHighlight`;
   API 0.1 chưa có callback này. Không dùng listener để đoán cursor/filter.
7. Settings giữ section trong suốt overlay mount; muốn giữ selection giữa các
   lần mở, pha 2 nên giữ state trong host/hook lâu sống và truyền initialSection.

## Kiểm chứng

`bun test apps/tui/src/ink/features/picker` chạy test component bằng helper
`ink/testing`/ink-testing-library cùng SDK thật trên hermetic backend ports và
logic thuần. Có kiểm permission stale/unoffered/dismiss/grant scope/rule,
question multiselect/free text/explicit submit, hidden input, task cancellation,
OAuth close/failure, custom provider, SDK validation, discovery cancellation,
session/memory failure, theme rollback, agent stop, settings và canonical help.

Fixture không chứng minh OS sandbox hay provider tương thích live. Real PTY,
resize/cancellation trên terminal người dùng, live ChatGPT/DeepSeek và parity
end-to-end khi đã nối pha 2: **Needs verification**.

## Pha 2 integration (2026-11-18)

Các mục nối host ở trên được triển khai trong `ink/integrated-shell.tsx` và runtime,
router `ink/features/commands.ts`; API nền version 0.2 trong
[contracts](../../../../../../docs/delivery/tui-v3/contracts.md).
Evidence từng luồng và giới hạn tại
[parity](../../../../../../docs/delivery/tui-v3/parity.md),
`ink/testing/integration.test.tsx`, `tests/end-to-end/tui-ink-pty.test.ts` và
`tests/contracts/sdk-memory-write.test.ts`. Default/golden legacy không đổi.

## TUI v4 — phase D (2026-11-19)

Spec rows 4, 18, 19: trust defaults to `No, exit`, with persistent per-workspace consent and
billing disclosure preserved. Shared panels use the phase A Rule and Pointer,
numbered inline picker descriptions, independent current-item `✔`, and the
`Enter to confirm · Esc to exit` footer. Help, settings, permissions and status
have horizontal tabs controlled by Tab / arrows (status Summary / Details also
retains D). Question tabs preserve explicit submission and free-text answers.

Permission headings distinguish Bash, edit/write/patch, Fetch, network, MCP and
Web Search. Offered scopes are numbered contiguously, default Enter still selects
denial, denial reason goes to the host only after SDK resolution, diff is marked
proposed, and unsandboxed commands retain the red NO SANDBOX warning. No SDK,
policy, grant or durable-consent behavior is changed.

New evidence: `v4-dialogs.test.tsx` checks 80/36-column picker frames, current vs
cursor state, every permission tool kind and offered-key bounds, exact domain
scope labels, and tab navigation without accidental filtering.
`../startup-gate/startup-gate.test.tsx` checks refusal/no probe by default and
  workspace consent persists in user settings; unmount only disables live tools. Existing `dialogs.test.tsx` still checks
stale scopes, once/session/always grants, denial feedback, auth cancellation,
question submission, memory/session failures and theme rollback. These tests
prove UI/SDK behavior, not live provider or OS compatibility. Phase E updated shared test helpers and expectations to the new labels,
reviewed/re-recorded 80/36-column golden frames, and verified the native PTY
lifecycle on synthetic SDK ports. Full provider-backed PTY tests still need an
environment that permits local server binding. Phase D evidence and remaining
limits now live in `docs/delivery/tui-v4/claude-code-parity.md`.

Phase E fix round: permission choices set `filterable={false}` (no filter/count),
use kind headings including Read file, put risk/reason under the target, and keep
a dedicated Esc-to-cancel footer. Filtering pickers retain their filter/count.

## TUI v4 (G3: dialogs and panels)

Spec: `docs/delivery/tui-v4/spec.md` sections 5-7 and the reference frames.

- Panels (`Panel`, `ruleStyle="panel"`): `▔` rule, content indented 2, bold rule-coloured title or `PanelTabs`
  (`Settings  Status   Config   Usage   Stats`: one padded gap between tabs, selected tab reversed), `SearchBox` (rounded `⌕` box,
  shown for lists over eight rows or once the user types), `ListPicker` rows without numbers (`❯ ✔ label   description`, `↓ N more`).
- Decision dialogs (`ruleStyle="dialog"`, `padding={0}`): `─` rule, `OptionList` numbered rows (`❯ 1. Yes`), `╌` rules around the diff.
  Permission: Enter on the highlighted row, number keys, Shift+Tab = accept-edits row, Tab = amend (deny with a reason), Esc cancels
  (denies). The cursor starts on `Yes`; an unsandboxed command and settings-trust prompts start on `No`.
  Question: one chip per question (`☐`/`☒`, plus `✔ Submit` when there are several), `Type something.` is typed inline,
  `Chat about this` dismisses the question.
- `/config`, `/status`, `/usage`, `/cost` are tabs of `SettingsDialog` (`initialTab`); `/context` draws the 20x7 grid from `contextBlock`.
- `features/panels`: `/mcp`, `/hooks` (both "Not implemented"), `/rewind` (prompt list; restoring is not implemented) and the transcript
  helpers `commandResult` / `cancelledResult` / `notImplementedResult` for `❯ /cmd` + `  ⎿  result` lines.
- Colour test: `v4-colors.test.ts` (subprocess with `FORCE_COLOR=3`, dark variant of spec 9).


### Pointer input in shared controls

`ListPicker` uses wheel input over its measured list to move the bounded highlight.
Clicks highlight rows, including disabled entries; Enter or the existing keyboard action
remains necessary to activate them. `OptionList` accepts `onCursorChange` and `isActive`
for the same focus-only behavior, measuring the full wrapped label and description.
Split question lists pass `onWheel` to navigate across their sections. These controls
respect `InputScope`, so background panels cannot receive pointer actions.

`PanelTabs` accepts `onSelect` and `isActive`; only measured tab boxes respond to clicks.
Tab keyboard shortcuts remain owned by each feature. `Detail` scrolls output with the
wheel only over its output area. The same shared behavior applies to background task
lists and output views. Rewind and plan approval keep execution behind explicit Enter
confirmation after pointer highlighting; the plan body has its own wheel region.
