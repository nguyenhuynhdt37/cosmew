# Pha 1 — tui-dialogs

Chỉ thêm file trong các feature được giao. Không đổi SDK/core/security, app slots,
UI nền, dependency hay renderer mặc định. Không commit/push.

Mỗi thư mục export qua `index.tsx`. Component cần client/theme/overlay providers;
hook `open…` mở qua `OverlayRouter`, không tạo listener stdin riêng. Common props:
`width?: number`, `visibleRows?: number`; resize theo stdout, text được sanitize,
màu qua theme, không có timer animation của feature. `usePicker` cung cấp
`open(id, ReactNode)` và `close()` cho host composition.

| Feature     | Component / hook                                                                                                    | Props bổ sung                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| permissions | `PermissionsDialog`, `PermissionRequestDialog`, `PermissionRulesDialog` / `usePermissions`                          | `approvalId?`, `toolName?`, `onDenied?(reason, request)`; request component cần `request`; rules có `confirmFullAccessOnOpen?` |
| question    | `QuestionDialog`, `QuestionRequestDialog` / `useQuestion`                                                           | `questionId?`; request component cần `request`                                                                                 |
| models      | `ModelsDialog`, `EffortDialog` / `useModels`                                                                        | `accountId?`, `isStreaming?`, `onChanged?`                                                                                     |
| connect     | `ConnectDialog` / `useConnect`                                                                                      | `initialStep?: provider\|accounts`, `accountId?`, `action?: switch\|logout`, `initialQuery?`, `isStreaming?`, `onChanged?`     |
| sessions    | `SessionsDialog` / `useSessions`                                                                                    | `onChanged?`                                                                                                                   |
| settings    | `SettingsDialog` / `useSettings`                                                                                    | `onNavigate(action)` bắt buộc; `isStreaming?`, `initialSection?`                                                               |
| themes      | `ThemesDialog` / `useThemes`                                                                                        | common props                                                                                                                   |
| help        | `HelpDialog` / `useHelp`                                                                                            | `onCommand?(command)`                                                                                                          |
| memory      | `MemoryDialog` / `useMemory`                                                                                        | common props                                                                                                                   |
| agents      | `AgentsDialog` / `useAgents`                                                                                        | common props                                                                                                                   |
| skills      | `SkillsDialog` / `useSkills`                                                                                        | `onInvoke?(command)`; thiếu callback thì invocation disabled                                                                   |
| picker      | `Dialog`, `PickerDialog`, `TextEntry`, `Detail` / `usePicker`, `useDialogTask`, `useDialogRefresh`, `useDialogSize` | explicit interfaces trong `index.tsx`; `Detail.onBack?` cho Enter quay lại                                                     |

Hooks trả catalog/pending state từ SDK và hàm `openPermissions`, `openQuestion`,
`openModels`/`openEffort`, `openConnect`, … tương ứng. `usePermissions.cyclePreset()`
chuyển preset qua SDK; khi sắp vào Full Access mở warning confirmation, không tự
bypass. Hook subscriptions được cleanup khi unmount.

## Hành vi

- Permission: chỉ các quyết định SDK cung cấp; phím 1 once / 2 session / 3 always
  (phải có rule) / 4 deny + lý do. Enter mặc định đi vào deny. Giữ scope hash,
  persist rule qua SDK trước approval, proposed diff không ghi là đã apply,
  escalation hiện NO SANDBOX, Ctrl+X revoke grants. Unmount dismiss đúng request.
  `/permissions`: preset, approval modes, Allow/Ask/Deny thêm/xoá và Full Access
  confirmation. Các quyết định không được cung cấp không thể gọi bằng phím số.
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
